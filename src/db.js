// Orion persistence: SQLite via better-sqlite3 (synchronous API).
// DB lives at $ORION_DATA/orion.db (default ./data/orion.db).
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = process.env.ORION_DATA || './data';
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'files'), { recursive: true });

const db = new Database(path.join(DATA_DIR, 'orion.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT 'New chat',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  tool_calls TEXT,
  tool_call_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  filename TEXT,
  mime TEXT,
  path TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reactions (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  emoji TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'user',
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reactions_unique ON reactions(message_id, user_id, emoji);
CREATE INDEX IF NOT EXISTS idx_reactions_msg ON reactions(message_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_attachments_msg ON attachments(message_id);
`);

// ---- idempotent v2 migrations (ALTER TABLE is safe to re-run) --------------
// NOTE: uses exec+try/catch instead of PRAGMA+prepare on purpose — transient
// prepared Statements created during module evaluation can be GC'd while the
// module graph is still loading, which crashes better-sqlite3 on some Node
// versions (RemoveEnvironmentCleanupHook with no current Environment).
function addColumn(table, column, ddl) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) throw e;
  }
}

addColumn('users', 'totp_secret', 'TEXT');
addColumn('users', 'totp_enabled', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'totp_pending_secret', 'TEXT');
addColumn('sessions', 'ip', 'TEXT');
addColumn('sessions', 'user_agent', 'TEXT');
addColumn('sessions', 'last_seen_at', 'INTEGER');
// Public session id: the sessions.id column IS the bearer token, so the API
// must never hand it out (session list / revoke). public_id is a random,
// non-secret handle safe to expose.
addColumn('sessions', 'public_id', 'TEXT');
{
  const missing = db.prepare('SELECT id FROM sessions WHERE public_id IS NULL').all();
  if (missing.length) {
    const stmt = db.prepare('UPDATE sessions SET public_id = ? WHERE id = ?');
    const txn = db.transaction((rows) => {
      for (const r of rows) stmt.run(crypto.randomBytes(16).toString('hex'), r.id);
    });
    txn(missing);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_public_id ON sessions(public_id)');
}
addColumn('conversations', 'kind', "TEXT NOT NULL DEFAULT 'chat'");
addColumn('conversations', 'task_id', 'INTEGER');
addColumn('messages', 'kind', "TEXT NOT NULL DEFAULT 'message'");
// Phase 3: abuse lock + weekly token limits.
// NOTE: weekly_token_limit is deliberately NULLABLE — NULL means unlimited
// (see setWeeklyLimit in usage.js). It must never be NOT NULL.
addColumn('users', 'abuse_locked', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'abuse_reason', 'TEXT');
addColumn('users', 'abuse_locked_at', 'INTEGER');
addColumn('users', 'weekly_token_limit', 'INTEGER DEFAULT 1000000');
addColumn('users', 'avatar_path', 'TEXT');
// User file uploads: rows are staged (message_id = 0, staged = 1) at
// upload time and claimed by a user message at send time.
addColumn('attachments', 'user_id', 'INTEGER');
addColumn('attachments', 'staged', 'INTEGER NOT NULL DEFAULT 0');
addColumn('attachments', 'size', 'INTEGER');
addColumn('attachments', 'created_at', 'INTEGER');

// Repair: phase-3 briefly declared weekly_token_limit NOT NULL, which made
// "unlimited" (NULL) impossible to store. If that constraint is present,
// rebuild the users table once with the nullable definition. The table has
// no foreign keys, so a copy is safe. Runs at boot, before any request.
const weeklyLimitPragma = db.prepare(
  "SELECT `notnull` AS nn FROM pragma_table_info('users') WHERE name = 'weekly_token_limit'"
);
try {
  const col = weeklyLimitPragma.get();
  if (col && col.nn === 1) {
    console.log('[orion] repairing users.weekly_token_limit: dropping NOT NULL so NULL (unlimited) is storable');
    db.exec('BEGIN');
    try {
      db.exec(`
        CREATE TABLE users_limit_fix (
          id INTEGER PRIMARY KEY,
          username TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'user',
          disabled INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          totp_secret TEXT,
          totp_enabled INTEGER NOT NULL DEFAULT 0,
          totp_pending_secret TEXT,
          abuse_locked INTEGER NOT NULL DEFAULT 0,
          abuse_reason TEXT,
          abuse_locked_at INTEGER,
          weekly_token_limit INTEGER DEFAULT 1000000,
          avatar_path TEXT
        );
        INSERT INTO users_limit_fix
          (id, username, password_hash, role, disabled, created_at,
           totp_secret, totp_enabled, totp_pending_secret,
           abuse_locked, abuse_reason, abuse_locked_at, weekly_token_limit,
           avatar_path)
          SELECT id, username, password_hash, role, disabled, created_at,
           totp_secret, totp_enabled, totp_pending_secret,
           abuse_locked, abuse_reason, abuse_locked_at, weekly_token_limit,
           avatar_path
          FROM users;
        DROP TABLE users;
        ALTER TABLE users_limit_fix RENAME TO users;
      `);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw e;
    }
  }
} catch (e) {
  console.warn('[orion] weekly_token_limit repair skipped:', e?.message || e);
}

db.exec(`
CREATE TABLE IF NOT EXISTS totp_backup_codes (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  code_hash TEXT NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS passkey_credentials (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  credential_id TEXT UNIQUE NOT NULL,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  name TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'cron',
  cron_expr TEXT,
  run_at INTEGER,
  prompt TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  next_run_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS user_settings (
  user_id INTEGER PRIMARY KEY,
  heartbeat_enabled INTEGER NOT NULL DEFAULT 0,
  heartbeat_interval_hours INTEGER NOT NULL DEFAULT 6,
  heartbeat_prompt TEXT NOT NULL DEFAULT '',
  last_heartbeat_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_passkeys_user ON passkey_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_backup_codes_user ON totp_backup_codes(user_id);
CREATE TABLE IF NOT EXISTS vault_items (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  label TEXT NOT NULL,
  secret_enc TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS vault_requests (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  conversation_id INTEGER NOT NULL,
  message_id INTEGER,
  label TEXT NOT NULL,
  hint TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  item_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vault_items_user ON vault_items(user_id);
CREATE INDEX IF NOT EXISTS idx_vault_requests_user ON vault_requests(user_id);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS token_usage (
  user_id INTEGER NOT NULL,
  week_start INTEGER NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, week_start)
);
CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);
`);

// NOTE: `messages.tool_call_id` is one column beyond the original sketch —
// tool-role rows need it to be replayable as valid OpenAI history.

// Seed defaults for settings the admin panel edits.
// NOTE: uses a single exec with literals (no prepare) — see addColumn note
// about transient Statements during module evaluation.
db.exec(`
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('provider_name', 'OpenAI'),
  ('base_url', 'https://api.openai.com/v1'),
  ('api_key', ''),
  ('model', 'gpt-4o'),
  ('signup_enabled', '1');
`);

export function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

export function deleteSetting(key) {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

// Orion has a single main chat per user — no conversation list. This
// returns the user's main conversation, adopting their most recent
// regular chat (pre-single-chat history) or creating a fresh one.
export function getOrCreateConversation(userId) {
  // All chats are equal — there is no special "main" chat. Return the most
  // recently updated conversation, creating one only when none exist.
  const existing = db
    .prepare(
      "SELECT id FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1"
    )
    .get(userId);
  if (existing) return existing.id;
  const now = Date.now();
  return Number(
    db
      .prepare("INSERT INTO conversations (user_id, title, kind, created_at, updated_at) VALUES (?, ?, 'chat', ?, ?)")
      .run(userId, 'New chat', now, now).lastInsertRowid
  );
}

/**
 * Grouped reactions for one message: [{ emoji, count, mine, agent }].
 * mine = this account reacted (as the user or via the agent);
 * agent = the agent (not the user) added this emoji.
 */
export function groupedReactions(messageId, userId) {
  const rows = db
    .prepare('SELECT emoji, actor, user_id FROM reactions WHERE message_id = ?')
    .all(messageId);
  const groups = new Map();
  for (const r of rows) {
    let g = groups.get(r.emoji);
    if (!g) {
      g = { emoji: r.emoji, count: 0, mine: false, agent: false };
      groups.set(r.emoji, g);
    }
    g.count++;
    if (r.user_id === userId) g.mine = true;
    if (r.actor === 'agent') g.agent = true;
  }
  return [...groups.values()];
}

/** One-line reaction summary for model history, or '' when there are none. */
export function reactionSummary(messageId) {
  const rows = db
    .prepare('SELECT emoji, actor, COUNT(*) AS n FROM reactions WHERE message_id = ? GROUP BY emoji, actor')
    .all(messageId);
  if (!rows.length) return '';
  const parts = rows.map((r) => {
    const who = r.actor === 'agent' ? 'you' : 'the user';
    return `${r.emoji}${r.n > 1 ? ' ×' + r.n : ''} (${who} reacted)`;
  });
  return `\n\n[reactions on this message: ${parts.join('; ')}]`;
}

/** Plain-text summary of a message's file attachments for the model. Text
 * files are embedded (bounded); other non-image files get a short note.
 * Images are NOT summarized here — agent.js passes them as vision parts. */
export function attachmentSummary(messageId) {
  const rows = db
    .prepare('SELECT filename, mime, size, path FROM attachments WHERE message_id = ? AND staged = 0')
    .all(messageId);
  if (!rows.length) return '';
  const dataRoot = path.resolve(DATA_DIR) + path.sep;
  let budget = 120 * 1024;
  const parts = [];
  for (const a of rows) {
    const name = a.filename || 'file';
    const mime = String(a.mime || '').toLowerCase();
    if (mime.startsWith('image/') || a.kind === 'image') continue; // vision parts, not text
    const isText =
      mime.startsWith('text/') ||
      ['application/json', 'application/x-sh', 'application/javascript'].includes(mime) ||
      /\.(txt|md|markdown|json|jsonl|csv|tsv|log|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|c|cpp|cc|h|hpp|cs|php|swift|kt|kts|sh|bash|zsh|sql|ya?ml|toml|ini|cfg|conf|xml|html?|css|scss|vue|svelte|diff|patch)$/i.test(name);
    if (isText && budget > 0) {
      try {
        const fp = path.resolve(DATA_DIR, a.path);
        if (fp.startsWith(dataRoot)) {
          const buf = fs.readFileSync(fp);
          if (buf.length <= 1024 * 1024) {
            const n = Math.min(buf.length, 40 * 1024, budget);
            let text = buf.slice(0, n).toString('utf8');
            if (n < buf.length) text += '\n…[truncated]';
            parts.push(`[attached file: ${name}]\n${text}`);
            budget -= n;
            continue;
          }
        }
      } catch { /* fall through to the plain note */ }
    }
    const size = a.size ? ` (${formatBytes(a.size)})` : '';
    parts.push(`[attached file: ${name} (${mime || 'unknown type'}${size})]`);
  }
  return `\n\n${parts.join('\n\n')}`;
}

function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

/** Validate a reaction emoji: one emoji-ish token, no whitespace, bounded. */
export function normalizeEmoji(s) {
  if (typeof s !== 'string') return null;
  const e = s.trim();
  if (!e || e.length > 16 || /\s/.test(e)) return null;
  return e;
}

/** Add or remove an account's reaction; returns the grouped reactions. */
export function setReaction(messageId, userId, emoji, actor, add) {
  if (add) {
    db.prepare(
      `INSERT INTO reactions (message_id, user_id, emoji, actor, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(message_id, user_id, emoji) DO UPDATE SET actor = excluded.actor`
    ).run(messageId, userId, emoji, actor, Date.now());
  } else {
    db.prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(
      messageId,
      userId,
      emoji
    );
  }
  return groupedReactions(messageId, userId);
}

export { db };
