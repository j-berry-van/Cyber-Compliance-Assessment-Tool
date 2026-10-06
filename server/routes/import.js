import { Router } from 'express';
import { nextRev } from '../db.js';
import { requireAuth } from '../middlewares/auth.js';

const COLLECTION_RE = /^[A-Za-z0-9._:-]{1,100}$/;

const validEntry = (x) =>
  x !== null && typeof x === 'object' && !Array.isArray(x) &&
  typeof x.collection === 'string' && COLLECTION_RE.test(x.collection) &&
  typeof x.id === 'string' && x.id.length >= 1 && x.id.length <= 300 &&
  x.data !== undefined;

export default function importRoutes(db) {
  const r = Router();
  r.use(requireAuth);
  r.post('/', (req, res) => {
    const records = req.body && req.body.records;
    if (!Array.isArray(records) || !records.every(validEntry)) {
      return res.status(400).json({ error: 'records must be an array of {collection, id, data}' });
    }
    const seen = new Set();
    for (const x of records) {
      const key = JSON.stringify([x.collection, x.id]);
      if (seen.has(key)) return res.status(400).json({ error: 'duplicate-record' });
      seen.add(key);
    }
    const run = db.transaction(() => {
      if (db.prepare('SELECT 1 FROM records LIMIT 1').get()) return null;
      const insert = db.prepare(
        `INSERT INTO records(collection, id, data, version, rev, updated_by, updated_at, deleted)
         VALUES (?, ?, ?, 1, ?, ?, ?, 0)`
      );
      const now = new Date().toISOString();
      for (const x of records) insert.run(x.collection, x.id, JSON.stringify(x.data), nextRev(db), req.user.id, now);
      return records.length;
    });
    const imported = run();
    if (imported === null) return res.status(409).json({ error: 'workspace-not-empty' });
    return res.json({ imported });
  });
  return r;
}
