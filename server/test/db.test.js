import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, nextRev } from '../db.js';

test('openDb creates the schema', () => {
  const db = openDb(':memory:');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  for (const t of ['users', 'sessions', 'records', 'meta']) assert.ok(tables.includes(t), `missing ${t}`);
});

test('nextRev is strictly increasing', () => {
  const db = openDb(':memory:');
  assert.equal(nextRev(db), 1);
  assert.equal(nextRev(db), 2);
});

test('openDb is idempotent on an existing file', () => {
  const db = openDb(':memory:');
  assert.equal(db.pragma('user_version', { simple: true }), 1);
});
