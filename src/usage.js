// Orion weekly token usage: per-user token accounting bucketed by week
// (Monday 00:00 UTC), plus the admin-set weekly limit and enforcement.
import { db } from './db.js';
import { httpError } from './auth.js';

export const LIMIT_REACHED_MESSAGE =
  'Weekly token limit reached — ask your admin to raise it.';

/** Start of the week (Monday 00:00 UTC) containing `now`, in ms. */
export function weekStartMs(now = Date.now()) {
  const d = new Date(now);
  // getUTCDay: 0=Sun … 6=Sat. Days since Monday:
  const daysSinceMonday = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysSinceMonday);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Add one LLM call's usage to the user's current week. Never throws.
 *
 * When the provider omits the usage chunk, `estimate` ({ promptChars,
 * completionChars }) supplies a rough token count (~1 token per 4 chars)
 * so the weekly limit stays enforceable instead of recording nothing.
 */
export function recordUsage(userId, usage, estimate) {
  try {
    const uid = Number(userId);
    if (!uid) return;
    let p = num(usage?.prompt_tokens);
    let c = num(usage?.completion_tokens);
    if (p === 0 && c === 0 && estimate) {
      // No usage chunk from the provider — estimate rather than record
      // zero, otherwise a provider that never reports usage would let a
      // user burn unlimited tokens past their weekly limit.
      p = Math.ceil(Number(estimate.promptChars) / 4) || 0;
      c = Math.ceil(Number(estimate.completionChars) / 4) || 0;
    }
    const t = num(usage?.total_tokens) || p + c;
    const ws = weekStartMs();
    db.prepare(
      `INSERT INTO token_usage (user_id, week_start, prompt_tokens, completion_tokens, total_tokens)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, week_start) DO UPDATE SET
         prompt_tokens = prompt_tokens + excluded.prompt_tokens,
         completion_tokens = completion_tokens + excluded.completion_tokens,
         total_tokens = total_tokens + excluded.total_tokens`
    ).run(uid, ws, p, c, t);
  } catch (e) {
    console.warn('[orion] recordUsage failed:', e?.message || e);
  }
}

/** The user's weekly token limit (number) or null for unlimited. */
export function getLimit(userId) {
  const row = db.prepare('SELECT weekly_token_limit FROM users WHERE id = ?').get(userId);
  if (!row || row.weekly_token_limit === null || row.weekly_token_limit === undefined) return null;
  return Number(row.weekly_token_limit);
}

export function getWeeklyUsage(userId) {
  const ws = weekStartMs();
  const row = db
    .prepare('SELECT prompt_tokens, completion_tokens, total_tokens FROM token_usage WHERE user_id = ? AND week_start = ?')
    .get(userId, ws);
  const limit = getLimit(userId);
  const total = row?.total_tokens || 0;
  return {
    week_start: ws,
    prompt_tokens: row?.prompt_tokens || 0,
    completion_tokens: row?.completion_tokens || 0,
    total_tokens: total,
    limit,
    remaining: limit === null ? null : Math.max(0, limit - total),
  };
}

/** True when the user has a limit and has reached it. Never throws.
 * Admins are exempt — the weekly token budget only gates regular users. */
export function isOverLimit(userId) {
  try {
    const row = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
    if (row && row.role === 'admin') return false;
    const u = getWeeklyUsage(userId);
    return u.limit !== null && u.total_tokens >= u.limit;
  } catch {
    return false; // fail open — a DB hiccup must not brick the agent
  }
}

/** Zero the user's current-week counters. */
export function resetWeeklyUsage(userId) {
  db.prepare('DELETE FROM token_usage WHERE user_id = ? AND week_start = ?')
    .run(userId, weekStartMs());
}

/**
 * Set the user's weekly token limit. `limit` must be null (unlimited) or a
 * positive integer. Returns the stored value.
 */
export function setWeeklyLimit(userId, limit) {
  if (limit !== null && limit !== undefined) {
    const n = Number(limit);
    if (!Number.isInteger(n) || n <= 0) {
      throw httpError(400, 'weekly_token_limit must be null (unlimited) or a positive integer');
    }
    db.prepare('UPDATE users SET weekly_token_limit = ? WHERE id = ?').run(n, userId);
    return n;
  }
  db.prepare('UPDATE users SET weekly_token_limit = NULL WHERE id = ?').run(userId);
  return null;
}

/** All users' current-week usage, for the admin panel. */
export function allWeeklyUsage() {
  const ws = weekStartMs();
  return db
    .prepare(
      `SELECT u.id AS user_id, u.username, u.weekly_token_limit,
              COALESCE(t.prompt_tokens, 0) AS prompt_tokens,
              COALESCE(t.completion_tokens, 0) AS completion_tokens,
              COALESCE(t.total_tokens, 0) AS total_tokens
       FROM users u
       LEFT JOIN token_usage t ON t.user_id = u.id AND t.week_start = ?
       ORDER BY u.id`
    )
    .all(ws)
    .map((r) => ({ ...r, week_start: ws }));
}
