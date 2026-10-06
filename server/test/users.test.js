import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { makeApp, setupAdmin, JSON_HEADERS } from './helpers.js';

const newUser = { username: 'sam', displayName: 'Sam', password: 'sam has a long password' };

test('admin creates a user who can sign in; non-admins cannot manage users', async () => {
  const { app } = makeApp();
  const admin = await setupAdmin(app);
  await admin.post('/api/users').set(JSON_HEADERS).send(newUser).expect(201);
  const sam = request.agent(app);
  await sam.post('/api/auth/login').set(JSON_HEADERS).send({ username: 'sam', password: newUser.password }).expect(200);
  await sam.post('/api/users').set(JSON_HEADERS).send({ ...newUser, username: 'x' }).expect(403);
  const list = await sam.get('/api/users').expect(200);
  assert.deepEqual(list.body.map((u) => u.username).sort(), ['admin', 'sam']);
});

test('duplicate usernames (case-insensitive) are rejected', async () => {
  const { app } = makeApp();
  const admin = await setupAdmin(app);
  await admin.post('/api/users').set(JSON_HEADERS).send(newUser).expect(201);
  await admin.post('/api/users').set(JSON_HEADERS).send({ ...newUser, username: 'SAM' }).expect(409);
});

test('disabling a user kills their session and blocks login', async () => {
  const { app } = makeApp();
  const admin = await setupAdmin(app);
  const created = await admin.post('/api/users').set(JSON_HEADERS).send(newUser).expect(201);
  const sam = request.agent(app);
  await sam.post('/api/auth/login').set(JSON_HEADERS).send({ username: 'sam', password: newUser.password }).expect(200);
  await admin.patch(`/api/users/${created.body.id}`).set(JSON_HEADERS).send({ disabled: true }).expect(200);
  await sam.get('/api/auth/me').expect(401);
  await request(app).post('/api/auth/login').set(JSON_HEADERS).send({ username: 'sam', password: newUser.password }).expect(401);
});

test('admin can reset a password', async () => {
  const { app } = makeApp();
  const admin = await setupAdmin(app);
  const created = await admin.post('/api/users').set(JSON_HEADERS).send(newUser).expect(201);
  await admin.patch(`/api/users/${created.body.id}`).set(JSON_HEADERS).send({ password: 'reset to something new' }).expect(200);
  await request(app).post('/api/auth/login').set(JSON_HEADERS).send({ username: 'sam', password: 'reset to something new' }).expect(200);
});

test('password reset kills the user\'s existing sessions', async () => {
  const { app } = makeApp();
  const admin = await setupAdmin(app);
  const created = await admin.post('/api/users').set(JSON_HEADERS).send(newUser).expect(201);
  const sam = request.agent(app);
  await sam.post('/api/auth/login').set(JSON_HEADERS).send({ username: 'sam', password: newUser.password }).expect(200);
  await admin.patch(`/api/users/${created.body.id}`).set(JSON_HEADERS).send({ password: 'reset to something new' }).expect(200);
  await sam.get('/api/auth/me').expect(401);
});

test('the last active admin cannot be disabled or demoted', async () => {
  const { app } = makeApp();
  const admin = await setupAdmin(app);
  const me = await admin.get('/api/auth/me');
  await admin.patch(`/api/users/${me.body.id}`).set(JSON_HEADERS).send({ disabled: true }).expect(409);
  await admin.patch(`/api/users/${me.body.id}`).set(JSON_HEADERS).send({ isAdmin: false }).expect(409);
});

test('participantId can be linked and is returned by /me', async () => {
  const { app } = makeApp();
  const admin = await setupAdmin(app);
  const me = await admin.get('/api/auth/me');
  await admin.patch(`/api/users/${me.body.id}`).set(JSON_HEADERS).send({ participantId: 3 }).expect(200);
  const again = await admin.get('/api/auth/me').expect(200);
  assert.equal(again.body.participantId, 3);
});

test('POST rejects blank or whitespace-only username/displayName and short passwords', async () => {
  const { app } = makeApp();
  const admin = await setupAdmin(app);
  await admin.post('/api/users').set(JSON_HEADERS).send({ ...newUser, username: '   ' }).expect(400);
  await admin.post('/api/users').set(JSON_HEADERS).send({ ...newUser, displayName: '   ' }).expect(400);
  await admin.post('/api/users').set(JSON_HEADERS).send({ ...newUser, username: 5 }).expect(400);
  await admin.post('/api/users').set(JSON_HEADERS).send({ ...newUser, password: 'short' }).expect(400);
});

test('PATCH rejects whitespace-only displayName, short password and bad participantId; 404 for unknown user', async () => {
  const { app } = makeApp();
  const admin = await setupAdmin(app);
  const created = await admin.post('/api/users').set(JSON_HEADERS).send(newUser).expect(201);
  const url = `/api/users/${created.body.id}`;
  await admin.patch(url).set(JSON_HEADERS).send({ displayName: '   ' }).expect(400);
  await admin.patch(url).set(JSON_HEADERS).send({ password: 'short' }).expect(400);
  await admin.patch(url).set(JSON_HEADERS).send({ participantId: 'abc' }).expect(400);
  await admin.patch('/api/users/9999').set(JSON_HEADERS).send({ displayName: 'x' }).expect(404);
  await admin.patch(url).set(JSON_HEADERS).send({ displayName: '  Samuel ' }).expect(200);
  const list = await admin.get('/api/users').expect(200);
  assert.ok(list.body.some((u) => u.displayName === 'Samuel'));
});

test('an admin can be demoted when another active admin exists', async () => {
  const { app } = makeApp();
  const admin = await setupAdmin(app);
  const me = await admin.get('/api/auth/me');
  await admin.post('/api/users').set(JSON_HEADERS).send({ ...newUser, isAdmin: true }).expect(201);
  await admin.patch(`/api/users/${me.body.id}`).set(JSON_HEADERS).send({ isAdmin: false }).expect(200);
});

test('non-boolean isAdmin/disabled are rejected and cannot bypass the last-admin guard', async () => {
  const { app } = makeApp();
  const admin = await setupAdmin(app);
  const me = await admin.get('/api/auth/me');
  const url = `/api/users/${me.body.id}`;
  await admin.patch(url).set(JSON_HEADERS).send({ isAdmin: null }).expect(400);
  await admin.patch(url).set(JSON_HEADERS).send({ disabled: null }).expect(400);
  await admin.patch(url).set(JSON_HEADERS).send({ isAdmin: 'false' }).expect(400);
  await admin.patch(url).set(JSON_HEADERS).send({ disabled: 'true' }).expect(400);
  await admin.post('/api/users').set(JSON_HEADERS).send({ ...newUser, isAdmin: 'yes' }).expect(400);
  await admin.post('/api/users').set(JSON_HEADERS).send({ ...newUser, isAdmin: null }).expect(400);
  const after = await admin.get('/api/users').expect(200);
  assert.equal(after.body[0].isAdmin, true);
  assert.equal(after.body[0].disabled, false);
});

test('non-admin PATCH is forbidden', async () => {
  const { app } = makeApp();
  const admin = await setupAdmin(app);
  const created = await admin.post('/api/users').set(JSON_HEADERS).send(newUser).expect(201);
  const sam = request.agent(app);
  await sam.post('/api/auth/login').set(JSON_HEADERS).send({ username: 'sam', password: newUser.password }).expect(200);
  await sam.patch(`/api/users/${created.body.id}`).set(JSON_HEADERS).send({ displayName: 'Hax' }).expect(403);
});

test('demote+disable in one PATCH on the last admin is 409', async () => {
  const { app } = makeApp();
  const admin = await setupAdmin(app);
  const me = await admin.get('/api/auth/me');
  await admin.patch(`/api/users/${me.body.id}`).set(JSON_HEADERS).send({ isAdmin: false, disabled: true }).expect(409);
});

test('with a second active admin the first can be disabled; a disabled admin does not count', async () => {
  const { app } = makeApp();
  const admin = await setupAdmin(app);
  const me = await admin.get('/api/auth/me');
  const b = await admin.post('/api/users').set(JSON_HEADERS).send({ ...newUser, isAdmin: true }).expect(201);
  // disable B first: A is then the only active admin, so A cannot be disabled
  await admin.patch(`/api/users/${b.body.id}`).set(JSON_HEADERS).send({ disabled: true }).expect(200);
  await admin.patch(`/api/users/${me.body.id}`).set(JSON_HEADERS).send({ disabled: true }).expect(409);
  // re-enable B: now A can be disabled
  await admin.patch(`/api/users/${b.body.id}`).set(JSON_HEADERS).send({ disabled: false }).expect(200);
  await admin.patch(`/api/users/${me.body.id}`).set(JSON_HEADERS).send({ disabled: true }).expect(200);
});
