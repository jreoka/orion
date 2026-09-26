// Orion heartbeat: a periodic proactive check-in per user. When enabled,
// every 30 minutes we run the agent against the user's dedicated
// heartbeat conversation with a quiet-instruction: if nothing needs the
// user's attention the model replies HEARTBEAT_QUIET and we throw the whole
// check away (no notification noise, no history clutter).
import { db, getSetting, getOrCreateMainConversation } from './db.js';
import { httpError } from './auth.js';
import { runAgent } from './agent.js';
import { tryAcquireRun, releaseRun, isStopRequested, clearStop } from './runlock.js';
import { registerController, unregisterController, chainPendingUserMessages } from './runs.js';
import { notifyConversation } from './push.js';

const CHECK_MS = 5 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000; // fixed: no user option
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
    interval_minutes: 30,
    prompt: row?.heartbeat_prompt ?? '',
  };
}

export function putHeartbeatSettings(userId, body) {
  const { enabled, prompt } = body || {};
  if (typeof enabled !== 'boolean') throw httpError(400, 'enabled must be a boolean');
  const p = String(prompt ?? '').slice(0, 2000);
  db.prepare(
    `INSERT INTO user_settings (user_id, heartbeat_enabled, heartbeat_prompt)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       heartbeat_enabled = excluded.heartbeat_enabled,
       heartbeat_prompt = excluded.heartbeat_prompt`
  ).run(userId, enabled ? 1 : 0, p);
  return getHeartbeatSettings(userId);
}

export async function runHeartbeatFor(userId) {
  const s = getHeartbeatSettings(userId);
  if (!s.enabled) return { ok: false, reason: 'disabled' };

  const convId = getOrCreateMainConversation(userId);
  if (!tryAcquireRun(convId)) {
    console.log(`[orion] heartbeat for user ${userId} skipped: main chat busy`);
    return { ok: false, reason: 'busy' };
  }

  const maxIdBefore = db
    .prepare('SELECT COALESCE(MAX(id), 0) AS m FROM messages WHERE conversation_id = ?')
    .get(convId).m;

  const controller = registerController(convId);
  let userMsgId = null;
  let finalText = '';
  try {
    const r = await runAgent({
      userId,
      conversationId: convId,
      userText: s.prompt || DEFAULT_PROMPT,
      settings: globalSettings(),
      shouldAbort: () => isStopRequested(convId),
      signal: controller.signal,
      systemExtra: HEARTBEAT_SYSTEM_EXTRA,
      historyLimit: 20,
    });
    finalText = r?.finalText || '';
    userMsgId = r?.userMsgId ?? null;

    const now = Date.now();
    if ((finalText || '').trim() === 'HEARTBEAT_QUIET') {
      // Nothing to report: delete the check's own messages (and their
      // attachments) so the main chat stays clean — but never touch
      // messages the user sent mid-check.
      const ids = db
        .prepare(
          `SELECT id FROM messages WHERE conversation_id = ? AND id > ?
           AND (role != 'user' OR id = ?)`
        )
        .all(convId, maxIdBefore, userMsgId ?? -1)
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
    // The heartbeat had something to say: ping the user if they aren't
    // watching the chat live.
    try {
      const snippet = String(finalText || '').replace(/\s+/g, ' ').trim().slice(0, 140);
      await notifyConversation(userId, convId, { title: 'Orion', body: `Heartbeat: ${snippet}` });
    } catch (e) {
      console.warn('[orion] heartbeat push failed:', e?.message || e);
    }
    return { ok: true, quiet: false };
  } catch (e) {
    console.error(`[orion] heartbeat for user ${userId} threw:`, e?.message || e);
    return { ok: false, reason: 'error' };
  } finally {
    unregisterController(convId);
    clearStop(convId);
    releaseRun(convId);
    // The user may have written into the main chat mid-check: answer them.
    try {
      chainPendingUserMessages(convId, userId, maxIdBefore, userMsgId);
    } catch (e) {
      console.error(`[orion] heartbeat chain for user ${userId} failed:`, e?.message || e);
    }
  }
}

async function checkHeartbeats() {
  const now = Date.now();
  const rows = db
    .prepare('SELECT user_id, last_heartbeat_at FROM user_settings WHERE heartbeat_enabled = 1')
    .all();
  for (const r of rows) {
    if (r.last_heartbeat_at && now - r.last_heartbeat_at < HEARTBEAT_INTERVAL_MS) continue;
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
