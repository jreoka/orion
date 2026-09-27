// Orion event bus: in-memory pub/sub of per-conversation SSE events.
//
// The agent run is detached from any single HTTP request — the client holds
// a long-lived EventSource on GET /api/conversations/:id/events and the run
// publishes token/tool/message/run_started/run_ended frames to it. Queued
// messages, task fires, heartbeats, and mid-run send_update notes all flow
// through the same bus, so every client watching the conversation sees the
// same live state.
//
// In-memory: a server restart drops subscribers; clients reconnect and
// re-fetch history to catch up.
const subs = new Map(); // conversationId -> Set<ServerResponse>

export function subscribe(conversationId, res) {
  const id = Number(conversationId);
  let set = subs.get(id);
  if (!set) {
    set = new Set();
    subs.set(id, set);
  }
  set.add(res);
}

export function unsubscribe(conversationId, res) {
  const id = Number(conversationId);
  const set = subs.get(id);
  if (!set) return;
  set.delete(res);
  if (!set.size) subs.delete(id);
}

/**
 * Publish an event object ({ type, ... }) to every subscriber of the
 * conversation. Never throws — the bus must not kill an agent run.
 */
export function publish(conversationId, event) {
  const set = subs.get(Number(conversationId));
  if (!set || !set.size) return;
  let frame;
  try {
    frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  } catch {
    return;
  }
  for (const res of set) {
    try {
      res.write(frame);
    } catch {
      /* dead subscriber; pruned on its 'close' handler */
    }
  }
}

export function subscriberCount(conversationId) {
  return subs.get(Number(conversationId))?.size || 0;
}

// ---- per-user channel (usage updates, etc.) ----
const userSubs = new Map(); // userId -> Set<ServerResponse>

export function subscribeUser(userId, res) {
  const id = Number(userId);
  let set = userSubs.get(id);
  if (!set) {
    set = new Set();
    userSubs.set(id, set);
  }
  set.add(res);
}

export function unsubscribeUser(userId, res) {
  const id = Number(userId);
  const set = userSubs.get(id);
  if (!set) return;
  set.delete(res);
  if (!set.size) userSubs.delete(id);
}

/** Publish an event object ({ type, ... }) to every client of the user. */
export function publishToUser(userId, event) {
  const set = userSubs.get(Number(userId));
  if (!set || !set.size) return;
  let frame;
  try {
    frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  } catch {
    return;
  }
  for (const res of set) {
    try {
      res.write(frame);
    } catch {
      /* dead subscriber; pruned on its 'close' handler */
    }
  }
}
