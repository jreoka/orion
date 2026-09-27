// Orion heartbeat: always on, every 30 minutes, no options. The check runs
// in the user's dedicated hidden heartbeat conversation — NEVER inside one
// of their real chats (a check that runs in a real chat posts follow-ups
// there). If nothing needs the user's attention the model replies
// HEARTBEAT_QUIET and we throw the whole check away (no notification noise,
// no history clutter).
import { db, getSetting, getOrCreateHeartbeatConversation } from './db.js';
import { runAgent } from './agent.js';
import { tryAcquireRun, releaseRun, isStopRequested, clearStop } from './runlock.js';
import { registerController, unregisterController, chainPendingUserMessages, trackExecStart, trackExecEnd, clearExecTracking } from './runs.js';
import { notifyConversation } from './push.js';

const CHECK_MS = 5 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000; // fixed: no user option
const DEFAULT_PROMPT =
  'Check in: review the recent conversation and tell me anything that still needs my attention.';
const HEARTBEAT_SYSTEM_EXTRA =
  'This is a scheduled heartbeat check. Only speak up about something that still needs the user\'s action or decision — an unfinished task, an unanswered question, a problem that is still open. Do not re-report past mistakes or incidents that were already fixed, acknowledged, or resolved; those need no attention and bringing them up again is noise. If nothing actionable remains, reply with exactly: HEARTBEAT_QUIET and nothing else.';

function globalSettings() {
  return {
    base_url: getSetting('base_url', ''),
    api_key: getSetting('api_key', ''),
    model: getSetting('model', ''),
  };
}

// Custom heartbeat instructions, if the user ever set any before the
// settings UI was removed. There is no toggle or interval: the heartbeat
// is always on, every 30 minutes.
function getHeartbeatPrompt(userId) {
  return db.prepare('SELECT heartbeat_prompt FROM user_settings WHERE user_id = ?').get(userId)
    ?.heartbeat_prompt || '';
}

function touchHeartbeatAt(userId, now) {
  db.prepare(
    `INSERT INTO user_settings (user_id, last_heartbeat_at)
     VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET last_heartbeat_at = excluded.last_heartbeat_at`
  ).run(userId, now);
}

function relTime(ts) {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// Compact digest of recent user-chat activity, so the check still has
// "recent conversation" context without ever running inside a real chat.
function recentActivityDigest(userId) {
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const convs = db
    .prepare(
      `SELECT id, title, updated_at FROM conversations
       WHERE user_id = ? AND kind = 'chat' AND updated_at > ?
       ORDER BY updated_at DESC LIMIT 5`
    )
    .all(userId, dayAgo);
  const lines = [];
  for (const c of convs) {
    const msgs = db
      .prepare(
        `SELECT role, substr(content, 1, 180) AS snippet FROM messages
         WHERE conversation_id = ? AND role IN ('user', 'assistant')
           AND content IS NOT NULL AND length(content) > 0
         ORDER BY id DESC LIMIT 4`
      )
      .all(c.id)
      .reverse();
    if (!msgs.length) continue;
    lines.push(`- "${c.title || 'Untitled'}" (${relTime(c.updated_at)}):`);
    for (const m of msgs) {
      lines.push(`  ${m.role}: ${String(m.snippet).replace(/\s+/g, ' ')}`);
    }
  }
  return lines.length ? '\n\nRecent chat activity:\n' + lines.join('\n') : '';
}

// Delete everything one heartbeat check wrote, except messages from the
// real user (they may have written mid-check). The injected prompt must
// never linger as a message the user "sent" — that is confusing. Partial
// heartbeat output from a failed check is scrubbed the same way.
function scrubHeartbeatMessages(convId, maxIdBefore, ownUserMsgId) {
  const ids = db
    .prepare(
      `SELECT id FROM messages WHERE conversation_id = ? AND id > ?
       AND (role != 'user' OR id = ?)`
    )
    .all(convId, maxIdBefore, ownUserMsgId ?? -1)
    .map((r) => r.id);
  if (!ids.length) return;
  const ph = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM attachments WHERE message_id IN (${ph})`).run(...ids);
  db.prepare(`DELETE FROM messages WHERE id IN (${ph})`).run(...ids);
  // The check's own vault widget dies with its message: delete the request
  // row(s) too, so they don't linger until the expiry sweep. The message_id
  // IS NULL arm catches a request created just before a crash between the
  // row INSERT and the message_id UPDATE — only this check's agent loop
  // could have written such rows (the run lock is per conversation).
  db.prepare(
    `DELETE FROM vault_requests WHERE conversation_id = ? AND (message_id IN (${ph}) OR message_id IS NULL)`
  ).run(convId, ...ids);
}

// Delete just the injected heartbeat prompt, keeping the assistant's
// report: the report then reads as Orion speaking up on its own, which is
// what actually happened.
function deleteHeartbeatPrompt(convId, userMsgId) {
  if (userMsgId == null) return;
  db.prepare('DELETE FROM attachments WHERE message_id = ?').run(userMsgId);
  db.prepare("DELETE FROM messages WHERE id = ? AND role = 'user'").run(userMsgId);
}

export async function runHeartbeatFor(userId) {
  const prompt = getHeartbeatPrompt(userId);
  // Dedicated hidden conversation: the check never touches the user's chats.
  const convId = getOrCreateHeartbeatConversation(userId);
  if (!tryAcquireRun(convId)) {
    console.log(`[orion] heartbeat for user ${userId} skipped: heartbeat chat busy`);
    return { ok: false, reason: 'busy' };
  }

  const maxIdBefore = db
    .prepare('SELECT COALESCE(MAX(id), 0) AS m FROM messages WHERE conversation_id = ?')
    .get(convId).m;

  // The injected check-in prompt, with recent chat activity for context.
  // (Matched by exact content in the error-path cleanup below.)
  const checkPrompt = (prompt || DEFAULT_PROMPT) + recentActivityDigest(userId);

  const controller = registerController(convId);
  let userMsgId = null;
  let finalText = '';
  try {
    const r = await runAgent({
      userId,
      conversationId: convId,
      userText: checkPrompt,
      settings: globalSettings(),
      shouldAbort: () => isStopRequested(convId),
      signal: controller.signal,
      systemExtra: HEARTBEAT_SYSTEM_EXTRA,
      historyLimit: 20,
      noAutoTitle: true, // the injected check-in prompt must never title a chat
      onExecStart: (execId) => trackExecStart(convId, userId, execId),
      onExecEnd: (execId) => trackExecEnd(convId, execId),
    });
    finalText = r?.finalText || '';
    userMsgId = r?.userMsgId ?? null;

    const now = Date.now();
    const trimmed = (finalText || '').trim();
    if (trimmed === '' || trimmed === 'HEARTBEAT_QUIET') {
      // Nothing to report: delete the check's own messages (and their
      // attachments) so the heartbeat chat stays clean — but never touch
      // messages the user sent mid-check.
      scrubHeartbeatMessages(convId, maxIdBefore, userMsgId);
      touchHeartbeatAt(userId, now);
      return { ok: true, quiet: true };
    }
    // The heartbeat had something to say: drop the injected prompt (the
    // user never typed it) but keep the report.
    deleteHeartbeatPrompt(convId, userMsgId);
    touchHeartbeatAt(userId, now);
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
    // The check died mid-run: remove the injected prompt so it never
    // masquerades as the user, and scrub partial heartbeat output. Real
    // user messages are always preserved.
    try {
      // runAgent persists the prompt before the loop runs, but throws away
      // its id when the loop fails — locate it by exact content instead.
      // (The prompt text is fixed per user; only the heartbeat writes it.)
      let pid = userMsgId;
      if (pid == null) {
        pid =
          db
            .prepare(
              `SELECT id FROM messages WHERE conversation_id = ? AND id > ?
               AND role = 'user' AND content = ? ORDER BY id DESC LIMIT 1`
            )
            .get(convId, maxIdBefore, checkPrompt)?.id ?? null;
      }
      scrubHeartbeatMessages(convId, maxIdBefore, pid ?? -1);
    } catch (se) {
      console.error('[orion] heartbeat error-path cleanup failed:', se?.message || se);
    }
    return { ok: false, reason: 'error' };
  } finally {
    unregisterController(convId);
    clearExecTracking(convId);
    clearStop(convId);
    releaseRun(convId);
    // Chain anything the user managed to write into the heartbeat chat
    // mid-check (not normally reachable, but harmless to handle).
    try {
      chainPendingUserMessages(convId, userId, maxIdBefore, userMsgId);
    } catch (e) {
      console.error(`[orion] heartbeat chain for user ${userId} failed:`, e?.message || e);
    }
  }
}

async function checkHeartbeats() {
  // No provider configured yet: nothing to run with.
  const g = globalSettings();
  if (!g.model || !g.api_key) return;
  const now = Date.now();
  const rows = db
    .prepare(
      `SELECT u.id AS user_id, s.last_heartbeat_at
       FROM users u LEFT JOIN user_settings s ON s.user_id = u.id
       WHERE u.disabled = 0`
    )
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
