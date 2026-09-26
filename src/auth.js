// Orion auth: username/password + opaque session tokens in SQLite.
// The very first user ever created becomes the admin.
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { db } from './db.js';

export const COOKIE_NAME = 'orion_session';
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days

const USERNAME_RE = /^[a-zA-Z0-9_-]{3,24}$/;

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

export function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

function publicUser(row) {
  return { id: row.id, username: row.username, role: row.role };
}

export function signup(username, password) {
  if (!USERNAME_RE.test(username || '')) {
    throw httpError(400, 'Username must be 3–24 characters: letters, numbers, _ or -');
  }
  if (!password || password.length < 8) {
    throw httpError(400, 'Password must be at least 8 characters');
  }
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const role = count === 0 ? 'admin' : 'user'; // first user is the admin
  try {
    const info = db
      .prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)')
      .run(username, hashPassword(password), role, Date.now());
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
  if (!row || !bcrypt.compareSync(password || '', row.password_hash)) {
    throw httpError(401, 'Invalid username or password');
  }
  if (row.disabled) {
    throw httpError(403, 'This account has been disabled');
  }
  return publicUser(row);
}

export function createSession(userId) {
  const token = crypto.randomBytes(48).toString('hex');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, now, now + SESSION_TTL_MS);
  return token;
}

export function getUserBySession(token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.role, u.disabled, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`
    )
    .get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(token);
    return null;
  }
  if (row.disabled) return null;
  return { id: row.id, username: row.username, role: row.role };
}

export function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE id = ?').run(token);
}

export function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS,
    path: '/',
    // NOTE: set secure: true here if you always serve Orion over HTTPS.
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

export function requireAuth(req, res, next) {
  const user = getUserBySession(req.cookies?.[COOKIE_NAME]);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  req.user = user;
  next();
}

export function requireAdmin(req, res, next) {
  const user = getUserBySession(req.cookies?.[COOKIE_NAME]);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  if (user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  req.user = user;
  next();
}
