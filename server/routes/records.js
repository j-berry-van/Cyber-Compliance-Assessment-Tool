import { Router } from 'express';
import { nextRev } from '../db.js';
import { requireAuth } from '../middlewares/auth.js';

const COLLECTION_RE = /^[A-Za-z0-9._:-]{1,100}$/;
const isState = (c) => c.endsWith(':state');

const shape = (row) => ({
  collection: row.collection, id: row.id, data: row.data == null ? null : JSON.parse(row.data),
  version: row.version, deleted: !!row.deleted, updatedBy: row.updated_by, updatedAt: row.updated_at
});

export default function recordRoutes(db) {
  const r = Router();
  r.use(requireAuth);

  const current = (c, id) => db.prepare('SELECT * FROM records WHERE collection = ? AND id = ?').get(c, id);
  const cursorNow = () => Number(db.prepare("SELECT value FROM meta WHERE key = 'rev'").get().value);

  const validate = (req, res, next) => {
    const { collection, id } = req.params;
    if (!COLLECTION_RE.test(collection) || id.length < 1 || id.length > 300) {
      return res.status(400).json({ error: 'invalid-collection-or-id' });
    }
    return next();
  };

  r.get('/', (req, res) => {
    const raw = req.query.since;
    const since = typeof raw === 'string' && /^\d{1,15}$/.test(raw) ? Number(raw) : 0;
    const cursor = cursorNow();
    const rows = db.prepare(
      `SELECT * FROM records WHERE rev > ? ${since === 0 ? 'AND deleted = 0' : ''} ORDER BY rev`
    ).all(since);
    res.json({ cursor, records: rows.map(shape) });
  });

  r.put('/:collection/:id', validate, (req, res) => {
    const { collection, id } = req.params;
    const { data, baseVersion, force } = req.body || {};
    if (data === undefined || !Number.isInteger(baseVersion)) {
      return res.status(400).json({ error: 'data and integer baseVersion are required' });
    }
    const write = db.transaction(() => {
      const row = current(collection, id);
      const forced = force === true && isState(collection);
      // Full loads hide tombstones, so a client that never saw this record (or saw it before it was
      // deleted by someone else and reloaded) re-creates it with baseVersion 0. That means "I believe it
      // does not exist", which a tombstone satisfies. An edit made against an older live version
      // (0 < baseVersion < tombstone version) is still a conflict.
      const createsOverTombstone = !!row?.deleted && baseVersion === 0;
      if (!forced && !createsOverTombstone && (row ? row.version : 0) !== baseVersion) {
        return { conflict: row ? shape(row) : null };
      }
      const version = (row ? row.version : 0) + 1;
      const rev = nextRev(db);
      db.prepare(
        `INSERT INTO records(collection, id, data, version, rev, updated_by, updated_at, deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(collection, id) DO UPDATE SET
           data = excluded.data, version = excluded.version, rev = excluded.rev,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at, deleted = 0`
      ).run(collection, id, JSON.stringify(data), version, rev, req.user.id, new Date().toISOString());
      return { version, rev };
    });
    const result = write();
    if (result.conflict !== undefined) return res.status(409).json({ error: 'conflict', current: result.conflict });
    return res.json(result);
  });

  r.delete('/:collection/:id', validate, (req, res) => {
    const { collection, id } = req.params;
    const { baseVersion } = req.body || {};
    if (!Number.isInteger(baseVersion)) return res.status(400).json({ error: 'integer baseVersion is required' });
    const remove = db.transaction(() => {
      const row = current(collection, id);
      if (!row || row.deleted) return { version: row ? row.version : 0 };
      if (row.version !== baseVersion) return { conflict: shape(row) };
      const version = row.version + 1;
      db.prepare(
        `UPDATE records SET data = NULL, version = ?, rev = ?, updated_by = ?, updated_at = ?, deleted = 1
          WHERE collection = ? AND id = ?`
      ).run(version, nextRev(db), req.user.id, new Date().toISOString(), collection, id);
      return { version };
    });
    const result = remove();
    if (result.conflict) return res.status(409).json({ error: 'conflict', current: result.conflict });
    return res.json(result);
  });

  return r;
}
