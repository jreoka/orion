// Orion server: express app. Auth, conversations, SSE agent chat, sandbox
// management, file serving, and the admin panel API.
import express from 'express';
import cookieParser from 'cookie-parser';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, getSetting, setSetting, DATA_DIR } from './db.js';
import {
  signup,
  login,
  createSession,
  destroySession,
  requireAuth,
  requireAdmin,
  setSessionCookie,
  clearSessionCookie,
  hashPassword,
  httpError,
  COOKIE_NAME,
} from './auth.js';
import { runAgent } from './agent.js';
import { ensureImage, sandboxStatus, sandboxReset, removeSandbox } from './sandbox.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

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
  const user = login(req.body?.username, req.body?.password);
  setSessionCookie(res, createSession(user.id));
  res.json(user);
}));

app.post('/api/auth/logout', (req, res) => {
  destroySession(req.cookies?.[COOKIE_NAME]);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json(req.user);
});

app.patch('/api/auth/me', requireAuth, asyncRoute(async (req, res) => {
  const { password } = req.body || {};
  if (password !== undefined) {
    if (String(password).length < 8) throw httpError(400, 'Password must be at least 8 characters');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), req.user.id);
  }
  res.json({ ok: true });
}));

// ---- conversations --------------------------------------------------------

function getConv(id, userId) {
  return db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(id, userId);
}

app.get('/api/conversations', requireAuth, (req, res) => {
  const rows = db
    .prepare('SELECT id, title, created_at, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC')
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
  // The client sees user/assistant turns only; the agent replays tool rows
  // from the DB directly when it needs context.
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
    }));
  res.json({
    conversation: { id: conv.id, title: conv.title, created_at: conv.created_at, updated_at: conv.updated_at },
    messages,
  });
});

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

// ---- agent chat (SSE) -----------------------------------------------------

app.post('/api/conversations/:id/messages', requireAuth, asyncRoute(async (req, res) => {
  const conv = getConv(req.params.id, req.user.id);
  if (!conv) return res.status(404).json({ error: 'Not found' });
  const content = String(req.body?.content || '').trim();
  if (!content) throw httpError(400, 'Empty message');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // don't let proxies buffer the stream
  });
  const emit = (type, data) => {
    try {
      res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      /* client gone */
    }
  };

  let aborted = false;
  const controller = new AbortController();
  // NOTE: listen on res, not req — req 'close' fires as soon as the (small)
  // request body is consumed, which is not a disconnect. res 'close' with an
  // unfinished response means the client actually went away.
  res.on('close', () => {
    if (!res.writableEnded) {
      aborted = true;
      controller.abort(); // aborts the in-flight LLM fetch ASAP
    }
  });

  const settings = {
    base_url: getSetting('base_url', ''),
    api_key: getSetting('api_key', ''),
    model: getSetting('model', ''),
  };

  try {
    await runAgent({
      userId: req.user.id,
      conversationId: conv.id,
      userText: content,
      settings,
      emit,
      shouldAbort: () => aborted,
      signal: controller.signal,
    });
    if (!aborted) emit('done', {});
  } catch (e) {
    // runAgent handles agent errors itself; this is the backstop.
    if (!aborted) emit('error', { message: e?.message || 'Something went wrong' });
  }
  res.end();
}));

// ---- sandbox --------------------------------------------------------------

app.get('/api/sandbox/status', requireAuth, asyncRoute(async (req, res) => {
  res.json(await sandboxStatus(req.user.id));
}));

app.post('/api/sandbox/reset', requireAuth, asyncRoute(async (req, res) => {
  await sandboxReset(req.user.id);
  res.json({ ok: true });
}));

// ---- files ----------------------------------------------------------------

app.get('/api/files/:id', requireAuth, (req, res) => {
  const att = db
    .prepare(
      `SELECT a.* FROM attachments a
       JOIN messages m ON m.id = a.message_id
       JOIN conversations c ON c.id = m.conversation_id
       WHERE a.id = ? AND c.user_id = ?`
    )
    .get(req.params.id, req.user.id);
  if (!att) return res.status(404).json({ error: 'Not found' });
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
      `SELECT u.id, u.username, u.role, u.disabled, u.created_at, COUNT(m.id) AS message_count
       FROM users u
       LEFT JOIN conversations c ON c.user_id = u.id
       LEFT JOIN messages m ON m.conversation_id = c.id
       GROUP BY u.id ORDER BY u.id`
    )
    .all();
  res.json(rows);
});

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
    if (disabled) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id); // log them out now
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

const PORT = process.env.PORT || 3000;
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  app.listen(PORT, () => console.log(`[orion] listening on :${PORT}`));
}

export default app;
