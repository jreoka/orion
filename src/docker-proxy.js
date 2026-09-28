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

function forward(method, p, headers, body) {
  return new Promise((resolve, reject) => {
    const fwd = http.request(
      { socketPath: REAL_SOCK, path: p, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
        );
      }
    );
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
    const r = await forward(m, req.url, req.headers, body).catch((e) => null);
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
      const isAttach = rest.startsWith('/attach');
      if (own === 'readonly' && !isRead) {
        return deny(res, 'your sandbox container is managed by Orion');
      }
      if (isAttach) {
        // Streaming attach: pipe bidirectionally without buffering.
        const fwd = http.request(
          { socketPath: REAL_SOCK, path: req.url, method: m, headers: req.headers }
        );
        fwd.on('response', (pres) => {
          res.writeHead(pres.statusCode, pres.headers);
          pres.pipe(res);
        });
        fwd.on('error', () => deny(res, 'docker daemon unreachable'));
        req.pipe(fwd);
        return;
      }
    }
    const body = ['POST', 'PUT', 'PATCH'].includes(m) ? await readBody(req).catch(() => '') : '';
    const r = await forward(m, req.url, req.headers, body).catch(() => null);
    if (!r) return deny(res, 'docker daemon unreachable');
    // Filter `GET /containers/json` to the user's resources.
    if (m === 'GET' && p === '/containers/json' && r.status === 200) {
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

  // ---- exec create/start: /containers/{id}/exec handled above; /exec/{id}/start ----
  const em = p.match(/^\/exec\/([^/]+)(\/.*)?$/);
  if (em) {
    // We don't track exec ids -> containers cheaply; resolve via inspect.
    const execId = decodeURIComponent(em[1]);
    const info = await new Promise((resolve) => {
      const rq = http.request(
        { socketPath: REAL_SOCK, path: `/exec/${encodeURIComponent(execId)}/json`, method: 'GET' },
        (rs) => {
          let b = '';
          rs.on('data', (c) => (b += c));
          rs.on('end', () => {
            try {
              resolve(rs.statusCode === 200 ? JSON.parse(b) : null);
            } catch {
              resolve(null);
            }
          });
        }
      );
      rq.on('error', () => resolve(null));
      rq.end();
    });
    const own = info ? await ownsContainer(userId, info.ContainerID || info.Container) : false;
    if (!own || own === 'readonly') return deny(res, 'exec target not in your namespace');
    const body = m === 'POST' ? await readBody(req).catch(() => '') : '';
    const r = await forward(m, req.url, req.headers, body).catch(() => null);
    if (!r) return deny(res, 'docker daemon unreachable');
    return sendRaw(res, r);
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
    const r = await forward(m, req.url, req.headers, body).catch(() => null);
    if (!r) return deny(res, 'docker daemon unreachable');
    return sendRaw(res, r);
  }
  const vm = p.match(/^\/volumes\/([^/]+)$/);
  if (vm) {
    const vname = decodeURIComponent(vm[1]);
    if (!allowedName(userId, vname) && !ownInfra(userId, vname)) return deny(res, 'volume not in your namespace');
    if (ownInfra(userId, vname) && m !== 'GET') return deny(res, 'your data volume is managed by Orion');
    const body = ['POST', 'PUT'].includes(m) ? await readBody(req).catch(() => '') : '';
    const r = await forward(m, req.url, req.headers, body).catch(() => null);
    if (!r) return deny(res, 'docker daemon unreachable');
    if (m === 'GET' && p === '/volumes' && r.status === 200) {
      try {
        const j = JSON.parse(r.body.toString());
        j.Volumes = (j.Volumes || []).filter((v) => allowedName(userId, v.Name) || ownInfra(userId, v.Name));
        j.Warnings = [];
        r.body = Buffer.from(JSON.stringify(j));
      } catch {
        /* leave as-is */
      }
    }
    return sendRaw(res, r);
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
    const r = await forward(m, req.url, req.headers, body).catch(() => null);
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
    const body = ['POST', 'PUT'].includes(m) ? await readBody(req).catch(() => '') : '';
    const r = await forward(m, req.url, req.headers, body).catch(() => null);
    if (!r) return deny(res, 'docker daemon unreachable');
    return sendRaw(res, r);
  }

  // ---- images: pull/build/list/inspect allowed; push/delete blocked ----
  if (p.startsWith('/images/') && (m === 'DELETE' || p.endsWith('/push'))) {
    return deny(res, 'image push/delete is not allowed from the sandbox');
  }

  // ---- everything else: pass through (info, version, image pull, etc.) ----
  const body = ['POST', 'PUT', 'PATCH'].includes(m) ? await readBody(req).catch(() => '') : '';
  const r = await forward(m, req.url, req.headers, body).catch(() => null);
  if (!r) return deny(res, 'docker daemon unreachable');
  return sendRaw(res, r);
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
  const ready = new Promise((resolve, reject) => {
    server.listen(sockPath, () => {
      // World-writable socket: the sandbox's `agent` user (different uid)
      // must be able to talk to it.
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
  return path.resolve(path.join(PROXY_DIR, `u${Number(userId)}.sock`));
}

/** Host-side path for bind-mounting the user's proxy socket into sandboxes. */
export function proxySockHostPath(userId) {
  return path.resolve(path.join(PROXY_HOST_DIR, `u${Number(userId)}.sock`));
}
