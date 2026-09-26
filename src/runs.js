// Orion run driver: background agent runs over a conversation.
//
// The chat POST handler inserts the user message and publishes it, then
// hands the conversation to runConversation() WITHOUT awaiting it — the
// HTTP response returns immediately (JSON { message, queued }), and the run
// streams its progress over the per-conversation event bus (src/events.js).
//
// If the conversation is already running, the new message is simply queued:
// when the in-flight run finishes it looks for user messages newer than the
// run's starting point and chains another run, up to MAX_CHAINED_RUNS runs
// per trigger, so messages can never pile up silently or error with 409.
//
// Server-side stop: POST /:id/stop sets a stop flag and aborts the run's
// AbortController. The loop checks the flag between iterations; an in-flight
// LLM call is aborted mid-stream. The flag is cleared when the run ends.
// A user message queued while the run was active still chains a follow-up —
// stop halts the in-flight work, not the user's newer intent.
import { db, getSetting } from './db.js';
import { runAgentContinuation } from './agent.js';
import { tryAcquireRun, releaseRun, isStopRequested, clearStop } from './runlock.js';
import { sandboxKillExec } from './sandbox.js';
import { notifyConversation } from './push.js';

export const MAX_CHAINED_RUNS = 10;

// conversationId -> AbortController of the currently running agent run.
// Aborted by abortRun() (the stop endpoint).
const controllers = new Map();

// conversationId -> { userId, execId } of the currently running `exec`
// tool call. The LLM abort alone wouldn't stop a long command, so Stop
// also kills the in-container process via its ORION_EXEC_ID marker.
const activeExecs = new Map();

/** Record the start of one sandbox exec inside a conversation's run. */
export function trackExecStart(conversationId, userId, execId) {
  activeExecs.set(Number(conversationId), { userId: Number(userId), execId });
}

/** Record the end of a sandbox exec; only clears if it matches. */
export function trackExecEnd(conversationId, execId) {
  const id = Number(conversationId);
  if (activeExecs.get(id)?.execId === execId) activeExecs.delete(id);
}

/** Drop any exec tracking for a conversation (run cleanup, belt-and-braces). */
export function clearExecTracking(conversationId) {
  activeExecs.delete(Number(conversationId));
}

/**
 * Abort the in-flight work of the current run, if any: the LLM fetch via
 * its AbortController, and any running sandbox exec via its process
 * marker. Best-effort — sandboxKillExec never throws.
 */
export function abortRun(conversationId) {
  const id = Number(conversationId);
  const c = controllers.get(id);
  if (c) {
    try {
      c.abort();
    } catch {
      /* ignore */
    }
  }
  const a = activeExecs.get(id);
  if (a) {
    activeExecs.delete(id);
    sandboxKillExec(a.userId, a.execId); // fire-and-forget; never rejects
  }
}

/**
 * Register an AbortController for a conversation's run (for stop support).
 * Tasks and heartbeat use this so POST /:id/stop can abort their LLM fetch.
 * Returns the controller; the caller must call unregisterController(id)
 * when the run ends.
 */
export function registerController(conversationId) {
  const c = new AbortController();
  controllers.set(Number(conversationId), c);
  return c;
}

export function unregisterController(conversationId) {
  controllers.delete(Number(conversationId));
}

/** Global provider/model settings for agent runs (same keys as the admin panel). */
export function globalSettings() {
  return {
    base_url: getSetting('base_url', ''),
    api_key: getSetting('api_key', ''),
    model: getSetting('model', ''),
  };
}

/**
 * Run the agent over the conversation until there is no unanswered user
 * input left. The caller MUST hold the run lock for this conversation.
 * Returns { stopped } when the user stopped the run, { chained:false }
 * otherwise. Never throws — unexpected errors are logged; the run_ended
 * event (published by the agent) already told clients the outcome.
 *
 * chainDepth/maxChain: cap automatic follow-up runs so a pathological
 * backlog can't loop forever; extra messages simply wait for the next
 * user message or task/heartbeat run.
 */
export async function runConversation(
  conversationId,
  userId,
  userText,
  chainDepth = 0,
  maxChain = MAX_CHAINED_RUNS
) {
  const id = Number(conversationId);
  const startMaxId =
    db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM messages WHERE conversation_id = ?').get(id).m;

  const controller = new AbortController();
  controllers.set(id, controller);
  let runStatus = 'done';
  try {
    const r = await runAgentContinuation({
      userId,
      conversationId: id,
      userText,
      settings: globalSettings(),
      shouldAbort: () => isStopRequested(id),
      signal: controller.signal,
      onExecStart: (execId) => trackExecStart(id, userId, execId),
      onExecEnd: (execId) => trackExecEnd(id, execId),
    });
    if (r?.status) runStatus = r.status;
  } catch (e) {
    // runAgentLoop only throws on unexpected internal errors; the agent
    // already published run_ended for handled outcomes (done/error/stopped).
    console.error(`[orion] run for conversation ${id} threw:`, e?.message || e);
  } finally {
    controllers.delete(id);
    activeExecs.delete(id); // belt-and-braces: no stale exec after a run
  }

  const wasStopped = isStopRequested(id);
  clearStop(id);
  releaseRun(id);

  if (chainDepth >= maxChain) return { chained: false, reason: 'chain-cap' };

  // Anything the user said while this run was working? Answer it next —
  // even if this run was stopped, a queued user message is new intent that
  // should not be silently dropped.
  const pending = db
    .prepare("SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ? AND id > ? AND role = 'user'")
    .get(id, startMaxId).c;
  if (pending > 0 && tryAcquireRun(id)) {
    return runConversation(id, userId, userText, chainDepth + 1, maxChain);
  }

  // Outermost run of this trigger finished: ping the user if they aren't
  // watching this conversation live. Chained runs notify only once, here.
  // Skip when the conversation was deleted mid-run (nothing to deep-link).
  if (chainDepth === 0) {
    try {
      const conv = db.prepare('SELECT title FROM conversations WHERE id = ?').get(id);
      if (conv) {
        const last = db
          .prepare("SELECT content FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1")
          .get(id);
        const snippet = String(last?.content || '').replace(/\s+/g, ' ').trim().slice(0, 140);
        await notifyConversation(userId, id, {
          title: 'Orion',
          body: `${conv.title || 'Chat'}${runStatus !== 'done' ? ` (${runStatus})` : ''}: ${snippet || 'finished'}`,
        });
      }
    } catch (e) {
      console.warn('[orion] run-end push failed:', e?.message || e);
    }
  }

  return wasStopped ? { stopped: true } : { chained: false };
}

/**
 * Kick off a background run for a conversation the caller owns, unless one
 * is already running. Returns true when a run was started, false when the
 * conversation was busy (the message stays queued and the current run will
 * chain to it).
 */
export function startRunIfIdle(conversationId, userId, userText) {
  const id = Number(conversationId);
  if (!tryAcquireRun(id)) return false;
  runConversation(id, userId, userText).catch((e) => {
    console.error(`[orion] background run for conversation ${id} failed:`, e?.message || e);
  });
  return true;
}

/**
 * Boot-time recovery for stranded user messages.
 *
 * The run lock and chain state live in memory, so a deploy or crash
 * between a user message being stored and the agent run answering it
 * leaves the message hanging: the POST handler already returned and
 * nothing re-chains after a restart. On boot, any conversation whose
 * latest message is a recent user message is handed to the normal run
 * driver, so the question gets answered instead of hanging forever.
 * Anything older than a couple of hours is left alone — answering
 * ancient questions unprompted is worse than leaving them; the
 * heartbeat will surface them if they still matter.
 */
export function recoverStrandedRuns() {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  let rows = [];
  try {
    rows = db
      .prepare(
        `SELECT c.id AS conversation_id, c.user_id,
                (SELECT content FROM messages WHERE conversation_id = c.id AND role = 'user' ORDER BY id DESC LIMIT 1) AS last_user_text
         FROM conversations c
         WHERE (SELECT role FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) = 'user'
           AND (SELECT created_at FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) > ?`
      )
      .all(cutoff);
  } catch (e) {
    console.warn('[orion] stranded-run scan failed:', e?.message || e);
    return;
  }
  for (const r of rows) {
    try {
      if (startRunIfIdle(r.conversation_id, r.user_id, String(r.last_user_text || ''))) {
        console.log(`[orion] boot recovery: answering stranded message in conversation ${r.conversation_id}`);
      }
    } catch (e) {
      console.warn(`[orion] boot recovery for conversation ${r.conversation_id} failed:`, e?.message || e);
    }
  }
}
/**
 * If the user sent messages into the chat while a task/heartbeat run held
 * the lock, they were queued but nothing will chain them (chaining only
 * happens inside this module's own driver). Hand the chat back to the
 * driver so the user's newer intent gets answered. ownUserMsgId is the
 * prompt message the background run inserted itself — excluded so it is
 * never mistaken for user intent.
 */
export function chainPendingUserMessages(conversationId, userId, maxIdBefore, ownUserMsgId) {
  const pending = db
    .prepare(
      "SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ? AND id > ? AND role = 'user' AND id != ?"
    )
    .get(Number(conversationId), maxIdBefore, ownUserMsgId ?? -1).c;
  if (pending > 0) startRunIfIdle(conversationId, userId);
}
