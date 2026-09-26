// Orion vault: server-side encrypted secret storage.
//
// Threat model: anything the user types into chat is visible to the
// underlying LLM provider. The vault gives the agent a way to collect
// credentials (API keys, tokens, passwords) WITHOUT them ever entering
// model context:
//
//   1. The agent calls the vault_request tool -> the user gets a secure
//      in-chat form (same-origin page, session-authenticated).
//   2. The form POSTs the secret straight to the server, which encrypts
//      it with AES-256-GCM (key lives in the VM data dir, 0600) and
//      stores only ciphertext in SQLite.
//   3. The agent only ever sees a handle: "vault:<id>". When it needs
//      the value (e.g. as an env var for exec), it passes the handle;
//      the server resolves it at spawn time and scrubs the value from
//      any output before it reaches the model.
//
// Plaintext values never leave this module except into a sandbox exec
// environment. Nothing here is ever logged.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, DATA_DIR } from './db.js';

const KEY_PATH = path.join(DATA_DIR, 'vault.key');
const REQUEST_TTL_MS = 15 * 60 * 1000;
const MAX_SECRET_BYTES = 8 * 1024;
const MAX_ENV_VARS = 20;
export const VAULT_REF_PREFIX = 'vault:';

let keyCache = null;

function loadKey() {
  if (keyCache) return keyCache;
  try {
    const raw = fs.readFileSync(KEY_PATH);
    if (raw.length !== 32) throw new Error('bad vault key length');
    keyCache = raw;
    return keyCache;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    // First boot: generate and persist the key. Losing this file means
    // losing the vault contents — that is the intended trade-off.
    const k = crypto.randomBytes(32);
    fs.writeFileSync(KEY_PATH, k, { mode: 0o600 });
    try { fs.chmodSync(KEY_PATH, 0o600); } catch { /* best effort */ }
    keyCache = k;
    return keyCache;
  }
}

export function encryptSecret(plaintext) {
  const key = loadKey();
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${nonce.toString('base64')}:${Buffer.concat([ct, tag]).toString('base64')}`;
}

export function decryptSecret(blob) {
  const key = loadKey();
  const parts = String(blob).split(':');
  if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('unknown vault blob version');
  const nonce = Buffer.from(parts[1], 'base64');
  const data = Buffer.from(parts[2], 'base64');
  if (nonce.length !== 12 || data.length < 16) throw new Error('corrupt vault blob');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]).toString('utf8');
}

/** Create a pending secret request. Returns the request id (unguessable). */
export function createVaultRequest(userId, conversationId, label, hint = '') {
  const cleanLabel = String(label ?? '').trim().slice(0, 120);
  if (!cleanLabel) throw new Error('vault_request: label is required');
  const cleanHint = String(hint ?? '').trim().slice(0, 500);
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO vault_requests (id, user_id, conversation_id, label, hint, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).run(id, userId, conversationId, cleanLabel, cleanHint, now, now + REQUEST_TTL_MS);
  return id;
}

export function getVaultRequest(id) {
  return db.prepare('SELECT * FROM vault_requests WHERE id = ?').get(String(id)) || null;
}

/** Mark expired pending requests so the UI can show them as such. */
export function pruneExpiredRequests() {
  try {
    db.prepare(
      `UPDATE vault_requests SET status = 'expired' WHERE status = 'pending' AND expires_at < ?`
    ).run(Date.now());
  } catch { /* never break a request path on prune */ }
}

/**
 * Fulfill a pending request with the user's secret. Only the owning user
 * can fulfill; single-use; expires. Returns the new vault item id.
 */
export function fulfillVaultRequest(userId, requestId, value) {
  const req = getVaultRequest(requestId);
  if (!req || req.user_id !== userId) throw new Error('request not found');
  if (req.status !== 'pending') throw new Error(`request is ${req.status}`);
  if (req.expires_at < Date.now()) {
    db.prepare(`UPDATE vault_requests SET status = 'expired' WHERE id = ?`).run(requestId);
    throw new Error('request expired — ask the agent for a new one');
  }
  const secret = String(value ?? '');
  if (!secret) throw new Error('value is required');
  if (Buffer.byteLength(secret, 'utf8') > MAX_SECRET_BYTES) throw new Error('value too long (max 8KB)');
  const itemId = crypto.randomUUID();
  const now = Date.now();
  db.prepare(
    'INSERT INTO vault_items (id, user_id, label, secret_enc, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(itemId, userId, req.label, encryptSecret(secret), now);
  db.prepare(`UPDATE vault_requests SET status = 'fulfilled', item_id = ? WHERE id = ?`).run(itemId, requestId);
  return { itemId, request: req };
}

/** Metadata only — values never leave the vault except into exec env. */
export function listVaultItems(userId) {
  pruneExpiredRequests();
  return db
    .prepare('SELECT id, label, created_at FROM vault_items WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId);
}

export function deleteVaultItem(userId, id) {
  const info = db.prepare('DELETE FROM vault_items WHERE id = ? AND user_id = ?').run(String(id), userId);
  return info.changes > 0;
}

/** Server-side only: resolve one handle to its plaintext value. */
export function getVaultSecret(userId, id) {
  const row = db
    .prepare('SELECT secret_enc FROM vault_items WHERE id = ? AND user_id = ?')
    .get(String(id), userId);
  if (!row) throw new Error('vault item not found');
  return decryptSecret(row.secret_enc);
}

/**
 * Resolve an exec env object. Values may be plain strings or vault
 * references ("vault:<id>"). Returns docker-style KEY=value entries plus
 * the plaintext secrets so the caller can redact them from output.
 */
export function resolveVaultEnv(userId, envObj) {
  const env = [];
  const secrets = [];
  if (!envObj || typeof envObj !== 'object') return { env, secrets };
  const entries = Object.entries(envObj);
  if (entries.length > MAX_ENV_VARS) throw new Error(`too many env vars (max ${MAX_ENV_VARS})`);
  for (const [name, raw] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`invalid env var name: ${name}`);
    const value = String(raw ?? '');
    if (value.startsWith(VAULT_REF_PREFIX)) {
      const secret = getVaultSecret(userId, value.slice(VAULT_REF_PREFIX.length));
      env.push(`${name}=${secret}`);
      secrets.push(secret);
    } else {
      env.push(`${name}=${value}`);
    }
  }
  return { env, secrets };
}

/** Scrub known secret values from text before it reaches the model. */
export function redactSecrets(text, secrets) {
  let out = String(text ?? '');
  if (!out || !secrets || !secrets.length) return out;
  const sorted = [...new Set(secrets)].filter((s) => s).sort((a, b) => b.length - a.length);
  for (const s of sorted) {
    if (s.length < 4) continue; // avoid nuking common short strings
    out = out.split(s).join('[vault:redacted]');
  }
  return out;
}
