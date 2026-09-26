// Orion push notifications: Web Push (VAPID) for mobile + desktop.
// VAPID keys are generated once on first use and stored in the settings
// table (the private key is never exposed via the API).
import webpush from 'web-push';
import { db, getSetting, setSetting } from './db.js';
import { httpError } from './auth.js';
import { subscriberCount } from './events.js';

let vapidReady = false;

/** Generate (once) and cache the VAPID keypair; returns { publicKey }. */
export function ensureVapidKeys() {
  let pub = getSetting('vapid_public_key', '');
  let priv = getSetting('vapid_private_key', '');
  if (!pub || !priv) {
    const keys = webpush.generateVAPIDKeys();
    setSetting('vapid_public_key', keys.publicKey);
    setSetting('vapid_private_key', keys.privateKey);
    pub = keys.publicKey;
    priv = keys.privateKey;
    console.log('[orion] generated VAPID keypair for push notifications');
  }
  if (!vapidReady) {
    webpush.setVapidDetails('mailto:orion@localhost', pub, priv);
    vapidReady = true;
  }
  return { publicKey: pub };
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
  db.prepare(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       user_id = excluded.user_id,
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
  const payload = JSON.stringify({
    title: title || 'Orion',
    body: body || '',
    url: '/#/chat',
  });
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload
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
