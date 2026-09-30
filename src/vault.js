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
const MAX_FIELDS = 10;
const FIELD_NAME_RE = /^[a-z_][a-z0-9_]{0,39}$/;
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

/**
 * Validate the agent-supplied field list for a multi-field vault form.
 * Returns the cleaned array, or null when no fields were given (legacy
 * single-value form). Throws on invalid definitions.
 */
export function cleanVaultFields(fields) {
  if (fields === undefined || fields === null) return null;
  if (!Array.isArray(fields)) throw new Error('vault_request: fields must be an array');
  if (!fields.length || fields.length > MAX_FIELDS) {
    throw new Error(`vault_request: fields must have 1–${MAX_FIELDS} entries`);
  }
  const seen = new Set();
  return fields.map((f, i) => {
    const name = String(f?.name ?? '').trim();
    const label = String(f?.label ?? '').trim().slice(0, 120);
    if (!FIELD_NAME_RE.test(name)) {
      throw new Error(`vault_request: fields[${i}].name must match ${FIELD_NAME_RE} (e.g. "api_key")`);
    }
    if (seen.has(name)) throw new Error(`vault_request: duplicate field name "${name}"`);
    seen.add(name);
    if (!label) throw new Error(`vault_request: fields[${i}].label is required`);
    return { name, label };
  });
}

/** Parse the stored fields JSON for a request/item row (null = single value). */
export function parseVaultFields(row) {
  if (!row?.fields) return null;
  try {
    const arr = JSON.parse(row.fields);
    return Array.isArray(arr) && arr.length ? arr : null;
  } catch {
    return null;
  }
}

/** Create a pending secret request. Returns the request id (unguessable). */
export function createVaultRequest(userId, conversationId, label, hint = '', fields = null) {
  const cleanLabel = String(label ?? '').trim().slice(0, 120);
  if (!cleanLabel) throw new Error('vault_request: label is required');
  const cleanHint = String(hint ?? '').trim().slice(0, 500);
  const cleanFields = cleanVaultFields(fields);
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO vault_requests (id, user_id, conversation_id, label, hint, fields, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).run(id, userId, conversationId, cleanLabel, cleanHint, cleanFields ? JSON.stringify(cleanFields) : null, now, now + REQUEST_TTL_MS);
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
 * Fulfill a pending request with the user's secret(s). Only the owning user
 * can fulfill; single-use; expires. Multi-field requests store ONE vault
 * item whose encrypted blob is a JSON object of field values; legacy
 * requests store one plaintext value. Returns the new vault item id.
 */
export function fulfillVaultRequest(userId, requestId, payload = {}) {
  const req = getVaultRequest(requestId);
  if (!req || req.user_id !== userId) throw new Error('request not found');
  if (req.status !== 'pending') throw new Error(`request is ${req.status}`);
  if (req.expires_at < Date.now()) {
    db.prepare(`UPDATE vault_requests SET status = 'expired' WHERE id = ?`).run(requestId);
    throw new Error('request expired — ask the agent for a new one');
  }
  const fields = parseVaultFields(req);
  let blob;
  let fieldsJson = null;
  if (fields) {
    const values = payload?.values;
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      throw new Error('field values are required');
    }
    const clean = {};
    for (const f of fields) {
      const v = String(values[f.name] ?? '');
      if (!v) throw new Error(`“${f.label}” is required`);
      if (Buffer.byteLength(v, 'utf8') > MAX_SECRET_BYTES) {
        throw new Error(`“${f.label}” is too long (max 8KB)`);
      }
      clean[f.name] = v;
    }
    // Ignore any extra keys the client sent that weren't requested.
    blob = JSON.stringify(clean);
    fieldsJson = JSON.stringify(fields);
  } else {
    const secret = String(payload?.value ?? '');
    if (!secret) throw new Error('value is required');
    if (Buffer.byteLength(secret, 'utf8') > MAX_SECRET_BYTES) throw new Error('value too long (max 8KB)');
    blob = secret;
  }
  const itemId = crypto.randomUUID();
  const now = Date.now();
  db.prepare(
    'INSERT INTO vault_items (id, user_id, label, secret_enc, fields, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(itemId, userId, req.label, encryptSecret(blob), fieldsJson, now);
  db.prepare(`UPDATE vault_requests SET status = 'fulfilled', item_id = ? WHERE id = ?`).run(itemId, requestId);
  return { itemId, request: req, fields };
}

/** Metadata only — values never leave the vault except into exec env. */
export function listVaultItems(userId) {
  pruneExpiredRequests();
  return db
    .prepare('SELECT id, label, fields, created_at FROM vault_items WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId);
}

export function deleteVaultItem(userId, id) {
  const info = db.prepare('DELETE FROM vault_items WHERE id = ? AND user_id = ?').run(String(id), userId);
  return info.changes > 0;
}

export function renameVaultItem(userId, id, label) {
  const clean = String(label || '').trim().slice(0, 120);
  if (!clean) return false;
  const info = db.prepare('UPDATE vault_items SET label = ? WHERE id = ? AND user_id = ?').run(clean, String(id), userId);
  return info.changes > 0;
}

/**
 * Wipe a user's entire vault (all stored items) and expire their pending
 * requests. Used by sandbox reset — a fresh sandbox shouldn't inherit old
 * secrets, and a stale request iframe must not re-populate the vault
 * right after the wipe. The global vault key is untouched (rotating it
 * would invalidate every other user's items on this box).
 */
export function clearUserVault(userId) {
  const items = db.prepare('DELETE FROM vault_items WHERE user_id = ?').run(userId);
  db.prepare(`UPDATE vault_requests SET status = 'expired' WHERE user_id = ? AND status = 'pending'`).run(userId);
  return items.changes;
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
 * Server-side only: resolve one field of a multi-field vault item.
 * Throws a helpful error for single-value items or unknown fields.
 */
export function getVaultFieldSecret(userId, id, field) {
  const row = db
    .prepare('SELECT secret_enc, fields, label FROM vault_items WHERE id = ? AND user_id = ?')
    .get(String(id), userId);
  if (!row) throw new Error('vault item not found');
  const fields = parseVaultFields(row);
  if (!fields) throw new Error(`vault item "${row.label}" holds a single value — use "vault:${id}" without a field`);
  const def = fields.find((f) => f.name === field);
  if (!def) {
    throw new Error(`vault item "${row.label}" has no field "${field}" (fields: ${fields.map((f) => f.name).join(', ')})`);
  }
  let obj;
  try {
    obj = JSON.parse(decryptSecret(row.secret_enc));
  } catch {
    throw new Error(`vault item "${row.label}" is corrupt`);
  }
  const value = obj?.[field];
  if (typeof value !== 'string' || !value) throw new Error(`vault item "${row.label}" has no stored value for "${field}"`);
  return value;
}

/** Human-readable field summary for listings, e.g. ' [username, password]'. */
export function vaultFieldSummary(row) {
  const fields = parseVaultFields(row);
  return fields ? ` [${fields.map((f) => f.name).join(', ')}]` : '';
}

/**
 * Resolve an exec env object. Values may be plain strings or vault
 * references: "vault:<id>" for a whole item, or "vault:<id>:<field>"
 * for one field of a multi-field item. Returns docker-style KEY=value
 * entries plus the plaintext secrets so the caller can redact them
 * from output.
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
      const ref = value.slice(VAULT_REF_PREFIX.length);
      const sep = ref.indexOf(':');
      if (sep === -1) {
        // Whole-item reference. For multi-field items this would inject
        // the raw JSON blob — refuse and point at the field form instead.
        const row = db
          .prepare('SELECT id, fields, label FROM vault_items WHERE id = ? AND user_id = ?')
          .get(ref, userId);
        if (!row) throw new Error('vault item not found');
        const fields = parseVaultFields(row);
        if (fields) {
          throw new Error(
            `vault item "${row.label}" holds multiple fields (${fields.map((f) => f.name).join(', ')}) — ` +
            `use "vault:${ref}:<field>"`
          );
        }
        const secret = getVaultSecret(userId, ref);
        env.push(`${name}=${secret}`);
        secrets.push(secret);
      } else {
        const secret = getVaultFieldSecret(userId, ref.slice(0, sep), ref.slice(sep + 1));
        env.push(`${name}=${secret}`);
        secrets.push(secret);
      }
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
