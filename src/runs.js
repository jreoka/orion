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

/** Persistent run state (conversations.run_state). Mirrors the in-memory
 *  run lock so boot recovery can find runs that were in flight when the
 *  server went down. 'active' while a run holds the conversation. */
export function setRunState(conversationId, state) {
  try {
    db.prepare('UPDATE conversations SET run_state = ? WHERE id = ?').run(state, Number(conversationId));
  } catch {
    /* telemetry must never break a run */
  }
}

// Set when the process is shutting down (SIGTERM/SIGINT): in-flight runs
// finish their finally blocks but must not chain follow-up runs — the
// process is going away, and boot recovery re-answers anything stranded.
let shuttingDown = false;
/** Called by server.js gracefulShutdown before it aborts in-flight runs. */
export function setShuttingDown() {
  shuttingDown = true;
}

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
  maxChain = MAX_CHAINED_RUNS,
  opts = {}
) {
  const id = Number(conversationId);
  // The caller holds the run lock. Persist it: if the server dies now,
  // boot recovery resumes this run instead of stranding it.
  setRunState(id, 'active');
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
      // Lets the agent distinguish a deploy/crash abort (the run will be
      // resumed at boot) from the user pressing stop.
      isShutdownAbort: () => shuttingDown && !isStopRequested(id),
      signal: controller.signal,
      systemExtra: opts.systemExtra,
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
  // A run that ends normally goes idle. One aborted by graceful shutdown
  // deliberately STAYS active — the new process resumes it at boot.
  // (A user stop during the shutdown window still goes idle: their stop
  // wins over the resume.)
  if (!shuttingDown || wasStopped) setRunState(id, 'idle');
  releaseRun(id);

  if (chainDepth >= maxChain) return { chained: false, reason: 'chain-cap' };

  // Anything the user said while this run was working? Answer it next —
  // even if this run was stopped, a queued user message is new intent that
  // should not be silently dropped.
  const pending = db
    .prepare("SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ? AND id > ? AND role = 'user'")
    .get(id, startMaxId).c;
  if (pending > 0 && !shuttingDown && tryAcquireRun(id)) {
    return runConversation(id, userId, userText, chainDepth + 1, maxChain, opts);
  }

  // Outermost run of this trigger finished: ping the user if they aren't
  // watching this conversation live. Chained runs notify only once, here.
  // Skip when the conversation was deleted mid-run (nothing to deep-link).
  // Every run end notifies — notifyConversation suppresses the push while
  // the user is watching, so this only buzzes when they weren't looking.
  // Reminders, scheduled tasks, and heartbeat findings always notify via
  // their own paths.
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
 * chain to it). opts.systemExtra adds a system-prompt note (used by boot
 * recovery so the resumed agent knows about the restart).
 */
export function startRunIfIdle(conversationId, userId, userText, opts = {}) {
  if (shuttingDown) return false;
  const id = Number(conversationId);
  if (!tryAcquireRun(id)) return false;
  runConversation(id, userId, userText, 0, MAX_CHAINED_RUNS, opts).catch((e) => {
    console.error(`[orion] background run for conversation ${id} failed:`, e?.message || e);
  });
  return true;
}

/**
 * Pass 1 of boot recovery: resume runs that were in flight when the
 * server went down (deploy, crash, SIGKILL). run_state stays 'active'
 * for these — a clean run end flips it back to 'idle', and graceful
 * shutdown deliberately leaves aborted runs 'active' so they resume.
 *
 * This is genuine continuation, not a restart: runAgentLoop rebuilds the
 * full conversation history from the DB (loadHistory even synthesizes
 * placeholder results for tool calls that never returned), so the agent
 * sees its partial work and carries on. A system note tells it about the
 * restart so it confirms completion instead of redoing finished work.
 *
 * Skipped: task-owned conversations (the scheduler owns those), runs the
 * user stopped (their stop note is the marker — a stop during the
 * shutdown window already flipped those back to idle), and runs idle
 * for over a day (resuming week-old work unprompted is worse than
 * leaving it; those flags are reset).
 */
function resumeInterruptedRuns() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let rows = [];
  try {
    rows = db
      .prepare(
        `SELECT c.id AS conversation_id, c.user_id,
                (SELECT role FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) AS last_role,
                (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) AS last_content,
                (SELECT created_at FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) AS last_created,
                (SELECT content FROM messages WHERE conversation_id = c.id AND role = 'user'
                 ORDER BY id DESC LIMIT 1) AS last_user_text
         FROM conversations c
         WHERE c.run_state = 'active' AND c.task_id IS NULL`
      )
      .all();
  } catch (e) {
    console.warn('[orion] interrupted-run scan failed:', e?.message || e);
    return;
  }
  const RESUME_NOTE =
    'The server restarted while you were working on this conversation. ' +
    'Review the message history: work that already has tool results is done — do not redo it. ' +
    'If the task is already complete, just briefly confirm that. Otherwise pick up exactly where you left off.';
  for (const r of rows) {
    try {
      if (!r.last_created || r.last_created <= cutoff) {
        setRunState(r.conversation_id, 'idle');
        continue;
      }
      const lastContent = String(r.last_content || '');
      if (r.last_role === 'assistant' && lastContent.includes('(stopped by user)')) {
        setRunState(r.conversation_id, 'idle');
        continue;
      }
      if (r.last_role === 'assistant' && !lastContent.trim()) {
        // Trailing empty reply placeholder: the run died before producing
        // anything. Drop it so the resumed run starts clean instead of
        // leaving a dead empty bubble in history.
        db.prepare(
          `DELETE FROM messages WHERE conversation_id = ? AND role = 'assistant'
           AND (content = '' OR content IS NULL)
           AND id > (SELECT COALESCE(MAX(id), 0) FROM messages
                     WHERE conversation_id = ? AND role = 'assistant' AND content != '')`
        ).run(r.conversation_id, r.conversation_id);
      }
      if (startRunIfIdle(r.conversation_id, r.user_id, String(r.last_user_text || ''), { systemExtra: RESUME_NOTE })) {
        console.log(`[orion] boot recovery: resuming interrupted run in conversation ${r.conversation_id}`);
      } else {
        setRunState(r.conversation_id, 'idle');
      }
    } catch (e) {
      console.warn(`[orion] boot resume for conversation ${r.conversation_id} failed:`, e?.message || e);
      setRunState(r.conversation_id, 'idle');
    }
  }
}

/**
 * Boot-time recovery for stranded user messages.
 *
 * Pass 1 (resumeInterruptedRuns): conversations whose run_state is still
 * 'active' had a run in flight when the server went down. They are
 * resumed — the agent rebuilds full history from the DB and continues
 * where it stopped, it does not start over.
 *
 * Pass 2 (legacy shapes): run_state is 'idle' but a message still slipped
 * through — e.g. the process died between the POST handler storing the
 * user message and the run starting, or data written before run_state
 * existed. Two shapes are recovered: a trailing recent user message, and
 * a trailing empty assistant placeholder after a recent user message.
 *
 * Anything older than a couple of hours is left alone in pass 2 —
 * answering ancient questions unprompted is worse than leaving them; the
 * heartbeat will surface them if they still matter. Conversations owned
 * by a scheduled task (task_id set) are excluded from both passes: the
 * task scheduler owns those and has its own retry logic, so recovery
 * must not double-execute them.
 */
export function recoverStrandedRuns() {
  try {
    resumeInterruptedRuns();
  } catch (e) {
    console.warn('[orion] interrupted-run resume failed:', e?.message || e);
  }
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  let convs = [];
  try {
    convs = db
      .prepare(
        `SELECT c.id AS conversation_id, c.user_id,
                (SELECT role FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) AS last_role,
                (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) AS last_content,
                (SELECT created_at FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) AS last_created,
                (SELECT content FROM messages WHERE conversation_id = c.id AND role = 'user'
                   AND id < (SELECT MAX(id) FROM messages WHERE conversation_id = c.id)
                 ORDER BY id DESC LIMIT 1) AS prev_user_text
         FROM conversations c
         WHERE c.task_id IS NULL AND c.run_state != 'active'`
      )
      .all();
  } catch (e) {
    console.warn('[orion] stranded-run scan failed:', e?.message || e);
    return;
  }
  for (const r of convs) {
    try {
      if (!r.last_created || r.last_created <= cutoff) continue;
      let userText = null;
      let deadPlaceholder = false;
      if (r.last_role === 'user') {
        // The run died before (or without) creating its reply placeholder.
        userText = String(r.last_content || '');
      } else if (r.last_role === 'assistant' && (r.last_content === '' || r.last_content == null)) {
        // Trailing empty row: at boot no run is alive to fill it, so the
        // run died mid-turn — whether it was a reply placeholder or an
        // update card that never got its text. The question it was
        // answering is the latest user message before it. (Assistant
        // content between the two belongs to an earlier question — only a
        // trailing empty row means the last run produced nothing.)
        userText = String(r.prev_user_text || '');
        deadPlaceholder = true;
      } else {
        continue;
      }
      if (!userText.trim()) continue;
      if (deadPlaceholder) {
        // Drop abandoned rows (empty placeholders/cards after the last
        // real reply) so the fresh run starts clean. Content-bearing cards
        // are never touched.
        db.prepare(
          `DELETE FROM messages WHERE conversation_id = ? AND role = 'assistant'
           AND (content = '' OR content IS NULL)
           AND id > (SELECT COALESCE(MAX(id), 0) FROM messages
                     WHERE conversation_id = ? AND role = 'assistant' AND content != '')`
        ).run(r.conversation_id, r.conversation_id);
      }
      if (startRunIfIdle(r.conversation_id, r.user_id, userText)) {
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
