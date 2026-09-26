// Orion run lock: at most one active agent run per conversation.
// Guards against overlapping runs corrupting history or double-spending
// tool calls. In-memory: a server restart simply clears stuck locks.
const locks = new Map(); // conversationId -> { startedAt }

/** Try to acquire the run lock. Returns true when acquired, false when busy. */
export function tryAcquireRun(conversationId) {
  const id = Number(conversationId);
  if (locks.has(id)) return false;
  locks.set(id, { startedAt: Date.now() });
  return true;
}

export function releaseRun(conversationId) {
  locks.delete(Number(conversationId));
}

export function isRunLocked(conversationId) {
  return locks.has(Number(conversationId));
}
