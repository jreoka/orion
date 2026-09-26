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
function addColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
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
`);

// NOTE: `messages.tool_call_id` is one column beyond the original sketch —
// tool-role rows need it to be replayable as valid OpenAI history.

// Seed defaults for settings the admin panel edits.
const seed = (key, value) => {
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(key, value);
};
seed('provider_name', 'OpenAI');
seed('base_url', 'https://api.openai.com/v1');
seed('api_key', '');
seed('model', 'gpt-4o');
seed('signup_enabled', '1');

export function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

export { db };
