// Orion persistence: SQLite via better-sqlite3 (synchronous API).
// DB lives at $ORION_DATA/orion.db (default ./data/orion.db).
import Database from 'better-sqlite3';
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
addColumn('conversations', 'kind', "TEXT NOT NULL DEFAULT 'chat'");
addColumn('conversations', 'task_id', 'INTEGER');
// Phase 3: abuse lock + weekly token limits.
// NOTE: weekly_token_limit is deliberately NULLABLE — NULL means unlimited
// (see setWeeklyLimit in usage.js). It must never be NOT NULL.
addColumn('users', 'abuse_locked', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'abuse_reason', 'TEXT');
addColumn('users', 'abuse_locked_at', 'INTEGER');
addColumn('users', 'weekly_token_limit', 'INTEGER DEFAULT 1000000');

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
          weekly_token_limit INTEGER DEFAULT 1000000
        );
        INSERT INTO users_limit_fix
          (id, username, password_hash, role, disabled, created_at,
           totp_secret, totp_enabled, totp_pending_secret,
           abuse_locked, abuse_reason, abuse_locked_at, weekly_token_limit)
          SELECT id, username, password_hash, role, disabled, created_at,
           totp_secret, totp_enabled, totp_pending_secret,
           abuse_locked, abuse_reason, abuse_locked_at, weekly_token_limit
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

export { db };
