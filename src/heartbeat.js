// Orion heartbeat: a periodic proactive check-in per user. When enabled,
// every interval_hours we run the agent against the user's dedicated
// heartbeat conversation with a quiet-instruction: if nothing needs the
// user's attention the model replies HEARTBEAT_QUIET and we throw the whole
// check away (no notification noise, no history clutter).
import { db, getSetting } from './db.js';
import { httpError } from './auth.js';
import { runAgent } from './agent.js';
import { tryAcquireRun, releaseRun, isStopRequested, clearStop } from './runlock.js';
import { registerController, unregisterController } from './runs.js';

const CHECK_MS = 5 * 60 * 1000;
const DEFAULT_PROMPT =
  'Check in: review the recent conversation and tell me anything that needs my attention.';
const HEARTBEAT_SYSTEM_EXTRA =
  'This is a scheduled heartbeat check. If nothing needs the user\'s attention, reply with exactly: HEARTBEAT_QUIET and nothing else.';

function globalSettings() {
  return {
    base_url: getSetting('base_url', ''),
    api_key: getSetting('api_key', ''),
    model: getSetting('model', ''),
  };
}

export function getHeartbeatSettings(userId) {
  const row = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId);
  return {
    enabled: !!row?.heartbeat_enabled,
    interval_hours: row?.heartbeat_interval_hours ?? 6,
    prompt: row?.heartbeat_prompt ?? '',
  };
}

export function putHeartbeatSettings(userId, body) {
  const { enabled, interval_hours, prompt } = body || {};
  if (typeof enabled !== 'boolean') throw httpError(400, 'enabled must be a boolean');
  const h = Number(interval_hours);
  if (!Number.isFinite(h) || h < 1 || h > 168) {
    throw httpError(400, 'interval_hours must be 1–168');
  }
  const p = String(prompt ?? '').slice(0, 2000);
  db.prepare(
    `INSERT INTO user_settings (user_id, heartbeat_enabled, heartbeat_interval_hours, heartbeat_prompt)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       heartbeat_enabled = excluded.heartbeat_enabled,
       heartbeat_interval_hours = excluded.heartbeat_interval_hours,
       heartbeat_prompt = excluded.heartbeat_prompt`
  ).run(userId, enabled ? 1 : 0, Math.floor(h), p);
  return getHeartbeatSettings(userId);
}

function getOrCreateHeartbeatConversation(userId) {
  const existing = db
    .prepare("SELECT id FROM conversations WHERE user_id = ? AND kind = 'heartbeat'")
    .get(userId);
  if (existing) return existing.id;
  const now = Date.now();
  return Number(
    db
      .prepare(
        "INSERT INTO conversations (user_id, title, kind, created_at, updated_at) VALUES (?, 'Heartbeat', 'heartbeat', ?, ?)"
      )
      .run(userId, now, now).lastInsertRowid
  );
}

export async function runHeartbeatFor(userId) {
  const s = getHeartbeatSettings(userId);
  if (!s.enabled) return { ok: false, reason: 'disabled' };

  const convId = getOrCreateHeartbeatConversation(userId);
  if (!tryAcquireRun(convId)) {
    console.log(`[orion] heartbeat for user ${userId} skipped: conversation ${convId} busy`);
    return { ok: false, reason: 'busy' };
  }

  const maxIdBefore = db
    .prepare('SELECT COALESCE(MAX(id), 0) AS m FROM messages WHERE conversation_id = ?')
    .get(convId).m;

  const controller = registerController(convId);
  try {
    const { finalText } = await runAgent({
      userId,
      conversationId: convId,
      userText: s.prompt || DEFAULT_PROMPT,
      settings: globalSettings(),
      shouldAbort: () => isStopRequested(convId),
      signal: controller.signal,
      systemExtra: HEARTBEAT_SYSTEM_EXTRA,
      historyLimit: 20,
    });

    const now = Date.now();
    if ((finalText || '').trim() === 'HEARTBEAT_QUIET') {
      // Nothing to report: delete the check's messages (and their
      // attachments) so the heartbeat conversation stays clean.
      const ids = db
        .prepare('SELECT id FROM messages WHERE conversation_id = ? AND id > ?')
        .all(convId, maxIdBefore)
        .map((r) => r.id);
      if (ids.length) {
        const ph = ids.map(() => '?').join(',');
        db.prepare(`DELETE FROM attachments WHERE message_id IN (${ph})`).run(...ids);
        db.prepare(`DELETE FROM messages WHERE id IN (${ph})`).run(...ids);
      }
      db.prepare('UPDATE user_settings SET last_heartbeat_at = ? WHERE user_id = ?').run(now, userId);
      return { ok: true, quiet: true };
    }
    db.prepare('UPDATE user_settings SET last_heartbeat_at = ? WHERE user_id = ?').run(now, userId);
    return { ok: true, quiet: false };
  } catch (e) {
    console.error(`[orion] heartbeat for user ${userId} threw:`, e?.message || e);
    return { ok: false, reason: 'error' };
  } finally {
    unregisterController(convId);
    clearStop(convId);
    releaseRun(convId);
  }
}

async function checkHeartbeats() {
  const now = Date.now();
  const rows = db
    .prepare(
      'SELECT user_id, heartbeat_interval_hours, last_heartbeat_at FROM user_settings WHERE heartbeat_enabled = 1'
    )
    .all();
  for (const r of rows) {
    const intervalMs = (r.heartbeat_interval_hours || 6) * 3600 * 1000;
    if (r.last_heartbeat_at && now - r.last_heartbeat_at < intervalMs) continue;
    try {
      await runHeartbeatFor(r.user_id);
    } catch (e) {
      console.error(`[orion] heartbeat for user ${r.user_id} failed:`, e?.message || e);
    }
  }
}

// Start the 5-minute ticker. Runs inside the server process; the interval is
// unref'd so tests importing the module don't hang on exit.
export function initHeartbeat() {
  setInterval(() => {
    checkHeartbeats().catch((e) => console.error('[orion] heartbeat check failed:', e?.message || e));
  }, CHECK_MS).unref?.();
  // No immediate fire: the first tick (≤5 min) picks up anything due.
}
