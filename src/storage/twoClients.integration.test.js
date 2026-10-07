/**
 * Two signed-in users editing one workspace through the real sync engine against the real server
 * (server/index.js in a child process, with a throwaway SQLite file). Only the browser's fetch is
 * replaced by Node's http client with a cookie jar per user.
 */
const http = require('http');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

jest.setTimeout(60000);

let server;
let port;
let dataDir;

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => resolve(p)); });
});

class ApiError extends Error {
  constructor(status, body) { super(body?.error || `HTTP ${status}`); this.status = status; this.body = body; }
}

const makeClient = () => {
  let cookie = '';
  const api = (method, p, body) => new Promise((resolve, reject) => {
    const payload = method === 'GET' ? null : JSON.stringify(body ?? {});
    const req = http.request({
      host: '127.0.0.1', port, path: `/api${p}`, method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}) }
    }, (res) => {
      const set = res.headers['set-cookie'];
      if (set) cookie = set.map((c) => c.split(';')[0]).join('; ');
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* empty */ }
        if (res.statusCode >= 400) reject(new ApiError(res.statusCode, json)); else resolve(json);
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
  return { api, ApiError };
};

// A private copy of the engine per user (the real module is a singleton), wired to that user's client.
const loadEngine = (client) => {
  let engine;
  jest.isolateModules(() => {
    jest.doMock('./serverClient', () => ({ api: client.api, ApiError: client.ApiError, setUnauthorizedHandler: () => {} }));
    engine = require('./syncEngine');
  });
  engine.configureEngine({ debounceMs: 20, pollMs: 3600000 });
  return engine;
};

const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error('timed out waiting for condition');
};
const settled = (e) => until(() => e.useSyncStatus.getState().pending === 0 && e.useSyncStatus.getState().state !== 'saving');

let alice;
let bob;
const COLLECTION = 'assessmentsStore.assessments';

beforeAll(async () => {
  port = await freePort();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csf-int-'));
  server = spawn('node', [path.resolve(__dirname, '../../server/index.js')], {
    env: { ...process.env, MULTIUSER: 'true', PORT: String(port), DATA_DIR: dataDir, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 15000);
    server.stdout.on('data', (d) => { if (String(d).includes('Server is running')) { clearTimeout(timer); resolve(); } });
    server.on('exit', (code) => reject(new Error(`server exited early (${code})`)));
  });
  const a = makeClient();
  await a.api('POST', '/auth/setup', { username: 'alice', displayName: 'Alice', password: 'correct horse battery' });
  await a.api('POST', '/users', { username: 'bob', displayName: 'Bob', password: 'another long password' });
  const b = makeClient();
  await b.api('POST', '/auth/login', { username: 'bob', password: 'another long password' });
  alice = { client: a, id: (await a.api('GET', '/auth/me')).id };
  bob = { client: b, id: (await b.api('GET', '/auth/me')).id };
});

afterAll(() => {
  if (server) { server.removeAllListeners('exit'); server.kill(); }
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

let engA;
let engB;
beforeEach(async () => {
  localStorage.clear();
  engA = loadEngine(alice.client);
  engB = loadEngine(bob.client);
  await engA.bootstrap(alice.id);
  await engB.bootstrap(bob.id);
});
afterEach(() => { engA.reset(); engB.reset(); });

const put = (eng, id, data) => eng.enqueue({ puts: [{ collection: COLLECTION, id, data }], deletes: [] });
const read = (eng, id) => eng.readCollection(COLLECTION).get(id);
const reboot = async () => { await engA.bootstrap(alice.id); await engB.bootstrap(bob.id); };

test('a record one user creates reaches the other user, and so does its deletion', async () => {
  put(engA, 'asm-1', { id: 'asm-1', name: 'FY26' });
  await settled(engA);
  await engB.pollNow();
  expect(read(engB, 'asm-1')).toEqual({ id: 'asm-1', name: 'FY26' });
  engA.enqueue({ puts: [], deletes: [{ collection: COLLECTION, id: 'asm-1' }] });
  await settled(engA);
  await engB.pollNow();
  expect(read(engB, 'asm-1')).toBeUndefined();
});

test('edits to different fields of the same record merge: no conflict dialog, both changes kept', async () => {
  put(engA, 'asm-2', { id: 'asm-2', title: 't', status: 'open', owner: 'x' });
  await settled(engA);
  await reboot();
  put(engA, 'asm-2', { id: 'asm-2', title: 't', status: 'closed', owner: 'x' });
  await settled(engA);
  put(engB, 'asm-2', { id: 'asm-2', title: 't', status: 'open', owner: 'bob' }); // started from the old version
  await settled(engB);
  await engA.pollNow();
  const expected = { id: 'asm-2', title: 't', status: 'closed', owner: 'bob' };
  expect(engB.useSyncStatus.getState().conflicts).toEqual([]);
  expect(read(engA, 'asm-2')).toEqual(expected);
  expect(read(engB, 'asm-2')).toEqual(expected);
  const onServer = (await bob.client.api('GET', '/records?since=0')).records.find((r) => r.collection === COLLECTION && r.id === 'asm-2');
  expect(onServer.data).toEqual(expected);
});

test('two users making the identical change do not raise a conflict', async () => {
  put(engA, 'asm-3', { id: 'asm-3', status: 'open' });
  await settled(engA);
  await reboot();
  put(engA, 'asm-3', { id: 'asm-3', status: 'closed' });
  await settled(engA);
  put(engB, 'asm-3', { id: 'asm-3', status: 'closed' });
  await settled(engB);
  expect(engB.useSyncStatus.getState().conflicts).toEqual([]);
  expect(read(engB, 'asm-3')).toEqual({ id: 'asm-3', status: 'closed' });
});

test('the same field changed differently raises a conflict; keeping mine wins on the server', async () => {
  put(engA, 'asm-4', { id: 'asm-4', status: 'open' });
  await settled(engA);
  await reboot();
  put(engA, 'asm-4', { id: 'asm-4', status: 'closed' });
  await settled(engA);
  put(engB, 'asm-4', { id: 'asm-4', status: 'deferred' });
  await until(() => engB.useSyncStatus.getState().conflicts.length === 1);
  const [c] = engB.useSyncStatus.getState().conflicts;
  expect(c.mine.status).toBe('deferred');
  expect(c.theirs.status).toBe('closed');
  engB.resolveConflict(c.key, 'mine');
  await settled(engB);
  await engA.pollNow();
  expect(read(engA, 'asm-4').status).toBe('deferred');
});

test('a change queued while offline is sent on reconnect and reaches the other user', async () => {
  const flaky = makeClient();
  let down = true;
  const realApi = flaky.api;
  await realApi('POST', '/auth/login', { username: 'bob', password: 'another long password' });
  flaky.api = (m, p, b) => (down && m !== 'GET' ? Promise.reject(new flaky.ApiError(503, { error: 'down' })) : realApi(m, p, b));
  const engOff = loadEngine(flaky);
  await engOff.bootstrap(bob.id);
  put(engOff, 'asm-5', { id: 'asm-5', name: 'offline edit' });
  await until(() => engOff.useSyncStatus.getState().state === 'offline');
  expect(engOff.useSyncStatus.getState().pending).toBe(1);
  down = false;
  await engOff.flushNow();
  await settled(engOff);
  await engA.pollNow();
  expect(read(engA, 'asm-5')).toEqual({ id: 'asm-5', name: 'offline edit' });
  engOff.reset();
});

test('re-creating a record someone deleted before this user loaded succeeds without a conflict', async () => {
  put(engA, 'asm-6', { id: 'asm-6', name: 'first' });
  await settled(engA);
  engA.enqueue({ puts: [], deletes: [{ collection: COLLECTION, id: 'asm-6' }] });
  await settled(engA);
  await reboot(); // full load hides tombstones, so B has no entry for asm-6
  put(engB, 'asm-6', { id: 'asm-6', name: 'second' });
  await settled(engB);
  expect(engB.useSyncStatus.getState().conflicts).toEqual([]);
  await engA.pollNow();
  expect(read(engA, 'asm-6')).toEqual({ id: 'asm-6', name: 'second' });
});
