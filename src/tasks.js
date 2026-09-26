// Orion tasks: user-scheduled agent runs, either cron expressions or a
// one-shot run at a future timestamp. Scheduled fires run the normal agent
// loop against a dedicated per-task conversation (kind='task') and respect
// the per-conversation run lock — a busy conversation is skipped, never
// double-run.
import cron from 'node-cron';
import { CronExpressionParser } from 'cron-parser';
import { db, getSetting } from './db.js';
import { httpError } from './auth.js';
import { runAgent } from './agent.js';
import { tryAcquireRun, releaseRun } from './runlock.js';

const jobs = new Map(); // taskId -> { type: 'cron', job } | { type: 'timeout', timer }

function globalSettings() {
  return {
    base_url: getSetting('base_url', ''),
    api_key: getSetting('api_key', ''),
    model: getSetting('model', ''),
  };
}

export function validateTaskInput({ name, kind, cron_expr, run_at, prompt }) {
  if (!name || String(name).trim().length < 1 || String(name).length > 80) {
    throw httpError(400, 'Name must be 1–80 characters');
  }
  if (kind !== 'once' && kind !== 'cron') {
    throw httpError(400, "kind must be 'once' or 'cron'");
  }
  if (!prompt || String(prompt).length < 1 || String(prompt).length > 4000) {
    throw httpError(400, 'Prompt must be 1–4000 characters');
  }
  if (kind === 'cron') {
    if (!cron_expr || !cron.validate(cron_expr)) {
      throw httpError(400, 'Invalid cron expression');
    }
  } else {
    const ra = Number(run_at);
    if (!Number.isFinite(ra) || ra <= Date.now()) {
      throw httpError(400, 'run_at must be a future timestamp (ms)');
    }
  }
}

export function publicTask(t) {
  return {
    id: t.id,
    name: t.name,
    kind: t.kind,
    cron_expr: t.cron_expr,
    run_at: t.run_at,
    prompt: t.prompt,
    enabled: !!t.enabled,
    last_run_at: t.last_run_at,
    next_run_at: t.next_run_at,
    created_at: t.created_at,
    updated_at: t.updated_at,
  };
}

// One conversation per task, shared across all its fires.
export function getOrCreateTaskConversation(userId, task) {
  const existing = db
    .prepare("SELECT id FROM conversations WHERE user_id = ? AND kind = 'task' AND task_id = ?")
    .get(userId, task.id);
  if (existing) return existing.id;
  const now = Date.now();
  return Number(
    db
      .prepare(
        "INSERT INTO conversations (user_id, title, kind, task_id, created_at, updated_at) VALUES (?, ?, 'task', ?, ?, ?)"
      )
      .run(userId, '⏰ ' + task.name, task.id, now, now).lastInsertRowid
  );
}

// Fire a task now (scheduled or manual). Returns { ok, conversationId }
// or { ok: false, reason }. Once-tasks are consumed by firing; cron tasks
// get last_run_at / next_run_at updated. Agent errors are written into the
// conversation by runAgent, so the user always sees what happened.
export async function fireTask(taskId, { manual = false } = {}) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task) {
    unscheduleTask(taskId);
    return { ok: false, reason: 'deleted' };
  }
  if (!task.enabled && !manual) return { ok: false, reason: 'disabled' };

  const convId = getOrCreateTaskConversation(task.user_id, task);
  if (!tryAcquireRun(convId)) {
    console.log(`[orion] task ${taskId} skipped: conversation ${convId} already has an active run`);
    return { ok: false, reason: 'busy' };
  }

  try {
    await runAgent({
      userId: task.user_id,
      conversationId: convId,
      userText: task.prompt,
      settings: globalSettings(),
      emit: () => {},
      shouldAbort: () => false,
      signal: undefined,
    });
  } catch (e) {
    // runAgent only throws for aborts, which can't happen here (no signal),
    // but never let a task fire take down the scheduler.
    console.error(`[orion] task ${taskId} run threw:`, e?.message || e);
  } finally {
    releaseRun(convId);
  }

  const now = Date.now();
  if (task.kind === 'cron' && task.cron_expr) {
    let next = null;
    try {
      next = CronExpressionParser.parse(task.cron_expr, { currentDate: new Date(now) }).next().getTime();
    } catch {
      /* keep next null; scheduler still fires on its own cadence */
    }
    db.prepare('UPDATE tasks SET last_run_at = ?, next_run_at = ? WHERE id = ?').run(now, next, taskId);
  } else {
    // One-shot: firing consumes it.
    db.prepare('UPDATE tasks SET last_run_at = ?, next_run_at = NULL, enabled = 0, updated_at = ? WHERE id = ?')
      .run(now, now, taskId);
    unscheduleTask(taskId);
  }
  return { ok: true, conversationId: convId };
}

export function unscheduleTask(taskId) {
  const j = jobs.get(taskId);
  if (!j) return;
  jobs.delete(taskId);
  if (j.type === 'cron') j.job.stop();
  else clearTimeout(j.timer);
}

export function scheduleTask(taskId) {
  unscheduleTask(taskId);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task || !task.enabled) return;
  if (task.kind === 'cron' && task.cron_expr) {
    if (!cron.validate(task.cron_expr)) return;
    const job = cron.schedule(task.cron_expr, () => {
      fireTask(taskId).catch((e) => console.error(`[orion] task ${taskId} failed:`, e?.message || e));
    });
    jobs.set(taskId, { type: 'cron', job });
    try {
      const next = CronExpressionParser.parse(task.cron_expr).next().getTime();
      db.prepare('UPDATE tasks SET next_run_at = ? WHERE id = ?').run(next, taskId);
    } catch {
      /* next_run_at stays null */
    }
  } else if (task.kind === 'once' && task.run_at) {
    const delay = task.run_at - Date.now();
    if (delay <= 0) {
      db.prepare('UPDATE tasks SET enabled = 0, next_run_at = NULL WHERE id = ?').run(taskId);
      return;
    }
    const timer = setTimeout(() => {
      fireTask(taskId).catch((e) => console.error(`[orion] task ${taskId} failed:`, e?.message || e));
    }, delay);
    timer.unref?.();
    jobs.set(taskId, { type: 'timeout', timer });
    db.prepare('UPDATE tasks SET next_run_at = ? WHERE id = ?').run(task.run_at, taskId);
  }
}

// Restore all enabled tasks on boot.
export function initTasks() {
  const rows = db.prepare('SELECT id FROM tasks WHERE enabled = 1').all();
  for (const t of rows) {
    try {
      scheduleTask(t.id);
    } catch (e) {
      console.warn(`[orion] could not schedule task ${t.id}:`, e?.message || e);
    }
  }
  if (rows.length) console.log(`[orion] task scheduler restored ${rows.length} task(s)`);
}
