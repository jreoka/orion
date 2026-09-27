// Orion passkeys (WebAuthn): registration + authentication via
// @simplewebauthn/server. Credentials store the public key only —
// private material never touches this server.
import crypto from 'node:crypto';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { db } from './db.js';
import { httpError, avatarUrlFor } from './auth.js';

const RP_NAME = 'Orion';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

// token -> { challenge, userId|null, type: 'register'|'login', expiresAt }
const challenges = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [token, c] of challenges) {
    if (c.expiresAt <= now) challenges.delete(token);
  }
}, 60 * 1000).unref?.();

function takeChallenge(token, type) {
  const c = challenges.get(String(token || ''));
  if (!c || c.type !== type) return null;
  challenges.delete(String(token));
  if (c.expiresAt <= Date.now()) return null;
  return c;
}

/** rpID from the Host header (no port); origin http for localhost, https otherwise. */
export function rpParams(req) {
  const rawHost = String(req.headers.host || '') || 'localhost';
  // Strip the port — careful with IPv6 literals like [::1]:8080, where a
  // naive split(':')[0] yields '['.
  const host = rawHost.startsWith('[')
    ? rawHost.slice(0, rawHost.indexOf(']') + 1)
    : rawHost.split(':')[0];
  const bare = host.replace(/^\[|\]$/g, '');
  const local = bare === 'localhost' || bare === '127.0.0.1' || bare === '::1';
  return { rpID: bare, expectedOrigin: `${local ? 'http' : 'https'}://${rawHost}` };
}

function userCredentials(userId) {
  return db.prepare('SELECT * FROM passkey_credentials WHERE user_id = ? ORDER BY created_at').all(userId);
}

function toAuthCredential(row) {
  return {
    id: row.credential_id,
    publicKey: new Uint8Array(Buffer.from(row.public_key, 'base64')),
    counter: row.counter,
    transports: row.transports ? JSON.parse(row.transports) : undefined,
  };
}

// ---- registration ---------------------------------------------------------

export async function registrationOptions(req, user) {
  const { rpID } = rpParams(req);
  const existing = userCredentials(user.id).map((c) => ({
    id: c.credential_id,
    transports: c.transports ? JSON.parse(c.transports) : undefined,
  }));
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: user.username,
    userID: new TextEncoder().encode(`orion:${user.id}`),
    userDisplayName: user.username,
    attestationType: 'none',
    excludeCredentials: existing,
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });
  const token = crypto.randomBytes(32).toString('hex');
  challenges.set(token, { challenge: options.challenge, userId: user.id, type: 'register', expiresAt: Date.now() + CHALLENGE_TTL_MS });
  return { token, options };
}

export async function verifyRegistration(req, user, token, response, name) {
  const c = takeChallenge(token, 'register');
  if (!c || c.userId !== user.id) throw httpError(401, 'Registration challenge expired — try again');
  const { rpID, expectedOrigin } = rpParams(req);
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: c.challenge,
      expectedOrigin,
      expectedRPID: rpID,
      requireUserVerification: false,
    });
  } catch (e) {
    throw httpError(400, `Passkey registration failed: ${e.message}`);
  }
  if (!verification.verified || !verification.registrationInfo) {
    throw httpError(400, 'Passkey registration failed: not verified');
  }
  const cred = verification.registrationInfo.credential;
  const credentialId = cred.id; // base64url
  const publicKey = Buffer.from(cred.publicKey).toString('base64');
  const transports = response.transports || cred.transports || [];
  try {
    db.prepare(
      'INSERT INTO passkey_credentials (user_id, credential_id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(user.id, credentialId, publicKey, cred.counter ?? 0, JSON.stringify(transports), String(name || 'Passkey').slice(0, 40), Date.now());
  } catch (e) {
    if (String(e.message).includes('UNIQUE constraint failed')) {
      throw httpError(409, 'This passkey is already registered');
    }
    throw e;
  }
  return { ok: true };
}

export function listPasskeys(userId) {
  return db
    .prepare('SELECT id, name, created_at FROM passkey_credentials WHERE user_id = ? ORDER BY created_at')
    .all(userId);
}

export function deletePasskey(userId, id) {
  const info = db.prepare('DELETE FROM passkey_credentials WHERE id = ? AND user_id = ?').run(id, userId);
  if (!info.changes) throw httpError(404, 'Passkey not found');
}

// ---- authentication -------------------------------------------------------

export async function authenticationOptions(req, username) {
  const { rpID } = rpParams(req);
  let allowCredentials = [];
  let userId = null;
  if (username) {
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (user && !user.disabled) {
      userId = user.id;
      allowCredentials = userCredentials(user.id).map((c) => ({
        id: c.credential_id,
        transports: c.transports ? JSON.parse(c.transports) : undefined,
      }));
    }
    // Unknown/disabled username: still return options with no allowCredentials
    // so we don't leak which usernames exist.
  }
  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials,
    // Accounts with TOTP enabled opted into stronger auth: require the
    // authenticator's user verification (biometric/PIN) so a bare passkey
    // tap can't silently bypass the second factor.
    userVerification: userId && db.prepare('SELECT totp_enabled FROM users WHERE id = ?').get(userId)?.totp_enabled
      ? 'required'
      : 'preferred',
  });
  const token = crypto.randomBytes(32).toString('hex');
  challenges.set(token, { challenge: options.challenge, userId, type: 'login', expiresAt: Date.now() + CHALLENGE_TTL_MS });
  return { token, options };
}

export async function verifyAuthentication(req, token, response) {
  const c = takeChallenge(token, 'login');
  if (!c) throw httpError(401, 'Login challenge expired — try again');
  const { rpID, expectedOrigin } = rpParams(req);
  const rawId = response.rawId || response.id;
  // Find the credential: prefer the challenge-bound user, else global lookup
  // (discoverable credentials).
  let row = null;
  if (c.userId) {
    row = db.prepare('SELECT * FROM passkey_credentials WHERE user_id = ? AND credential_id = ?').get(c.userId, rawId);
  } else {
    row = db.prepare(
      `SELECT pc.*, u.disabled FROM passkey_credentials pc JOIN users u ON u.id = pc.user_id WHERE pc.credential_id = ?`
    ).get(rawId);
  }
  if (!row || row.disabled) throw httpError(401, 'Unknown passkey');
  // TOTP-enabled accounts require real user verification on the passkey —
  // otherwise the passkey would silently bypass the second factor.
  const preUser = db.prepare('SELECT totp_enabled FROM users WHERE id = ?').get(row.user_id);
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: c.challenge,
      expectedOrigin,
      expectedRPID: rpID,
      credential: toAuthCredential(row),
      requireUserVerification: !!preUser?.totp_enabled,
    });
  } catch (e) {
    throw httpError(401, `Passkey verification failed: ${e.message}`);
  }
  if (!verification.verified) throw httpError(401, 'Passkey verification failed');
  const newCounter = verification.authenticationInfo?.newCounter ?? row.counter;
  db.prepare('UPDATE passkey_credentials SET counter = ? WHERE id = ?').run(newCounter, row.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  if (!user || user.disabled) throw httpError(401, 'Account unavailable');
  if (user.abuse_locked) throw httpError(403, 'Account locked — contact your administrator.');
  return { id: user.id, username: user.username, role: user.role, avatar_url: avatarUrlFor(user.id) };
}
