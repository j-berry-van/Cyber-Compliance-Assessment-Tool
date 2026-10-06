import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

const MIGRATIONS = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    disabled INTEGER NOT NULL DEFAULT 0,
    participant_id INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE records (
    collection TEXT NOT NULL,
    id TEXT NOT NULL,
    data TEXT,
    version INTEGER NOT NULL,
    rev INTEGER NOT NULL,
    updated_by INTEGER,
    updated_at TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (collection, id)
  );
  CREATE INDEX records_rev ON records(rev);
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO meta(key, value) VALUES ('rev', '0');
  `
];

export function openDb(file = ':memory:') {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const current = db.pragma('user_version', { simple: true });
  for (let v = current; v < MIGRATIONS.length; v += 1) {
    db.exec('BEGIN');
    db.exec(MIGRATIONS[v]);
    db.pragma(`user_version = ${v + 1}`);
    db.exec('COMMIT');
  }
  const hasWorkspace = db.prepare("SELECT 1 FROM meta WHERE key = 'workspace_id'").get();
  if (!hasWorkspace) {
    db.prepare("INSERT INTO meta(key, value) VALUES ('workspace_id', ?)").run(randomUUID());
  }
  return db;
}

export function nextRev(db) {
  db.prepare("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'rev'").run();
  return Number(db.prepare("SELECT value FROM meta WHERE key = 'rev'").get().value);
}
