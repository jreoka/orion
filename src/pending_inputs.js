// Pending user inputs (plan approvals).
// The agent pauses and waits for the user to respond.

import { db } from './db.js';

// Wait for a pending input to be resolved. Polls the DB.
// Returns the result object, or throws on abort/timeout.
export async function waitForPendingInput({ pendingId, userId, conversationId, shouldAbort, signal, timeoutMs = 10 * 60 * 1000 }) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (shouldAbort && shouldAbort()) throw new Error('Aborted while waiting for user input');
    if (signal && signal.aborted) {
      const err = new Error('Aborted while waiting for user input');
      err.name = 'AbortError';
      throw err;
    }
    const row = db.prepare('SELECT status, result FROM pending_inputs WHERE id = ?').get(pendingId);
    if (!row) throw new Error('Pending input was deleted');
    if (row.status !== 'pending') {
      return row.result ? JSON.parse(row.result) : { status: row.status };
    }
    // Poll every 2 seconds
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  // Timeout: mark as expired, agent continues with best judgment
  try {
    db.prepare("UPDATE pending_inputs SET status = 'expired', resolved_at = ? WHERE id = ? AND status = 'pending'")
      .run(Date.now(), pendingId);
  } catch {}
  return { status: 'expired', timeout: true };
}

export function createPendingInput({ userId, conversationId, type, data }) {
  const info = db.prepare(
    'INSERT INTO pending_inputs (user_id, conversation_id, type, data) VALUES (?, ?, ?, ?)'
  ).run(userId, conversationId, type, JSON.stringify(data));
  return Number(info.lastInsertRowid);
}

export function resolvePendingInput({ pendingId, userId, status, result }) {
  const info = db.prepare(
    "UPDATE pending_inputs SET status = ?, result = ?, resolved_at = ? WHERE id = ? AND user_id = ? AND status = 'pending'"
  ).run(status, result ? JSON.stringify(result) : null, Date.now(), pendingId, userId);
  return info.changes > 0;
}
