import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { makeApp, setupAdmin, JSON_HEADERS } from './helpers.js';

const recs = [
  { collection: 'findings', id: 'f1', data: { t: 1 } },
  { collection: 'findings', id: 'f2', data: { t: 2 } }
];

test('import loads records into an empty workspace at version 1', async () => {
  const { app } = makeApp();
  const a = await setupAdmin(app);
  const res = await a.post('/api/import').set(JSON_HEADERS).send({ records: recs }).expect(200);
  assert.equal(res.body.imported, 2);
  const all = await a.get('/api/records?since=0').expect(200);
  assert.deepEqual(all.body.records.map((r) => [r.id, r.version]), [['f1', 1], ['f2', 1]]);
});

test('imported records are attributed to the importing user', async () => {
  const { app } = makeApp();
  const a = await setupAdmin(app);
  const me = await a.get('/api/auth/me').expect(200);
  await a.post('/api/import').set(JSON_HEADERS).send({ records: recs }).expect(200);
  const all = await a.get('/api/records?since=0').expect(200);
  assert.equal(all.body.records.length, 2);
  for (const r of all.body.records) {
    assert.equal(r.updatedBy, me.body.id);
    assert.deepEqual(r.data, recs.find((x) => x.id === r.id).data);
  }
});

test('import is refused when the workspace already has data', async () => {
  const { app } = makeApp();
  const a = await setupAdmin(app);
  await a.post('/api/import').set(JSON_HEADERS).send({ records: recs }).expect(200);
  const again = await a.post('/api/import').set(JSON_HEADERS).send({ records: recs }).expect(409);
  assert.equal(again.body.error, 'workspace-not-empty');
});

test('soft-deleted rows still block import', async () => {
  const { app } = makeApp();
  const a = await setupAdmin(app);
  await a.post('/api/import').set(JSON_HEADERS).send({ records: recs }).expect(200);
  await a.delete('/api/records/findings/f1').set(JSON_HEADERS).send({ baseVersion: 1 });
  await a.delete('/api/records/findings/f2').set(JSON_HEADERS).send({ baseVersion: 1 });
  await a.post('/api/import').set(JSON_HEADERS).send({ records: [{ collection: 'x', id: 'y', data: 1 }] }).expect(409);
});

test('import validates its payload', async () => {
  const { app } = makeApp();
  const a = await setupAdmin(app);
  await a.post('/api/import').set(JSON_HEADERS).send({ records: 'nope' }).expect(400);
  await a.post('/api/import').set(JSON_HEADERS).send({ records: [{ collection: 'bad name', id: 'x', data: 1 }] }).expect(400);
  await a.post('/api/import').set(JSON_HEADERS).send({ records: [null] }).expect(400);
  await a.post('/api/import').set(JSON_HEADERS).send({ records: ['str'] }).expect(400);
  await a.post('/api/import').set(JSON_HEADERS).send({ records: [{ collection: 'c', id: 5, data: 1 }] }).expect(400);
  await a.post('/api/import').set(JSON_HEADERS).send({ records: [{ collection: 'c', id: 'x' }] }).expect(400);
});

test('duplicate (collection,id) in payload is 400 and nothing is written', async () => {
  const { app, db } = makeApp();
  const a = await setupAdmin(app);
  const dup = [...recs, { collection: 'findings', id: 'f1', data: { t: 3 } }];
  await a.post('/api/import').set(JSON_HEADERS).send({ records: dup }).expect(400);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM records').get().n, 0);
  // workspace still importable afterwards
  await a.post('/api/import').set(JSON_HEADERS).send({ records: recs }).expect(200);
});

test('unauthenticated import is 401', async () => {
  const { app, db } = makeApp();
  await request(app).post('/api/import').set(JSON_HEADERS).send({ records: recs }).expect(401);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM records').get().n, 0);
});
