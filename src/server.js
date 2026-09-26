// Orion server: express app. Auth, conversations, SSE agent chat, sandbox
// management, file serving, and the admin panel API.
import express from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, getSetting, setSetting, DATA_DIR, getOrCreateMainConversation, groupedReactions, normalizeEmoji, setReaction } from './db.js';
import {
  signup,
  loginStep1,
  createSession,
  destroySession,
  requireAuth,
  requireAdmin,
  setSessionCookie,
  clearSessionCookie,
  hashPassword,
  verifyPassword,
  listSessions,
  revokeSession,
  revokeOtherSessions,
  httpError,
  COOKIE_NAME,
} from './auth.js';
import {
  beginTotpSetup,
  confirmTotpSetup,
  disableTotp,
  getTotpStatus,
  totpEnabled,
  verifySecondFactor,
  consumeLoginChallenge,
} from './totp.js';
import {
  registrationOptions,
  verifyRegistration,
  authenticationOptions,
  verifyAuthentication,
  listPasskeys,
  deletePasskey,
} from './passkey.js';
import { publish, subscribe, unsubscribe } from './events.js';
import { runConversation, startRunIfIdle, abortRun } from './runs.js';
import { isRunLocked, requestStop } from './runlock.js';
import {
  validateTaskInput,
  publicTask,
  fireTask,
  scheduleTask,
  unscheduleTask,
  initTasks,
} from './tasks.js';
import {
  initHeartbeat,
} from './heartbeat.js';
import { ensureImage, sandboxStatus, sandboxReset, removeSandbox } from './sandbox.js';
import { checkUserMessage } from './abuse.js';
import {
  getVapidPublicKey,
  saveSubscription,
  deleteSubscription,
  listSubscriptions,
} from './push.js';
import {
  getWeeklyUsage,
  setWeeklyLimit,
  resetWeeklyUsage,
  allWeeklyUsage,
} from './usage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders(res, filePath) {
    // App code and the service worker must revalidate every load so deploys
    // take effect without a hard refresh. Icons are immutable build assets.
    if (/\.(html|js|css)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }
  },
}));

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---- auth ---------------------------------------------------------------

app.post('/api/auth/signup', asyncRoute(async (req, res) => {
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (userCount > 0 && getSetting('signup_enabled', '1') !== '1') {
    throw httpError(403, 'Sign-ups are disabled');
  }
  const user = signup(req.body?.username, req.body?.password);
  setSessionCookie(res, createSession(user.id));
  res.json(user);
}));

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const result = loginStep1(req.body?.username, req.body?.password);
  if (result.need_2fa) {
    // No cookie yet — the second factor completes the login.
    return res.json({ need_2fa: true, challenge: result.challenge });
  }
  setSessionCookie(res, createSession(result.user.id));
  res.json(result.user);
}));

app.post('/api/auth/logout', (req, res) => {
  destroySession(req.cookies?.[COOKIE_NAME]);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const row = db.prepare('SELECT avatar_path FROM users WHERE id = ?').get(req.user.id);
  let avatarUrl = null;
  if (row?.avatar_path) {
    // mtime cache-buster so a fresh upload never shows the stale image.
    try {
      const v = fs.statSync(path.resolve(DATA_DIR, row.avatar_path)).mtimeMs.toString(36);
      avatarUrl = '/api/avatar?v=' + v;
    } catch { avatarUrl = '/api/avatar'; }
  }
  res.json({ ...req.user, avatar_url: avatarUrl });
});

app.patch('/api/auth/me', requireAuth, asyncRoute(async (req, res) => {
  const { password, current_password } = req.body || {};
  if (password !== undefined) {
    if (!verifyPassword(req.user.id, current_password || '')) {
      throw httpError(403, 'Current password is incorrect.');
    }
    if (String(password).length < 8) throw httpError(400, 'Password must be at least 8 characters');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), req.user.id);
  }
  res.json({ ok: true });
}));

// ---- two-factor auth (TOTP) ------------------------------------------------

app.get('/api/auth/2fa/status', requireAuth, (req, res) => {
  res.json(getTotpStatus(req.user.id));
});

app.post('/api/auth/2fa/setup', requireAuth, asyncRoute(async (req, res) => {
  // The secret is returned ONCE here; afterwards only the hash is stored.
  res.json(beginTotpSetup(req.user.id));
}));

app.post('/api/auth/2fa/confirm', requireAuth, asyncRoute(async (req, res) => {
  // Backup codes are returned ONCE here — plaintext never stored.
  res.json(confirmTotpSetup(req.user.id, req.body?.code));
}));

app.post('/api/auth/2fa/disable', requireAuth, asyncRoute(async (req, res) => {
  if (!verifyPassword(req.user.id, req.body?.password)) {
    throw httpError(401, 'Incorrect password');
  }
  disableTotp(req.user.id);
  res.json({ ok: true });
}));

app.post('/api/auth/2fa/verify', asyncRoute(async (req, res) => {
  const userId = consumeLoginChallenge(req.body?.challenge);
  if (!userId) throw httpError(401, 'Login challenge expired — please sign in again');
  const check = verifySecondFactor(userId, req.body?.code);
  if (!check) throw httpError(401, 'Invalid code');
  const row = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(userId);
  setSessionCookie(res, createSession(userId));
  res.json({ id: row.id, username: row.username, role: row.role });
}));

// ---- passkeys ---------------------------------------------------------------

app.post('/api/auth/passkey/register/options', requireAuth, asyncRoute(async (req, res) => {
  res.json(await registrationOptions(req, req.user));
}));

app.post('/api/auth/passkey/register/verify', requireAuth, asyncRoute(async (req, res) => {
  res.json(await verifyRegistration(req, req.user, req.body?.token, req.body?.response, req.body?.name));
}));

app.get('/api/auth/passkeys', requireAuth, (req, res) => {
  res.json(listPasskeys(req.user.id));
});

app.delete('/api/auth/passkeys/:id', requireAuth, asyncRoute(async (req, res) => {
  deletePasskey(req.user.id, Number(req.params.id));
  res.json({ ok: true });
}));

app.post('/api/auth/passkey/login/options', asyncRoute(async (req, res) => {
  res.json(await authenticationOptions(req, req.body?.username));
}));

app.post('/api/auth/passkey/login/verify', asyncRoute(async (req, res) => {
  // A verified passkey is a full login — it bypasses TOTP.
  const user = await verifyAuthentication(req, req.body?.token, req.body?.response);
  setSessionCookie(res, createSession(user.id));
  res.json(user);
}));

// ---- session management -----------------------------------------------------

app.get('/api/auth/sessions', requireAuth, (req, res) => {
  res.json(listSessions(req.user.id, req.sessionId));
});

app.delete('/api/auth/sessions/others', requireAuth, (req, res) => {
  revokeOtherSessions(req.user.id, req.sessionId);
  res.json({ ok: true });
});

app.delete('/api/auth/sessions/:id', requireAuth, (req, res) => {
  const sid = req.params.id;
  revokeSession(req.user.id, sid);
  if (sid === req.sessionId) clearSessionCookie(res); // revoked our own session
  res.json({ ok: true });
});

// ---- conversations --------------------------------------------------------

function getConv(id, userId) {
  return db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(id, userId);
}

// The client sees user/assistant turns only; the agent replays tool rows
// from the DB directly when it needs context.
function conversationPayload(conv) {
  const messages = db
    .prepare(
      `SELECT id, role, content, created_at FROM messages
       WHERE conversation_id = ? AND role != 'tool' ORDER BY id`
    )
    .all(conv.id)
    .map((m) => ({
      ...m,
      attachments: db
        .prepare('SELECT id, filename, mime FROM attachments WHERE message_id = ?')
        .all(m.id)
        .map((a) => ({ id: a.id, filename: a.filename, url: `/api/files/${a.id}` })),
      reactions: groupedReactions(m.id, conv.user_id),
    }));
  return {
    conversation: { id: conv.id, title: conv.title, kind: conv.kind, task_id: conv.task_id, created_at: conv.created_at, updated_at: conv.updated_at },
    messages,
  };
}

// ---- reactions ------------------------------------------------------------
// Emoji reactions on messages: the user taps chips in the UI, the agent uses
// the react_to_message tool. Updates stream live over the conversation bus.

// Message row + its conversation, or null when the message isn't the user's.
function getMessageConv(messageId, userId) {
  return (
    db
      .prepare(
        `SELECT m.id, m.conversation_id FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         WHERE m.id = ? AND c.user_id = ?`
      )
      .get(Number(messageId), userId) || null
  );
}

app.post('/api/messages/:id/reactions', requireAuth, (req, res) => {
  const mc = getMessageConv(req.params.id, req.user.id);
  if (!mc) return res.status(404).json({ error: 'Not found' });
  const emoji = normalizeEmoji(req.body?.emoji);
  if (!emoji) return res.status(400).json({ error: 'Invalid emoji.' });
  const reactions = setReaction(mc.id, req.user.id, emoji, 'user', true);
  publish(mc.conversation_id, { type: 'reaction', message_id: mc.id, reactions });
  res.json({ message_id: mc.id, reactions });
});

app.delete('/api/messages/:id/reactions/:emoji', requireAuth, (req, res) => {
  const mc = getMessageConv(req.params.id, req.user.id);
  if (!mc) return res.status(404).json({ error: 'Not found' });
  const emoji = normalizeEmoji(req.params.emoji); // express already URL-decodes params
  if (!emoji) return res.status(400).json({ error: 'Invalid emoji.' });
  const reactions = setReaction(mc.id, req.user.id, emoji, 'user', false);
  publish(mc.conversation_id, { type: 'reaction', message_id: mc.id, reactions });
  res.json({ message_id: mc.id, reactions });
});

// Single main chat: the only conversation the client ever opens.
app.get('/api/chat', requireAuth, (req, res) => {
  const conv = getConv(getOrCreateMainConversation(req.user.id), req.user.id);
  res.json(conversationPayload(conv));
});

app.get('/api/conversations', requireAuth, (req, res) => {
  const rows = db
    .prepare('SELECT id, title, kind, task_id, created_at, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC')
    .all(req.user.id);
  res.json(rows);
});

app.post('/api/conversations', requireAuth, (req, res) => {
  const now = Date.now();
  const title = String(req.body?.title || 'New chat').slice(0, 120) || 'New chat';
  const info = db
    .prepare('INSERT INTO conversations (user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(req.user.id, title, now, now);
  res.json({ id: Number(info.lastInsertRowid), title, created_at: now, updated_at: now });
});

app.get('/api/conversations/:id', requireAuth, (req, res) => {
  const conv = getConv(req.params.id, req.user.id);
  if (!conv) return res.status(404).json({ error: 'Not found' });
  res.json(conversationPayload(conv));
});

app.patch('/api/conversations/:id', requireAuth, asyncRoute(async (req, res) => {
  const conv = getConv(req.params.id, req.user.id);
  if (!conv) return res.status(404).json({ error: 'Not found' });
  const title = String(req.body?.title || '').trim();
  if (!title || title.length > 120) throw httpError(400, 'Title must be 1–120 characters');
  db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?')
    .run(title, Date.now(), conv.id);
  res.json({ ok: true, title });
}));

function deleteConversationFiles(convId) {
  const dir = path.join(DATA_DIR, 'files', String(convId));
  fs.rmSync(dir, { recursive: true, force: true });
}

app.delete('/api/conversations/:id', requireAuth, (req, res) => {
  const conv = getConv(req.params.id, req.user.id);
  if (!conv) return res.status(404).json({ error: 'Not found' });
  const msgIds = db.prepare('SELECT id FROM messages WHERE conversation_id = ?').all(conv.id).map((m) => m.id);
  if (msgIds.length) {
    const placeholders = msgIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM attachments WHERE message_id IN (${placeholders})`).run(...msgIds);
    db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conv.id);
  }
  db.prepare('DELETE FROM conversations WHERE id = ?').run(conv.id);
  deleteConversationFiles(conv.id);
  res.json({ ok: true });
});

// ---- agent chat (live event stream) ---------------------------------------
// The client opens a long-lived EventSource on :id/events and POSTs messages
// as plain JSON. The server inserts the message, detaches a background run,
// and streams all progress (tokens, tool calls, mid-run updates) over the
// per-conversation event bus. Sending while a run is active is always OK —
// the message is queued and the in-flight run chains a follow-up run.

// Long-lived event stream for a conversation. Sends `hello` on connect and
// a `: ping` comment every 20s (proxies idle-timeout SSE otherwise).
app.get('/api/conversations/:id/events', requireAuth, (req, res) => {
  const conv = getConv(req.params.id, req.user.id);
  if (!conv) return res.status(404).json({ error: 'Not found' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // don't let proxies buffer the stream
  });
  subscribe(conv.id, res);
  res.write(`event: hello\ndata: ${JSON.stringify({ type: 'hello', running: isRunLocked(conv.id) })}\n\n`);

  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* dead connection; its 'close' handler cleans up */
    }
  }, 20000);
  res.on('close', () => {
    clearInterval(ping);
    unsubscribe(conv.id, res);
  });
});

app.post('/api/conversations/:id/messages', requireAuth, asyncRoute(async (req, res) => {
  const conv = getConv(req.params.id, req.user.id);
  if (!conv) return res.status(404).json({ error: 'Not found' });
  const content = String(req.body?.content || '').trim();
  const attachmentIds = Array.isArray(req.body?.attachment_ids)
    ? req.body.attachment_ids.map(Number).filter((n) => Number.isFinite(n)).slice(0, 10)
    : [];
  if (!content && !attachmentIds.length) throw httpError(400, 'Empty message');

  // Persist + publish the user message first. Runs always replay history
  // from the DB, so the insert is the single source of truth.
  const now = Date.now();
  const info = db
    .prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)')
    .run(conv.id, 'user', content, now);
  const messageId = Number(info.lastInsertRowid);
  // Claim this user's staged uploads for the new message.
  if (attachmentIds.length) {
    const ph = attachmentIds.map(() => '?').join(',');
    db.prepare(
      `UPDATE attachments SET message_id = ?, staged = 0
       WHERE id IN (${ph}) AND staged = 1 AND user_id = ?`
    ).run(messageId, ...attachmentIds, req.user.id);
  }
  const attachments = db
    .prepare('SELECT id, filename, mime FROM attachments WHERE message_id = ?')
    .all(messageId)
    .map((a) => ({ id: a.id, filename: a.filename, url: `/api/files/${a.id}` }));
  const message = { id: messageId, role: 'user', content, created_at: now, attachments };
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conv.id);
  publish(conv.id, { type: 'message', message });

  // Abuse screening: the message is already stored (evidence). A positive
  // verdict locks the account and no run starts.
  const abuse = await checkUserMessage(req.user, content);
  if (abuse.locked) {
    publish(conv.id, { type: 'error', message: 'Account locked for abuse — an admin must re-enable it.' });
    publish(conv.id, { type: 'run_ended', status: 'error' });
    return res.json({ message, queued: false, locked: true });
  }

  // A run is already active — the message stays queued; the in-flight run
  // chains a follow-up when it finishes. Never 409: sending mid-run is fine.
  if (!startRunIfIdle(conv.id, req.user.id, content)) {
    publish(conv.id, { type: 'queued' });
    return res.json({ message, queued: true });
  }
  res.json({ message, queued: false });
}));

// Stop the current agent run for a conversation. Sets the stop flag and
// aborts the in-flight LLM fetch; partial text is kept with a
// "(stopped by user)" note. A user message queued while the run was active
// still chains a follow-up run — stop halts the in-flight work, not the
// user's newer intent.
app.post('/api/conversations/:id/stop', requireAuth, (req, res) => {
  const conv = getConv(req.params.id, req.user.id);
  if (!conv) return res.status(404).json({ error: 'Not found' });
  if (!isRunLocked(conv.id)) return res.json({ ok: true, stopped: false });
  requestStop(conv.id);
  abortRun(conv.id);
  res.json({ ok: true, stopped: true });
});

// ---- sandbox --------------------------------------------------------------

app.get('/api/sandbox/status', requireAuth, asyncRoute(async (req, res) => {
  res.json(await sandboxStatus(req.user.id));
}));

app.post('/api/sandbox/reset', requireAuth, asyncRoute(async (req, res) => {
  await sandboxReset(req.user.id);
  res.json({ ok: true });
}));

// ---- full reset -----------------------------------------------------------
// Wipes the main chat (messages + attachment files) AND the sandbox, then
// starts the sandbox fresh. Requires the account password, plus a 2FA code
// when 2FA is enabled.
app.post('/api/reset', requireAuth, asyncRoute(async (req, res) => {
  const { password, totp_code } = req.body || {};
  if (!verifyPassword(req.user.id, password || '')) {
    return res.status(403).json({ error: 'Wrong password.' });
  }
  if (totpEnabled(req.user.id) && !verifySecondFactor(req.user.id, totp_code || '')) {
    return res.status(403).json({ error: 'Wrong two-factor code.' });
  }
  const convId = getOrCreateMainConversation(req.user.id);
  abortRun(convId); // stop any in-flight run before wiping its messages
  const msgIds = db.prepare('SELECT id FROM messages WHERE conversation_id = ?').all(convId).map((m) => m.id);
  if (msgIds.length) {
    const ph = msgIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM attachments WHERE message_id IN (${ph})`).run(...msgIds);
    db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(convId);
  }
  db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run('Main chat', Date.now(), convId);
  deleteConversationFiles(convId);
  // Drop this user's staged (unclaimed) uploads too.
  const stagedPaths = db
    .prepare('SELECT path FROM attachments WHERE staged = 1 AND user_id = ?')
    .all(req.user.id)
    .map((r) => r.path);
  db.prepare('DELETE FROM attachments WHERE staged = 1 AND user_id = ?').run(req.user.id);
  for (const p of stagedPaths) {
    try { fs.rmSync(path.resolve(DATA_DIR, p), { force: true }); } catch { /* gone */ }
  }
  publish(convId, { type: 'chat_cleared' });
  await sandboxReset(req.user.id);
  res.json({ ok: true });
}));

// ---- tasks ----------------------------------------------------------------

app.get('/api/tasks', requireAuth, (req, res) => {
  res.json(
    db.prepare('SELECT * FROM tasks WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id).map(publicTask)
  );
});

app.post('/api/tasks', requireAuth, asyncRoute(async (req, res) => {
  const { name, kind, cron_expr, run_at, prompt } = req.body || {};
  validateTaskInput({ name, kind, cron_expr, run_at, prompt });
  const now = Date.now();
  const info = db
    .prepare(
      'INSERT INTO tasks (user_id, name, kind, cron_expr, run_at, prompt, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)'
    )
    .run(
      req.user.id,
      String(name).trim(),
      kind,
      kind === 'cron' ? cron_expr : null,
      kind === 'once' ? Number(run_at) : null,
      String(prompt),
      now,
      now
    );
  const id = Number(info.lastInsertRowid);
  scheduleTask(id);
  res.json(publicTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)));
}));

app.patch('/api/tasks/:id', requireAuth, asyncRoute(async (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  const next = {
    name: b.name !== undefined ? b.name : task.name,
    kind: b.kind !== undefined ? b.kind : task.kind,
    cron_expr: b.cron_expr !== undefined ? b.cron_expr : task.cron_expr,
    run_at: b.run_at !== undefined ? b.run_at : task.run_at,
    prompt: b.prompt !== undefined ? b.prompt : task.prompt,
    enabled: b.enabled !== undefined ? (b.enabled ? 1 : 0) : task.enabled,
  };
  validateTaskInput(next);
  db.prepare(
    'UPDATE tasks SET name = ?, kind = ?, cron_expr = ?, run_at = ?, prompt = ?, enabled = ?, updated_at = ? WHERE id = ?'
  ).run(
    String(next.name).trim(),
    next.kind,
    next.kind === 'cron' ? next.cron_expr : null,
    next.kind === 'once' ? Number(next.run_at) : null,
    String(next.prompt),
    next.enabled,
    Date.now(),
    task.id
  );
  scheduleTask(task.id); // reschedules (or unschedules) based on the new enabled/kind values
  res.json(publicTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id)));
}));

app.delete('/api/tasks/:id', requireAuth, (req, res) => {
  const info = db.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (!info.changes) return res.status(404).json({ error: 'Not found' });
  unscheduleTask(Number(req.params.id));
  res.json({ ok: true });
});

app.post('/api/tasks/:id/run', requireAuth, asyncRoute(async (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  const convId = getOrCreateMainConversation(req.user.id);
  if (isRunLocked(convId)) {
    throw httpError(409, 'A run is already in progress for this task');
  }
  // Fire in the background; the result accumulates in the task conversation.
  // fireTask re-checks the lock atomically, so a race here degrades to a
  // skipped run, never a double run.
  fireTask(task.id, { manual: true }).catch((e) =>
    console.error(`[orion] manual task ${task.id} failed:`, e?.message || e)
  );
  res.json({ ok: true, conversationId: convId });
}));

// ---- push notifications -----------------------------------------------------
// Web Push (VAPID). The service worker shows incoming pushes; tapping one
// deep-links into the conversation.

app.get('/api/push/vapid-public-key', requireAuth, (req, res) => {
  res.json({ publicKey: getVapidPublicKey() });
});

app.get('/api/push/subscriptions', requireAuth, (req, res) => {
  res.json(
    listSubscriptions(req.user.id).map((s) => ({ endpoint: s.endpoint, created_at: s.created_at }))
  );
});

app.post('/api/push/subscribe', requireAuth, asyncRoute(async (req, res) => {
  saveSubscription(req.user.id, req.body?.subscription);
  res.json({ ok: true });
}));

app.delete('/api/push/unsubscribe', requireAuth, asyncRoute(async (req, res) => {
  deleteSubscription(req.user.id, req.body?.endpoint);
  res.json({ ok: true });
}));

// ---- token usage (self) -------------------------------------------------------

app.get('/api/usage', requireAuth, (req, res) => {
  res.json(getWeeklyUsage(req.user.id));
});

// ---- files ----------------------------------------------------------------
// User uploads land staged (message_id = 0) until a message claims them.

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = path.join(DATA_DIR, 'files', 'uploads', String(req.user.id));
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').slice(0, 12).replace(/[^a-zA-Z0-9.]/g, '');
      cb(null, crypto.randomUUID() + ext);
    },
  }),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB per file
});

function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

app.post('/api/upload', requireAuth, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File is over the 100 MB limit.' : 'Upload failed.';
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: 'No file received.' });
    // Sweep this user's abandoned staged uploads (older than 2 hours).
    const stale = db
      .prepare('SELECT id, path FROM attachments WHERE user_id = ? AND staged = 1 AND created_at < ?')
      .all(req.user.id, Date.now() - 2 * 3600 * 1000);
    for (const s of stale) {
      try { fs.rmSync(path.resolve(DATA_DIR, s.path), { force: true }); } catch { /* gone */ }
      db.prepare('DELETE FROM attachments WHERE id = ?').run(s.id);
    }
    const now = Date.now();
    const info = db
      .prepare(
        `INSERT INTO attachments (message_id, kind, filename, mime, path, size, user_id, staged, created_at)
         VALUES (0, 'upload', ?, ?, ?, ?, ?, 1, ?)`
      )
      .run(
        (req.file.originalname || 'file').slice(0, 255),
        req.file.mimetype || 'application/octet-stream',
        `files/uploads/${req.user.id}/${req.file.filename}`,
        req.file.size,
        req.user.id,
        now
      );
    const id = Number(info.lastInsertRowid);
    res.json({
      id,
      filename: req.file.originalname || 'file',
      mime: req.file.mimetype,
      size: req.file.size,
      url: `/api/files/${id}`,
    });
  });
});

// ---- profile avatar ---------------------------------------------------------
// One image per user, served only to its owner.

const AVATAR_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };

const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = path.join(DATA_DIR, 'files', 'avatars', String(req.user.id));
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      cb(null, crypto.randomUUID() + (AVATAR_EXT[file.mimetype] || '.png'));
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => cb(null, !!AVATAR_EXT[file.mimetype]),
});

function deleteAvatarFile(userId) {
  const row = db.prepare('SELECT avatar_path FROM users WHERE id = ?').get(userId);
  if (row?.avatar_path) {
    try { fs.rmSync(path.resolve(DATA_DIR, row.avatar_path), { force: true }); } catch { /* gone */ }
  }
}

app.post('/api/avatar', requireAuth, (req, res) => {
  avatarUpload.single('avatar')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Image is over the 5 MB limit.' : 'Upload failed.';
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: 'Please choose a PNG, JPEG, GIF, or WebP image.' });
    deleteAvatarFile(req.user.id);
    const rel = `files/avatars/${req.user.id}/${req.file.filename}`;
    db.prepare('UPDATE users SET avatar_path = ? WHERE id = ?').run(rel, req.user.id);
    res.json({ avatar_url: '/api/avatar' });
  });
});

app.get('/api/avatar', requireAuth, (req, res) => {
  const row = db.prepare('SELECT avatar_path FROM users WHERE id = ?').get(req.user.id);
  if (!row?.avatar_path) return res.status(404).json({ error: 'No avatar' });
  const fp = path.resolve(DATA_DIR, row.avatar_path);
  if (!fp.startsWith(path.resolve(DATA_DIR) + path.sep)) return res.status(400).json({ error: 'Bad path' });
  res.sendFile(fp, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'File missing' });
  });
});

app.delete('/api/avatar', requireAuth, (req, res) => {
  deleteAvatarFile(req.user.id);
  db.prepare('UPDATE users SET avatar_path = NULL WHERE id = ?').run(req.user.id);
  res.json({ ok: true });
});

app.get('/api/files/:id', requireAuth, (req, res) => {  const att = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
  if (!att) return res.status(404).json({ error: 'Not found' });
  // Staged uploads belong to the uploader alone; claimed ones follow their
  // message's conversation ownership.
  let allowed = att.staged === 1 && att.user_id === req.user.id;
  if (!allowed && att.message_id) {
    allowed = !!db
      .prepare(
        `SELECT 1 FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         WHERE m.id = ? AND c.user_id = ?`
      )
      .get(att.message_id, req.user.id);
  }
  if (!allowed) return res.status(404).json({ error: 'Not found' });
  const fp = path.resolve(DATA_DIR, att.path);
  if (!fp.startsWith(path.resolve(DATA_DIR) + path.sep)) {
    return res.status(400).json({ error: 'Bad file path' });
  }
  res.type(att.mime || 'application/octet-stream');
  res.set('Content-Disposition', `inline; filename="${(att.filename || 'file').replace(/"/g, '')}"`);
  res.sendFile(fp, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'File missing' });
  });
});

// ---- admin ----------------------------------------------------------------

const ADMIN_SETTING_KEYS = ['provider_name', 'base_url', 'api_key', 'model', 'signup_enabled'];

app.get('/api/admin/settings', requireAdmin, (req, res) => {
  const apiKey = getSetting('api_key', '');
  res.json({
    provider_name: getSetting('provider_name', ''),
    base_url: getSetting('base_url', ''),
    model: getSetting('model', ''),
    signup_enabled: getSetting('signup_enabled', '1'),
    has_key: apiKey.length > 0, // the raw key is never sent to clients
  });
});

app.put('/api/admin/settings', requireAdmin, (req, res) => {
  const body = req.body || {};
  for (const key of ADMIN_SETTING_KEYS) {
    if (body[key] === undefined) continue;
    if (key === 'api_key') {
      // Only overwrite when a non-empty value is sent — the client sends ''
      // when the admin didn't touch the field (it never sees the real key).
      if (String(body[key]).length > 0) setSetting(key, String(body[key]));
    } else if (key === 'signup_enabled') {
      setSetting(key, body[key] === '0' || body[key] === false ? '0' : '1');
    } else {
      setSetting(key, String(body[key]));
    }
  }
  res.json({ ok: true });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const rows = db
    .prepare(
      `SELECT u.id, u.username, u.role, u.disabled, u.abuse_locked, u.abuse_reason,
              u.weekly_token_limit, u.created_at, COUNT(m.id) AS message_count
       FROM users u
       LEFT JOIN conversations c ON c.user_id = u.id
       LEFT JOIN messages m ON m.conversation_id = c.id
       GROUP BY u.id ORDER BY u.id`
    )
    .all();
  res.json(rows);
});

app.get('/api/admin/usage', requireAdmin, (req, res) => {
  res.json(allWeeklyUsage());
});

app.patch('/api/admin/users/:id/limit', requireAdmin, asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: 'Not found' });
  const limit = setWeeklyLimit(id, req.body?.weekly_token_limit ?? null);
  res.json({ ok: true, weekly_token_limit: limit });
}));

app.post('/api/admin/users/:id/usage/reset', requireAdmin, asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: 'Not found' });
  resetWeeklyUsage(id);
  res.json({ ok: true });
}));

app.patch('/api/admin/users/:id', requireAdmin, asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) throw httpError(400, 'You cannot change your own role or status');
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: 'Not found' });
  const { role, disabled } = req.body || {};
  if (role !== undefined) {
    if (!['user', 'admin'].includes(role)) throw httpError(400, 'Invalid role');
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  }
  if (disabled !== undefined) {
    db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, id);
    if (disabled) {
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id); // log them out now
    } else {
      // Re-enabling clears an abuse lock (admins only get here via requireAdmin).
      db.prepare('UPDATE users SET abuse_locked = 0, abuse_reason = NULL, abuse_locked_at = NULL WHERE id = ?').run(id);
    }
  }
  res.json({ ok: true });
}));

app.delete('/api/admin/users/:id', requireAdmin, asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) throw httpError(400, 'You cannot delete yourself');
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: 'Not found' });

  for (const conv of db.prepare('SELECT id FROM conversations WHERE user_id = ?').all(id)) {
    const msgIds = db.prepare('SELECT id FROM messages WHERE conversation_id = ?').all(conv.id).map((m) => m.id);
    if (msgIds.length) {
      const ph = msgIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM attachments WHERE message_id IN (${ph})`).run(...msgIds);
      db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conv.id);
    }
    db.prepare('DELETE FROM conversations WHERE id = ?').run(conv.id);
    deleteConversationFiles(conv.id);
  }
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM tasks WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM user_settings WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM passkey_credentials WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM totp_backup_codes WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM token_usage WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);

  // Best-effort: Docker may be down; the user row is already gone.
  try {
    await removeSandbox(id);
  } catch (e) {
    console.warn(`[orion] could not remove sandbox for deleted user ${id}: ${e.message}`);
  }
  res.json({ ok: true });
}));

// ---- misc -----------------------------------------------------------------

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Errors from httpError carry .status; everything else is a 500.
// Never leak stack traces or secrets to clients.
app.use((err, _req, res, _next) => {
  const status = err?.status || 500;
  if (status >= 500) console.error('[orion]', err);
  res.status(status).json({ error: err?.message || 'Internal error' });
});

// ---- boot -----------------------------------------------------------------

ensureImage()
  .then(() => console.log('[orion] sandbox image ready'))
  .catch((e) => console.warn('[orion] sandbox image not available:', e.message));

// Restore scheduled tasks and start the heartbeat ticker. Neither blocks
// startup; timers are unref'd so they never keep the process alive alone.
try {
  initTasks();
} catch (e) {
  console.warn('[orion] task scheduler failed to start:', e.message);
}
try {
  initHeartbeat();
} catch (e) {
  console.warn('[orion] heartbeat failed to start:', e.message);
}

const PORT = process.env.PORT || 3000;
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  app.listen(PORT, () => console.log(`[orion] listening on :${PORT}`));
}

export default app;
