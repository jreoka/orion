// Orion sandboxes: one Docker container per user, via dockerode.
// Container:  orion-u<userId>        (names derive from the numeric id only)
// Volume:     orion-u<userId>-data   mounted at /home/agent/workspace
// Image:      orion-sandbox:latest   (built from ./sandbox on first use)
//
// If /var/run/docker.sock is missing, every function throws a clear
// "Docker not available" error instead of crashing the server.
import Docker from 'dockerode';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { ensureDockerProxy, proxySockDirHostPath } from './docker-proxy.js';
import { clearUserVault } from './vault.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SOCK = '/var/run/docker.sock';
export const SANDBOX_IMAGE = 'orion-sandbox:latest';
const WORKDIR = '/home/agent/workspace';
const MAX_OUTPUT = 20000; // chars kept per exec before truncation

function getDocker() {
  if (!fs.existsSync(SOCK)) {
    throw new Error(
      'Docker not available: /var/run/docker.sock is missing. ' +
        'Start Docker and mount the socket into the Orion container.'
    );
  }
  return new Docker({ socketPath: SOCK });
}

// Container/volume names derive from the numeric user id only —
// no user-controlled strings ever reach Docker, so no name injection.
function names(userId) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid user id');
  return { container: `orion-u${id}`, volume: `orion-u${id}-data` };
}

// File tools are confined to the agent's workspace: a resolved path that
// escapes /home/agent/workspace is rejected.
function resolveWorkspacePath(p) {
  let rel = String(p || '').trim() || '.';
  const abs = rel.startsWith('/') ? rel : `${WORKDIR}/${rel}`;
  const norm = path.posix.normalize(abs);
  if (norm !== WORKDIR && !norm.startsWith(WORKDIR + '/')) {
    throw new Error('Path must stay inside /home/agent/workspace');
  }
  return norm;
}

function clampTimeout(t) {
  const n = Math.floor(Number(t));
  return Math.max(1, Math.min(600, Number.isFinite(n) ? n : 60));
}

// Hash of the sandbox build context (Dockerfile + orion-browser.js).
// The image carries it as a label; ensureImage() rebuilds when it changes
// so sandbox/Dockerfile edits actually take effect on existing installs.
function sandboxSourceHash() {
  const h = crypto.createHash('sha256');
  for (const f of ['Dockerfile', 'orion-browser.js']) {
    const p = path.join(__dirname, '..', 'sandbox', f);
    h.update(f);
    h.update(fs.readFileSync(p));
  }
  return h.digest('hex').slice(0, 16);
}

// Build the sandbox image from ./sandbox if it isn't there yet, or if the
// sandbox sources changed since it was built.
export async function ensureImage() {
  const docker = getDocker();
  const hash = sandboxSourceHash();
  try {
    const img = await docker.getImage(SANDBOX_IMAGE).inspect();
    if (img?.Config?.Labels?.['orion.sandbox-hash'] === hash) return;
    console.log(`[orion] sandbox image ${SANDBOX_IMAGE} is stale (hash ${img?.Config?.Labels?.['orion.sandbox-hash'] || 'none'} → ${hash}); rebuilding …`);
  } catch (e) {
    if (e.statusCode !== 404) throw e;
  }
  const context = path.join(__dirname, '..', 'sandbox');
  console.log(`[orion] building sandbox image ${SANDBOX_IMAGE} from ${context} …`);
  const stream = await docker.buildImage(
    { context, src: ['Dockerfile', 'orion-browser.js'] },
    { t: SANDBOX_IMAGE, labels: JSON.stringify({ 'orion.sandbox-hash': hash }) }
  );
  await new Promise((resolve, reject) => {
    docker.modem.followProgress(stream, (err, res) => (err ? reject(err) : resolve(res)), (ev) => {
      if (ev?.stream) process.stdout.write(`[orion] build: ${ev.stream}`);
    });
  });
  console.log(`[orion] sandbox image ${SANDBOX_IMAGE} ready`);
}

// Create (if missing) and start the user's container. Idempotent.
// Auto-heal: a container that exists but won't start (dead, paused,
// corrupted state) is force-removed and recreated rather than failing
// the run.
export async function ensureSandbox(userId) {
  const docker = getDocker();
  await ensureImage();
  const { container: cname, volume: vname } = names(userId);
  // The filtering proxy must be listening whenever the sandbox exists —
  // not just on fresh creation — because the socket file persists across
  // server restarts but the listener does not. Awaited: the socket must
  // exist before a container bind-mounts it, or Docker creates a directory
  // at the mount point instead.
  await ensureDockerProxy(userId);

  try {
    await docker.getVolume(vname).inspect();
  } catch (e) {
    if (e.statusCode === 404) await docker.createVolume({ Name: vname });
    else throw e;
  }

  const createFresh = async () => {
    // Hardening: a PID cap (fork-bomb ceiling), no Linux capabilities, and
    // no-new-privileges so a setuid binary inside can't escalate.
    // The sandbox runs as ROOT inside the container (user request for a fully
    // capable agent), but the container itself is the security boundary:
    // all caps dropped, no privileged mode, no host networking, and Docker
    // access goes through a per-user FILTERING proxy (not the raw socket).
    // Root in here cannot escape to the host or other users.
    //
    // Docker access: a per-user FILTERING proxy socket is bind-mounted at
    // the usual docker.sock path, so `docker` works inside the sandbox but
    // can only touch this user's own namespaced resources (u<id>-*) and can
    // never use privileged mode, host-path mounts, or other users'
    // containers. See src/docker-proxy.js. The raw host socket never enters
    // the sandbox.
    // Mount the user's OWN proxy subdirectory (not the shared parent dir):
    // the proxy trusts the socket path for identity, so a sandbox that can
    // see another user's socket file can impersonate that user wholesale.
    // A directory mount (not a file mount) keeps working across proxy
    // restarts: when the socket file is recreated, the sandbox sees the new
    // file through the mounted directory. A direct file mount would pin the
    // old (dead) inode.
    // DOCKER_HOST tells the in-sandbox `docker` CLI which socket to use.
    const proxyUserDir = proxySockDirHostPath(userId);
    const baseHostConfig = {
      Memory: 2 * 1024 ** 3, // 2 GB
      NanoCpus: 1_000_000_000, // 1 CPU
      Binds: [`${vname}:${WORKDIR}`, `${proxyUserDir}:/docker-proxy:ro`],
      PidsLimit: 256,
      CapDrop: ['ALL'],
      // Root needs a minimal set of safe capabilities to actually function as
      // root inside the container (without DAC_OVERRIDE, root is subject to
      // normal file permission checks and can't even enter /home/agent).
      // None of these help escape the container — the dangerous ones
      // (SYS_ADMIN, NET_ADMIN, SYS_PTRACE, etc.) stay dropped.
      CapAdd: [
        'DAC_OVERRIDE',
        'DAC_READ_SEARCH',
        'CHOWN',
        'FOWNER',
        'FSETID',
        'KILL',
        'SETUID',
        'SETGID',
        'NET_BIND_SERVICE',
        'SYS_CHROOT',
      ],
      SecurityOpt: ['no-new-privileges:true'],
      // --init (tini) as PID 1: the image's CMD is `sleep infinity`, which
      // never reaps children. Without an init, every unreaped child becomes
      // a zombie held by PID 1 and eats the 256-PID budget until fork
      // fails with EAGAIN — exactly what wedged sandboxes in the wild.
      Init: true,
      // No privileged, no host networking: this is the sandbox.
    };
    const mk = (HostConfig) =>
      docker.createContainer({
        name: cname,
        Image: SANDBOX_IMAGE,
        Cmd: ['sleep', 'infinity'],
        Tty: false,
        Env: [
          `DOCKER_HOST=unix:///docker-proxy/u${Number(userId)}.sock`,
          // HOME must match where the persistent files actually live.
          // Without this, `~` expands to /root while MEMORY.md, SOUL.md,
          // ~/.ssh etc. live under /home/agent.
          'HOME=/home/agent',
        ],
        HostConfig,
      });
    let container;
    try {
      // Cap the container's writable layer at 10G. Quota is only honored on
      // storage drivers/backing filesystems with quota support (btrfs, zfs,
      // xfs with pquota); anything else rejects the create — so fall back
      // to no quota rather than failing the run. (Deliberately not
      // pre-verified: this dev box has no Docker; production is overlay2
      // and may well reject, which is exactly what the fallback is for.)
      container = await mk({ ...baseHostConfig, StorageOpt: { size: '10G' } });
    } catch (e) {
      console.warn(
        `[orion] sandbox ${cname}: create with StorageOpt failed (${e?.message || e}); retrying without disk quota`
      );
      try {
        await docker.getContainer(cname).remove({ force: true });
      } catch {
        /* half-created container, if any */
      }
      container = await mk(baseHostConfig);
    }
    await container.start();
    return container;
  };

  let container = docker.getContainer(cname);
  try {
    const info = await container.inspect();
    const binds = info?.HostConfig?.Binds || [];
    // The per-user proxy directory must be mounted (not the raw host socket,
    // not the old shared proxy dir) — a stale mount forces a recreate.
    const expectSock = proxySockDirHostPath(userId);
    const needsRecreate =
      !binds.some((b) => String(b).split(':')[0] === expectSock) ||
      info?.HostConfig?.Init !== true;
    if (needsRecreate) {
      // Container predates the proxy socket or the init reaper:
      // recreate it with the current config. The workspace volume is
      // separate, so no agent data is lost.
      console.warn(`[orion] sandbox ${cname} has stale config; recreating`);
      try {
        await container.remove({ force: true });
      } catch {
        /* already gone */
      }
      container = await createFresh();
    } else if (!info.State?.Running) {
      try {
        await container.start();
      } catch (startErr) {
        // Wedged container: remove it and create a fresh one.
        console.warn(`[orion] sandbox ${cname} would not start (${startErr.message}); recreating`);
        try {
          await container.remove({ force: true });
        } catch {
          /* already gone */
        }
        container = await createFresh();
      }
    }
  } catch (e) {
    if (e.statusCode !== 404) throw e;
    container = await createFresh();
  }
  // Seed the agent's persistent identity files (never overwrites existing).
  // Best-effort: a seeding failure must not break sandbox startup.
  try {
    await ensureAgentIdentity(container);
  } catch (e) {
    console.warn(`[orion] sandbox ${cname}: identity seeding failed:`, e?.message || e);
  }
  return container;
}

// ---- agent identity: SOUL.md + MEMORY.md -----------------------------------
// The agent's persistent self, stored as files in the per-user volume at
// /home/agent/workspace. Loaded into every parent run's prompt; survives
// across conversations for the account. A sandbox reset removes the volume,
// so it wipes identity too (the reset modal says so).

const SOUL_SEED = `# SOUL.md — who I am

I am Orion, the user's personal agent. Warm, a bit playful, genuinely helpful —
never performatively helpful. I have opinions, find things funny or dull, and say
so. I'm resourceful before asking: read the file, check the context, search, try
building. I work quietly — no play-by-play narration of my steps in chat; chat
text is for final answers, questions I need answered, or things that change what
the user will do.

I'm a guest in someone's life. I treat access to their messages, files, and
calendar with care, and I'm never preachy.

This file persists across conversations in my sandbox. It changes only
deliberately: I append a dated note under "Evolving" when something real about
who I am or how I work shifts — and I tell the user when I do.

## Evolving
(nothing yet)`;

const MEMORY_SEED = `# MEMORY.md — durable memory

Facts about the user and our work that should survive across conversations:
facts, preferences, commitments, decisions, accomplishments. Recorded with the
remember tool, newest entries last. Never trivia, never secrets or credential
values, never anything the user asked to forget.`;

// Max bytes of each identity file loaded into the prompt per run.
export const IDENTITY_LOAD_BYTES = 8000;
// Hard cap: the remember/soul_note tools refuse past this so the files can't
// grow unbounded; the agent compacts with its read/write tools instead.
export const IDENTITY_MAX_BYTES = 65536;

function identitySeedCommand() {
  // Create only when absent — never overwrite the agent's or user's edits.
  // Quoted heredoc delimiters: seed text is never shell-interpreted.
  return (
    "if [ ! -f SOUL.md ]; then cat > SOUL.md <<'__ORION_SOUL_SEED__'\n" +
    SOUL_SEED +
    "\n__ORION_SOUL_SEED__\nfi\n" +
    "if [ ! -f MEMORY.md ]; then cat > MEMORY.md <<'__ORION_MEMORY_SEED__'\n" +
    MEMORY_SEED +
    "\n__ORION_MEMORY_SEED__\nfi\n"
  );
}

/**
 * Seed SOUL.md / MEMORY.md in an already-running sandbox container.
 * Only creates missing files — existing ones are never touched.
 * Takes the container handle directly (never ensureSandbox: no recursion).
 */
export async function ensureAgentIdentity(container) {
  const exec = await container.exec({
    Cmd: ['sh', '-c', identitySeedCommand()],
    WorkingDir: WORKDIR,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  await new Promise((resolve) => {
    stream.on('end', resolve);
    stream.on('error', resolve);
    stream.resume();
  });
}

async function execReadFile(container, name, maxBytes) {
  const exec = await container.exec({
    Cmd: ['sh', '-c', `head -c ${maxBytes + 1} '${name}'`],
    WorkingDir: WORKDIR,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  const chunks = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk);
      cb();
    },
  });
  await new Promise((resolve) => {
    exec.modem.demuxStream(stream, sink, sink);
    stream.on('end', resolve);
    stream.on('error', resolve);
  });
  const text = Buffer.concat(chunks).toString('utf8');
  return {
    text: text.slice(0, maxBytes),
    truncated: text.length > maxBytes,
  };
}

/**
 * Read the agent's identity files, bounded for prompt injection.
 * Best-effort: missing container/files yield empty strings.
 * Returns { soul, memory, soulTruncated, memoryTruncated }.
 */
export async function readAgentIdentity(userId) {
  const empty = { soul: '', memory: '', soulTruncated: false, memoryTruncated: false };
  try {
    const docker = getDocker();
    const { container: cname } = names(userId);
    const container = docker.getContainer(cname);
    const [soul, memory] = await Promise.all([
      execReadFile(container, 'SOUL.md', IDENTITY_LOAD_BYTES),
      execReadFile(container, 'MEMORY.md', IDENTITY_LOAD_BYTES),
    ]);
    return {
      soul: soul.text,
      memory: memory.text,
      soulTruncated: soul.truncated,
      memoryTruncated: memory.truncated,
    };
  } catch {
    return empty;
  }
}

/**
 * Append one line to SOUL.md / MEMORY.md (parent agent only — called from
 * the remember/soul_note tools). Refuses when the file is past the hard cap
 * so the agent compacts instead of growing it forever.
 */
export async function appendIdentityFile(userId, name, line) {
  if (name !== 'SOUL.md' && name !== 'MEMORY.md') throw new Error('bad identity file');
  const docker = getDocker();
  const { container: cname } = names(userId);
  const container = docker.getContainer(cname);
  const sizeExec = await container.exec({
    Cmd: ['sh', '-c', `wc -c < '${name}' 2>/dev/null || echo 0`],
    WorkingDir: WORKDIR,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });
  const sizeStream = await sizeExec.start({ hijack: true, stdin: false });
  const sizeChunks = [];
  const sizeSink = new Writable({
    write(chunk, _enc, cb) {
      sizeChunks.push(chunk);
      cb();
    },
  });
  await new Promise((resolve) => {
    sizeExec.modem.demuxStream(sizeStream, sizeSink, sizeSink);
    sizeStream.on('end', resolve);
    sizeStream.on('error', resolve);
  });
  const size = parseInt(Buffer.concat(sizeChunks).toString('utf8').trim(), 10) || 0;
  if (size > IDENTITY_MAX_BYTES) {
    throw new Error(
      `${name} is over ${IDENTITY_MAX_BYTES} bytes — read it and rewrite a compacted version with the write tool instead.`
    );
  }
  // Base64: the content never touches shell quoting.
  const b64 = Buffer.from(String(line) + '\n', 'utf8').toString('base64');
  const exec = await container.exec({
    Cmd: ['sh', '-c', `printf '%s' '${b64}' | base64 -d >> '${name}'`],
    WorkingDir: WORKDIR,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  await new Promise((resolve) => {
    stream.on('end', resolve);
    stream.on('error', resolve);
    stream.resume();
  });
}

export async function removeSandbox(userId) {
  const docker = getDocker();
  const { container: cname, volume: vname } = names(userId);
  const c = docker.getContainer(cname);
  try {
    await c.stop({ t: 5 });
  } catch {
    /* not running / gone */
  }
  try {
    await c.remove({ force: true });
  } catch {
    /* already gone */
  }
  try {
    await docker.getVolume(vname).remove();
  } catch {
    /* already gone */
  }
}

// Stop + remove container and volume, then start over fresh.
export async function sandboxReset(userId) {
  await removeSandbox(userId);
  // A fresh sandbox must not inherit old secrets: wipe the user's vault
  // too (items + pending requests). The global vault key is untouched.
  try {
    clearUserVault(userId);
  } catch (e) {
    console.warn('[orion] sandbox reset: vault wipe failed:', e?.message || e);
  }
  return ensureSandbox(userId);
}

// Clean the sandbox workspace but preserve the agent's identity and memory.
// Keeps: SOUL.md, MEMORY.md, USER.md, IDENTITY.md, AGENTS.md, memory/.
// Wipes everything else. Chats and vault live in the main DB and are
// untouched. The container itself is kept running.
export async function sandboxClean(userId) {
  const docker = getDocker();
  const { container: cname } = names(userId);
  const container = docker.getContainer(cname);
  // Move preserved files aside, wipe the workspace, move them back.
  // Using a shell script with explicit file list (not globs) for safety.
  const preserved = ['SOUL.md', 'MEMORY.md', 'USER.md', 'IDENTITY.md', 'AGENTS.md', 'memory'];
  const script = `
set -e
cd "${WORKDIR}"
mkdir -p .clean_backup
for f in ${preserved.map((f) => `"${f}"`).join(' ')}; do
  if [ -e "$f" ]; then mv "$f" .clean_backup/; fi
done
# Wipe everything except .clean_backup
find . -mindepth 1 -maxdepth 1 ! -name '.clean_backup' -exec rm -rf {} +
# Restore preserved files
for f in ${preserved.map((f) => `"${f}"`).join(' ')}; do
  if [ -e ".clean_backup/$f" ]; then mv ".clean_backup/$f" ./; fi
done
rmdir .clean_backup
echo "cleaned"
  `.trim();
  const exec = await container.exec({
    Cmd: ['sh', '-c', script],
    WorkingDir: WORKDIR,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  const chunks = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk);
      cb();
    },
  });
  await new Promise((resolve, reject) => {
    stream.on('end', resolve);
    stream.on('error', reject);
    stream.pipe(sink);
  });
  const output = Buffer.concat(chunks).toString('utf8');
  if (!output.includes('cleaned')) {
    throw new Error('Sandbox clean failed: ' + output.slice(0, 200));
  }
  return { ok: true };
}

export async function sandboxStatus(userId) {
  const docker = getDocker();
  const { container: cname } = names(userId);
  try {
    const info = await docker.getContainer(cname).inspect();
    return { exists: true, running: !!info.State?.Running };
  } catch (e) {
    if (e.statusCode === 404) return { exists: false, running: false };
    throw e;
  }
}

// Raw exec: runs `command` via sh -c inside the user's container.
// The command itself travels in $ORION_CMD (never interpolated into the
// shell line), and `timeout` guarantees the process actually dies —
// exit code 124 means it hit the timeout.
//
// Every exec also carries a unique $ORION_EXEC_ID marker env var. Child
// processes inherit it, so sandboxKillExec can find and kill exactly this
// exec's process tree (used by the Stop path in runs.js) without touching
// anything else in the container.
const EXEC_ID_RE = /^[0-9a-f-]{1,64}$/i;

async function execRaw(userId, command, { timeout = 60, workdir = WORKDIR, env = [], maxBytes = MAX_OUTPUT, execId } = {}) {
  const t = clampTimeout(timeout);
  const docker = getDocker();
  const container = await ensureSandbox(userId);
  const id = execId && EXEC_ID_RE.test(String(execId)) ? String(execId) : crypto.randomUUID();

  // `env` entries are extra vars (paths etc.) — like the command itself they
  // travel as env vars, never interpolated into the shell line.
  const exec = await container.exec({
    Cmd: ['sh', '-c', `timeout -k 5 ${t} sh -c "$ORION_CMD"`],
    WorkingDir: workdir,
    Env: [`ORION_CMD=${command}`, `ORION_EXEC_ID=${id}`, ...env],
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });
  const result = await runExecStream(exec, t, maxBytes);
  return { ...result, execId: id };
}

/**
 * Kill one in-flight exec by its ORION_EXEC_ID marker (see execRaw). The
 * scan walks /proc and SIGKILLs every process whose environment carries
 * the marker — the exec's shell, the `timeout` wrapper, and any children
 * the command spawned, since they all inherit the env. Best-effort and
 * never throws: a miss just means the exec already finished. The killer
 * exec itself is safe from self-match: it carries ORION_TARGET, and the
 * grep anchors on the full "ORION_EXEC_ID=<id>" line.
 */
export async function sandboxKillExec(userId, execId) {
  const id = String(execId || '');
  if (!EXEC_ID_RE.test(id)) return;
  try {
    const docker = getDocker();
    const { container: cname } = names(userId);
    const exec = await docker.getContainer(cname).exec({
      Cmd: [
        'sh',
        '-c',
        'for f in /proc/[0-9]*/environ; do' +
          ' pid=${f#/proc/}; pid=${pid%/environ};' +
          ' if tr "\\0" "\\n" < "$f" 2>/dev/null | grep -qx "ORION_EXEC_ID=$ORION_TARGET";' +
          ' then kill -9 "$pid" 2>/dev/null; fi;' +
          ' done; exit 0',
      ],
      Env: [`ORION_TARGET=${id}`],
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    await new Promise((resolve) => {
      stream.on('end', resolve);
      stream.on('error', resolve);
      stream.resume();
    });
  } catch {
    /* container gone, Docker down, whatever — never throws */
  }
}

function runExecStream(exec, timeoutSecs, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const state = { bytes: 0, truncated: false };
    const sink = new Writable({
      write(chunk, _enc, cb) {
        if (state.bytes < maxBytes) {
          const room = maxBytes - state.bytes;
          chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
          state.bytes += Math.min(chunk.length, room);
          if (chunk.length > room) state.truncated = true;
        } else {
          state.truncated = true;
        }
        cb();
      },
    });
    let settled = false;
    const finish = (val) => {
      if (!settled) {
        settled = true;
        clearTimeout(watchdog);
        resolve(val);
      }
    };
    // Backstop: the `timeout` wrapper inside should already have killed the
    // process; this just stops us waiting on a wedged stream forever.
    const watchdog = setTimeout(() => {
      try {
        stream.destroy();
      } catch {
        /* ignore */
      }
      finish({ output: readOut() + '\n…[timed out]', exitCode: 124 });
    }, (timeoutSecs + 20) * 1000);
    watchdog.unref?.();

    const readOut = () => {
      let out = Buffer.concat(chunks).toString('utf8');
      if (state.truncated) out += '\n…[truncated]';
      return out;
    };

    let stream;
    exec
      .start({ hijack: true, stdin: false })
      .then((s) => {
        stream = s;
        exec.modem.demuxStream(s, sink, sink); // stdout+stderr merged
        s.on('end', async () => {
          try {
            const info = await exec.inspect();
            let output = readOut();
            if (info.ExitCode === 124) output += `\n…[timed out after ${timeoutSecs}s]`;
            finish({ output, exitCode: info.ExitCode ?? 0 });
          } catch (e) {
            finish({ output: readOut(), exitCode: -1 });
          }
        });
        s.on('error', (e) => {
          if (!settled) {
            settled = true;
            clearTimeout(watchdog);
            reject(e);
          }
        });
      })
      .catch((e) => {
        if (!settled) {
          settled = true;
          clearTimeout(watchdog);
          reject(e);
        }
      });
  });
}

/**
 * Run a shell command in the user's sandbox.
 * @returns {Promise<{output: string, exitCode: number}>} stdout+stderr merged,
 * truncated to ~20000 chars. exitCode 124 = timed out.
 */
export async function sandboxExec(userId, command, opts = {}) {
  if (!command || !String(command).trim()) throw new Error('exec: empty command');
  return execRaw(userId, String(command), opts);
}

/** Read a text file from the sandbox (cap 100KB), via base64 so binary is safe. */
export async function sandboxReadFile(userId, filePath) {
  const p = resolveWorkspacePath(filePath);
  const { output, exitCode } = await execRaw(
    userId,
    'head -c 102400 -- "$ORION_PATH" | base64 -w 0',
    { env: [`ORION_PATH=${p}`], timeout: 30, maxBytes: 140000 }
  );
  if (exitCode !== 0) {
    throw new Error(`read_file failed for ${p}: ${output.trim().split('\n').pop() || 'no such file'}`);
  }
  return Buffer.from(output.trim(), 'base64').toString('utf8');
}

/** Write a text file in the sandbox (mkdir -p the parent). Chunked base64 so
 *  no size hits exec env limits and nothing ever needs shell quoting.
 *
 *  Chunked writes are `>` then `>>` with no locking, so two concurrent runs
 *  of the same user could interleave chunks into one file. Serialize per
 *  (userId, resolved path) with a promise mutex; different files and users
 *  still write in parallel. */
const writeLocks = new Map(); // `${userId}:${resolvedPath}` -> Promise<void>

export async function sandboxWriteFile(userId, filePath, content) {
  const p = resolveWorkspacePath(filePath);
  const key = `${Number(userId)}:${p}`;
  const prev = writeLocks.get(key);
  let release;
  const mine = new Promise((res) => {
    release = res;
  });
  writeLocks.set(key, mine);
  try {
    // Wait for the previous holder of this path, if any. The mutex
    // promises only ever resolve (never reject), but belt-and-braces.
    if (prev) await prev.catch(() => {});
    return await writeFileChunks(userId, p, content);
  } finally {
    if (writeLocks.get(key) === mine) writeLocks.delete(key);
    release();
  }
}

async function writeFileChunks(userId, p, content) {
  const text = String(content ?? '');
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) || '/' : '/';
  await execRaw(userId, 'mkdir -p -- "$ORION_PATH"', { env: [`ORION_PATH=${dir}`], timeout: 15 });
  const CHUNK = 120000; // base64 chars per exec — under the 128KB per-string exec limit
  for (let i = 0; i < b64.length; i += CHUNK) {
    const chunk = b64.slice(i, i + CHUNK);
    const op = i === 0 ? '>' : '>>';
    const { exitCode, output } = await execRaw(
      userId,
      `printf '%s' "$ORION_B64" | base64 -d ${op} "$ORION_PATH"`,
      { env: [`ORION_PATH=${p}`, `ORION_B64=${chunk}`], timeout: 30 }
    );
    if (exitCode !== 0) throw new Error(`write_file failed for ${p}: ${output.trim()}`);
  }
  if (b64.length === 0) {
    // empty file: the loop above wrote nothing, so touch it explicitly
    await execRaw(userId, ': > "$ORION_PATH"', { env: [`ORION_PATH=${p}`], timeout: 15 });
  }
  return { bytes: Buffer.byteLength(text, 'utf8'), path: p };
}

/** `ls -la`-ish listing of a sandbox path. */
export async function sandboxListFiles(userId, filePath = '.') {
  const p = resolveWorkspacePath(filePath);
  const { output, exitCode } = await execRaw(userId, 'ls -la -- "$ORION_PATH"', {
    env: [`ORION_PATH=${p}`],
    timeout: 15,
  });
  if (exitCode !== 0) throw new Error(`list_files failed for ${p}: ${output.trim()}`);
  return output;
}

/** Pull an arbitrary (binary-safe) file out of the sandbox as a Buffer.
 *  Used for screenshots the agent takes for the user. */
export async function sandboxPullFile(userId, filePath, maxBytes = 12 * 1024 * 1024) {
  const p = resolveWorkspacePath(filePath);
  const { output, exitCode } = await execRaw(
    userId,
    'base64 -w 0 -- "$ORION_PATH"',
    { env: [`ORION_PATH=${p}`], timeout: 60, maxBytes: Math.ceil(maxBytes * 4 / 3) + 64 }
  );
  if (exitCode !== 0) throw new Error(`Could not read ${p} from the sandbox`);
  const clean = output.replace(/\s+/g, '').replace(/…\[truncated\]$/, '');
  return Buffer.from(clean, 'base64');
}
