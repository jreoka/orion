// Orion auth: username/password + opaque session tokens in SQLite.
// The very first user ever created becomes the admin.
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, getSetting, DATA_DIR } from './db.js';
import { totpEnabled, createLoginChallenge } from './totp.js';

export const COOKIE_NAME = 'orion_session';
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days

const USERNAME_RE = /^[a-zA-Z0-9_-]{3,24}$/;

// Burned on unknown-username logins so the response time doesn't reveal
// whether an account exists (see login()).
const DUMMY_HASH = bcrypt.hashSync('orion-nonexistent-user-dummy', 10);

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

export function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

// bcrypt silently truncates at 72 bytes — cap the byte length so a
// "longer" password isn't weaker than the user believes. Existing hashes
// keep working: verification truncates the same way.
export function checkPasswordRules(password) {
  const s = String(password ?? '');
  if (s.length < 8) {
    throw httpError(400, 'Password must be at least 8 characters');
  }
  if (Buffer.byteLength(s, 'utf8') > 72) {
    throw httpError(400, 'Password must be at most 72 bytes (fewer characters if you use non-ASCII characters)');
  }
  return s;
}

function publicUser(row) {
  return { id: row.id, username: row.username, role: row.role, avatar_url: avatarUrlFor(row.id) };
}

/** Cache-busted avatar URL for a user, or null when they have no picture. */
export function avatarUrlFor(userId) {
  const row = db.prepare('SELECT avatar_path FROM users WHERE id = ?').get(userId);
  if (!row?.avatar_path) return null;
  try {
    const v = fs.statSync(path.resolve(DATA_DIR, row.avatar_path)).mtimeMs.toString(36);
    return '/api/avatar?v=' + v;
  } catch {
    return '/api/avatar';
  }
}

export function signup(username, password) {
  if (!USERNAME_RE.test(username || '')) {
    throw httpError(400, 'Username must be 3–24 characters: letters, numbers, _ or -');
  }
  const pw = checkPasswordRules(password);
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const role = count === 0 ? 'admin' : 'user'; // first user is the admin
  // New accounts start on the admin-configured default allowance ('' = unlimited).
  const defRaw = getSetting('default_weekly_token_limit', '1000000').trim();
  const defLimit = defRaw === '' ? null : Number(defRaw);
  try {
    const info = db
      .prepare('INSERT INTO users (username, password_hash, role, weekly_token_limit, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(username, hashPassword(pw), role, defLimit, Date.now());
    return { id: Number(info.lastInsertRowid), username, role };
  } catch (e) {
    if (String(e.message).includes('UNIQUE constraint failed')) {
      throw httpError(409, 'That username is taken');
    }
    throw e;
  }
}

export function login(username, password) {
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  // Don't reveal whether the username exists via bcrypt timing: always pay
  // the compare cost, even for unknown users.
  if (!row) {
    bcrypt.compareSync(password || '', DUMMY_HASH);
    throw httpError(401, 'Invalid username or password');
  }
  if (!bcrypt.compareSync(password || '', row.password_hash)) {
    throw httpError(401, 'Invalid username or password');
  }
  if (row.abuse_locked) {
    throw httpError(403, 'Account locked — contact your administrator.');
  }
  if (row.disabled) {
    throw httpError(403, 'This account has been disabled');
  }
  return publicUser(row);
}

export function verifyPassword(userId, password) {
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId);
  return !!row && bcrypt.compareSync(password || '', row.password_hash);
}

/**
 * First login step: verify password. When the user has 2FA enabled this
 * returns { need_2fa: true, challenge } instead of a session — the client
 * must then POST /api/auth/2fa/verify. Otherwise returns { user }.
 */
export function loginStep1(username, password) {
  const user = login(username, password); // throws on bad credentials
  if (totpEnabled(user.id)) {
    return { need_2fa: true, challenge: createLoginChallenge(user.id) };
  }
  return { user };
}

export function createSession(userId) {
  const token = crypto.randomBytes(48).toString('hex');
  const publicId = crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (id, public_id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(token, publicId, userId, now, now + SESSION_TTL_MS);
  return token;
}

export function getUserBySession(token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.role, u.disabled, u.theme, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`
    )
    .get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(token);
    return null;
  }
  if (row.disabled) return null;
  return { id: row.id, username: row.username, role: row.role, theme: row.theme };
}

export function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE id = ?').run(token);
}

// Production is HTTPS-only (Caddy terminates TLS). Local HTTP dev can set
// ORION_INSECURE_COOKIES=1 — otherwise the browser would refuse the cookie.
const SECURE_COOKIES = process.env.ORION_INSECURE_COOKIES !== '1';

export function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: SECURE_COOKIES,
    // Strict: the session cookie is only ever needed by our own pages.
    // (The SPA is static, so a cookieless first paint after an external
    // link is harmless — the first same-origin API call re-authenticates.)
    sameSite: 'strict',
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
}

export function clearSessionCookie(res) {
  // Clearing must mirror the cookie's flags or the browser won't overwrite it.
  res.clearCookie(COOKIE_NAME, { path: '/', secure: SECURE_COOKIES, sameSite: 'strict' });
}

// Session telemetry: refresh last_seen_at/ip/user_agent at most every 5 min
// so normal API traffic doesn't turn into a write storm.
function touchSession(req, token) {
  const now = Date.now();
  const row = db.prepare('SELECT last_seen_at FROM sessions WHERE id = ?').get(token);
  if (row && row.last_seen_at && now - row.last_seen_at < 5 * 60 * 1000) return;
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = (fwd || req.socket?.remoteAddress || '').slice(0, 64);
  const ua = String(req.headers['user-agent'] || '').slice(0, 256);
  db.prepare('UPDATE sessions SET last_seen_at = ?, ip = ?, user_agent = ? WHERE id = ?')
    .run(now, ip, ua, token);
}

function authFromCookie(req) {
  const token = req.cookies?.[COOKIE_NAME];
  const user = getUserBySession(token);
  return { token, user };
}

export function requireAuth(req, res, next) {
  const { token, user } = authFromCookie(req);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  req.user = user;
  req.sessionId = token;
  try {
    touchSession(req, token);
  } catch {
    /* telemetry must never break auth */
  }
  next();
}

export function requireAdmin(req, res, next) {
  const { token, user } = authFromCookie(req);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  if (user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  req.user = user;
  req.sessionId = token;
  try {
    touchSession(req, token);
  } catch {
    /* telemetry must never break auth */
  }
  next();
}

// ---- session management ---------------------------------------------------

// Lists sessions by their PUBLIC id — the bearer token (sessions.id) is
// never exposed. Revocation also goes through the public id.
export function listSessions(userId, currentId) {
  return db
    .prepare(
      'SELECT id AS token, public_id, created_at, last_seen_at, ip, user_agent, name FROM sessions WHERE user_id = ? ORDER BY created_at DESC'
    )
    .all(userId)
    .map((s) => ({
      id: s.public_id,
      created_at: s.created_at,
      last_seen_at: s.last_seen_at,
      ip: s.ip,
      user_agent: s.user_agent,
      name: s.name,
      current: s.token === currentId,
    }));
}

export function revokeSession(userId, publicId) {
  const info = db.prepare('DELETE FROM sessions WHERE public_id = ? AND user_id = ?').run(publicId, userId);
  if (!info.changes) throw httpError(404, 'Session not found');
}

export function revokeOtherSessions(userId, currentId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(userId, currentId);
}
