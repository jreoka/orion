// Orion abuse detection: protects the shared VM and the admin's token
// budget from users who try to damage the machine or deliberately waste
// compute. Admins are never checked.
//
// Two layers:
//  1. Heuristic triage (cheap, one COUNT query): destructive-command
//     patterns, crypto-miner references, absurd message length, and
//     rapid-fire messaging. Fast enough to run on every message.
//  2. LLM judge (only when heuristics flag): the model decides whether the
//     user's request is genuinely abusive. Fails OPEN — if the provider is
//     unconfigured or errors, the message is allowed through.
//
// A positive verdict locks the account immediately: disabled=1,
// abuse_locked=1, all sessions revoked, sandbox removed. Only an admin can
// re-enable the account.
import { db, getSetting } from './db.js';
import { streamChatCompletion } from './llm.js';
import { removeSandbox } from './sandbox.js';
import { recordUsage } from './usage.js';

const HEURISTICS = [
  { re: /:\(\)\s*\{\s*:\|\s*:\s*&\s*\}\s*;?\s*:/, reason: 'fork bomb pattern' },
  { re: /\brm\b[^;|&]*--no-preserve-root|\brm\s+(-[a-z]*r[a-z]*|--recursive)\b[^;|&]*\/\s*(;|$)/i, reason: 'recursive delete of filesystem root' },
  { re: /\bmkfs(\.\w+)?\s+\/dev\//i, reason: 'filesystem format of a block device' },
  { re: /\bdd\s+[^;|&]*\bof=\/dev\//i, reason: 'raw write to a block device' },
  { re: /\b(xmrig|minergate|cpuminer|cgminer|bfgminer|ethminer|nbminer|t-rex)\b/i, reason: 'crypto miner reference' },
  { re: /--donate-level/i, reason: 'miner flag' },
  { re: /curl.+\|\s*(bash|sh)\s*$/im, reason: 'piped remote script execution' },
];

const MAX_MESSAGE_LEN = 20000;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 10; // >10 user messages in 60s feeds the judge (never auto-locks)

/**
 * Cheap triage: returns a list of human-readable flags (empty = clean).
 * Exported for tests.
 */
export function triageMessage(userId, text) {
  const flags = [];
  const t = String(text || '');
  for (const h of HEURISTICS) {
    if (h.re.test(t)) flags.push(h.reason);
  }
  if (t.length > MAX_MESSAGE_LEN) {
    flags.push(`message too long (${t.length} chars)`);
  }
  try {
    const since = Date.now() - RATE_WINDOW_MS;
    const n = db
      .prepare(
        `SELECT COUNT(*) AS c FROM messages
         WHERE role = 'user' AND created_at > ?
         AND conversation_id IN (SELECT id FROM conversations WHERE user_id = ?)`
      )
      .get(since, userId).c;
    if (n > RATE_MAX) flags.push(`rapid messaging (${n} messages in 60s)`);
  } catch {
    /* a counting hiccup must not block chat */
  }
  return flags;
}

const JUDGE_SYSTEM = `You are a safety classifier for a self-hosted AI agent platform. Each user gets an isolated Linux VM where the agent runs commands on their behalf. Classify the user's request.

Reply with EXACTLY one JSON object, no other text:
{"verdict":"ok"} — the request is legitimate use (coding, questions, file work, normal agent tasks), even if it mentions dangerous commands in an educational or hypothetical context.
{"verdict":"abusive","reason":"<short reason>"} — the user is actually trying to: damage or escape the VM, run crypto miners, exfiltrate data or credentials, deliberately waste compute/tokens (e.g. infinite loops to burn budget), or attack the platform itself.

Be strict about real attacks, lenient about everything else. A user asking what a command does is NOT abusive. A user asking the agent to run it IS abusive.`;

/**
 * Ask the model to judge a flagged message. Returns
 * { verdict: 'ok'|'abusive', reason }. Fails open (verdict 'ok') when no
 * provider is configured or the call errors. Exported for tests.
 */
export async function judgeMessage(userId, text, flags) {
  const settings = {
    base_url: getSetting('base_url', ''),
    api_key: getSetting('api_key', ''),
    model: getSetting('model', ''),
  };
  if (!settings.api_key) {
    console.log('[orion] abuse judge skipped: no LLM provider configured (fail open)');
    return { verdict: 'ok', reason: 'judge unavailable' };
  }
  const userContent =
    `Heuristic flags: ${flags.join('; ')}\n\nUser message:\n${String(text).slice(0, 4000)}`;
  const { content, usage } = await streamChatCompletion({
    baseUrl: settings.base_url,
    apiKey: settings.api_key,
    model: settings.model,
    messages: [
      { role: 'system', content: JUDGE_SYSTEM },
      { role: 'user', content: userContent },
    ],
    onToken: undefined,
  });
  // The judge's own tokens count against the user being judged.
  recordUsage(userId, usage);
  const m = String(content || '').match(/\{[\s\S]*\}/);
  if (!m) return { verdict: 'ok', reason: 'judge returned no JSON' };
  let parsed;
  try {
    parsed = JSON.parse(m[0]);
  } catch {
    return { verdict: 'ok', reason: 'judge returned invalid JSON' };
  }
  if (parsed.verdict === 'abusive') {
    return { verdict: 'abusive', reason: String(parsed.reason || 'judged abusive').slice(0, 500) };
  }
  return { verdict: 'ok' };
}

/** Lock the account: disable, mark, revoke sessions, remove the sandbox. */
export function lockAccount(userId, reason) {
  const now = Date.now();
  db.prepare(
    'UPDATE users SET disabled = 1, abuse_locked = 1, abuse_reason = ?, abuse_locked_at = ? WHERE id = ?'
  ).run(String(reason).slice(0, 500), now, userId);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  console.warn(`[orion] account ${userId} locked for abuse: ${reason}`);
  // Best-effort: the sandbox may not exist or Docker may be down.
  removeSandbox(userId).catch((e) =>
    console.warn(`[orion] could not remove sandbox for locked user ${userId}:`, e?.message || e)
  );
}

/**
 * Check one user message. Returns { locked: true, reason } when the account
 * was just locked, otherwise { locked: false }. Admins are never checked.
 * Never throws — abuse detection must not break chat.
 */
export async function checkUserMessage(user, text) {
  try {
    if (!user || user.role === 'admin') return { locked: false };
    const flags = triageMessage(user.id, text);
    if (!flags.length) return { locked: false };
    let verdict;
    try {
      verdict = await judgeMessage(user.id, text, flags);
    } catch (e) {
      console.error('[orion] abuse judge failed (fail open):', e?.message || e);
      return { locked: false };
    }
    if (verdict.verdict === 'abusive') {
      const reason = verdict.reason || flags.join('; ');
      lockAccount(user.id, reason);
      return { locked: true, reason };
    }
    return { locked: false };
  } catch (e) {
    console.error('[orion] abuse check failed (fail open):', e?.message || e);
    return { locked: false };
  }
}
