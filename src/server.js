// Orion server: express app. Auth, conversations, SSE agent chat, sandbox
// management, file serving, and the admin panel API.
import express from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, getSetting, setSetting, DATA_DIR, getOrCreateConversation, groupedReactions, normalizeEmoji, setReaction } from './db.js';
import {
  signup,
  loginStep1,
  createSession,
  destroySession,
  requireAuth,
  requireAdmin,
  getUserBySession,
  setSessionCookie,
  clearSessionCookie,
  hashPassword,
  checkPasswordRules,
  verifyPassword,
  listSessions,
  revokeSession,
  revokeOtherSessions,
  httpError,
  COOKIE_NAME,
  avatarUrlFor,
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
import {
  createVaultRequest as vaultCreateRequest,
  getVaultRequest,
  fulfillVaultRequest,
  listVaultItems,
  deleteVaultItem,
  pruneExpiredRequests,
} from './vault.js';
import { runConversation, startRunIfIdle, abortRun, recoverStrandedRuns, setShuttingDown } from './runs.js';
import { isRunLocked, requestStop, activeRunIds } from './runlock.js';
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
  parseTokenLimitSetting,
} from './usage.js';
import {
  checkLimit,
  recordFailure,
  recordSuccess,
  hitRateLimit,
  limitErrorMessage,
} from './ratelimit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// The asset hash baked into public/index.html's ?v= URLs. The client
// compares it against the bundle it loaded so a long-lived tab can reload
// itself after a deploy instead of testing stale code.
let ASSET_VERSION = null;
try {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const m = /\/js\/app\.js\?v=([0-9a-f]+)/.exec(html);
  if (m) ASSET_VERSION = m[1];
} catch { /* health simply omits it */ }

// Behind Caddy (the only ingress — the app container publishes no ports),
// so X-Forwarded-For is trustworthy and req.ip is the real client IP.
app.set('trust proxy', true);
app.disable('x-powered-by');

// Baseline security headers on every response.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  // The vault form is same-origin iframed; nothing else may frame the app.
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

// CSRF: the session cookie is the only credential, so every state-changing
// request must prove it came from our own pages. Same-origin fetches carry
// an Origin (or Referer) header — it must match our host. Requests with
// neither (curl, exotic clients) must send X-Requested-With instead, which
// a cross-site page cannot add without a preflight the browser would block.
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const host = req.headers.host;
  const sameHost = (u) => {
    try {
      return new URL(u).host === host;
    } catch {
      return false;
    }
  };
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  const ok = origin
    ? sameHost(origin)
    : referer
      ? sameHost(referer)
      : req.headers['x-requested-with'] === 'XMLHttpRequest';
  if (!ok) return res.status(403).json({ error: 'Cross-origin request blocked.' });
  next();
});

app.use(express.json({ limit: '1mb' }));
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

// ---- brute-force protection --------------------------------------------
// Per-account AND per-IP failure buckets (see src/ratelimit.js). The account
// bucket is the real defense — the IP bucket only slows distributed guessing.
// A success clears the account bucket; the IP bucket expires on its own so a
// legitimate user sharing an IP can't hand an attacker a fresh window.
function authLimitKeys(req, kind, account) {
  const keys = [`${kind}:ip:${req.ip || 'unknown'}`];
  if (account) keys.push(`${kind}:user:${String(account).toLowerCase()}`);
  return keys;
}

function checkAuthLimit(req, res, kind, account, opts) {
  for (const k of authLimitKeys(req, kind, account)) {
    const hit = checkLimit(k, opts);
    if (hit) {
      res.set('Retry-After', String(Math.ceil(hit.retryAfterMs / 1000)));
      throw httpError(429, limitErrorMessage(hit.retryAfterMs));
    }
  }
}

function authFailed(req, kind, account, opts) {
  for (const k of authLimitKeys(req, kind, account)) recordFailure(k, opts);
}

// ---- auth ---------------------------------------------------------------

// Public: lets the login page hide the signup tab when public signups are
// off. The first-ever account can always sign up (it becomes the admin).
// Temporary layout diagnostics receiver (?debuglayout). No auth —
// only receives anonymous layout metrics, never user data.
app.post('/api/debug/layout', (req, res) => {
  try {
    console.log('[layout-debug]', JSON.stringify(req.body).slice(0, 3000));
  } catch {}
  res.json({ ok: true });
});

app.get('/api/auth/config', (req, res) => {
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  res.json({
    signup_enabled: userCount === 0 || getSetting('signup_enabled', '1') === '1',
    // Public site key only — the secret never leaves the server.
    turnstile_site_key: getSetting('turnstile_site_key', '') || null,
  });
});

// Verify a Cloudflare Turnstile token with the siteverify API.
// Only enforced when a secret key is configured; otherwise returns true.
async function verifyTurnstile(token, ip) {
  const secret = getSetting('turnstile_secret_key', '');
  if (!secret) return true; // not configured — captcha disabled
  if (!token) return false;
  try {
    const params = new URLSearchParams({ secret, response: token });
    if (ip) params.set('remoteip', ip);
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(8000),
    });
    const data = await r.json();
    return data && data.success === true;
  } catch {
    return false; // fail closed — a verification outage must not open the gate
  }
}

// Captcha gate for password auth: when Turnstile is configured, the client
// sends the token from the widget; reject before touching credentials.
async function checkTurnstile(req) {
  if (!getSetting('turnstile_secret_key', '')) return; // not configured
  const ok = await verifyTurnstile(req.body?.turnstile_token, req.ip);
  if (!ok) throw httpError(403, 'Captcha verification failed — please try again.');
}

app.post('/api/auth/signup', asyncRoute(async (req, res) => {
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (userCount > 0 && getSetting('signup_enabled', '1') !== '1') {
    throw httpError(403, 'Sign-ups are disabled');
  }
  await checkTurnstile(req);
  // Account-creation spam: 5/hour per IP.
  checkAuthLimit(req, res, 'signup', null, { max: 5, windowMs: 60 * 60 * 1000 });
  let user;
  try {
    user = signup(req.body?.username, req.body?.password);
  } catch (e) {
    authFailed(req, 'signup', null, { max: 5, windowMs: 60 * 60 * 1000 });
    throw e;
  }
  setSessionCookie(res, createSession(user.id));
  res.json(user);
}));

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  checkAuthLimit(req, res, 'login', req.body?.username);
  await checkTurnstile(req);
  let result;
  try {
    result = loginStep1(req.body?.username, req.body?.password);
  } catch (e) {
    authFailed(req, 'login', req.body?.username);
    throw e;
  }
  // Success clears the per-account bucket only — a shared-IP attacker
  // doesn't get a fresh window from someone else's login.
  recordSuccess(`login:user:${String(req.body?.username || '').toLowerCase()}`);
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
  res.json({ ...req.user, avatar_url: avatarUrlFor(req.user.id) });
});

app.patch('/api/auth/me', requireAuth, asyncRoute(async (req, res) => {
  const { password, current_password, theme } = req.body || {};
  if (password !== undefined) {
    if (!verifyPassword(req.user.id, current_password || '')) {
      throw httpError(403, 'Current password is incorrect.');
    }
    const pw = checkPasswordRules(password);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(pw), req.user.id);
    // A password change may mean compromise — drop every other session.
    revokeOtherSessions(req.user.id, req.sessionId);
  }
  if (theme !== undefined) {
    // Cross-device theme sync: the toggle writes through here; other
    // devices pick it up on focus/visible.
    if (theme !== 'light' && theme !== 'dark') throw httpError(400, 'Invalid theme.');
    db.prepare('UPDATE users SET theme = ? WHERE id = ?').run(theme, req.user.id);
  }
  res.json({ ok: true });
}));

// ---- two-factor auth (TOTP) ------------------------------------------------

app.get('/api/auth/2fa/status', requireAuth, (req, res) => {
  res.json(getTotpStatus(req.user.id));
});

app.post('/api/auth/2fa/setup', requireAuth, asyncRoute(async (req, res) => {
  // Enrolling a second factor is sensitive: re-authenticate with the
  // password first, so a hijacked session alone can't lock the user out.
  if (!verifyPassword(req.user.id, req.body?.password || '')) {
    throw httpError(401, 'Incorrect password');
  }
  // The secret is returned ONCE here; afterwards only the encrypted secret is stored.
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
  // Removing the second factor is sensitive — drop every other session.
  revokeOtherSessions(req.user.id, req.sessionId);
  res.json({ ok: true });
}));

app.post('/api/auth/2fa/verify', asyncRoute(async (req, res) => {
  const userId = consumeLoginChallenge(req.body?.challenge);
  if (!userId) throw httpError(401, 'Login challenge expired — please sign in again');
  // The account may have been locked/disabled after the password step.
  const acct = db.prepare('SELECT disabled, abuse_locked FROM users WHERE id = ?').get(userId);
  if (!acct) throw httpError(401, 'Login challenge expired — please sign in again');
  if (acct.abuse_locked) throw httpError(403, 'Account locked — contact your administrator.');
  if (acct.disabled) throw httpError(403, 'This account has been disabled');
  checkAuthLimit(req, res, '2fa', `id:${userId}`);
  const check = verifySecondFactor(userId, req.body?.code);
  if (!check) {
    authFailed(req, '2fa', `id:${userId}`);
    throw httpError(401, 'Invalid code');
  }
  recordSuccess(`2fa:user:id:${userId}`);
  const row = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(userId);
  setSessionCookie(res, createSession(userId));
  res.json({ id: row.id, username: row.username, role: row.role, avatar_url: avatarUrlFor(userId) });
}));

// ---- passkeys ---------------------------------------------------------------

app.post('/api/auth/passkey/register/options', requireAuth, asyncRoute(async (req, res) => {
  // Registering a passkey is sensitive: re-authenticate with the password
  // first, so a hijacked session alone can't add a login method.
  if (!verifyPassword(req.user.id, req.body?.password || '')) {
    throw httpError(401, 'Incorrect password');
  }
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
  checkAuthLimit(req, res, 'passkey-login', req.body?.username);
  let user;
  try {
    // A verified passkey is a full login — it bypasses TOTP.
    user = await verifyAuthentication(req, req.body?.token, req.body?.response);
  } catch (e) {
    authFailed(req, 'passkey-login', req.body?.username);
    throw e;
  }
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
  const sid = req.params.id; // public session id (never the bearer token)
  const cur = db.prepare('SELECT public_id FROM sessions WHERE id = ?').get(req.sessionId);
  revokeSession(req.user.id, sid);
  if (cur && sid === cur.public_id) clearSessionCookie(res); // revoked our own session
  res.json({ ok: true });
});

// ---- conversations --------------------------------------------------------

function getConv(id, userId) {
  return db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(id, userId);
}

// The client sees user/assistant turns only; the agent replays tool rows
// from the DB directly when it needs context.
function messagePayload(m, userId) {
  return {
    ...m,
    attachments: db
      .prepare('SELECT id, filename, mime FROM attachments WHERE message_id = ?')
      .all(m.id)
      .map((a) => ({ id: a.id, filename: a.filename, url: `/api/files/${a.id}` })),
    reactions: groupedReactions(m.id, userId),
  };
}

function conversationPayload(conv, limit = 80) {
  const n = Math.max(1, Math.min(200, Number(limit) || 80));
  const messages = db
    .prepare(
      `SELECT id, role, content, kind, created_at FROM messages
       WHERE conversation_id = ? AND role != 'tool' ORDER BY id DESC LIMIT ?`
    )
    .all(conv.id, n)
    .reverse()
    .map((m) => messagePayload(m, conv.user_id));
  const oldestLoaded = messages.length ? messages[0].id : null;
  const hasMoreOlder = oldestLoaded
    ? db
        .prepare(
          `SELECT 1 FROM messages WHERE conversation_id = ? AND role != 'tool' AND id < ? LIMIT 1`
        )
        .get(conv.id, oldestLoaded)
      ? true
      : false
    : false;
  return {
    conversation: { id: conv.id, title: conv.title, kind: conv.kind, task_id: conv.task_id, created_at: conv.created_at, updated_at: conv.updated_at },
    messages,
    hasMoreOlder,
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
  const conv = getConv(getOrCreateConversation(req.user.id), req.user.id);
  res.json(conversationPayload(conv, req.query.limit));
});

// Older messages for scroll-up windowing: messages before `before` (exclusive).
app.get('/api/conversations/:id/messages', requireAuth, (req, res) => {
  const conv = getConv(req.params.id, req.user.id);
  if (!conv) return res.status(404).json({ error: 'Not found' });
  const n = Math.max(1, Math.min(200, Number(req.query.limit) || 60));
  const before = Number(req.query.before);
  if (!Number.isFinite(before)) return res.status(400).json({ error: 'before is required' });
  const messages = db
    .prepare(
      `SELECT id, role, content, kind, created_at FROM messages
       WHERE conversation_id = ? AND role != 'tool' AND id < ?
       ORDER BY id DESC LIMIT ?`
    )
    .all(conv.id, before, n)
    .reverse()
    .map((m) => messagePayload(m, conv.user_id));
  const oldestLoaded = messages.length ? messages[0].id : null;
  const hasMoreOlder = oldestLoaded
    ? !!db
        .prepare(
          `SELECT 1 FROM messages WHERE conversation_id = ? AND role != 'tool' AND id < ? LIMIT 1`
        )
        .get(conv.id, oldestLoaded)
    : false;
  res.json({ messages, hasMoreOlder });
});

app.get('/api/conversations', requireAuth, (req, res) => {
  const rows = db
    .prepare("SELECT id, title, kind, task_id, created_at, updated_at FROM conversations WHERE user_id = ? AND kind != 'heartbeat' ORDER BY updated_at DESC")
    .all(req.user.id)
    .map((c) => ({ ...c, running: isRunLocked(c.id) }));
  res.json(rows);
});

// Full-text-ish search over the user's chats: matches conversation titles
// and message bodies, newest first, with a snippet from the first matching
// message. (Registered before /:id so "search" isn't swallowed as an id.)
app.get('/api/conversations/search', requireAuth, (req, res) => {
  const q = (req.query.q || '').trim().slice(0, 120);
  if (q.length < 2) return res.json([]);
  const like = `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
  const rows = db
    .prepare(
      `SELECT c.id, c.title, c.updated_at,
         (SELECT substr(m.content, 1, 200) FROM messages m
           WHERE m.conversation_id = c.id AND m.content LIKE ? ESCAPE '\\'
           ORDER BY m.id LIMIT 1) AS snippet
       FROM conversations c
       WHERE c.user_id = ?
         AND c.kind != 'heartbeat'
         AND (c.title LIKE ? ESCAPE '\\' OR EXISTS (
           SELECT 1 FROM messages m2
           WHERE m2.conversation_id = c.id AND m2.content LIKE ? ESCAPE '\\'))
       ORDER BY c.updated_at DESC
       LIMIT 20`
    )
    .all(like, req.user.id, like, like);
  res.json(rows);
});

app.post('/api/conversations', requireAuth, (req, res) => {
  // Never stack up empty chats: if the user already has a message-less
  // conversation, hand that one back instead of creating another.
  const empty = db
    .prepare(
      `SELECT c.id, c.title, c.kind, c.created_at, c.updated_at FROM conversations c
       WHERE c.user_id = ?
         AND c.kind = 'chat'
         AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)
       ORDER BY c.updated_at DESC LIMIT 1`
    )
    .get(req.user.id);
  if (empty) return res.json(empty);
  const now = Date.now();
  const title = String(req.body?.title || 'New chat').slice(0, 120) || 'New chat';
  const info = db
    .prepare("INSERT INTO conversations (user_id, title, kind, created_at, updated_at) VALUES (?, ?, 'chat', ?, ?)")
    .run(req.user.id, title, now, now);
  res.json({ id: Number(info.lastInsertRowid), title, kind: 'chat', created_at: now, updated_at: now });
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

// ---- deletion helpers --------------------------------------------------------
// Uploads live at files/uploads/<userId>/<uuid> and avatars at
// files/avatars/<userId>/<uuid> — never under files/<convId>. The DB rows are
// the source of truth for what bytes exist: gather paths BEFORE deleting
// rows, then remove the files.

function attachmentPathsForMessages(msgIds) {
  if (!msgIds.length) return [];
  const ph = msgIds.map(() => '?').join(',');
  return db
    .prepare(`SELECT path FROM attachments WHERE message_id IN (${ph})`)
    .all(...msgIds)
    .map((r) => r.path)
    .filter(Boolean);
}

// Remove files/dirs strictly inside DATA_DIR. Never throws.
function removeDataPaths(paths) {
  const base = path.resolve(DATA_DIR) + path.sep;
  for (const p of paths) {
    try {
      const fp = path.resolve(DATA_DIR, p);
      if (fp.startsWith(base)) fs.rmSync(fp, { force: true });
    } catch {
      /* already gone */
    }
  }
}

function removeDataDir(rel) {
  try {
    const fp = path.resolve(DATA_DIR, rel);
    if (fp.startsWith(path.resolve(DATA_DIR) + path.sep)) {
      fs.rmSync(fp, { recursive: true, force: true });
    }
  } catch {
    /* already gone */
  }
}

// Delete one conversation completely: stop any in-flight run first so it
// can't write into rows we're removing, then DB rows, then bytes.
function deleteConversation(convId) {
  abortRun(convId);
  const msgIds = db
    .prepare('SELECT id FROM messages WHERE conversation_id = ?')
    .all(convId)
    .map((m) => m.id);
  const paths = attachmentPathsForMessages(msgIds);
  if (msgIds.length) {
    const ph = msgIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM attachments WHERE message_id IN (${ph})`).run(...msgIds);
    db.prepare(`DELETE FROM reactions WHERE message_id IN (${ph})`).run(...msgIds);
    db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(convId);
  }
  db.prepare('DELETE FROM conversations WHERE id = ?').run(convId);
  // A deleted chat's share link dies with it — the row is the link.
  db.prepare('DELETE FROM shared_chats WHERE conversation_id = ?').run(convId);
  removeDataPaths(paths);
}

app.delete('/api/conversations/:id', requireAuth, (req, res) => {
  const conv = getConv(req.params.id, req.user.id);
  if (!conv) return res.status(404).json({ error: 'Not found' });
  // All chats are equal: any of them can be deleted. The heartbeat lazily
  // recreates its anchor chat if it ever goes missing.
  deleteConversation(conv.id);
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
  // A single chat message has no business being megabytes: cap it well below
  // the JSON body limit so one paste can't bloat the DB or the model replay.
  if (content.length > 100_000) throw httpError(400, 'Message too long (100,000 character limit).');

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
  // "Reset everything" means everything: every conversation (not just the
  // most recent), all staged uploads, and the sandbox.
  const convIds = db
    .prepare('SELECT id FROM conversations WHERE user_id = ?')
    .all(req.user.id)
    .map((c) => c.id);
  for (const cid of convIds) deleteConversation(cid);
  // Drop this user's staged (unclaimed) uploads too.
  const stagedPaths = db
    .prepare('SELECT path FROM attachments WHERE staged = 1 AND user_id = ?')
    .all(req.user.id)
    .map((r) => r.path);
  db.prepare('DELETE FROM attachments WHERE staged = 1 AND user_id = ?').run(req.user.id);
  removeDataPaths(stagedPaths);
  for (const cid of convIds) publish(cid, { type: 'chat_cleared' });
  await sandboxReset(req.user.id);
  // Hand the client a fresh empty chat so it never sits on a deleted one.
  const freshId = getOrCreateConversation(req.user.id);
  res.json({ ok: true, conversation_id: freshId });
}));

// Delete every conversation (all chats) but leave the sandbox alone — the
// agent's files, installed tools, and persistent memory (SOUL.md / MEMORY.md)
// survive. Same password (+2FA) gate as the full reset: this is destructive.
// Task definitions are kept; only their chat transcripts go.
app.post('/api/chats/delete-all', requireAuth, asyncRoute(async (req, res) => {
  const { password, totp_code } = req.body || {};
  if (!verifyPassword(req.user.id, password || '')) {
    return res.status(403).json({ error: 'Wrong password.' });
  }
  if (totpEnabled(req.user.id) && !verifySecondFactor(req.user.id, totp_code || '')) {
    return res.status(403).json({ error: 'Wrong two-factor code.' });
  }
  const convIds = db
    .prepare('SELECT id FROM conversations WHERE user_id = ?')
    .all(req.user.id)
    .map((c) => c.id);
  for (const cid of convIds) deleteConversation(cid);
  // Drop this user's staged (unclaimed) uploads too.
  const stagedPaths = db
    .prepare('SELECT path FROM attachments WHERE staged = 1 AND user_id = ?')
    .all(req.user.id)
    .map((r) => r.path);
  db.prepare('DELETE FROM attachments WHERE staged = 1 AND user_id = ?').run(req.user.id);
  removeDataPaths(stagedPaths);
  for (const cid of convIds) publish(cid, { type: 'chat_cleared' });
  // The sandbox (and the agent's memory inside it) is deliberately untouched.
  const freshId = getOrCreateConversation(req.user.id);
  res.json({ ok: true, conversation_id: freshId });
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
  const convId = getOrCreateConversation(req.user.id);
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
    // Multer already wrote the file — remove it on any rejection below so
    // denied uploads don't linger on disk.
    const dropFile = () => {
      try {
        fs.rmSync(req.file.path, { force: true });
      } catch {
        /* gone */
      }
    };
    // Rate limit: 30 uploads/hour per user. No quota on count alone would
    // let an account fill the data volume 100 MB at a time.
    const hit = hitRateLimit(`upload:user:${req.user.id}`, { max: 30, windowMs: 60 * 60 * 1000 });
    if (hit) {
      dropFile();
      res.set('Retry-After', String(Math.ceil(hit.retryAfterMs / 1000)));
      return res.status(429).json({ error: 'Too many uploads — try again later.' });
    }
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
    // Storage quota: 2 GB per user across staged + claimed uploads. Enforced
    // after the insert (the file is already on disk); over-quota uploads are
    // removed again immediately.
    const used = db
      .prepare('SELECT COALESCE(SUM(size), 0) AS s FROM attachments WHERE user_id = ?')
      .get(req.user.id).s;
    if (used > 2 * 1024 * 1024 * 1024) {
      db.prepare('DELETE FROM attachments WHERE id = ?').run(id);
      dropFile();
      return res.status(413).json({ error: 'Storage quota exceeded (2 GB). Delete chats or files to free space.' });
    }
    res.json({
      id,
      filename: req.file.originalname || 'file',
      mime: req.file.mimetype,
      size: req.file.size,
      url: `/api/files/${id}`,
    });
  });
});

// ---- vault ------------------------------------------------------------------
// Encrypted per-user secret storage. The agent collects credentials through
// a same-origin form (never through chat, which the model can see) and only
// ever handles opaque "vault:<id>" references. Plaintext is resolved
// server-side at exec time and scrubbed from output.

const vaultEsc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Secure input form. Session-authenticated; the request id is unguessable,
// single-use, and expires after 15 minutes.
app.get('/vault/form/:requestId', (req, res) => {
  const user = getUserBySession(req.cookies?.[COOKIE_NAME]);
  const rq = getVaultRequest(req.params.requestId);
  if (!user || !rq || rq.user_id !== user.id) {
    return res.status(404).type('html').send(vaultFormPage(null, 'Not found', 'This secure form link is invalid or belongs to a different account.'));
  }
  pruneExpiredRequests();
  const fresh = getVaultRequest(req.params.requestId);
  if (fresh.status === 'fulfilled') {
    return res.type('html').send(vaultFormPage(fresh, 'Already saved ✓', 'This secret was already stored. You can close this tab.', true));
  }
  if (fresh.status !== 'pending') {
    return res.type('html').send(vaultFormPage(fresh, 'Expired', 'This request expired. Ask the agent for a new secure form.', true));
  }
  res.type('html').send(vaultFormPage(fresh, null, null, false));
});

function vaultFormPage(rq, title, message, done) {
  const heading = title || 'Save a secret';
  const label = rq ? rq.label : '';
  const hint = rq ? rq.hint : '';
  const reqId = rq ? rq.id : '';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${vaultEsc(heading)} — Orion vault</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: Georgia, 'Times New Roman', serif; background: #faf7f0; color: #2b2620;
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
  @media (prefers-color-scheme: dark) { body { background: #171310; color: #e8e0d2; } }
  .card { max-width: 420px; width: 100%; }
  .lock { font-size: 28px; }
  h1 { font-size: 22px; margin: 12px 0 4px; font-weight: 600; }
  .label-name { color: #8a8175; font-size: 14px; margin-bottom: 16px; }
  .hint { font-size: 14px; line-height: 1.5; color: #6b6257; margin-bottom: 16px; }
  @media (prefers-color-scheme: dark) { .hint { color: #a89e8d; } .label-name { color: #8f8574; } }
  .field { margin-bottom: 12px; }
  input[type=password], input[type=text] { width: 100%; box-sizing: border-box; font-size: 16px;
    font-family: ui-monospace, monospace; padding: 10px 12px; border: 1px solid #d8d0c0; border-radius: 8px;
    background: #fff; color: inherit; }
  @media (prefers-color-scheme: dark) { input[type=password], input[type=text] { background: #221d17; border-color: #3d362c; } }
  .row { display: flex; gap: 10px; align-items: center; }
  button.submit { flex: 1; font-size: 16px; padding: 11px; border: 0; border-radius: 8px; cursor: pointer;
    background: #1f4fd8; color: #fff; font-family: inherit; }
  button.submit:disabled { opacity: .6; cursor: default; }
  .show { font-size: 13px; background: none; border: 1px solid #d8d0c0; border-radius: 8px; padding: 10px 12px;
    cursor: pointer; color: inherit; font-family: inherit; }
  .err { color: #b3261e; font-size: 14px; margin-top: 10px; min-height: 20px; }
  .ok { color: #2e7d32; font-size: 15px; line-height: 1.6; }
  .note { margin-top: 18px; font-size: 12.5px; color: #8a8175; line-height: 1.5; }
  @media (prefers-color-scheme: dark) { .note { color: #6f6656; } }
</style></head><body><div class="card">
  <div class="lock">🔒</div>
  <h1>${vaultEsc(heading)}</h1>
  ${label ? `<div class="label-name">${vaultEsc(label)}</div>` : ''}
  ${done
    ? `<p class="ok">${vaultEsc(message)}</p>`
    : `
  ${hint ? `<p class="hint">${vaultEsc(hint)}</p>` : ''}
  <form id="f">
    <div class="field"><input id="v" type="password" autocomplete="off" autocapitalize="off" spellcheck="false"
      placeholder="Paste the secret here" aria-label="Secret value"></div>
    <div class="row">
      <button class="submit" type="submit" id="go">Save to vault</button>
      <button class="show" type="button" id="sh">Show</button>
    </div>
    <div class="err" id="e"></div>
  </form>
  <p class="note">This goes straight into the encrypted vault in your VM. It is never shown to the AI model —
  not in chat, not in any log. Only this server can use it, when the agent explicitly asks for it by name.</p>
  <script>
    const f = document.getElementById('f'), v = document.getElementById('v'),
          e = document.getElementById('e'), go = document.getElementById('go');
    document.getElementById('sh').onclick = () => {
      const show = v.type === 'password';
      v.type = show ? 'text' : 'password';
      document.getElementById('sh').textContent = show ? 'Hide' : 'Show';
    };
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      e.textContent = '';
      if (!v.value) { e.textContent = 'Paste a value first.'; return; }
      go.disabled = true;
      try {
        const r = await fetch('/api/vault/requests/${vaultEsc(reqId)}/fulfill', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: v.value })
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || 'Save failed');
        document.querySelector('.card').innerHTML =
          '<div class="lock">🔒</div><h1>Saved ✓</h1>' +
          '<p class="ok">“' + ${JSON.stringify(label)}.replace(/</g, '\\u003c') + '” is in your vault. ' +
          'You can close this tab and tell the agent to continue.</p>';
      } catch (err) { e.textContent = err.message; go.disabled = false; }
    };
    v.focus();
    // Report the content height to the embedding page (the chat widget) so
    // the iframe can size itself — no inner scrollbar. Skipped when opened
    // as a standalone tab (no parent to report to).
    let lastH = 0;
    const reportH = () => {
      const card = document.querySelector('.card');
      if (!card || window.parent === window) return;
      const h = Math.ceil(card.getBoundingClientRect().height) + 56; // body padding + slack
      if (h !== lastH) {
        lastH = h;
        try { window.parent.postMessage({ type: 'orion-vault-form-height', height: h }, window.location.origin); } catch {}
      }
    };
    if ('ResizeObserver' in window) new ResizeObserver(reportH).observe(document.body);
    window.addEventListener('load', reportH);
    reportH();
  </script>`}
</div></body></html>`;
}

// Fulfill a vault request. The secret travels only in this request body —
// it is encrypted immediately and never echoed back or logged.
app.post('/api/vault/requests/:requestId/fulfill', requireAuth, asyncRoute(async (req, res) => {
  let itemId, rq;
  try {
    ({ itemId, request: rq } = fulfillVaultRequest(req.user.id, req.params.requestId, req.body?.value));
  } catch (e) {
    throw httpError(400, e.message); // expired/used/missing — a user error, not a 500
  }
  // Flip the widget message to "fulfilled" so reloaded history reads right.
  if (rq.message_id) {
    try {
      const row = db.prepare('SELECT content FROM messages WHERE id = ?').get(rq.message_id);
      if (row) {
        const c = JSON.parse(row.content);
        c.status = 'fulfilled';
        db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(JSON.stringify(c), rq.message_id);
      }
    } catch { /* cosmetic only */ }
  }
  publish(rq.conversation_id, {
    type: 'vault', request_id: rq.id, status: 'fulfilled', item_id: itemId, label: rq.label,
  });
  res.json({ ok: true, item_id: itemId });
}));

// Metadata only — values never leave the vault through the API.
app.get('/api/vault/items', requireAuth, (req, res) => {
  res.json(listVaultItems(req.user.id));
});

app.delete('/api/vault/items/:id', requireAuth, (req, res) => {
  if (!deleteVaultItem(req.user.id, req.params.id)) throw httpError(404, 'Vault item not found');
  res.json({ ok: true });
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
  db.prepare('UPDATE users SET avatar_path = NULL WHERE id = ?').run(req.user.id);  res.json({ ok: true });
});

// Admin: view any user's avatar (the /api/avatar route is self-only).
app.get('/api/admin/users/:id/avatar', requireAdmin, (req, res) => {
  const row = db.prepare('SELECT avatar_path FROM users WHERE id = ?').get(Number(req.params.id));
  if (!row?.avatar_path) return res.status(404).json({ error: 'No avatar' });
  const fp = path.resolve(DATA_DIR, row.avatar_path);
  if (!fp.startsWith(path.resolve(DATA_DIR) + path.sep)) return res.status(400).json({ error: 'Bad path' });
  res.sendFile(fp, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'File missing' });
  });
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
  serveAttachmentFile(att, res);
});

// Serve an attachment row's bytes with the same safety rules everywhere:
// path confined to DATA_DIR, active content forced to download + sandboxed
// so it can never execute as our origin.
function serveAttachmentFile(att, res) {
  const fp = path.resolve(DATA_DIR, att.path);
  if (!fp.startsWith(path.resolve(DATA_DIR) + path.sep)) {
    return res.status(400).json({ error: 'Bad file path' });
  }
  // Active content must never render as our origin: an uploaded .html/.svg
  // served inline with its claimed mime would run script as orion.dill.moe
  // (stored XSS) when opened directly. Force a download for those, and belt
  // and braces, sandbox them. (The mime is client-supplied at upload, so the
  // file extension is checked too — nosniff is already set globally.)
  const mime = String(att.mime || 'application/octet-stream').toLowerCase().split(';')[0].trim();
  const name = String(att.filename || 'file');
  const activeMime = new Set([
    'text/html', 'application/xhtml+xml', 'image/svg+xml', 'text/xml', 'application/xml',
  ]).has(mime);
  const activeExt = /\.(html?|svg|xml|xhtml)$/i.test(name);
  const safeName = name.replace(/[\r\n"]/g, '');
  if (activeMime || activeExt) {
    res.set('Content-Disposition', `attachment; filename="${safeName}"`);
    res.set('Content-Security-Policy', 'sandbox');
  } else {
    res.set('Content-Disposition', `inline; filename="${safeName}"`);
  }
  res.type(mime);
  res.sendFile(fp, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'File missing' });
  });
}

// ---- chat sharing ------------------------------------------------------------
// A share link is a public, unguessable token per conversation. The DB row
// IS the link: revoking (or deleting the chat) removes the row and the link
// stops resolving.
//
// A share is a FROZEN snapshot of the transcript at share time — messages
// written after sharing never appear on the link. Re-sharing refreshes the
// snapshot on the same link.

// Build the public transcript for a conversation — the same filtering the
// share page uses. Attachment URLs are scoped to the share token.
function buildShareTranscript(conversationId, token) {
  return db
    .prepare(
      `SELECT id, role, content, kind, created_at FROM messages
       WHERE conversation_id = ? AND role != 'tool'
         AND (kind IS NULL OR kind = 'message')
       ORDER BY id ASC`
    )
    .all(conversationId)
    .map((m) => ({
      ...m,
      attachments: db
        .prepare('SELECT id, filename, mime FROM attachments WHERE message_id = ?')
        .all(m.id)
        .map((a) => ({
          id: a.id,
          filename: a.filename,
          url: `/api/share/${token}/files/${a.id}`,
        })),
    }));
}

function shareSnapshot(token, title, conversationId) {
  return JSON.stringify({ title, messages: buildShareTranscript(conversationId, token) });
}

// One share link per chat. Sharing a chat that is already shared refreshes
// the frozen transcript on the existing link.
app.post('/api/conversations/:id/share', requireAuth, (req, res) => {
  const conv = getConv(req.params.id, req.user.id);
  if (!conv) return res.status(404).json({ error: 'Not found' });
  let row = db.prepare('SELECT token FROM shared_chats WHERE conversation_id = ?').get(conv.id);
  let fresh = false;
  if (!row) {
    const token = crypto.randomBytes(24).toString('base64url');
    try {
      db.prepare(
        'INSERT INTO shared_chats (conversation_id, user_id, token, snapshot) VALUES (?, ?, ?, ?)'
      ).run(conv.id, req.user.id, token, shareSnapshot(token, conv.title, conv.id));
      fresh = true;
    } catch {
      // Lost a race with a parallel share — fall through to the existing row.
    }
    row = db.prepare('SELECT token FROM shared_chats WHERE conversation_id = ?').get(conv.id);
  }
  if (!fresh && row) {
    db.prepare('UPDATE shared_chats SET snapshot = ? WHERE conversation_id = ?')
      .run(shareSnapshot(row.token, conv.title, conv.id), conv.id);
  }
  res.json({ token: row.token, fresh });
});

// Revoke a chat's share link. The row is gone, so the link stops working.
app.delete('/api/conversations/:id/share', requireAuth, (req, res) => {
  const conv = getConv(req.params.id, req.user.id);
  if (!conv) return res.status(404).json({ error: 'Not found' });
  const info = db
    .prepare('DELETE FROM shared_chats WHERE conversation_id = ? AND user_id = ?')
    .run(conv.id, req.user.id);
  if (!info.changes) return res.status(404).json({ error: 'Not shared' });
  res.json({ ok: true });
});

// All of the current user's live share links.
app.get('/api/shared', requireAuth, (req, res) => {
  const shares = db
    .prepare(
      `SELECT s.conversation_id, s.token, s.created_at, c.title
       FROM shared_chats s JOIN conversations c ON c.id = s.conversation_id
       WHERE s.user_id = ? ORDER BY s.created_at DESC`
    )
    .all(req.user.id);
  res.json({ shares });
});

// Public: resolve a share token to its chat, or null.
function getShare(token) {
  if (!token || typeof token !== 'string' || token.length > 128) return null;
  return (
    db
      .prepare(
        `SELECT s.*, c.title FROM shared_chats s
         JOIN conversations c ON c.id = s.conversation_id WHERE s.token = ?`
      )
      .get(token) || null
  );
}

// Public: the shared chat's transcript — the frozen snapshot captured at
// share time. Plain user/assistant turns only: progress notes, vault cards,
// tool rows, and empty tool-only turns are internal and stay out.
app.get('/api/share/:token', (req, res) => {
  const share = getShare(req.params.token);
  if (!share) return res.status(404).json({ error: 'This link is invalid or has been revoked.' });
  let snap = null;
  if (share.snapshot) {
    try {
      snap = JSON.parse(share.snapshot);
    } catch {
      snap = null;
    }
  }
  if (!snap || !Array.isArray(snap.messages)) {
    // Legacy share from before snapshots — freeze it at its current state.
    snap = { title: share.title, messages: buildShareTranscript(share.conversation_id, share.token) };
    db.prepare('UPDATE shared_chats SET snapshot = ? WHERE token = ?')
      .run(JSON.stringify(snap), share.token);
  }
  res.json({ title: snap.title || share.title, created_at: share.created_at, messages: snap.messages });
});

// Public: an attachment scoped to its share token — only files that belong
// to the shared conversation are reachable this way.
app.get('/api/share/:token/files/:attId', (req, res) => {
  const share = getShare(req.params.token);
  if (!share) return res.status(404).json({ error: 'Not found' });
  const att = db
    .prepare(
      `SELECT a.* FROM attachments a JOIN messages m ON m.id = a.message_id
       WHERE a.id = ? AND m.conversation_id = ?`
    )
    .get(req.params.attId, share.conversation_id);
  if (!att) return res.status(404).json({ error: 'Not found' });
  serveAttachmentFile(att, res);
});

// Public: the read-only shared-chat page. Never cached — a revoked link
// must stop working immediately, not linger in the browser cache.
app.get('/s/:token', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, '..', 'public', 'share.html'));
});

// ---- admin ----------------------------------------------------------------

// Token-limit shorthand parsing lives in usage.js (imported above).
const ADMIN_SETTING_KEYS = ['provider_name', 'base_url', 'api_key', 'model', 'signup_enabled', 'default_weekly_token_limit', 'turnstile_site_key', 'turnstile_secret_key'];
// Settings that hold secrets: only overwrite when a non-empty value is sent
// (the client never sees the real value, it sends '' when untouched).
const SECRET_SETTING_KEYS = new Set(['api_key', 'turnstile_secret_key']);

app.get('/api/admin/settings', requireAdmin, (req, res) => {
  const apiKey = getSetting('api_key', '');
  const tsSecret = getSetting('turnstile_secret_key', '');
  res.json({
    provider_name: getSetting('provider_name', ''),
    base_url: getSetting('base_url', ''),
    model: getSetting('model', ''),
    signup_enabled: getSetting('signup_enabled', '1'),
    default_weekly_token_limit: getSetting('default_weekly_token_limit', '1000000'),
    turnstile_site_key: getSetting('turnstile_site_key', ''),
    has_key: apiKey.length > 0, // the raw key is never sent to clients
    has_turnstile_secret: tsSecret.length > 0,
  });
});

app.put('/api/admin/settings', requireAdmin, (req, res) => {
  const body = req.body || {};
  for (const key of ADMIN_SETTING_KEYS) {
    if (body[key] === undefined) continue;
    // Every setting is a short string — bound it so a bad paste can't bloat
    // the settings table (api keys are dozens of chars; 4000 is generous).
    const val = String(body[key]);
    if (val.length > 4000) throw httpError(400, `Setting ${key} is too long (4000 character limit).`);
    if (SECRET_SETTING_KEYS.has(key)) {
      // Only overwrite when a non-empty value is sent — the client sends ''
      // when the admin didn't touch the field (it never sees the real key).
      if (val.length > 0) setSetting(key, val);
    } else if (key === 'signup_enabled') {
      setSetting(key, body[key] === '0' || body[key] === false ? '0' : '1');
    } else if (key === 'default_weekly_token_limit') {
      // Accepts shorthand ("1M", "500K") or a plain number; empty = unlimited.
      const parsed = parseTokenLimitSetting(val);
      if (!parsed.ok) throw httpError(400, parsed.error);
      setSetting(key, parsed.value === null ? '' : String(parsed.value));
    } else {
      setSetting(key, val);
    }
  }
  res.json({ ok: true });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const rows = db
    .prepare(
      `SELECT u.id, u.username, u.role, u.disabled, u.abuse_locked, u.abuse_reason,
              u.weekly_token_limit, u.avatar_path, u.created_at, COUNT(m.id) AS message_count
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
      // A disabled account's scheduled tasks must stop firing too.
      for (const t of db.prepare('SELECT id FROM tasks WHERE user_id = ?').all(id)) {
        try {
          unscheduleTask(t.id);
        } catch {
          /* best effort */
        }
      }
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
    deleteConversation(conv.id);
  }
  // Staged (never claimed) uploads: rows + bytes.
  const stagedPaths = db
    .prepare('SELECT path FROM attachments WHERE staged = 1 AND user_id = ?')
    .all(id)
    .map((r) => r.path);
  db.prepare('DELETE FROM attachments WHERE user_id = ?').run(id);
  removeDataPaths(stagedPaths);
  // Per-user file dirs (uploads + avatars) and every other user-owned row.
  removeDataDir(`files/uploads/${id}`);
  removeDataDir(`files/avatars/${id}`);
  db.prepare('DELETE FROM vault_items WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM vault_requests WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM reactions WHERE user_id = ?').run(id);
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

app.get('/api/health', (_req, res) => res.json({ ok: true, asset: ASSET_VERSION }));

// Errors from httpError carry .status; everything else is a 500.
// Never leak stack traces, SQL, or filesystem paths to clients —
// unexpected failures get a generic message (details stay in the log).
app.use((err, _req, res, _next) => {
  const status = err?.status || 500;
  if (status >= 500) console.error('[orion]', err);
  const msg = status >= 500 ? 'Internal error' : err?.message || 'Internal error';
  res.status(status).json({ error: msg });
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
// A deploy or crash kills in-flight runs (the run lock and chain state are
// in-memory), which can strand a freshly stored user message with no run
// to answer it. Pick those up now so they get answered instead of hanging.
try {
  recoverStrandedRuns();
} catch (e) {
  console.warn('[orion] stranded-run recovery failed:', e.message);
}

const PORT = process.env.PORT || 3000;
let listener = null;
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  listener = app.listen(PORT, () => console.log(`[orion] listening on :${PORT}`));
}

// Graceful shutdown: a deploy recreates the container, which used to kill
// the process mid-run and strand partial messages + held run locks (the
// stranded-heartbeat incident). On SIGTERM/SIGINT: stop accepting new
// connections, abort in-flight runs so their finally blocks publish
// run_ended and release locks, then exit — as soon as the runs are done,
// or after a bounded grace period, whichever comes first.
let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[orion] ${signal}: draining — no new connections, aborting in-flight runs`);
  try {
    listener?.close();
  } catch {
    /* not listening */
  }
  // Must come before abortRun: aborted runs' finally blocks would
  // otherwise chain follow-up runs for queued messages, which would then
  // be killed mid-flight by the shutdown deadline. Boot recovery
  // re-answers anything stranded once the new process is up.
  try {
    setShuttingDown();
  } catch {
    /* best effort */
  }
  try {
    for (const convId of activeRunIds()) {
      try {
        abortRun(convId);
      } catch {
        /* best effort */
      }
    }
  } catch {
    /* best effort */
  }
  const deadline = setTimeout(() => {
    console.log('[orion] shutdown grace period elapsed; exiting');
    process.exit(0);
  }, 8000);
  deadline.unref?.();
  const poll = setInterval(() => {
    try {
      if (activeRunIds().length === 0) {
        clearInterval(poll);
        clearTimeout(deadline);
        process.exit(0);
      }
    } catch {
      /* keep waiting for the deadline */
    }
  }, 250);
  poll.unref?.();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

export default app;
