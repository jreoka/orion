// Orion TOTP 2FA: setup/confirm/verify plus single-use backup codes.
// Secrets are base32 TOTP secrets; backup codes are stored as SHA-256 hashes
// and only ever shown in plaintext once, at confirm time.
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { TOTP, Secret } from 'otpauth';
import QRCode from 'qrcode';
import { db } from './db.js';
import { httpError } from './auth.js';
import { encryptSecret, decryptSecret } from './vault.js';

const ISSUER = 'Orion';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

// Pending password-login challenges: token -> { userId, expiresAt }.
// Single-use, 5-minute TTL; lazy expiry on access plus a periodic sweep.
const challenges = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [token, c] of challenges) {
    if (c.expiresAt <= now) challenges.delete(token);
  }
}, 60 * 1000).unref?.();

function makeTotp(secretBase32, username) {
  return new TOTP({
    issuer: ISSUER,
    label: `${ISSUER}:${username}`,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secretBase32),
  });
}

function getUserRow(userId) {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!row) throw httpError(404, 'User not found');
  return row;
}

/** Start 2FA setup: returns a fresh secret + otpauth URL; stores it pending. */
export async function beginTotpSetup(userId) {
  const user = getUserRow(userId);
  if (user.totp_enabled) throw httpError(400, '2FA is already enabled');
  const secret = new Secret({ size: 20 });
  const secretBase32 = secret.base32;
  const url = makeTotp(secretBase32, user.username).toString();
  const qrDataUrl = await QRCode.toDataURL(url, { width: 220, margin: 1 });
  db.prepare('UPDATE users SET totp_pending_secret = ? WHERE id = ?').run(encryptSecret(secretBase32), userId);
  return { secret: secretBase32, otpauth_url: url, qr_data_url: qrDataUrl };
}

function randomBackupCodes(n = 10) {
  const codes = [];
  for (let i = 0; i < n; i++) {
    codes.push(crypto.randomBytes(6).toString('base64url').replace(/[^a-zA-Z0-9]/g, 'x').slice(0, 8).padEnd(8, '0'));
  }
  return codes;
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/**
 * TOTP secrets at rest: sealed with the server vault key (AES-256-GCM).
 * Legacy rows may hold plaintext — openTotpSecret handles both.
 */
function openTotpSecret(stored) {
  if (!stored) return null;
  const s = String(stored);
  if (s.startsWith('v1:')) {
    try {
      return decryptSecret(s);
    } catch {
      return null;
    }
  }
  return s; // legacy plaintext
}

/** Confirm setup with a code from the authenticator app. Returns backup codes (plaintext, once). */
export function confirmTotpSetup(userId, code) {
  const user = getUserRow(userId);
  if (user.totp_enabled) throw httpError(400, '2FA is already enabled');
  const pendingSecret = openTotpSecret(user.totp_pending_secret);
  if (!pendingSecret) throw httpError(400, 'No 2FA setup in progress');
  const delta = makeTotp(pendingSecret, user.username).validate({
    token: String(code || '').replace(/\s+/g, ''),
    window: 1,
  });
  if (delta === null) throw httpError(401, 'Invalid code — check your authenticator app and try again');
  const pending = pendingSecret;
  const now = Date.now();
  const codes = randomBackupCodes(10);
  const insert = db.prepare(
    'INSERT INTO totp_backup_codes (user_id, code_hash, created_at) VALUES (?, ?, ?)'
  );
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM totp_backup_codes WHERE user_id = ?').run(userId);
    for (const c of codes) insert.run(userId, bcrypt.hashSync(c, 10), now);
    db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 1, totp_pending_secret = NULL WHERE id = ?')
      .run(encryptSecret(pending), userId);
  });
  tx();
  return { backup_codes: codes };
}

/** Disable 2FA (caller must have verified the password already). */
export function disableTotp(userId) {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM totp_backup_codes WHERE user_id = ?').run(userId);
    db.prepare('UPDATE users SET totp_secret = NULL, totp_enabled = 0, totp_pending_secret = NULL WHERE id = ?')
      .run(userId);
  });
  tx();
}

export function totpEnabled(userId) {
  const row = db.prepare('SELECT totp_enabled FROM users WHERE id = ?').get(userId);
  return !!row?.totp_enabled;
}

/** Status for the settings UI: whether 2FA is on and how many backup codes remain. */
export function getTotpStatus(userId) {
  const enabled = totpEnabled(userId);
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM totp_backup_codes WHERE user_id = ? AND used_at IS NULL')
    .get(userId);
  return { enabled, backup_codes_remaining: enabled ? row.n : 0 };
}

function verifyTotpCode(userId, code) {
  const user = getUserRow(userId);
  const secret = openTotpSecret(user.totp_secret);
  if (!user.totp_enabled || !secret) return false;
  const delta = makeTotp(secret, user.username).validate({
    token: String(code || '').replace(/\s+/g, ''),
    window: 1, // ±30s clock skew
  });
  return delta !== null;
}

/** Accept a TOTP code or an unused backup code (marks it used). */
export function verifySecondFactor(userId, code) {
  if (verifyTotpCode(userId, code)) return { method: 'totp' };
  const clean = String(code || '').replace(/\s+/g, '');
  // Backup codes are bcrypt hashes; legacy rows are unsalted SHA-256 and get
  // upgraded to bcrypt on first successful use.
  const candidates = db
    .prepare('SELECT id, code_hash FROM totp_backup_codes WHERE user_id = ? AND used_at IS NULL')
    .all(userId);
  for (const r of candidates) {
    let ok = false;
    if (String(r.code_hash).startsWith('$2')) {
      ok = bcrypt.compareSync(clean, r.code_hash);
    } else if (sha256(clean) === r.code_hash) {
      ok = true;
      db.prepare('UPDATE totp_backup_codes SET code_hash = ? WHERE id = ?')
        .run(bcrypt.hashSync(clean, 10), r.id);
    }
    if (ok) {
      db.prepare('UPDATE totp_backup_codes SET used_at = ? WHERE id = ?').run(Date.now(), r.id);
      return { method: 'backup_code' };
    }
  }
  return null;
}

/** Issue a single-use login challenge after a correct password when 2FA is on. */
export function createLoginChallenge(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  challenges.set(token, { userId, expiresAt: Date.now() + CHALLENGE_TTL_MS });
  return token;
}

/** Consume a challenge token → userId, or null when missing/expired/used. */
export function consumeLoginChallenge(token) {
  if (!token) return null;
  const c = challenges.get(String(token));
  if (!c) return null;
  challenges.delete(String(token));
  if (c.expiresAt <= Date.now()) return null;
  return c.userId;
}
