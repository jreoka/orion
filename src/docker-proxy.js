// Orion Docker socket proxy: per-user filtering firewall between sandboxes
// and the host Docker daemon.
//
// Each sandbox gets its own Unix socket (instead of the real docker.sock).
// The proxy forwards to the real socket but enforces:
//   - Container/volume/network names must belong to the user (prefix u<id>-),
//     except the user's own sandbox container (orion-u<id>) which is read-only.
//   - No Privileged, no CapAdd, no host-path bind mounts, no --pid/host/ipc/uts,
//     no mounting the docker socket (or any socket) into new containers.
//   - List endpoints only return the user's own resources.
//   - Exec/attach/logs only on the user's own containers.
//
// This closes the sandbox-escape hole where the raw socket let any user
// manage (or break out via) other users' containers.
//
// Two protocol-critical behaviors:
//   - Responses are STREAMED (headers relayed immediately, body piped).
//     Buffering the whole body first breaks long-poll/streaming endpoints:
//     /wait (docker run -d opens the wait BEFORE start; the CLI blocks on
//     response headers), /events, logs -f, and image pull progress.
//   - Hijacked (Connection: Upgrade) requests — /exec/{id}/start and
//     /containers/{id}/attach — are handled via the server's 'upgrade' event
//     with a raw bidirectional pipe after the 101 response. Node's http
//     server never emits 'request' for these, so they need their own path.
//   - Published ports (-p) are brokered: Docker publishes on the HOST, but
//     127.0.0.1 inside the sandbox is the sandbox's own loopback. On
//     container start with PortBindings we spawn a tiny TCP forwarder inside
//     the sandbox (detached exec) listening on its 127.0.0.1:<hostPort> and
//     forwarding to the container's bridge IP. The forwarder exits when the
//     container stops, freeing the port.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './db.js';

const REAL_SOCK = '/var/run/docker.sock';
// Sockets live in DOCKER_PROXY_DIR (a host bind-mount, NOT a Docker volume:
// bind-mount sources resolve on the Docker host, so a volume path would not
// resolve). DOCKER_PROXY_HOST_DIR is the host-side path of that same dir.
const PROXY_DIR = process.env.DOCKER_PROXY_DIR || path.join(DATA_DIR, 'docker-proxy');
const PROXY_HOST_DIR = process.env.DOCKER_PROXY_HOST_DIR || PROXY_DIR;

const servers = new Map(); // userId -> http.Server

function userPrefix(userId) {
  return `u${Number(userId)}-`;
}
function sandboxName(userId) {
  return `orion-u${Number(userId)}`;
}
function sandboxVolume(userId) {
  return `orion-u${Number(userId)}-data`;
}

// In-sandbox path of this user's proxy socket (DOCKER_HOST inside the sandbox).
function sandboxSockPath(userId) {
  return `/docker-proxy/u${Number(userId)}.sock`;
}

// Each user's socket lives in its own subdirectory: PROXY_DIR/u<id>/u<id>.sock.
// The sandbox bind-mounts ONLY its own subdirectory at /docker-proxy, so a
// user can never reach another user's socket. (The proxy trusts the socket
// path for identity — mounting the shared parent directory let any sandbox
// point DOCKER_HOST at another user's socket and fully impersonate them:
// create/exec/cp as that user. Fixed 2026-09-29.) Directory mounts (not file
// mounts) keep working across proxy restarts: when the socket file is
// recreated, the sandbox sees the new file through the mounted directory.
function proxySockDir(userId) {
  return path.join(PROXY_DIR, `u${Number(userId)}`);
}

// Names the user is allowed to create/manage (their own namespace).
function allowedName(userId, name) {
  if (!name) return false;
  const n = String(name).replace(/^\//, ''); // Docker prefixes with /
  return n.startsWith(userPrefix(userId));
}
// The user's own sandbox container/volume: visible, but not modifiable
// through the proxy (the server manages its lifecycle).
function ownInfra(userId, name) {
  const n = String(name || '').replace(/^\//, '');
  return n === sandboxName(userId) || n === sandboxVolume(userId);
}

function deny(res, msg) {
  res.writeHead(403, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ message: `denied by orion docker proxy: ${msg}` }));
}

// Low-level daemon request returning parsed JSON (or null).
function daemonJson(method, p, body) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (payload !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ socketPath: REAL_SOCK, path: p, method, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return resolve(null);
        try {
          resolve(JSON.parse(buf || '{}'));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    if (payload !== null) req.write(payload);
    req.end();
  });
}

// Raw daemon request (no JSON parsing); resolves { status } when the response
// headers arrive.
function daemonRaw(method, p, body) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (payload !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ socketPath: REAL_SOCK, path: p, method, headers }, (res) => {
      res.resume(); // discard body
      resolve({ status: res.statusCode });
    });
    req.on('error', () => resolve(null));
    if (payload !== null) req.write(payload);
    req.end();
  });
}

// Resolve a container id/prefix to its full name via the real socket.
function inspectContainer(nameOrId) {
  return new Promise((resolve) => {
    const req = http.request(
      { socketPath: REAL_SOCK, path: `/containers/${encodeURIComponent(nameOrId)}/json`, method: 'GET' },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve(null);
          try {
            resolve(JSON.parse(buf));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.end();
  });
}

async function ownsContainer(userId, nameOrId) {
  // Fast path: name already tells us.
  const n = String(nameOrId || '').replace(/^\//, '');
  if (allowedName(userId, n)) return true;
  if (ownInfra(userId, n)) return 'readonly';
  // Slow path: resolve id -> name.
  const info = await inspectContainer(nameOrId);
  if (!info) return false;
  const iname = (info.Name || '').replace(/^\//, '');
  if (allowedName(userId, iname)) return true;
  if (ownInfra(userId, iname)) return 'readonly';
  return false;
}

// Resolve an exec id -> container -> ownership.
async function ownsExec(userId, execId) {
  const info = await daemonJson('GET', `/exec/${encodeURIComponent(execId)}/json`);
  if (!info) return false;
  return ownsContainer(userId, info.ContainerID || info.Container);
}

// Validate a container-create body. Returns null if OK, else a reason string.
function validateCreate(userId, body) {
  let cfg;
  try {
    cfg = JSON.parse(body || '{}');
  } catch {
    return 'invalid JSON body';
  }
  const hc = cfg.HostConfig || {};
  if (hc.Privileged) return 'privileged containers are not allowed';
  if (hc.CapAdd && hc.CapAdd.length) return 'adding capabilities is not allowed';
  if (hc.PidMode && hc.PidMode !== '') return 'custom pid mode is not allowed';
  if (hc.NetworkMode === 'host' || hc.NetworkMode === 'none') {
    // 'none' is harmless actually; only block host
    if (hc.NetworkMode === 'host') return 'host networking is not allowed';
  }
  if (hc.IpcMode === 'host' || hc.UsernsMode === 'host' || hc.UtsMode === 'host') {
    return 'host namespaces are not allowed';
  }
  if (hc.Devices && hc.Devices.length) return 'host device access is not allowed';
  // Binds: only the user's own named volumes, no host paths, no sockets.
  for (const b of hc.Binds || []) {
    const src = String(b).split(':')[0];
    if (src.includes('/')) return `host-path bind mounts are not allowed: ${b}`;
    if (src === 'docker.sock' || src.endsWith('.sock')) return `mounting sockets is not allowed: ${b}`;
    if (!allowedName(userId, src) && !ownInfra(userId, src)) {
      return `volume not in your namespace: ${b}`;
    }
  }
  for (const m of hc.Mounts || []) {
    const src = String(m.Source || '');
    if ((m.Type || 'volume') !== 'volume') return `only volume mounts are allowed (got ${m.Type})`;
    if (!allowedName(userId, src) && !ownInfra(userId, src)) {
      return `volume not in your namespace: ${src}`;
    }
  }
  return null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > 8 * 1024 * 1024) {
        req.destroy();
        reject(new Error('body too large'));
      }
    });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}

// Buffering forward: for endpoints where we must inspect/filter the body
// (container/volume list filtering). NOT for streaming endpoints.
function forwardBuffer(method, p, headers, body) {
  return new Promise((resolve, reject) => {
    const fwd = http.request({ socketPath: REAL_SOCK, path: p, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
      );
    });
    fwd.on('error', reject);
    if (body) fwd.write(body);
    fwd.end();
  });
}

function sendRaw(res, { status, headers, body }) {
  const h = { ...headers };
  delete h['transfer-encoding'];
  delete h['content-length'];
  // Strip hop-by-hop / socket-specific headers
  res.writeHead(status, h);
  res.end(body);
}

// Streaming forward: relay response headers immediately, then pipe the body.
// This is what makes long-poll/streaming endpoints work: /wait (docker run -d
// opens the wait BEFORE start, and the CLI blocks until response headers
// arrive), /events, logs -f, image pull progress. Resolves with the upstream
// status code.
// If `body` is undefined, the client request body is piped (for large bodies
// like image build contexts); otherwise `body` (a string) is sent.
function forwardStream(method, p, headers, body, clientReq, clientRes) {
  return new Promise((resolve) => {
    let done = false;
    let status = 0;
    const finish = () => {
      if (!done) {
        done = true;
        resolve({ status });
      }
    };
    const fwd = http.request({ socketPath: REAL_SOCK, path: p, method, headers }, (res) => {
      status = res.statusCode;
      const h = { ...res.headers };
      delete h['transfer-encoding']; // node de-chunks; re-chunk on the way out
      try {
        clientRes.writeHead(res.statusCode, h);
        // Flush immediately: long-poll endpoints (/wait) send headers now and
        // hold the body open; without this the headers sit buffered until the
        // first body chunk, which never comes.
        if (typeof clientRes.flushHeaders === 'function') clientRes.flushHeaders();
      } catch {
        fwd.destroy();
        finish();
        return;
      }
      res.pipe(clientRes);
      res.on('end', finish);
      res.on('error', finish);
    });
    fwd.on('error', () => {
      if (!clientRes.headersSent) {
        try {
          clientRes.writeHead(502, { 'Content-Type': 'application/json' });
          clientRes.end(JSON.stringify({ message: 'docker daemon unreachable' }));
        } catch {
          /* ignore */
        }
      } else {
        try {
          clientRes.destroy();
        } catch {
          /* ignore */
        }
      }
      finish();
    });
    // Client went away: abort the daemon request so it doesn't leak.
    clientRes.on('close', () => {
      try {
        fwd.destroy();
      } catch {
        /* ignore */
      }
    });
    if (body === undefined) {
      // Pipe the request body (large bodies like build contexts).
      clientReq.pipe(fwd);
    } else {
      if (body) fwd.write(body);
      fwd.end();
    }
  });
}

// ---- hijacked (Connection: Upgrade) requests ----
// Node's http server emits 'upgrade' instead of 'request' for these, so
// /exec/{id}/start and /containers/{id}/attach need this separate path.
// After the daemon's 101, we pipe the raw sockets bidirectionally.
async function handleUpgrade(userId, clientReq, clientSocket, head) {
  const u = new URL(clientReq.url, 'http://localhost');
  const p = u.pathname.replace(/^\/v\d+\.\d+/, '') || '/';
  const m = clientReq.method;

  const denyUpgrade = (msg) => {
    try {
      clientSocket.write(
        'HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n' +
          JSON.stringify({ message: `denied by orion docker proxy: ${msg}` })
      );
    } catch {
      /* ignore */
    }
    try {
      clientSocket.destroy();
    } catch {
      /* ignore */
    }
  };

  // Only Docker's hijacked endpoints may upgrade.
  let allowed = false;
  const em = p.match(/^\/exec\/([^/]+)\/start$/);
  const am = p.match(/^\/containers\/([^/]+)\/attach$/);
  if (em && m === 'POST') {
    const own = await ownsExec(userId, decodeURIComponent(em[1]));
    allowed = !!own && own !== 'readonly';
  } else if (am && m === 'POST') {
    const own = await ownsContainer(userId, decodeURIComponent(am[1]));
    allowed = !!own && own !== 'readonly';
  }
  if (!allowed) return denyUpgrade('upgrade not allowed');

  const cleanup = () => {
    try {
      clientSocket.destroy();
    } catch {
      /* ignore */
    }
  };

  const fwd = http.request({
    socketPath: REAL_SOCK,
    path: clientReq.url,
    method: m,
    headers: clientReq.headers,
  });

  fwd.on('upgrade', (daemonRes, daemonSocket, daemonHead) => {
    clientSocket.unpipe(fwd);
    try {
      clientSocket.write(`HTTP/1.1 ${daemonRes.statusCode} ${daemonRes.statusMessage}\r\n`);
      for (const [k, v] of Object.entries(daemonRes.headers)) {
        clientSocket.write(`${k}: ${Array.isArray(v) ? v.join(', ') : v}\r\n`);
      }
      clientSocket.write('\r\n');
    } catch {
      cleanup();
      try {
        daemonSocket.destroy();
      } catch {
        /* ignore */
      }
      return;
    }
    if (daemonHead && daemonHead.length) clientSocket.write(daemonHead);
    const onErr = () => {
      try {
        daemonSocket.destroy();
      } catch {
        /* ignore */
      }
      cleanup();
    };
    daemonSocket.on('error', onErr);
    clientSocket.on('error', onErr);
    daemonSocket.on('close', onErr);
    clientSocket.on('close', onErr);
    daemonSocket.pipe(clientSocket);
    clientSocket.pipe(daemonSocket);
  });

  fwd.on('response', (daemonRes) => {
    // Non-101 (e.g. 404/409): relay as a plain HTTP response.
    clientSocket.unpipe(fwd);
    try {
      clientSocket.write(`HTTP/1.1 ${daemonRes.statusCode} ${daemonRes.statusMessage}\r\n`);
      const h = { ...daemonRes.headers };
      delete h['transfer-encoding'];
      for (const [k, v] of Object.entries(h)) {
        clientSocket.write(`${k}: ${Array.isArray(v) ? v.join(', ') : v}\r\n`);
      }
      clientSocket.write('\r\n');
    } catch {
      cleanup();
      return;
    }
    daemonRes.pipe(clientSocket);
    daemonRes.on('end', cleanup);
    daemonRes.on('error', cleanup);
  });

  fwd.on('error', cleanup);
  clientSocket.on('error', cleanup);

  // Forward any request-body bytes already read, then stream the rest.
  // (Docker's hijacked POSTs carry a small JSON body like {"Detach":false}.)
  if (head && head.length) fwd.write(head);
  clientSocket.pipe(fwd);
}

// ---- published-port broker ----
// Docker publishes -p ports on the HOST, but 127.0.0.1 inside a sandbox is the
// sandbox's own loopback. After a container with PortBindings starts, spawn a
// tiny TCP forwarder inside the sandbox (detached exec, as root so it can bind
// low ports) that listens on the sandbox's 127.0.0.1:<hostPort> and forwards
// to the container's bridge IP. The forwarder polls the container and exits
// when it stops, freeing the port.
const FORWARDER_SCRIPT = String.raw`
const http = require('http');
const net = require('net');
const listenPort = Number(process.argv[1]);
const containerId = process.argv[2];
const containerPort = Number(process.argv[3]);
const sockPath = process.argv[4];
function inspect() {
  return new Promise((resolve) => {
    const req = http.request({ socketPath: sockPath, path: '/containers/' + containerId + '/json', method: 'GET' }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        try { resolve(res.statusCode === 200 ? JSON.parse(b) : null); }
        catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { try { req.destroy(); } catch (e) {} resolve(null); });
    req.end();
  });
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
let server = null;
let target = null;
function serve(ip) {
  target = ip + ':' + containerPort;
  server = net.createServer((client) => {
    const up = net.connect(containerPort, ip);
    up.on('connect', () => { client.pipe(up); up.pipe(client); });
    up.on('error', () => { try { client.destroy(); } catch (e) {} });
    up.on('timeout', () => { try { client.destroy(); } catch (e) {} try { up.destroy(); } catch (e) {} });
    client.on('error', () => { try { up.destroy(); } catch (e) {} });
  });
  server.on('error', () => process.exit(1));
  server.listen(listenPort, '127.0.0.1');
}
(async () => {
  // Wait up to 60s for the container to be running with an IP. Retry the
  // bind briefly: a previous forwarder for this port may still be exiting.
  let ip = null;
  for (let i = 0; i < 60; i++) {
    const info = await inspect();
    const nets = info && info.NetworkSettings && info.NetworkSettings.Networks;
    const firstNet = nets && Object.values(nets)[0];
    if (info && info.State && info.State.Running && firstNet && firstNet.IPAddress) {
      ip = firstNet.IPAddress;
      break;
    }
    await sleep(1000);
  }
  if (!ip) process.exit(0);
  for (let attempt = 0; attempt < 15; attempt++) {
    target = null; server = null;
    let bound = false;
    const s = net.createServer();
    await new Promise((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      s.on('error', done);
      s.on('listening', () => { bound = true; s.close(); });
      s.on('close', done);
      try { s.listen(listenPort, '127.0.0.1'); } catch (e) { done(); }
    });
    if (bound) break;
    await sleep(2000);
  }
  serve(ip);
  setInterval(async () => {
    const info = await inspect();
    const running = !!(info && info.State && info.State.Running);
    const nets = info && info.NetworkSettings && info.NetworkSettings.Networks;
    const firstNet = nets && Object.values(nets)[0];
    const curIp = firstNet && firstNet.IPAddress;
    if (!running || !curIp) process.exit(0);
    if (curIp + ':' + containerPort !== target) {
      try { server.close(); } catch (e) {}
      serve(curIp);
    }
  }, 5000);
})();
`;

// Spawn a detached forwarder inside the user's sandbox for one published port.
async function spawnPortForwarder(userId, containerId, hostPort, containerPort) {
  const sbox = sandboxName(userId);
  const exec = await daemonJson('POST', `/containers/${sbox}/exec`, {
    AttachStdin: false,
    AttachStdout: false,
    AttachStderr: false,
    Tty: false,
    Cmd: ['node', '-e', FORWARDER_SCRIPT, String(hostPort), containerId, String(containerPort), sandboxSockPath(userId)],
    User: 'root',
  });
  if (!exec || !exec.Id) {
    console.warn(`[orion] docker proxy: port-forwarder exec create failed for ${sbox}:${hostPort}`);
    return;
  }
  const r = await daemonRaw('POST', `/exec/${exec.Id}/start`, { Detach: true });
  if (!r || r.status < 200 || r.status >= 300) {
    console.warn(`[orion] docker proxy: port-forwarder exec start failed for ${sbox}:${hostPort}`);
  }
}

// After a successful container start, broker any published ports.
async function brokerPublishedPorts(userId, containerId) {
  try {
    const info = await inspectContainer(containerId);
    const bindings = (info && info.HostConfig && info.HostConfig.PortBindings) || {};
    for (const [cportProto, maps] of Object.entries(bindings)) {
      const containerPort = String(cportProto).split('/')[0];
      for (const mapEntry of maps || []) {
        const hostPort = Number(mapEntry && mapEntry.HostPort);
        if (!hostPort) continue; // random/ephemeral assignment: skip
        spawnPortForwarder(userId, info.Id || containerId, hostPort, containerPort).catch((e) =>
          console.warn('[orion] docker proxy: port broker error:', e?.message || e)
        );
      }
    }
  } catch (e) {
    console.warn('[orion] docker proxy: port broker error:', e?.message || e);
  }
}

async function handleProxy(userId, req, res) {
  const u = new URL(req.url, 'http://localhost');
  // Docker API paths are versioned (/v1.43/containers/json) — strip the
  // version prefix so the filters below match. Forward the original URL.
  const p = u.pathname.replace(/^\/v\d+\.\d+/, '') || '/';
  const m = req.method;

  // ---- container create ----
  if (m === 'POST' && p === '/containers/create') {
    const name = u.searchParams.get('name') || '';
    if (name && !allowedName(userId, name)) return deny(res, `container name must start with ${userPrefix(userId)}`);
    const body = await readBody(req).catch(() => null);
    if (body === null) return deny(res, 'could not read request body');
    const reason = validateCreate(userId, body);
    if (reason) return deny(res, reason);
    const r = await forwardBuffer(m, req.url, req.headers, body).catch((e) => null);
    if (!r) return deny(res, 'docker daemon unreachable');
    return sendRaw(res, r);
  }

  // ---- container-scoped actions: /containers/{id}/... ----
  const cm = p.match(/^\/containers\/([^/]+)(\/.*)?$/);
  if (cm) {
    const id = decodeURIComponent(cm[1]);
    const rest = cm[2] || '';
    if (id !== 'json' || rest) {
      const own = await ownsContainer(userId, id);
      if (!own) return deny(res, 'container not in your namespace');
      // Read-only actions allowed on own sandbox infra; mutations only on
      // user-created containers.
      const readOnly = ['/json', '/top', '/stats', '/logs'];
      const isRead = m === 'GET' && readOnly.some((r) => rest === r || rest.startsWith(r + '?') || rest === r);
      if (own === 'readonly' && !isRead) {
        return deny(res, 'your sandbox container is managed by Orion');
      }
    }
    const needsFilter = m === 'GET' && p === '/containers/json';
    if (needsFilter) {
      const r = await forwardBuffer(m, req.url, req.headers, '').catch(() => null);
      if (!r) return deny(res, 'docker daemon unreachable');
      if (r.status === 200) {
        try {
          const list = JSON.parse(r.body.toString());
          const kept = list.filter((c) =>
            (c.Names || []).some((n) => allowedName(userId, n) || ownInfra(userId, n))
          );
          r.body = Buffer.from(JSON.stringify(kept));
        } catch {
          /* leave as-is on parse failure */
        }
      }
      return sendRaw(res, r);
    }
    // Container start: stream the response, then broker published ports.
    if (m === 'POST' && rest === '/start') {
      const { status } = await forwardStream(m, req.url, req.headers, undefined, req, res).catch(() => ({ status: 0 }));
      if (status === 204) brokerPublishedPorts(userId, id);
      return;
    }
    await forwardStream(m, req.url, req.headers, undefined, req, res);
    return;
  }

  // ---- exec create/start: /exec/{id}/start (non-upgrade fallback; real
  // hijacks arrive via the 'upgrade' event and never hit this path) ----
  const em = p.match(/^\/exec\/([^/]+)(\/.*)?$/);
  if (em) {
    const execId = decodeURIComponent(em[1]);
    const own = await ownsExec(userId, execId);
    if (!own || own === 'readonly') return deny(res, 'exec target not in your namespace');
    await forwardStream(m, req.url, req.headers, undefined, req, res);
    return;
  }

  // ---- volumes ----
  if (p === '/volumes/create' && m === 'POST') {
    const body = await readBody(req).catch(() => null);
    if (body === null) return deny(res, 'could not read request body');
    let cfg;
    try {
      cfg = JSON.parse(body || '{}');
    } catch {
      return deny(res, 'invalid JSON body');
    }
    if (!allowedName(userId, cfg.Name)) return deny(res, `volume name must start with ${userPrefix(userId)}`);
    const r = await forwardBuffer(m, req.url, req.headers, body).catch(() => null);
    if (!r) return deny(res, 'docker daemon unreachable');
    return sendRaw(res, r);
  }
  const vm = p.match(/^\/volumes\/([^/]+)$/);
  if (vm) {
    const vname = decodeURIComponent(vm[1]);
    if (!allowedName(userId, vname) && !ownInfra(userId, vname)) return deny(res, 'volume not in your namespace');
    if (ownInfra(userId, vname) && m !== 'GET') return deny(res, 'your data volume is managed by Orion');
    await forwardStream(m, req.url, req.headers, undefined, req, res);
    return;
  }

  // ---- networks ----
  if (p === '/networks/create' && m === 'POST') {
    const body = await readBody(req).catch(() => null);
    if (body === null) return deny(res, 'could not read request body');
    let cfg;
    try {
      cfg = JSON.parse(body || '{}');
    } catch {
      return deny(res, 'invalid JSON body');
    }
    if (!allowedName(userId, cfg.Name)) return deny(res, `network name must start with ${userPrefix(userId)}`);
    const r = await forwardBuffer(m, req.url, req.headers, body).catch(() => null);
    if (!r) return deny(res, 'docker daemon unreachable');
    return sendRaw(res, r);
  }
  const nm = p.match(/^\/networks\/([^/]+)(\/.*)?$/);
  if (nm) {
    const nname = decodeURIComponent(nm[1]);
    // Always allow the default networks for inspection; block mutations on
    // anything outside the user's namespace.
    const builtin = ['bridge', 'host', 'none'];
    if (!allowedName(userId, nname) && !builtin.includes(nname)) return deny(res, 'network not in your namespace');
    if (!allowedName(userId, nname) && m !== 'GET') return deny(res, 'cannot modify this network');
    await forwardStream(m, req.url, req.headers, undefined, req, res);
    return;
  }

  // ---- images: pull/build/list/inspect allowed; push/delete blocked ----
  // /images/json is deliberately NOT filtered: images are a shared build
  // cache on the single shared daemon (layers are content-addressed and
  // common base images are identical for everyone). Filtering the list
  // would be theater — anyone can still `docker pull` by name. The security
  // boundary is containers/volumes/networks/exec, which are namespaced.
  if (p.startsWith('/images/') && (m === 'DELETE' || p.endsWith('/push'))) {
    return deny(res, 'image push/delete is not allowed from the sandbox');
  }

  // ---- everything else: pass through (info, version, image pull, etc.) ----
  // Stream: image pulls and builds emit long-lived progress streams.
  await forwardStream(m, req.url, req.headers, undefined, req, res);
}

/** Ensure a proxy socket exists for this user; resolves to its path
 *  once the socket is actually listening (so containers can bind-mount it). */
export function ensureDockerProxy(userId) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid user id');
  const sockPath = proxySockPath(id);
  const existing = servers.get(id);
  if (existing) {
    // Already listening? Resolve immediately; otherwise wait for it.
    if (existing.listening) return Promise.resolve(sockPath);
    return existing.ready;
  }
  fs.mkdirSync(PROXY_DIR, { recursive: true });
  // Per-user subdirectory (see proxySockDir): only this user's socket file
  // lives here, and only this directory is mounted into their sandbox.
  fs.mkdirSync(proxySockDir(id), { recursive: true });
  // Clean up the legacy flat socket (pre-2026-09-29 layout mounted the whole
  // PROXY_DIR into every sandbox — the cross-tenant impersonation hole).
  try {
    fs.unlinkSync(path.join(PROXY_DIR, `u${id}.sock`));
  } catch {
    /* already gone */
  }
  try {
    fs.unlinkSync(sockPath);
  } catch {
    /* not there */
  }
  const server = http.createServer((req, res) => {
    handleProxy(id, req, res).catch((e) => {
      console.warn('[orion] docker proxy error:', e?.message || e);
      try {
        deny(res, 'proxy internal error');
      } catch {
        /* already responded */
      }
    });
  });
  // Hijacked Docker connections (exec start, attach): raw bidirectional pipe.
  server.on('upgrade', (req, socket, head) => {
    handleUpgrade(id, req, socket, head).catch((e) => {
      console.warn('[orion] docker proxy upgrade error:', e?.message || e);
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    });
  });
  const ready = new Promise((resolve, reject) => {
    server.listen(sockPath, () => {
      // World-writable socket: harmless belt-and-braces (the sandbox runs as
      // root, and only its own per-user directory is mounted there anyway).
      try {
        fs.chmodSync(sockPath, 0o777);
      } catch {
        /* best effort */
      }
      resolve(sockPath);
    });
    server.on('error', reject);
  });
  server.ready = ready;
  // Don't let an unobserved rejection crash the process on restart races.
  ready.catch(() => {});
  servers.set(id, server);
  return ready;
}

export function proxySockPath(userId) {
  return path.resolve(path.join(proxySockDir(Number(userId)), `u${Number(userId)}.sock`));
}

/** Host-side per-user socket directory, bind-mounted at /docker-proxy inside
 *  that user's sandbox (contains only their own socket file). */
export function proxySockDirHostPath(userId) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid user id');
  return path.resolve(path.join(PROXY_HOST_DIR, `u${id}`));
}

/** Host-side path for bind-mounting the user's proxy socket into sandboxes. */
export function proxySockHostPath(userId) {
  return path.resolve(path.join(proxySockDirHostPath(userId), `u${Number(userId)}.sock`));
}
