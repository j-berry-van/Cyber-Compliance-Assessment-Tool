import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { makeApp, JSON_HEADERS } from './helpers.js';

const setupBody = { username: 'admin', displayName: 'Admin', password: 'correct horse battery' };

test('same-origin browser writes (Origin = Host) are accepted', async () => {
  const { app } = makeApp();
  const res = await request(app).post('/api/auth/setup').set(JSON_HEADERS)
    .set('Host', 'csf.example.org:4000').set('Origin', 'http://csf.example.org:4000').send(setupBody);
  assert.equal(res.status, 200);
});

test('requests without an Origin header are accepted', async () => {
  const { app } = makeApp();
  await request(app).get('/api/auth/status').expect(200);
});

test('the default dev origin is still allowed', async () => {
  const { app } = makeApp();
  await request(app).get('/api/auth/status').set('Origin', 'http://localhost:3000').expect(200);
});

test('a foreign Origin is refused with a JSON 403', async () => {
  const { app } = makeApp();
  const res = await request(app).post('/api/auth/setup').set(JSON_HEADERS)
    .set('Host', 'csf.example.org:4000').set('Origin', 'https://evil.example.com').send(setupBody);
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'origin-not-allowed');
});

test('an unparseable Origin is refused', async () => {
  const { app } = makeApp();
  await request(app).get('/api/auth/status').set('Origin', 'not a url').expect(403);
});
