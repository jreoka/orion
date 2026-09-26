// Tiny in-memory rate limiter for auth endpoints (brute-force protection).
// Single-instance only — matches the rest of Orion's in-memory state
// (2FA/passkey challenges, run locks). Buckets: { count, resetAt }.

const buckets = new Map();

function getBucket(key, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  return b;
}

// Periodic sweep so the map can't grow forever.
let lastSweep = Date.now();
function sweep() {
  const now = Date.now();
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [k, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(k);
  }
  // Absolute safety cap.
  if (buckets.size > 20000) {
    const keys = [...buckets.keys()].slice(0, buckets.size - 20000);
    for (const k of keys) buckets.delete(k);
  }
}

/**
 * Record one failed attempt against `key`. Returns null when still allowed,
 * or { retryAfterMs } when the bucket is exhausted.
 */
export function recordFailure(key, { max = 5, windowMs = 15 * 60 * 1000 } = {}) {
  sweep();
  const b = getBucket(key, windowMs);
  b.count += 1;
  if (b.count > max) {
    return { retryAfterMs: Math.max(0, b.resetAt - Date.now()) };
  }
  return null;
}

/** A success clears the bucket entirely. */
export function recordSuccess(key) {
  buckets.delete(key);
}

/**
 * Generic rate limit: record one hit against `key`. Returns null when still
 * allowed, or { retryAfterMs } when the bucket is exhausted.
 */
export function hitRateLimit(key, { max = 30, windowMs = 60 * 60 * 1000 } = {}) {
  sweep();
  const b = getBucket(key, windowMs);
  b.count += 1;
  if (b.count > max) {
    return { retryAfterMs: Math.max(0, b.resetAt - Date.now()) };
  }
  return null;
}

/** Check without recording: returns { retryAfterMs } when the bucket is exhausted. */
export function checkLimit(key, { max = 5 } = {}) {
  sweep();
  const b = buckets.get(key);
  if (!b) return null;
  if (b.resetAt <= Date.now()) {
    buckets.delete(key);
    return null;
  }
  if (b.count > max) return { retryAfterMs: Math.max(0, b.resetAt - Date.now()) };
  return null;
}

export function limitErrorMessage(retryAfterMs) {
  const mins = Math.max(1, Math.ceil(retryAfterMs / 60000));
  return `Too many failed attempts — try again in about ${mins} minute${mins === 1 ? '' : 's'}.`;
}
