// Orion push notifications: Web Push (VAPID) for mobile + desktop.
// VAPID keys are generated once on first use and stored in a 0600 file in
// the data dir (NOT the settings table — a DB read must never yield the
// private key). The private key is never exposed via the API.
import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import { db, DATA_DIR, getSetting, deleteSetting } from './db.js';
import { httpError } from './auth.js';
import { subscriberCount } from './events.js';

const VAPID_PATH = path.join(DATA_DIR, 'vapid.json');

let vapidReady = false;

/** Generate (once) and cache the VAPID keypair; returns { publicKey }. */
export function ensureVapidKeys() {
  let keys = null;
  try {
    keys = JSON.parse(fs.readFileSync(VAPID_PATH, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  // Migrate from the old settings-table storage (pre-hardening), then drop
  // the private key from the DB so a settings read can never yield it.
  // The DB copy is deleted only AFTER the file write is verified — if the
  // write fails, the DB key must survive so the next boot can retry instead
  // of generating a fresh keypair (which would silently break every existing
  // push subscription).
  let migratedFromDb = false;
  if (!keys?.publicKey || !keys?.privateKey) {
    const pub = getSetting('vapid_public_key', '');
    const priv = getSetting('vapid_private_key', '');
    if (pub && priv) {
      keys = { publicKey: pub, privateKey: priv };
      migratedFromDb = true;
    }
  }
  if (!keys?.publicKey || !keys?.privateKey) {
    keys = webpush.generateVAPIDKeys();
    console.log('[orion] generated VAPID keypair for push notifications');
  }
  try {
    fs.writeFileSync(VAPID_PATH, JSON.stringify(keys), { mode: 0o600 });
    try { fs.chmodSync(VAPID_PATH, 0o600); } catch { /* best effort */ }
    // Verify the write before dropping the DB copy.
    const back = JSON.parse(fs.readFileSync(VAPID_PATH, 'utf8'));
    if (
      migratedFromDb &&
      back?.publicKey === keys.publicKey &&
      back?.privateKey === keys.privateKey
    ) {
      try {
        deleteSetting('vapid_private_key');
      } catch { /* best effort */ }
    }
  } catch (e) {
    console.warn('[orion] could not persist VAPID keys:', e?.message || e);
  }
  if (!vapidReady) {
    webpush.setVapidDetails('mailto:notifications@orion.dill.moe', keys.publicKey, keys.privateKey);
    vapidReady = true;
  }
  return { publicKey: keys.publicKey };
}

export function getVapidPublicKey() {
  return ensureVapidKeys().publicKey;
}

function validSubscription(sub) {
  return (
    sub &&
    typeof sub.endpoint === 'string' &&
    sub.endpoint.startsWith('https://') &&
    sub.keys &&
    typeof sub.keys.p256dh === 'string' &&
    typeof sub.keys.auth === 'string'
  );
}

/** Store (or refresh) a push subscription for a user. */
export function saveSubscription(userId, subscription) {
  if (!validSubscription(subscription)) {
    throw httpError(400, 'Invalid push subscription');
  }
  const now = Date.now();
  // An endpoint belongs to whoever registered it first: another user
  // re-submitting the same endpoint must NOT steal the row (that would
  // reroute the victim's notifications to the attacker's account).
  const existing = db
    .prepare('SELECT user_id FROM push_subscriptions WHERE endpoint = ?')
    .get(subscription.endpoint);
  if (existing && existing.user_id !== userId) {
    throw httpError(409, 'This push subscription belongs to another account');
  }
  db.prepare(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       p256dh = excluded.p256dh,
       auth = excluded.auth`
  ).run(userId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, now);
  return { ok: true };
}

export function deleteSubscription(userId, endpoint) {
  db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?')
    .run(userId, String(endpoint || ''));
  return { ok: true };
}

export function listSubscriptions(userId) {
  return db
    .prepare('SELECT endpoint, p256dh, auth, created_at FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId);
}

/**
 * Send a push notification to all of a user's subscribed devices.
 * No-op when the user has no subscriptions. Dead endpoints (410/404)
 * are pruned. Never throws — push must not break agent runs.
 */
export async function notifyUser(userId, { title, body, convId } = {}) {
  try {
    ensureVapidKeys();
  } catch (e) {
    console.warn('[orion] push skipped (VAPID unavailable):', e?.message || e);
    return { sent: 0 };
  }
  const subs = listSubscriptions(userId);
  if (!subs.length) return { sent: 0 };
  const url = convId ? `/chat/${convId}` : '/chat';
  const payload = JSON.stringify({
    title: title || 'Orion',
    body: body || '',
    url,
  });
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload
        // Default (normal) urgency: nothing here is worth waking a
        // dozing device or camping on screen for.
      );
      sent++;
    } catch (e) {
      if (e?.statusCode === 404 || e?.statusCode === 410) {
        // Subscription is dead — prune it quietly.
        try {
          db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(s.endpoint);
        } catch {
          /* ignore */
        }
      } else {
        console.warn('[orion] push send failed:', e?.message || e);
      }
    }
  }
  return { sent };
}

/**
 * Notify about a conversation only when the user is NOT watching it live
 * (no active event-stream subscriber). Returns { sent, suppressed }.
 */
export async function notifyConversation(userId, conversationId, { title, body }) {
  if (subscriberCount(conversationId) > 0) return { sent: 0, suppressed: true };
  const r = await notifyUser(userId, { title, body, convId: conversationId });
  return { sent: r.sent, suppressed: false };
}
