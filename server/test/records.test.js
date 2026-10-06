import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { makeApp, setupAdmin, JSON_HEADERS } from './helpers.js';

const put = (agent, c, id, body) =>
  agent.put(`/api/records/${encodeURIComponent(c)}/${encodeURIComponent(id)}`).set(JSON_HEADERS).send(body);
const del = (agent, c, id, body) =>
  agent.delete(`/api/records/${encodeURIComponent(c)}/${encodeURIComponent(id)}`).set(JSON_HEADERS).send(body);

test('records require a session', async () => {
  const { app } = makeApp();
  await request(app).get('/api/records').expect(401);
});

test('create, read back, and version increments', async () => {
  const { app } = makeApp();
  const a = await setupAdmin(app);
  const r1 = await put(a, 'findings', 'f1', { data: { title: 'one' }, baseVersion: 0 }).expect(200);
  assert.equal(r1.body.version, 1);
  const r2 = await put(a, 'findings', 'f1', { data: { title: 'two' }, baseVersion: 1 }).expect(200);
  assert.equal(r2.body.version, 2);
  const all = await a.get('/api/records?since=0').expect(200);
  assert.equal(all.body.records.length, 1);
  assert.deepEqual(all.body.records[0].data, { title: 'two' });
  assert.equal(all.body.records[0].updatedBy, 1);
});

test('stale baseVersion returns 409 with the current copy', async () => {
  const { app } = makeApp();
  const a = await setupAdmin(app);
  await put(a, 'findings', 'f1', { data: { title: 'one' }, baseVersion: 0 }).expect(200);
  await put(a, 'findings', 'f1', { data: { title: 'two' }, baseVersion: 1 }).expect(200);
  const res = await put(a, 'findings', 'f1', { data: { title: 'mine' }, baseVersion: 1 }).expect(409);
  assert.equal(res.body.error, 'conflict');
  assert.equal(res.body.current.version, 2);
  assert.deepEqual(res.body.current.data, { title: 'two' });
});

test('creating over an existing id with baseVersion 0 conflicts', async () => {
  const { app } = makeApp();
  const a = await setupAdmin(app);
  await put(a, 'findings', 'f1', { data: {}, baseVersion: 0 }).expect(200);
  await put(a, 'findings', 'f1', { data: {}, baseVersion: 0 }).expect(409);
});

test(':state collections accept force writes, others ignore force', async () => {
  const { app } = makeApp();
  const a = await setupAdmin(app);
  await put(a, 'x:state', 'state', { data: { n: 1 }, baseVersion: 0 }).expect(200);
  await put(a, 'x:state', 'state', { data: { n: 2 }, baseVersion: 0, force: true }).expect(200);
  await put(a, 'findings', 'f1', { data: {}, baseVersion: 0 }).expect(200);
  await put(a, 'findings', 'f1', { data: {}, baseVersion: 0, force: true }).expect(409);
});

test('soft delete: hidden from full loads, visible as a tombstone to since-cursors', async () => {
  const { app } = makeApp();
  const a = await setupAdmin(app);
  await put(a, 'findings', 'f1', { data: { t: 1 }, baseVersion: 0 }).expect(200);
  const first = await a.get('/api/records?since=0').expect(200);
  await del(a, 'findings', 'f1', { baseVersion: 1 }).expect(200);
  const full = await a.get('/api/records?since=0').expect(200);
  assert.equal(full.body.records.length, 0);
  const delta = await a.get(`/api/records?since=${first.body.cursor}`).expect(200);
  assert.equal(delta.body.records.length, 1);
  assert.equal(delta.body.records[0].deleted, true);
});

test('deleting a missing record is a no-op; stale delete conflicts', async () => {
  const { app } = makeApp();
  const a = await setupAdmin(app);
  const none = await del(a, 'findings', 'ghost', { baseVersion: 0 }).expect(200);
  assert.equal(none.body.version, 0);
  await put(a, 'findings', 'f1', { data: {}, baseVersion: 0 }).expect(200);
  await put(a, 'findings', 'f1', { data: {}, baseVersion: 1 }).expect(200);
  await del(a, 'findings', 'f1', { baseVersion: 1 }).expect(409);
});

test('since-cursor returns only newer revisions and a stable cursor', async () => {
  const { app } = makeApp();
  const a = await setupAdmin(app);
  await put(a, 'c', 'a', { data: 1, baseVersion: 0 }).expect(200);
  const s1 = await a.get('/api/records?since=0').expect(200);
  await put(a, 'c', 'b', { data: 2, baseVersion: 0 }).expect(200);
  const s2 = await a.get(`/api/records?since=${s1.body.cursor}`).expect(200);
  assert.deepEqual(s2.body.records.map((r) => r.id), ['b']);
  const s3 = await a.get(`/api/records?since=${s2.body.cursor}`).expect(200);
  assert.equal(s3.body.records.length, 0);
  assert.equal(s3.body.cursor, s2.body.cursor);
});

test('ids with slashes, spaces and unicode round-trip', async () => {
  const { app } = makeApp();
  const a = await setupAdmin(app);
  const id = 'GV.SC-04/x ?#Ü';
  await put(a, 'c', id, { data: { ok: true }, baseVersion: 0 }).expect(200);
  const all = await a.get('/api/records?since=0').expect(200);
  assert.equal(all.body.records[0].id, id);
});

test('invalid collection names and payloads are rejected', async () => {
  const { app } = makeApp();
  const a = await setupAdmin(app);
  await put(a, 'bad name!', 'x', { data: 1, baseVersion: 0 }).expect(400);
  await put(a, 'c', 'x', { baseVersion: 0 }).expect(400); // missing data
  await put(a, 'c', 'x', { data: 1 }).expect(400); // missing baseVersion
});

test('large records are accepted', async () => {
  const { app } = makeApp();
  const a = await setupAdmin(app);
  await put(a, 'c', 'big', { data: { blob: 'x'.repeat(2_000_000) }, baseVersion: 0 }).expect(200);
});

test('PUT with data: null is accepted (null is a valid JSON value; only missing data is rejected)', async () => {
  const { app } = makeApp();
  const a = await setupAdmin(app);
  await put(a, 'c', 'n', { data: null, baseVersion: 0 }).expect(200);
  const all = await a.get('/api/records?since=0').expect(200);
  assert.equal(all.body.records.length, 1);
  assert.equal(all.body.records[0].data, null);
  assert.equal(all.body.records[0].deleted, false);
});

test('unauthenticated PUT and DELETE return 401', async () => {
  const { app } = makeApp();
  await request(app).put('/api/records/c/x').set(JSON_HEADERS).send({ data: 1, baseVersion: 0 }).expect(401);
  await request(app).delete('/api/records/c/x').set(JSON_HEADERS).send({ baseVersion: 0 }).expect(401);
});

test('baseVersion must be an integer on PUT and DELETE', async () => {
  const { app } = makeApp();
  const a = await setupAdmin(app);
  for (const bad of [null, '0', 0.5, true, [], {}]) {
    await put(a, 'c', 'x', { data: 1, baseVersion: bad }).expect(400);
    await del(a, 'c', 'x', { baseVersion: bad }).expect(400);
  }
  const all = await a.get('/api/records?since=0').expect(200);
  assert.equal(all.body.records.length, 0);
});

test('force is honored only when strictly boolean true', async () => {
  const { app } = makeApp();
  const a = await setupAdmin(app);
  await put(a, 'x:state', 'state', { data: { n: 1 }, baseVersion: 0 }).expect(200);
  for (const bad of ['true', 1, 'yes', {}, [], null]) {
    await put(a, 'x:state', 'state', { data: { n: 2 }, baseVersion: 0, force: bad }).expect(409);
  }
  await put(a, 'x:state', 'state', { data: { n: 3 }, baseVersion: 0, force: true }).expect(200);
});

test('non-numeric or malformed since is treated as 0', async () => {
  const { app } = makeApp();
  const a = await setupAdmin(app);
  await put(a, 'c', 'a', { data: 1, baseVersion: 0 }).expect(200);
  for (const s of ['abc', '', '-5', '1e3', '0x10', '1abc']) {
    const res = await a.get(`/api/records?since=${encodeURIComponent(s)}`).expect(200);
    assert.equal(res.body.records.length, 1, `since=${s}`);
  }
});

test('updatedBy comes from the session, not the body', async () => {
  const { app } = makeApp();
  const a = await setupAdmin(app);
  await put(a, 'c', 'a', { data: 1, baseVersion: 0, updatedBy: 999 }).expect(200);
  const all = await a.get('/api/records?since=0').expect(200);
  assert.equal(all.body.records[0].updatedBy, 1);
});

test('id length limits and re-creating a deleted record', async () => {
  const { app } = makeApp();
  const a = await setupAdmin(app);
  await put(a, 'c', 'x'.repeat(301), { data: 1, baseVersion: 0 }).expect(400);
  await put(a, 'c', 'x'.repeat(300), { data: 1, baseVersion: 0 }).expect(200);
  await put(a, 'c', 'r', { data: 1, baseVersion: 0 }).expect(200);
  await del(a, 'c', 'r', { baseVersion: 1 }).expect(200);
  const re = await put(a, 'c', 'r', { data: 2, baseVersion: 2 }).expect(200);
  assert.equal(re.body.version, 3);
  const all = await a.get('/api/records?since=0').expect(200);
  assert.ok(all.body.records.some((r) => r.id === 'r' && r.deleted === false));
});
