import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { makeApp, setupAdmin, JSON_HEADERS } from './helpers.js';
import { hashPassword, verifyPassword } from '../utils/passwords.js';

test('password hashing round-trips and rejects wrong passwords', () => {
  const h = hashPassword('s3cret-pass-phrase');
  assert.ok(verifyPassword('s3cret-pass-phrase', h));
  assert.ok(!verifyPassword('nope', h));
  assert.notEqual(h, hashPassword('s3cret-pass-phrase')); // salted
});

test('status reports needsSetup until the first admin exists', async () => {
  const { app } = makeApp();
  const before = await request(app).get('/api/auth/status').expect(200);
  assert.equal(before.body.needsSetup, true);
  await setupAdmin(app);
  const after = await request(app).get('/api/auth/status').expect(200);
  assert.equal(after.body.needsSetup, false);
});

test('setup is refused once a user exists', async () => {
  const { app } = makeApp();
  await setupAdmin(app);
  await request(app).post('/api/auth/setup').set(JSON_HEADERS)
    .send({ username: 'x', displayName: 'X', password: 'another long password' }).expect(409);
});

test('setup rejects short passwords', async () => {
  const { app } = makeApp();
  await request(app).post('/api/auth/setup').set(JSON_HEADERS)
    .send({ username: 'a', displayName: 'A', password: 'short' }).expect(400);
});

test('me requires a session and returns the user', async () => {
  const { app } = makeApp();
  await request(app).get('/api/auth/me').expect(401);
  const agent = await setupAdmin(app);
  const me = await agent.get('/api/auth/me').expect(200);
  assert.equal(me.body.username, 'admin');
  assert.equal(me.body.isAdmin, true);
});

test('login, logout and cookie flags', async () => {
  const { app } = makeApp();
  await setupAdmin(app);
  const agent = request.agent(app);
  await agent.post('/api/auth/login').set(JSON_HEADERS).send({ username: 'admin', password: 'wrong wrong wrong' }).expect(401);
  const ok = await agent.post('/api/auth/login').set(JSON_HEADERS).send({ username: 'ADMIN', password: 'correct horse battery' }).expect(200);
  const cookie = ok.headers['set-cookie'][0];
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  await agent.get('/api/auth/me').expect(200);
  await agent.post('/api/auth/logout').set(JSON_HEADERS).send({}).expect(200);
  await agent.get('/api/auth/me').expect(401);
});

test('state-changing requests must be JSON (CSRF guard)', async () => {
  const { app } = makeApp();
  const agent = await setupAdmin(app);
  await agent.post('/api/auth/logout').set('Content-Type', 'text/plain').send('x').expect(415);
});

test('change own password requires the current password', async () => {
  const { app } = makeApp();
  const agent = await setupAdmin(app);
  await agent.post('/api/auth/password').set(JSON_HEADERS)
    .send({ currentPassword: 'bad', newPassword: 'a brand new password' }).expect(403);
  await agent.post('/api/auth/password').set(JSON_HEADERS)
    .send({ currentPassword: 'correct horse battery', newPassword: 'a brand new password' }).expect(200);
  await request(app).post('/api/auth/login').set(JSON_HEADERS)
    .send({ username: 'admin', password: 'a brand new password' }).expect(200);
});
