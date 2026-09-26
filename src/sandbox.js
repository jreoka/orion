// Orion sandboxes: one Docker container per user, via dockerode.
// Container:  orion-u<userId>        (names derive from the numeric id only)
// Volume:     orion-u<userId>-data   mounted at /home/agent/workspace
// Image:      orion-sandbox:latest   (built from ./sandbox on first use)
//
// If /var/run/docker.sock is missing, every function throws a clear
// "Docker not available" error instead of crashing the server.
import Docker from 'dockerode';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

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

// Build the sandbox image from ./sandbox if it isn't there yet.
export async function ensureImage() {
  const docker = getDocker();
  try {
    await docker.getImage(SANDBOX_IMAGE).inspect();
    return;
  } catch (e) {
    if (e.statusCode !== 404) throw e;
  }
  const context = path.join(__dirname, '..', 'sandbox');
  console.log(`[orion] building sandbox image ${SANDBOX_IMAGE} from ${context} …`);
  const stream = await docker.buildImage(
    { context, src: ['Dockerfile', 'orion-browser.js'] },
    { t: SANDBOX_IMAGE }
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

  try {
    await docker.getVolume(vname).inspect();
  } catch (e) {
    if (e.statusCode === 404) await docker.createVolume({ Name: vname });
    else throw e;
  }

  const createFresh = async () => {
    const container = await docker.createContainer({
      name: cname,
      Image: SANDBOX_IMAGE,
      Cmd: ['sleep', 'infinity'],
      Tty: false,
      HostConfig: {
        Memory: 2 * 1024 ** 3, // 2 GB
        NanoCpus: 1_000_000_000, // 1 CPU
        Binds: [`${vname}:${WORKDIR}`],
        // No privileged, no extra caps, no host networking: this is the sandbox.
      },
    });
    await container.start();
    return container;
  };

  let container = docker.getContainer(cname);
  try {
    const info = await container.inspect();
    if (!info.State?.Running) {
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
  return container;
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
  return ensureSandbox(userId);
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
async function execRaw(userId, command, { timeout = 60, workdir = WORKDIR, env = [], maxBytes = MAX_OUTPUT } = {}) {
  const t = clampTimeout(timeout);
  const docker = getDocker();
  const container = await ensureSandbox(userId);

  // `env` entries are extra vars (paths etc.) — like the command itself they
  // travel as env vars, never interpolated into the shell line.
  const exec = await container.exec({
    Cmd: ['sh', '-c', `timeout -k 5 ${t} sh -c "$ORION_CMD"`],
    WorkingDir: workdir,
    Env: [`ORION_CMD=${command}`, ...env],
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });
  return runExecStream(exec, t, maxBytes);
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
 *  no size hits exec env limits and nothing ever needs shell quoting. */
export async function sandboxWriteFile(userId, filePath, content) {
  const p = resolveWorkspacePath(filePath);
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
