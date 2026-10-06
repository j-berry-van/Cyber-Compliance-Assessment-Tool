# Multi-user Server Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a small team self-host the app so assessment data lives in a server database (shared across browsers) and each person signs in with their own account, while the existing browser-only mode keeps working.

**Architecture:** The Express server in `server/` gains a SQLite database, session auth and a generic per-record API (`records` table). On the client, each zustand store keeps `persist(...)` but takes its `storage` from `createStorage(name)`, which returns the existing localStorage backend in local mode or a new server backend in server mode. The server backend diffs each store's state into per-record writes with optimistic versions, queues them in an outbox, polls for remote changes, and surfaces 409 conflicts for the user to resolve.

**Tech Stack:** Node 18 + Express 5 (ESM), `better-sqlite3`, `cookie-parser`, Node `crypto.scrypt`, `node:test` + `supertest` (server tests); React 19, zustand 5, Jest via `react-scripts` (client tests).

**Spec:** `docs/superpowers/specs/2026-10-06-multi-user-server-storage-design.md` (read it first; this plan amends it in Task 14, see "Spec amendments").

## Global Constraints

- Database: SQLite via `better-sqlite3`, a single file under a configurable data directory (`DATA_DIR`, default `./data`).
- Session cookie: opaque random ID, `HttpOnly`, `SameSite=Lax`, `Secure` over HTTPS, 14-day sliding expiry.
- `records` table is `(collection, id, data, version, rev, updated_by, updated_at, deleted)` with primary key `(collection, id)`; deletes are soft.
- `PUT`/`DELETE` take `baseVersion`; a stale `baseVersion` returns **409** with the current server copy.
- No roles beyond `is_admin`, which only gates user management. No self-signup, no email.
- First admin is created via `POST /auth/setup`, allowed only while `users` is empty.
- Client writes are debounced ~500 ms; client polls every 15-30 s (use 20 s) and on window focus.
- Local mode (no `REACT_APP_SERVER_MODE`) must behave exactly as today: no login, localStorage persistence, all existing tests pass. The Tauri build is always local mode.
- The server must keep working as an AI-proxy-only server when `MULTIUSER` is not `true` (today's behavior).
- Server never trusts a client-supplied author: `updated_by` comes from the session.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Test commands: server `cd server && npm test`; client `CI=true npx react-scripts test --watchAll=false <path>` from the repo root.

## Review Focus

- A synced collection item with no `id`, or two items with the same id, must produce a loud visible error and never silently drop data (Task 6, Task 10).
- Session expires mid-session (401 on poll or flush): the app returns to the login screen and the unsent outbox survives for the next login (Task 7, Task 9).
- A second teammate's browser still holding local data must not be able to overwrite an already-populated workspace, and their local data must be left untouched (Task 5, Task 12).
- Ids containing `/`, `?`, `#`, spaces or non-ASCII (e.g. `GV.SC-04/x`, `Ü`) must round-trip through the records API (Task 4, Task 7).
- A poll that brings remote changes while the user has unsent local edits must not wipe those edits (Task 7).
- Disabling a user or demoting the last admin must not lock the team out (Task 3).

---

## File Structure

**Server (`server/`, ESM)**
- `db.js` — `openDb(file)`, numbered SQL migrations via `PRAGMA user_version`, `nextRev(db)`.
- `app.js` — `createApp({ db, staticDir })`: helmet/cors/json/cookies, mounts routers, serves the build.
- `index.js` — reads env, opens the DB, calls `createApp`, listens. (Modified.)
- `utils/passwords.js` — `hashPassword`, `verifyPassword` (scrypt).
- `middlewares/auth.js` — `sessionMiddleware`, `requireAuth`, `requireAdmin`, `requireJson`, `createSession`, `destroySession`, cookie helpers.
- `routes/auth.js`, `routes/users.js`, `routes/records.js`, `routes/import.js` — one router each.
- `utils/rateLimiter.js` — add `loginLimiter`. (Modified.)
- `test/helpers.js`, `test/*.test.js` — `node:test` suites.

**Client (`src/storage/`, new)**
- `serverClient.js` — `api(method, path, body)`, `ApiError`.
- `diff.js` — pure functions: `toRecords`, `fromRecords`, `diffRecords`, `storeNameOf`, `isStateRecord`.
- `syncEngine.js` — singleton: cache, outbox, conflicts, bootstrap, flush, poll, `useSyncStatus`.
- `serverStorage.js` — `createServerStateStorage(storeName, config)` (zustand `StateStorage`).
- `storeConfigs.js` — which stores sync and how.
- `createStorage.js` — `isServerMode()`, `createStorage(name)`.
- `authStore.js` — session/login state, directory of accounts.
- `rehydrateOnRemote.js` — rehydrates stores when the engine reports remote changes; `whenAllHydrated()`.
- `importLocalData.js` — one-time browser-to-server import.
- `activity.js` — "who worked on this assessment" helper.
- `components/AuthGate.js`, `pages/Login.js` (inside `src/pages/`), `pages/Accounts.js`, `components/SyncConflictDialog.js`, `components/ImportLocalDataPrompt.js`.

---

### Task 1: Server foundation (database and app factory)

**Files:**
- Modify: `server/package.json`, `server/index.js`
- Create: `server/db.js`, `server/app.js`, `server/test/helpers.js`, `server/test/db.test.js`
- Modify: `.gitignore` (add `server/data/` and `data/*.db*` are NOT used; add `server/data/`)

**Interfaces:**
- Produces: `openDb(file?: string): Database` (default `:memory:`), `nextRev(db): number`, `createApp({ db, staticDir? }): express.Express`, test helper `makeApp(): { app, db }`.

- [ ] **Step 1: Install dependencies**

```bash
cd server && npm install better-sqlite3 cookie-parser && npm install -D supertest
```

Edit `server/package.json` scripts: `"test": "node --test test/"`, and add `"start": "node index.js"`.

- [ ] **Step 2: Write the failing test** — `server/test/db.test.js`

```js
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
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd server && npm test`
Expected: FAIL, `Cannot find module '../db.js'`.

- [ ] **Step 4: Implement `server/db.js`**

```js
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
```

- [ ] **Step 5: Implement `server/app.js` by moving the middleware out of `index.js`**

Move the CORS/helmet/bodyParser/rate-limit/`/api/ai` setup from `server/index.js` into `createApp`. Keep behavior identical for the AI routes. Replace `bodyParser.json()` with `express.json({ limit: '25mb' })`, add `cookie-parser`, and scope `apiLimiter` to `/api/ai` only (a global 50 req/15 min limit would throttle polling).

```js
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import aiRoutes from './routes/ai.js';
import { apiLimiter } from './utils/rateLimiter.js';

export function createApp({ db = null, staticDir = null } = {}) {
  const app = express();
  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
    : ['http://localhost:3000', 'http://127.0.0.1:3000'];

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'], connectSrc: ["'self'"], fontSrc: ["'self'"],
        objectSrc: ["'none'"], mediaSrc: ["'self'"], frameSrc: ["'none'"]
      }
    },
    crossOriginEmbedderPolicy: false,
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true }
  }));
  app.use(cors({
    origin(origin, cb) {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    optionsSuccessStatus: 200
  }));
  app.use(express.json({ limit: '25mb' }));
  app.use(cookieParser());

  app.locals.db = db;
  // Later tasks mount auth/users/records/import routers here when db is set.
  app.use('/api/ai', apiLimiter, aiRoutes);

  if (staticDir) {
    app.use(express.static(staticDir));
    app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile('index.html', { root: staticDir }));
  } else {
    app.get('/', (req, res) => res.json({ message: 'Welcome to the Express server!' }));
  }
  return app;
}
```

Rewrite `server/index.js`:

```js
import './env.js';
import path from 'node:path';
import fs from 'node:fs';
import { createApp } from './app.js';
import { openDb } from './db.js';

const PORT = process.env.PORT || 4000;
const multiuser = process.env.MULTIUSER === 'true';
let db = null;
if (multiuser) {
  const dir = path.resolve(process.env.DATA_DIR || './data');
  fs.mkdirSync(dir, { recursive: true });
  db = openDb(path.join(dir, 'csf.db'));
}
const staticDir = process.env.STATIC_DIR ? path.resolve(process.env.STATIC_DIR) : null;
createApp({ db, staticDir }).listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}${multiuser ? ' (multi-user)' : ''}`);
});
```

`server/test/helpers.js`:

```js
import request from 'supertest';
import { openDb } from '../db.js';
import { createApp } from '../app.js';

export function makeApp() {
  const db = openDb(':memory:');
  const app = createApp({ db });
  return { app, db };
}

export const JSON_HEADERS = { 'Content-Type': 'application/json' };

export async function setupAdmin(app, overrides = {}) {
  const agent = request.agent(app);
  const body = { username: 'admin', displayName: 'Admin', password: 'correct horse battery', ...overrides };
  await agent.post('/api/auth/setup').set(JSON_HEADERS).send(body).expect(200);
  return agent;
}
```

(`setupAdmin` is used from Task 2 onward.)

- [ ] **Step 6: Run the tests and a smoke start**

Run: `cd server && npm test`
Expected: PASS (3 tests).
Run: `cd server && node index.js` then Ctrl-C after "Server is running". Expected: starts without error (AI-proxy mode, no DB created).

- [ ] **Step 7: Commit**

```bash
git add server .gitignore
git commit -m "feat(server): SQLite foundation and testable app factory"
```

---

### Task 2: Passwords, sessions and auth routes

**Files:**
- Create: `server/utils/passwords.js`, `server/middlewares/auth.js`, `server/routes/auth.js`, `server/test/auth.test.js`
- Modify: `server/app.js`, `server/utils/rateLimiter.js`

**Interfaces:**
- Consumes: `openDb`, `createApp`, `makeApp`, `setupAdmin`, `JSON_HEADERS` (Task 1).
- Produces: `hashPassword(pw): string`, `verifyPassword(pw, stored): boolean`; middlewares `sessionMiddleware(db)`, `requireAuth`, `requireAdmin`, `requireJson`; `createSession(db, userId, res)`, `destroySession(db, req, res)`. `req.user` shape: `{ id, username, displayName, isAdmin, participantId }`. Routes: `GET /api/auth/status` → `{ needsSetup }`; `POST /api/auth/setup`; `POST /api/auth/login`; `POST /api/auth/logout`; `GET /api/auth/me` → user or 401; `POST /api/auth/password`.

- [ ] **Step 1: Write the failing tests** — `server/test/auth.test.js`

```js
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
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && npm test`
Expected: FAIL (`utils/passwords.js` missing / 404 on routes).

- [ ] **Step 3: Implement `server/utils/passwords.js`**

```js
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

const N = 16384, R = 8, P = 1, KEYLEN = 64;
export const MIN_PASSWORD_LENGTH = 10;

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEYLEN, { N, r: R, p: P });
  return ['scrypt', N, R, P, salt.toString('base64'), hash.toString('base64')].join('$');
}

export function verifyPassword(password, stored) {
  const [scheme, n, r, p, saltB64, hashB64] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length,
    { N: Number(n), r: Number(r), p: Number(p) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
```

- [ ] **Step 4: Implement `server/middlewares/auth.js`**

```js
import { randomBytes, createHash } from 'node:crypto';

export const COOKIE_NAME = 'csf_session';
const SESSION_MS = 14 * 24 * 60 * 60 * 1000;
const hashToken = (t) => createHash('sha256').update(t).digest('hex');

const cookieOptions = (req) => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.COOKIE_SECURE === 'true' || req.secure,
  maxAge: SESSION_MS,
  path: '/'
});

export function createSession(db, userId, req, res) {
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(id, user_id, expires_at) VALUES (?, ?, ?)')
    .run(hashToken(token), userId, Date.now() + SESSION_MS);
  res.cookie(COOKIE_NAME, token, cookieOptions(req));
}

export function destroySession(db, req, res) {
  const token = req.cookies?.[COOKIE_NAME];
  if (token) db.prepare('DELETE FROM sessions WHERE id = ?').run(hashToken(token));
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

export function sessionMiddleware(db) {
  return (req, res, next) => {
    req.user = null;
    const token = req.cookies?.[COOKIE_NAME];
    if (token) {
      const id = hashToken(token);
      const row = db.prepare(
        `SELECT u.id, u.username, u.display_name, u.is_admin, u.participant_id, s.expires_at
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.id = ? AND u.disabled = 0`
      ).get(id);
      if (row && row.expires_at > Date.now()) {
        req.user = {
          id: row.id, username: row.username, displayName: row.display_name,
          isAdmin: !!row.is_admin, participantId: row.participant_id
        };
        if (row.expires_at - Date.now() < SESSION_MS - 60 * 60 * 1000) { // slide at most hourly
          db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(Date.now() + SESSION_MS, id);
          res.cookie(COOKIE_NAME, token, cookieOptions(req));
        }
      }
    }
    next();
  };
}

export const requireAuth = (req, res, next) =>
  req.user ? next() : res.status(401).json({ error: 'unauthenticated' });

export const requireAdmin = (req, res, next) =>
  req.user?.isAdmin ? next() : res.status(403).json({ error: 'admin-only' });

// SameSite=Lax plus a JSON-only rule is the CSRF guard: a cross-site form post cannot send this content type.
export const requireJson = (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  return (req.headers['content-type'] || '').startsWith('application/json')
    ? next()
    : res.status(415).json({ error: 'content-type must be application/json' });
};
```

- [ ] **Step 5: Implement `server/routes/auth.js` and a `loginLimiter`**

Add to `server/utils/rateLimiter.js` (before the default export):

```js
// Login attempts: 20 per 15 minutes per IP (a shared office IP must not lock the team out).
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many login attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false
});
```

`server/routes/auth.js`:

```js
import { Router } from 'express';
import { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } from '../utils/passwords.js';
import { createSession, destroySession, requireAuth } from '../middlewares/auth.js';
import { loginLimiter } from '../utils/rateLimiter.js';

const publicUser = (u) => ({
  id: u.id, username: u.username, displayName: u.displayName, isAdmin: u.isAdmin, participantId: u.participantId ?? null
});

export default function authRoutes(db) {
  const r = Router();
  const userCount = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

  r.get('/status', (req, res) => res.json({ needsSetup: userCount() === 0 }));

  r.post('/setup', loginLimiter, (req, res) => {
    const { username, displayName, password } = req.body || {};
    if (!username || !displayName || typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `username, displayName and a password of at least ${MIN_PASSWORD_LENGTH} characters are required` });
    }
    // Insert-if-empty in one statement so two simultaneous setups cannot both win.
    const info = db.prepare(
      `INSERT INTO users(username, display_name, password_hash, is_admin, created_at)
       SELECT ?, ?, ?, 1, ? WHERE NOT EXISTS (SELECT 1 FROM users)`
    ).run(String(username).trim(), String(displayName).trim(), hashPassword(password), new Date().toISOString());
    if (info.changes === 0) return res.status(409).json({ error: 'setup-already-done' });
    createSession(db, info.lastInsertRowid, req, res);
    return res.json({ ok: true });
  });

  r.post('/login', loginLimiter, (req, res) => {
    const { username, password } = req.body || {};
    const row = db.prepare('SELECT * FROM users WHERE username = ? AND disabled = 0').get(String(username || ''));
    // Verify against a dummy hash when the user is missing so timing does not reveal valid usernames.
    const ok = row ? verifyPassword(String(password || ''), row.password_hash) : (verifyPassword('x', hashPassword('y')), false);
    if (!ok) return res.status(401).json({ error: 'invalid-credentials' });
    createSession(db, row.id, req, res);
    return res.json({ ok: true });
  });

  r.post('/logout', (req, res) => { destroySession(db, req, res); res.json({ ok: true }); });

  r.get('/me', requireAuth, (req, res) => res.json(publicUser(req.user)));

  r.post('/password', requireAuth, (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!verifyPassword(String(currentPassword || ''), row.password_hash)) {
      return res.status(403).json({ error: 'wrong-password' });
    }
    if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), req.user.id);
    return res.json({ ok: true });
  });

  return r;
}
```

In `server/app.js`, replace the "Later tasks mount…" comment with:

```js
if (db) {
  app.use('/api', requireJson, sessionMiddleware(db));
  app.use('/api/auth', authRoutes(db));
  // users, records and import routers are mounted below by later tasks
  app.use('/api/ai', requireAuth); // in multi-user mode the AI proxy requires a session
}
```

(add the imports `requireJson, sessionMiddleware, requireAuth` from `./middlewares/auth.js` and `authRoutes` from `./routes/auth.js`; the `app.use('/api/ai', requireAuth)` line must come **before** the `app.use('/api/ai', apiLimiter, aiRoutes)` line).

- [ ] **Step 6: Run the tests**

Run: `cd server && npm test`
Expected: PASS (all auth tests plus Task 1's).

- [ ] **Step 7: Commit**

```bash
git add server
git commit -m "feat(server): scrypt passwords, cookie sessions and auth routes"
```

---

### Task 3: User administration routes

**Files:**
- Create: `server/routes/users.js`, `server/test/users.test.js`
- Modify: `server/app.js`

**Interfaces:**
- Consumes: `requireAuth`, `requireAdmin`, `hashPassword`, `setupAdmin` (Tasks 1-2).
- Produces: `GET /api/users` (any signed-in user; returns `[{id, username, displayName, participantId, isAdmin, disabled}]`), `POST /api/users` (admin: `{username, displayName, password, isAdmin?, participantId?}`), `PATCH /api/users/:id` (admin: any of `displayName, password, disabled, isAdmin, participantId`).

- [ ] **Step 1: Write the failing tests** — `server/test/users.test.js`

```js
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
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && npm test`
Expected: FAIL (404 on `/api/users`).

- [ ] **Step 3: Implement `server/routes/users.js`**

```js
import { Router } from 'express';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../utils/passwords.js';
import { requireAuth, requireAdmin } from '../middlewares/auth.js';

const shape = (u) => ({
  id: u.id, username: u.username, displayName: u.display_name, isAdmin: !!u.is_admin,
  disabled: !!u.disabled, participantId: u.participant_id ?? null
});

export default function userRoutes(db) {
  const r = Router();
  r.use(requireAuth);

  r.get('/', (req, res) => {
    res.json(db.prepare('SELECT * FROM users ORDER BY display_name COLLATE NOCASE').all().map(shape));
  });

  r.post('/', requireAdmin, (req, res) => {
    const { username, displayName, password, isAdmin = false, participantId = null } = req.body || {};
    if (!username || !displayName || typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `username, displayName and a password of at least ${MIN_PASSWORD_LENGTH} characters are required` });
    }
    try {
      const info = db.prepare(
        `INSERT INTO users(username, display_name, password_hash, is_admin, participant_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(String(username).trim(), String(displayName).trim(), hashPassword(password), isAdmin ? 1 : 0, participantId, new Date().toISOString());
      return res.status(201).json(shape(db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid)));
    } catch (e) {
      if (String(e.code).startsWith('SQLITE_CONSTRAINT')) return res.status(409).json({ error: 'username-taken' });
      throw e;
    }
  });

  r.patch('/:id', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'not-found' });
    const { displayName, password, disabled, isAdmin, participantId } = req.body || {};

    const willBeActiveAdmin =
      (isAdmin ?? !!row.is_admin) && !(disabled ?? !!row.disabled);
    if (row.is_admin && !row.disabled && !willBeActiveAdmin) {
      const others = db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND disabled = 0 AND id != ?').get(id).n;
      if (others === 0) return res.status(409).json({ error: 'last-admin' });
    }
    if (password !== undefined && (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH)) {
      return res.status(400).json({ error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }

    db.prepare(
      `UPDATE users SET display_name = ?, password_hash = ?, disabled = ?, is_admin = ?, participant_id = ? WHERE id = ?`
    ).run(
      displayName !== undefined ? String(displayName).trim() : row.display_name,
      password !== undefined ? hashPassword(password) : row.password_hash,
      disabled !== undefined ? (disabled ? 1 : 0) : row.disabled,
      isAdmin !== undefined ? (isAdmin ? 1 : 0) : row.is_admin,
      participantId !== undefined ? participantId : row.participant_id,
      id
    );
    if (disabled || password !== undefined) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    return res.json(shape(db.prepare('SELECT * FROM users WHERE id = ?').get(id)));
  });

  return r;
}
```

Mount in `server/app.js` inside `if (db) { ... }`: `app.use('/api/users', userRoutes(db));` (import `userRoutes`).

- [ ] **Step 4: Run the tests**

Run: `cd server && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server
git commit -m "feat(server): admin user management routes"
```

---

### Task 4: Records API

**Files:**
- Create: `server/routes/records.js`, `server/test/records.test.js`
- Modify: `server/app.js`

**Interfaces:**
- Consumes: `nextRev`, `requireAuth`, `setupAdmin` (Tasks 1-2).
- Produces:
  - `GET /api/records?since=<rev>` → `{ cursor: number, records: [{collection, id, data, version, deleted, updatedBy, updatedAt}] }`. `since=0` (or absent) omits deleted rows.
  - `PUT /api/records/:collection/:id` body `{data, baseVersion, force?}` → `{version, rev}`; **409** `{error:'conflict', current:{data, version, deleted}|null}`. `force` is honored only when the collection ends with `:state`.
  - `DELETE /api/records/:collection/:id` body `{baseVersion}` → `{version}`; a missing row is a no-op returning `{version: 0}`.
  - Collection must match `^[A-Za-z0-9._:-]{1,100}$`; id length 1-300.

- [ ] **Step 1: Write the failing tests** — `server/test/records.test.js`

```js
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
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && npm test`
Expected: FAIL (404).

- [ ] **Step 3: Implement `server/routes/records.js`**

```js
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
    const since = Math.max(0, parseInt(req.query.since, 10) || 0);
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
      if (!forced && (row ? row.version : 0) !== baseVersion) {
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
```

Mount in `server/app.js`: `app.use('/api/records', recordRoutes(db));` (import it).

- [ ] **Step 4: Run the tests**

Run: `cd server && npm test`
Expected: PASS. If the `'GV.SC-04/x ?#Ü'` test fails because Express 5 route matching rejects the encoded slash, switch the route to `/:collection/:id(*)`-style handling or percent-decode `req.originalUrl` manually; keep the test as the acceptance criterion.

- [ ] **Step 5: Commit**

```bash
git add server
git commit -m "feat(server): per-record API with optimistic versions and soft deletes"
```

---

### Task 5: Import route and deployment wiring

**Files:**
- Create: `server/routes/import.js`, `server/test/import.test.js`
- Modify: `server/app.js`, `server/config.example.json` (no change) — add `server/.env.example`

**Interfaces:**
- Consumes: `nextRev`, `requireAuth`, `setupAdmin` (Tasks 1-4).
- Produces: `POST /api/import` body `{records: [{collection, id, data}]}` → `{imported: n}`; **409** `{error:'workspace-not-empty'}` if the `records` table has any row (deleted rows count).

- [ ] **Step 1: Write the failing tests** — `server/test/import.test.js`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
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

test('import is refused when the workspace already has data', async () => {
  const { app } = makeApp();
  const a = await setupAdmin(app);
  await a.post('/api/import').set(JSON_HEADERS).send({ records: recs }).expect(200);
  const again = await a.post('/api/import').set(JSON_HEADERS).send({ records: recs }).expect(409);
  assert.equal(again.body.error, 'workspace-not-empty');
});

test('import validates its payload', async () => {
  const { app } = makeApp();
  const a = await setupAdmin(app);
  await a.post('/api/import').set(JSON_HEADERS).send({ records: 'nope' }).expect(400);
  await a.post('/api/import').set(JSON_HEADERS).send({ records: [{ collection: 'bad name', id: 'x', data: 1 }] }).expect(400);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && npm test`
Expected: FAIL (404).

- [ ] **Step 3: Implement `server/routes/import.js` and mount it**

```js
import { Router } from 'express';
import { nextRev } from '../db.js';
import { requireAuth } from '../middlewares/auth.js';

const COLLECTION_RE = /^[A-Za-z0-9._:-]{1,100}$/;

export default function importRoutes(db) {
  const r = Router();
  r.use(requireAuth);
  r.post('/', (req, res) => {
    const { records } = req.body || {};
    if (!Array.isArray(records) || records.some((x) =>
      !x || !COLLECTION_RE.test(x.collection || '') || typeof x.id !== 'string' || !x.id || x.id.length > 300 || x.data === undefined)) {
      return res.status(400).json({ error: 'records must be an array of {collection, id, data}' });
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
```

In `server/app.js`: `app.use('/api/import', importRoutes(db));`.

- [ ] **Step 4: Add `server/.env.example`**

```
# Multi-user mode (accounts + shared database). Without this the server is only the AI proxy.
MULTIUSER=true
PORT=4000
DATA_DIR=./data
# Serve the built React app from the same port (build with REACT_APP_SERVER_MODE=true INLINE_RUNTIME_CHUNK=false).
STATIC_DIR=../build
# Set to true when served over HTTPS (also set automatically behind a proxy that sets X-Forwarded-Proto and trust proxy).
COOKIE_SECURE=false
ALLOWED_ORIGINS=http://localhost:3000
```

- [ ] **Step 5: Run the tests and commit**

Run: `cd server && npm test`
Expected: PASS (all suites).

```bash
git add server
git commit -m "feat(server): one-time import endpoint and env example"
```

---

### Task 6: Client record diffing (pure functions)

**Files:**
- Create: `src/storage/diff.js`, `src/storage/diff.test.js`

**Interfaces:**
- Produces:
  - `isStateRecord(collection): boolean`; `storeNameOf(collection): string`; `STATE_ID = 'state'`
  - `recordKey(collection, id): string`
  - `toRecords(storeName, config, persisted): { records: Record<string, {collection,id,data}>, problems: Array<{field,index,id}> }` where `persisted = {state, version}` and `config = {collections: {field: 'id' | (item)=>id}, localFields?: string[]}`.
  - `fromRecords(storeName, config, readCollection, local): {state, version} | null` where `readCollection(collection): Map<id, data>` and `local` is the object of local-only fields.
  - `diffRecords(prev, next): { puts: [{collection,id,data}], deletes: [{collection,id}] }`.
  - Collection naming: `` `${storeName}.${field}` ``; the singleton record is collection `` `${storeName}:state` ``, id `'state'`, data `{version, shared, order}`.

- [ ] **Step 1: Write the failing tests** — `src/storage/diff.test.js`

```js
import { toRecords, fromRecords, diffRecords, storeNameOf, isStateRecord, recordKey } from './diff';

const CONFIG = { collections: { items: 'id' }, localFields: ['selected'] };
const persisted = (items, extra = {}) => ({
  version: 3,
  state: { items, theme: 'dark', selected: 'a', ...extra }
});
const reader = (records) => (collection) => {
  const m = new Map();
  Object.values(records).forEach((r) => { if (r.collection === collection) m.set(r.id, r.data); });
  return m;
};

describe('toRecords', () => {
  it('splits a collection into per-record entries plus a state record', () => {
    const { records, problems } = toRecords('s', CONFIG, persisted([{ id: 'a', n: 1 }, { id: 'b', n: 2 }]));
    expect(problems).toEqual([]);
    expect(records[recordKey('s.items', 'a')].data).toEqual({ id: 'a', n: 1 });
    const state = records[recordKey('s:state', 'state')].data;
    expect(state.version).toBe(3);
    expect(state.shared).toEqual({ theme: 'dark' }); // local field "selected" is excluded
    expect(state.order).toEqual({ items: ['a', 'b'] });
  });

  it('reports items with a missing or duplicate key instead of dropping them silently', () => {
    const { records, problems } = toRecords('s', CONFIG, persisted([{ id: 'a' }, { n: 1 }, { id: 'a' }]));
    expect(problems.map((p) => p.index)).toEqual([1, 2]);
    expect(Object.keys(records).filter((k) => k.startsWith('s.items'))).toHaveLength(1);
  });

  it('supports function keys', () => {
    const cfg = { collections: { reqs: (r) => `${r.frameworkId}::${r.id}` } };
    const { records } = toRecords('s', cfg, { version: 1, state: { reqs: [{ id: 'x', frameworkId: 'f' }] } });
    expect(records[recordKey('s.reqs', 'f::x')]).toBeTruthy();
  });
});

describe('fromRecords', () => {
  it('returns null when the server has nothing for the store', () => {
    expect(fromRecords('s', CONFIG, reader({}), {})).toBeNull();
  });

  it('round-trips state, preserving order and merging local fields', () => {
    const original = persisted([{ id: 'b' }, { id: 'a' }]);
    const { records } = toRecords('s', CONFIG, original);
    const back = fromRecords('s', CONFIG, reader(records), { selected: 'a' });
    expect(back).toEqual(original);
  });

  it('appends records missing from the order and drops order ids with no record', () => {
    const { records } = toRecords('s', CONFIG, persisted([{ id: 'a' }, { id: 'b' }]));
    delete records[recordKey('s.items', 'a')];
    records[recordKey('s.items', 'c')] = { collection: 's.items', id: 'c', data: { id: 'c' } };
    const back = fromRecords('s', CONFIG, reader(records), {});
    expect(back.state.items.map((i) => i.id)).toEqual(['b', 'c']);
  });

  it('keeps an explicitly emptied collection empty', () => {
    const { records } = toRecords('s', CONFIG, persisted([]));
    expect(fromRecords('s', CONFIG, reader(records), {}).state.items).toEqual([]);
  });
});

describe('diffRecords', () => {
  it('finds adds, changes and deletes, and ignores unchanged records', () => {
    const prev = toRecords('s', CONFIG, persisted([{ id: 'a', n: 1 }, { id: 'b', n: 1 }, { id: 'c', n: 1 }])).records;
    const next = toRecords('s', CONFIG, persisted([{ id: 'a', n: 1 }, { id: 'b', n: 2 }, { id: 'd', n: 1 }])).records;
    const { puts, deletes } = diffRecords(prev, next);
    expect(puts.map((p) => p.id).sort()).toEqual(['b', 'd', 'state'].sort());
    expect(deletes.map((d) => d.id)).toEqual(['c']);
  });

  it('treats key order inside an object as irrelevant', () => {
    const a = toRecords('s', CONFIG, persisted([{ id: 'a', x: 1, y: 2 }])).records;
    const b = toRecords('s', CONFIG, persisted([{ y: 2, id: 'a', x: 1 }])).records;
    expect(diffRecords(a, b)).toEqual({ puts: [], deletes: [] });
  });

  it('never deletes the state record', () => {
    const prev = toRecords('s', CONFIG, persisted([])).records;
    expect(diffRecords(prev, {}).deletes).toEqual([]);
  });
});

describe('helpers', () => {
  it('derives the store name and detects state records', () => {
    expect(storeNameOf('csf-comments-storage.comments')).toBe('csf-comments-storage');
    expect(storeNameOf('csf-comments-storage:state')).toBe('csf-comments-storage');
    expect(isStateRecord('csf-comments-storage:state')).toBe(true);
    expect(isStateRecord('csf-comments-storage.comments')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `CI=true npx react-scripts test --watchAll=false src/storage/diff.test.js`
Expected: FAIL (`Cannot find module './diff'`).

- [ ] **Step 3: Implement `src/storage/diff.js`**

```js
export const STATE_ID = 'state';

export const isStateRecord = (collection) => collection.endsWith(':state');
export const storeNameOf = (collection) => collection.split(/[.:]/)[0];
export const recordKey = (collection, id) => `${collection}\u0000${id}`;
const collectionName = (storeName, field) => `${storeName}.${field}`;
const stateCollection = (storeName) => `${storeName}:state`;

const stable = (value) => JSON.stringify(value, (_k, v) =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? Object.keys(v).sort().reduce((o, k) => { o[k] = v[k]; return o; }, {})
    : v
);

const keyFn = (spec) => (typeof spec === 'function' ? spec : (item) => item?.[spec]);

export function toRecords(storeName, config, persisted) {
  const { state = {}, version = 0 } = persisted || {};
  const collections = config.collections || {};
  const local = config.localFields || [];
  const records = {};
  const order = {};
  const problems = [];

  Object.entries(collections).forEach(([field, spec]) => {
    const list = state[field];
    if (!Array.isArray(list)) return;
    const idOf = keyFn(spec);
    const seen = new Set();
    order[field] = [];
    list.forEach((item, index) => {
      const raw = idOf(item);
      const id = raw === undefined || raw === null || raw === '' ? null : String(raw);
      if (id === null || seen.has(id)) { problems.push({ field, index, id }); return; }
      seen.add(id);
      order[field].push(id);
      const collection = collectionName(storeName, field);
      records[recordKey(collection, id)] = { collection, id, data: item };
    });
  });

  const shared = {};
  Object.entries(state).forEach(([field, value]) => {
    if (!(field in collections) && !local.includes(field)) shared[field] = value;
  });
  const sc = stateCollection(storeName);
  records[recordKey(sc, STATE_ID)] = { collection: sc, id: STATE_ID, data: { version, shared, order } };
  return { records, problems };
}

export function fromRecords(storeName, config, readCollection, local = {}) {
  const collections = config.collections || {};
  const stateRec = readCollection(stateCollection(storeName)).get(STATE_ID);
  const fieldItems = {};
  let any = !!stateRec;
  Object.keys(collections).forEach((field) => {
    fieldItems[field] = readCollection(collectionName(storeName, field));
    if (fieldItems[field].size) any = true;
  });
  if (!any) return null;

  const state = { ...(stateRec?.shared || {}), ...local };
  Object.keys(collections).forEach((field) => {
    const items = fieldItems[field];
    const ordered = stateRec?.order?.[field];
    if (!ordered && items.size === 0) return; // never written: keep the store's default
    const list = [];
    const used = new Set();
    (ordered || []).forEach((id) => { if (items.has(id)) { list.push(items.get(id)); used.add(id); } });
    items.forEach((data, id) => { if (!used.has(id)) list.push(data); });
    state[field] = list;
  });
  return { state, version: stateRec?.version ?? 0 };
}

export function diffRecords(prev, next) {
  const puts = [];
  const deletes = [];
  Object.entries(next).forEach(([key, rec]) => {
    const old = prev[key];
    if (!old || stable(old.data) !== stable(rec.data)) puts.push({ collection: rec.collection, id: rec.id, data: rec.data });
  });
  Object.entries(prev).forEach(([key, rec]) => {
    if (!next[key] && !isStateRecord(rec.collection)) deletes.push({ collection: rec.collection, id: rec.id });
  });
  return { puts, deletes };
}
```

- [ ] **Step 4: Run the tests**

Run: `CI=true npx react-scripts test --watchAll=false src/storage/diff.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage/diff.js src/storage/diff.test.js
git commit -m "feat(storage): pure record diffing for server sync"
```

---

### Task 7: Client API wrapper and sync engine

**Files:**
- Create: `src/storage/serverClient.js`, `src/storage/syncEngine.js`, `src/storage/syncEngine.test.js`

**Interfaces:**
- Consumes: `recordKey`, `isStateRecord`, `storeNameOf` (Task 6); server API (Tasks 2-5).
- Produces (`serverClient.js`): `api(method, path, body?) → Promise<json>` (always sends `credentials: 'include'` and JSON; base URL is `process.env.REACT_APP_API_URL || ''` + `/api`), `class ApiError extends Error { status, body }`, and `setUnauthorizedHandler(fn)` called on any 401.
- Produces (`syncEngine.js`), all named exports:
  - `bootstrap(): Promise<void>`, `whenReady(): Promise<void>`, `start()`, `stop()`, `reset()` (tests), `configureEngine({debounceMs, pollMs})` (tests)
  - `readCollection(collection): Map<id, data>` (cache overlaid with unsent local edits and unresolved conflicts)
  - `getEntries(collection): Array<{id, data, version, updatedBy, updatedAt}>` (server metadata, no overlay)
  - `enqueue({puts, deletes})`, `flushNow(): Promise<void>`, `pollNow(): Promise<void>`
  - `resolveConflict(key, 'mine' | 'theirs')`, `removeStoreRecords(storeName)`
  - `onRemoteChange(fn: (collections: Set<string>) => void): () => void`
  - `useSyncStatus` zustand store: `{ state: 'idle'|'saving'|'offline', pending: number, conflicts: Array<{key, collection, id, mine, theirs}>, lastSaved: number|null }`
  - Outbox persists to `localStorage['csf-sync-outbox']`.

- [ ] **Step 1: Write the failing tests** — `src/storage/syncEngine.test.js`

```js
import * as engine from './syncEngine';
import { api, ApiError } from './serverClient';
import { recordKey } from './diff';

jest.mock('./serverClient', () => {
  class ApiError extends Error {
    constructor(status, body) { super(body?.error || `HTTP ${status}`); this.status = status; this.body = body; }
  }
  return { api: jest.fn(), ApiError, setUnauthorizedHandler: jest.fn() };
});

const rec = (collection, id, data, version = 1) => ({ collection, id, data, version, deleted: false, updatedBy: 1, updatedAt: 't' });

beforeEach(() => {
  jest.useFakeTimers();
  localStorage.clear();
  api.mockReset();
  engine.reset();
  engine.configureEngine({ debounceMs: 500, pollMs: 20000 });
});
afterEach(() => { engine.stop(); jest.useRealTimers(); });

const boot = async (records = [], cursor = 5) => {
  api.mockResolvedValueOnce({ cursor, records });
  await engine.bootstrap();
};

test('bootstrap loads the full snapshot and resolves whenReady', async () => {
  await boot([rec('c', 'a', { n: 1 })]);
  await engine.whenReady();
  expect(engine.readCollection('c').get('a')).toEqual({ n: 1 });
});

test('writes are debounced and sent with the cached baseVersion', async () => {
  await boot([rec('c', 'a', { n: 1 }, 4)]);
  api.mockResolvedValue({ version: 5, rev: 9 });
  engine.enqueue({ puts: [{ collection: 'c', id: 'a', data: { n: 2 } }], deletes: [] });
  engine.enqueue({ puts: [{ collection: 'c', id: 'a', data: { n: 3 } }], deletes: [] });
  expect(api).toHaveBeenCalledTimes(1); // only the bootstrap so far
  await jest.advanceTimersByTimeAsync(500);
  const call = api.mock.calls[1];
  expect(call[0]).toBe('PUT');
  expect(call[1]).toBe('/records/c/a');
  expect(call[2]).toEqual({ data: { n: 3 }, baseVersion: 4, force: false });
  expect(engine.useSyncStatus.getState().pending).toBe(0);
});

test('unsent edits overlay the cache for readers', async () => {
  await boot([rec('c', 'a', { n: 1 })]);
  engine.enqueue({ puts: [{ collection: 'c', id: 'a', data: { n: 9 } }, { collection: 'c', id: 'b', data: { n: 1 } }], deletes: [] });
  expect(engine.readCollection('c').get('a')).toEqual({ n: 9 });
  expect(engine.readCollection('c').has('b')).toBe(true);
  engine.enqueue({ puts: [], deletes: [{ collection: 'c', id: 'a' }] });
  expect(engine.readCollection('c').has('a')).toBe(false);
});

test('ids are URL-encoded', async () => {
  await boot();
  api.mockResolvedValue({ version: 1, rev: 1 });
  engine.enqueue({ puts: [{ collection: 'c', id: 'GV.SC-04/x ?#', data: 1 }], deletes: [] });
  await jest.advanceTimersByTimeAsync(500);
  expect(api.mock.calls[1][1]).toBe('/records/c/GV.SC-04%2Fx%20%3F%23');
});

test('a 409 becomes a conflict, keeps my copy on screen, and does not retry', async () => {
  await boot([rec('c', 'a', { n: 1 }, 1)]);
  api.mockRejectedValueOnce(new ApiError(409, { error: 'conflict', current: { data: { n: 'theirs' }, version: 2, deleted: false } }));
  engine.enqueue({ puts: [{ collection: 'c', id: 'a', data: { n: 'mine' } }], deletes: [] });
  await jest.advanceTimersByTimeAsync(500);
  const { conflicts } = engine.useSyncStatus.getState();
  expect(conflicts).toHaveLength(1);
  expect(conflicts[0].mine).toEqual({ n: 'mine' });
  expect(conflicts[0].theirs).toEqual({ n: 'theirs' });
  expect(engine.readCollection('c').get('a')).toEqual({ n: 'mine' });
  await jest.advanceTimersByTimeAsync(5000);
  expect(api).toHaveBeenCalledTimes(2); // bootstrap + one failed PUT
});

test('keep mine resends against the new version; take theirs drops mine', async () => {
  await boot([rec('c', 'a', { n: 1 }, 1)]);
  api.mockRejectedValueOnce(new ApiError(409, { error: 'conflict', current: { data: { n: 'theirs' }, version: 2, deleted: false } }));
  engine.enqueue({ puts: [{ collection: 'c', id: 'a', data: { n: 'mine' } }], deletes: [] });
  await jest.advanceTimersByTimeAsync(500);
  const key = engine.useSyncStatus.getState().conflicts[0].key;
  api.mockResolvedValueOnce({ version: 3, rev: 12 });
  engine.resolveConflict(key, 'mine');
  await jest.advanceTimersByTimeAsync(500);
  expect(api.mock.calls[2][2]).toEqual({ data: { n: 'mine' }, baseVersion: 2, force: false });
  expect(engine.useSyncStatus.getState().conflicts).toHaveLength(0);

  // take theirs on a fresh conflict
  api.mockRejectedValueOnce(new ApiError(409, { error: 'conflict', current: { data: { n: 'again' }, version: 4, deleted: false } }));
  engine.enqueue({ puts: [{ collection: 'c', id: 'a', data: { n: 'mine2' } }], deletes: [] });
  await jest.advanceTimersByTimeAsync(500);
  const heard = jest.fn();
  engine.onRemoteChange(heard);
  engine.resolveConflict(engine.useSyncStatus.getState().conflicts[0].key, 'theirs');
  expect(engine.readCollection('c').get('a')).toEqual({ n: 'again' });
  expect(heard).toHaveBeenCalled();
});

test(':state records are force-written', async () => {
  await boot();
  api.mockResolvedValue({ version: 1, rev: 1 });
  engine.enqueue({ puts: [{ collection: 's:state', id: 'state', data: { version: 1 } }], deletes: [] });
  await jest.advanceTimersByTimeAsync(500);
  expect(api.mock.calls[1][2].force).toBe(true);
});

test('network failure keeps the outbox, persists it, and retries with backoff', async () => {
  await boot();
  api.mockRejectedValueOnce(new Error('network down')).mockResolvedValue({ version: 1, rev: 1 });
  engine.enqueue({ puts: [{ collection: 'c', id: 'a', data: 1 }], deletes: [] });
  await jest.advanceTimersByTimeAsync(500);
  expect(engine.useSyncStatus.getState().state).toBe('offline');
  expect(JSON.parse(localStorage.getItem('csf-sync-outbox'))).toHaveLength(1);
  await jest.advanceTimersByTimeAsync(2500);
  expect(engine.useSyncStatus.getState().pending).toBe(0);
});

test('a persisted outbox is replayed after bootstrap', async () => {
  localStorage.setItem('csf-sync-outbox', JSON.stringify([{ collection: 'c', id: 'a', op: 'put', data: { n: 1 }, baseVersion: 0 }]));
  api.mockResolvedValueOnce({ cursor: 1, records: [] });
  await engine.bootstrap();
  api.mockResolvedValue({ version: 1, rev: 2 });
  await jest.advanceTimersByTimeAsync(10);
  expect(api.mock.calls[1][0]).toBe('PUT');
});

test('poll merges remote changes, ignores echoes of our own writes, and notifies listeners', async () => {
  await boot([rec('c', 'a', { n: 1 }, 1)], 5);
  const heard = jest.fn();
  engine.onRemoteChange(heard);
  api.mockResolvedValueOnce({ cursor: 8, records: [rec('c', 'a', { n: 1 }, 1), rec('c', 'b', { n: 2 }, 1)] });
  await engine.pollNow();
  expect(heard).toHaveBeenCalledTimes(1);
  expect([...heard.mock.calls[0][0]]).toEqual(['c']);
  expect(engine.readCollection('c').get('b')).toEqual({ n: 2 });
  expect(api.mock.calls[1][1]).toBe('/records?since=5');

  api.mockResolvedValueOnce({ cursor: 9, records: [rec('c', 'b', { n: 2 }, 1)] }); // echo, same version
  await engine.pollNow();
  expect(heard).toHaveBeenCalledTimes(1);
});

test('a poll does not wipe unsent local edits', async () => {
  await boot([rec('c', 'a', { n: 1 }, 1)], 5);
  engine.enqueue({ puts: [{ collection: 'c', id: 'a', data: { n: 'typing' } }], deletes: [] });
  api.mockResolvedValueOnce({ cursor: 6, records: [rec('c', 'a', { n: 'remote' }, 2)] });
  await engine.pollNow();
  expect(engine.readCollection('c').get('a')).toEqual({ n: 'typing' });
});

test('remote tombstones remove records', async () => {
  await boot([rec('c', 'a', { n: 1 }, 1)], 5);
  api.mockResolvedValueOnce({ cursor: 6, records: [{ ...rec('c', 'a', null, 2), deleted: true }] });
  await engine.pollNow();
  expect(engine.readCollection('c').has('a')).toBe(false);
});

test('removeStoreRecords queues deletes for every record of a store', async () => {
  await boot([rec('s.items', 'a', 1), rec('s:state', 'state', {}), rec('other.items', 'z', 1)]);
  engine.removeStoreRecords('s');
  expect(engine.readCollection('s.items').size).toBe(0);
  expect(engine.readCollection('other.items').size).toBe(1);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `CI=true npx react-scripts test --watchAll=false src/storage/syncEngine.test.js`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement `src/storage/serverClient.js`**

```js
export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

let onUnauthorized = null;
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

const base = () => `${process.env.REACT_APP_API_URL || ''}/api`;

export async function api(method, path, body) {
  const res = await fetch(`${base()}${path}`, {
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {})
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    if (res.status === 401 && onUnauthorized) onUnauthorized();
    throw new ApiError(res.status, json);
  }
  return json;
}
```

- [ ] **Step 4: Implement `src/storage/syncEngine.js`**

```js
import { create } from 'zustand';
import { api, ApiError } from './serverClient';
import { recordKey, isStateRecord, storeNameOf } from './diff';

const OUTBOX_KEY = 'csf-sync-outbox';
let cfg = { debounceMs: 500, pollMs: 20000 };
export const configureEngine = (next) => { cfg = { ...cfg, ...next }; };

export const useSyncStatus = create(() => ({ state: 'idle', pending: 0, conflicts: [], lastSaved: null }));

const listeners = new Set();
export const onRemoteChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

let cache = new Map();      // key -> {collection, id, data, version, deleted, updatedBy, updatedAt}
let outbox = new Map();     // key -> {collection, id, op, data, baseVersion}
let conflicts = new Map();  // key -> {key, collection, id, mine, theirs, theirsVersion}
let cursor = 0;
let flushTimer = null;
let pollTimer = null;
let flushing = false;
let backoff = 0;
let focusHandler = null;
let ready;
let markReady;
const newReady = () => { ready = new Promise((resolve) => { markReady = resolve; }); };
newReady();
export const whenReady = () => ready;

const entryOf = (r) => ({
  collection: r.collection, id: r.id, data: r.data, version: r.version, deleted: !!r.deleted,
  updatedBy: r.updatedBy ?? null, updatedAt: r.updatedAt ?? null
});

const persistOutbox = () => {
  try { localStorage.setItem(OUTBOX_KEY, JSON.stringify([...outbox.values()])); } catch { /* quota: keep in memory */ }
};
const loadOutbox = () => {
  try {
    return new Map(JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]').map((o) => [recordKey(o.collection, o.id), o]));
  } catch { return new Map(); }
};

const refreshStatus = (patch = {}) => {
  useSyncStatus.setState({
    pending: outbox.size,
    conflicts: [...conflicts.values()].map(({ key, collection, id, mine, theirs }) => ({ key, collection, id, mine, theirs })),
    ...patch
  });
};

const emit = (collections) => listeners.forEach((fn) => fn(collections));

export async function bootstrap() {
  const res = await api('GET', '/records?since=0');
  cache = new Map(res.records.map((r) => [recordKey(r.collection, r.id), entryOf(r)]));
  cursor = res.cursor;
  outbox = loadOutbox();
  conflicts = new Map();
  refreshStatus({ state: 'idle' });
  markReady();
  if (outbox.size) scheduleFlush(0);
}

export function readCollection(collection) {
  const out = new Map();
  cache.forEach((e) => { if (e.collection === collection && !e.deleted) out.set(e.id, e.data); });
  outbox.forEach((o) => {
    if (o.collection !== collection) return;
    if (o.op === 'put') out.set(o.id, o.data); else out.delete(o.id);
  });
  conflicts.forEach((c) => {
    if (c.collection !== collection) return;
    if (c.mine === null) out.delete(c.id); else out.set(c.id, c.mine);
  });
  return out;
}

export function getEntries(collection) {
  const rows = [];
  cache.forEach((e) => { if (e.collection === collection && !e.deleted) rows.push(e); });
  return rows;
}

const queue = (collection, id, op, data) => {
  const key = recordKey(collection, id);
  if (conflicts.has(key)) { conflicts.get(key).mine = op === 'put' ? data : null; return; }
  const prev = outbox.get(key);
  const baseVersion = prev ? prev.baseVersion : (cache.get(key)?.version ?? 0);
  outbox.set(key, { collection, id, op, data: op === 'put' ? data : null, baseVersion });
};

export function enqueue({ puts = [], deletes = [] }) {
  puts.forEach((p) => queue(p.collection, p.id, 'put', p.data));
  deletes.forEach((d) => queue(d.collection, d.id, 'delete', null));
  persistOutbox();
  refreshStatus();
  scheduleFlush(cfg.debounceMs);
}

function scheduleFlush(ms) {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => { flushNow(); }, ms);
}

export async function flushNow() {
  if (flushing) return;
  flushing = true;
  refreshStatus({ state: 'saving' });
  try {
    for (const [key, op] of [...outbox]) {
      if (outbox.get(key) !== op) continue;
      const path = `/records/${encodeURIComponent(op.collection)}/${encodeURIComponent(op.id)}`;
      try {
        const result = op.op === 'put'
          ? await api('PUT', path, { data: op.data, baseVersion: op.baseVersion, force: isStateRecord(op.collection) })
          : await api('DELETE', path, { baseVersion: op.baseVersion });
        cache.set(key, {
          collection: op.collection, id: op.id, data: op.data, version: result.version,
          deleted: op.op === 'delete', updatedBy: null, updatedAt: null
        });
        if (outbox.get(key) === op) outbox.delete(key);
        else if (outbox.get(key)) outbox.get(key).baseVersion = result.version;
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 409)) throw e;
        const newest = outbox.get(key) || op;
        const theirs = e.body?.current;
        if (theirs) cache.set(key, entryOf({ collection: op.collection, id: op.id, ...theirs }));
        conflicts.set(key, {
          key, collection: op.collection, id: op.id,
          mine: newest.op === 'put' ? newest.data : null,
          theirs: theirs && !theirs.deleted ? theirs.data : null,
          theirsVersion: theirs?.version ?? 0
        });
        outbox.delete(key);
      }
    }
    backoff = 0;
    refreshStatus({ state: 'idle', lastSaved: Date.now() });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      refreshStatus({ state: 'offline' }); // unauthorized handler (authStore) shows the login screen; outbox is kept
    } else {
      backoff = Math.min(backoff ? backoff * 2 : 2000, 60000);
      refreshStatus({ state: 'offline' });
      scheduleFlush(backoff);
    }
  } finally {
    flushing = false;
    persistOutbox();
    refreshStatus();
  }
}

export async function pollNow() {
  const res = await api('GET', `/records?since=${cursor}`);
  const changed = new Set();
  res.records.forEach((r) => {
    const key = recordKey(r.collection, r.id);
    const have = cache.get(key);
    if (have && have.version >= r.version) return;
    cache.set(key, entryOf(r));
    changed.add(r.collection);
    const c = conflicts.get(key);
    if (c) { c.theirs = r.deleted ? null : r.data; c.theirsVersion = r.version; }
  });
  cursor = res.cursor;
  refreshStatus();
  if (changed.size) emit(changed);
}

export function resolveConflict(key, choice) {
  const c = conflicts.get(key);
  if (!c) return;
  conflicts.delete(key);
  if (choice === 'mine') {
    outbox.set(key, { collection: c.collection, id: c.id, op: c.mine === null ? 'delete' : 'put', data: c.mine, baseVersion: c.theirsVersion });
    persistOutbox();
    refreshStatus();
    scheduleFlush(cfg.debounceMs);
  } else {
    refreshStatus();
    emit(new Set([c.collection]));
  }
}

export function removeStoreRecords(storeName) {
  const deletes = [];
  cache.forEach((e) => {
    if (storeNameOf(e.collection) === storeName && !e.deleted && !isStateRecord(e.collection)) {
      deletes.push({ collection: e.collection, id: e.id });
    }
  });
  enqueue({ deletes });
}

export function start() {
  stop();
  pollTimer = setInterval(() => { pollNow().catch(() => {}); }, cfg.pollMs);
  focusHandler = () => { pollNow().catch(() => {}); };
  if (typeof window !== 'undefined') window.addEventListener('focus', focusHandler);
}

export function stop() {
  clearInterval(pollTimer);
  clearTimeout(flushTimer);
  if (focusHandler && typeof window !== 'undefined') window.removeEventListener('focus', focusHandler);
  focusHandler = null;
}

export function reset() {
  stop();
  cache = new Map(); outbox = new Map(); conflicts = new Map();
  cursor = 0; flushing = false; backoff = 0;
  listeners.clear();
  newReady();
  useSyncStatus.setState({ state: 'idle', pending: 0, conflicts: [], lastSaved: null });
}
```

- [ ] **Step 5: Run the tests**

Run: `CI=true npx react-scripts test --watchAll=false src/storage/syncEngine.test.js`
Expected: PASS. The `removeStoreRecords` test calls `enqueue` which schedules a timer; `afterEach` calls `stop()`, which clears it.

- [ ] **Step 6: Commit**

```bash
git add src/storage/serverClient.js src/storage/syncEngine.js src/storage/syncEngine.test.js
git commit -m "feat(storage): sync engine with outbox, conflicts and polling"
```

---

### Task 8: Server storage backend, store configs, `createStorage`, pilot store

**Files:**
- Create: `src/storage/serverStorage.js`, `src/storage/storeConfigs.js`, `src/storage/createStorage.js`, `src/storage/serverStorage.test.js`, `src/storage/createStorage.test.js`, `src/storage/persistedVersions.js`
- Modify: `src/stores/commentsStore.js`

**Interfaces:**
- Consumes: Tasks 6-7.
- Produces:
  - `createServerStateStorage(storeName, config)` → zustand `StateStorage` (`getItem`, `setItem`, `removeItem`; getItem and setItem wait for `whenReady()`).
  - `STORE_CONFIGS: Record<storeName, {collections?, localFields?, local?: true}>`. In this task only `'csf-comments-storage': { collections: { comments: 'id' } }`.
  - `isServerMode(): boolean` (reads `process.env.REACT_APP_SERVER_MODE === 'true'` at call time).
  - `createStorage(storeName)` → a zustand `PersistStorage` (via `createJSONStorage`). Local mode returns `createJSONStorage(() => quotaSafeLocalStorage)`.
  - `persistedVersions.js`: `setPersistedVersion(key, v)`, `getPersistedVersion(key): number|null`.
  - Problems (items without a key) are reported by setting `useSyncStatus` `error` text: add `error: null` to its initial state and `reportProblems` sets `{state:'error', error: '<n> item(s) in <store> have no id and were not saved to the server'}`.

- [ ] **Step 1: Write the failing tests**

`src/storage/serverStorage.test.js`:

```js
import { createServerStateStorage } from './serverStorage';
import * as engine from './syncEngine';
import { api } from './serverClient';

jest.mock('./serverClient', () => {
  class ApiError extends Error { constructor(s, b) { super('x'); this.status = s; this.body = b; } }
  return { api: jest.fn(), ApiError, setUnauthorizedHandler: jest.fn() };
});

const CONFIG = { collections: { items: 'id' }, localFields: ['selected'] };

beforeEach(async () => {
  jest.useFakeTimers();
  localStorage.clear();
  api.mockReset();
  engine.reset();
  api.mockResolvedValueOnce({ cursor: 0, records: [] });
  await engine.bootstrap();
});
afterEach(() => { engine.stop(); jest.useRealTimers(); });

const wrap = (state, version = 2) => JSON.stringify({ state, version });

test('getItem returns null when the server has nothing, so store defaults apply', async () => {
  const s = createServerStateStorage('s', CONFIG);
  expect(await s.getItem('s')).toBeNull();
});

test('setItem enqueues only changed records, then getItem reads them back with local fields', async () => {
  const s = createServerStateStorage('s', CONFIG);
  await s.getItem('s');
  api.mockResolvedValue({ version: 1, rev: 1 });
  await s.setItem('s', wrap({ items: [{ id: 'a', n: 1 }], theme: 'dark', selected: 'a' }));
  await jest.advanceTimersByTimeAsync(500);
  const puts = api.mock.calls.slice(1).map((c) => c[1]).sort();
  expect(puts).toEqual(['/records/s%3Astate/state', '/records/s.items/a'].sort());

  api.mockClear();
  await s.setItem('s', wrap({ items: [{ id: 'a', n: 1 }], theme: 'dark', selected: 'a' }));
  await jest.advanceTimersByTimeAsync(500);
  expect(api).not.toHaveBeenCalled(); // unchanged => no writes

  const back = JSON.parse(await s.getItem('s'));
  expect(back.state.items).toEqual([{ id: 'a', n: 1 }]);
  expect(back.state.selected).toBe('a');
  expect(back.version).toBe(2);
});

test('removing an item sends a delete', async () => {
  const s = createServerStateStorage('s', CONFIG);
  await s.getItem('s');
  api.mockResolvedValue({ version: 1, rev: 1 });
  await s.setItem('s', wrap({ items: [{ id: 'a' }, { id: 'b' }] }));
  await jest.advanceTimersByTimeAsync(500);
  api.mockClear();
  await s.setItem('s', wrap({ items: [{ id: 'a' }] }));
  await jest.advanceTimersByTimeAsync(500);
  expect(api.mock.calls.map((c) => c[0] + ' ' + c[1])).toContain('DELETE /records/s.items/b');
});

test('items without an id surface a visible sync error and are not sent', async () => {
  const s = createServerStateStorage('s', CONFIG);
  await s.getItem('s');
  api.mockResolvedValue({ version: 1, rev: 1 });
  await s.setItem('s', wrap({ items: [{ id: 'a' }, { n: 1 }] }));
  await jest.advanceTimersByTimeAsync(500);
  expect(engine.useSyncStatus.getState().error).toMatch(/1 item.*no id/i);
});

test('a remote change is visible to the next getItem (rehydrate path)', async () => {
  const s = createServerStateStorage('s', CONFIG);
  await s.getItem('s');
  api.mockResolvedValueOnce({
    cursor: 3,
    records: [
      { collection: 's.items', id: 'z', data: { id: 'z' }, version: 1, deleted: false },
      { collection: 's:state', id: 'state', data: { version: 2, shared: {}, order: { items: ['z'] } }, version: 1, deleted: false }
    ]
  });
  await engine.pollNow();
  const back = JSON.parse(await s.getItem('s'));
  expect(back.state.items).toEqual([{ id: 'z' }]);
});
```

`src/storage/createStorage.test.js`:

```js
import { createStorage, isServerMode } from './createStorage';

afterEach(() => { delete process.env.REACT_APP_SERVER_MODE; localStorage.clear(); });

test('local mode round-trips through localStorage exactly like today', async () => {
  expect(isServerMode()).toBe(false);
  const storage = createStorage('csf-comments-storage');
  storage.setItem('csf-comments-storage', { state: { comments: [1] }, version: 1 });
  expect(JSON.parse(localStorage.getItem('csf-comments-storage'))).toEqual({ state: { comments: [1] }, version: 1 });
  expect(storage.getItem('csf-comments-storage')).toEqual({ state: { comments: [1] }, version: 1 });
});

test('server mode is switched by REACT_APP_SERVER_MODE', () => {
  process.env.REACT_APP_SERVER_MODE = 'true';
  expect(isServerMode()).toBe(true);
});

test('server mode falls back to localStorage for stores with no sync config', () => {
  process.env.REACT_APP_SERVER_MODE = 'true';
  const storage = createStorage('csf-ui-storage-not-configured');
  storage.setItem('k', { state: { a: 1 }, version: 0 });
  expect(localStorage.getItem('k')).toBeTruthy();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `CI=true npx react-scripts test --watchAll=false src/storage/serverStorage.test.js src/storage/createStorage.test.js`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement the modules**

Add `error: null` to `useSyncStatus`'s initial state and to the `reset()` call in `syncEngine.js`; add and export:

```js
export function reportSyncProblem(message) {
  useSyncStatus.setState({ state: 'error', error: message });
}
```

`src/storage/persistedVersions.js`:

```js
const versions = {};
export const setPersistedVersion = (key, version) => { versions[key] = version; };
export const getPersistedVersion = (key) => (typeof versions[key] === 'number' ? versions[key] : null);
```

`src/storage/serverStorage.js`:

```js
import { toRecords, fromRecords, diffRecords } from './diff';
import { enqueue, readCollection, whenReady, removeStoreRecords, reportSyncProblem } from './syncEngine';
import { setPersistedVersion } from './persistedVersions';

const readLocal = (key) => {
  try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch { return {}; }
};
const writeLocal = (key, obj) => {
  try { localStorage.setItem(key, JSON.stringify(obj)); } catch { /* per-device prefs only */ }
};

export function createServerStateStorage(storeName, config) {
  const localKey = `${storeName}.local`;
  let snapshot = {};

  return {
    async getItem() {
      await whenReady();
      const persisted = fromRecords(storeName, config, readCollection, readLocal(localKey));
      if (!persisted) { snapshot = {}; return null; }
      snapshot = toRecords(storeName, config, persisted).records;
      setPersistedVersion(storeName, persisted.version);
      return JSON.stringify(persisted);
    },

    async setItem(_name, value) {
      await whenReady();
      const persisted = JSON.parse(value);
      const local = {};
      (config.localFields || []).forEach((f) => { if (f in persisted.state) local[f] = persisted.state[f]; });
      writeLocal(localKey, local);

      const { records, problems } = toRecords(storeName, config, persisted);
      if (problems.length) {
        reportSyncProblem(`${problems.length} item(s) in ${storeName} have no id (or a duplicate id) and were not saved to the server`);
      }
      const { puts, deletes } = diffRecords(snapshot, records);
      snapshot = records;
      setPersistedVersion(storeName, persisted.version);
      if (puts.length || deletes.length) enqueue({ puts, deletes });
    },

    async removeItem() {
      await whenReady();
      snapshot = {};
      removeStoreRecords(storeName);
    }
  };
}
```

`src/storage/storeConfigs.js`:

```js
// Which persisted stores sync to the server, and how. Stores absent from this map
// (or marked `local: true`) stay in this browser's localStorage in every mode.
// collections: field -> key (property name, or function returning a unique string id)
// localFields: per-browser fields kept in localStorage even in server mode
export const STORE_CONFIGS = {
  'csf-comments-storage': { collections: { comments: 'id' } }
};
```

`src/storage/createStorage.js`:

```js
import { createJSONStorage } from 'zustand/middleware';
import { quotaSafeLocalStorage } from '../utils/safeStorage';
import { STORE_CONFIGS } from './storeConfigs';
import { createServerStateStorage } from './serverStorage';

export const isServerMode = () => process.env.REACT_APP_SERVER_MODE === 'true';

export function createStorage(storeName) {
  const config = STORE_CONFIGS[storeName];
  if (!isServerMode() || !config || config.local) {
    return createJSONStorage(() => quotaSafeLocalStorage);
  }
  return createJSONStorage(() => createServerStateStorage(storeName, config));
}
```

- [ ] **Step 4: Wire the pilot store**

In `src/stores/commentsStore.js` add `import { createStorage } from '../storage/createStorage';` and change the persist options to:

```js
    {
      name: 'csf-comments-storage',
      version: 1,
      storage: createStorage('csf-comments-storage')
    }
```

- [ ] **Step 5: Run the new tests plus the existing comments tests**

Run: `CI=true npx react-scripts test --watchAll=false src/storage src/stores/commentsStore.test.js`
Expected: PASS (the existing comments tests run in local mode and prove no regression).

- [ ] **Step 6: Commit**

```bash
git add src/storage src/stores/commentsStore.js
git commit -m "feat(storage): server storage backend and createStorage, pilot on commentsStore"
```

---

### Task 9: Auth state, login screens, conflict dialog, app wiring

**Files:**
- Create: `src/storage/authStore.js`, `src/storage/rehydrateOnRemote.js`, `src/components/AuthGate.js`, `src/pages/Login.js`, `src/components/SyncConflictDialog.js`, `src/components/AuthGate.test.js`
- Modify: `src/App.js`, `src/components/AutoSaveIndicator.js`, `src/index.js` (only if the app root is mounted there; wrap in `AuthGate` inside `App.js` otherwise)

**Interfaces:**
- Consumes: `api`, `setUnauthorizedHandler` (Task 7), `bootstrap`, `start`, `onRemoteChange`, `useSyncStatus`, `resolveConflict` (Task 7), `isServerMode` (Task 8).
- Produces:
  - `useAuthStore` (zustand, not persisted): `{ status: 'unknown'|'needsSetup'|'anonymous'|'authenticated', user: {id, username, displayName, isAdmin, participantId}|null, directory: Map<number, {displayName, username}>, error: string|null, init(), login(username, password), setup(username, displayName, password), logout() }`. `logout()` calls `POST /auth/logout` then `window.location.reload()`.
  - `registerStoreForRehydrate(store)`, `whenAllHydrated(): Promise<void>` in `rehydrateOnRemote.js`.
  - `<AuthGate>{children}</AuthGate>`: in local mode renders children; in server mode renders loading / setup / login / loading-workspace / children.

- [ ] **Step 1: Write the failing tests** — `src/components/AuthGate.test.js`

```js
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AuthGate from './AuthGate';
import { api } from '../storage/serverClient';
import * as engine from '../storage/syncEngine';
import useAuthStore from '../storage/authStore';

jest.mock('../storage/serverClient', () => {
  class ApiError extends Error { constructor(s, b) { super(b?.error || 'x'); this.status = s; this.body = b; } }
  return { api: jest.fn(), ApiError, setUnauthorizedHandler: jest.fn() };
});

beforeEach(() => {
  api.mockReset();
  engine.reset();
  useAuthStore.setState({ status: 'unknown', user: null, error: null, directory: new Map() });
  process.env.REACT_APP_SERVER_MODE = 'true';
});
afterEach(() => { delete process.env.REACT_APP_SERVER_MODE; });

test('local mode renders children with no auth calls', () => {
  delete process.env.REACT_APP_SERVER_MODE;
  render(<AuthGate><div>app</div></AuthGate>);
  expect(screen.getByText('app')).toBeInTheDocument();
  expect(api).not.toHaveBeenCalled();
});

test('first run shows the create-admin screen', async () => {
  api.mockImplementation(async (m, p) => {
    if (p === '/auth/status') return { needsSetup: true };
    throw new Error(`unexpected ${m} ${p}`);
  });
  render(<AuthGate><div>app</div></AuthGate>);
  expect(await screen.findByRole('heading', { name: /create the admin account/i })).toBeInTheDocument();
});

test('signing in loads the workspace and then shows the app', async () => {
  let signedIn = false;
  api.mockImplementation(async (m, p) => {
    if (p === '/auth/status') return { needsSetup: false };
    if (p === '/auth/me') { if (!signedIn) { const e = new Error('401'); e.status = 401; throw e; } return { id: 1, username: 'admin', displayName: 'Admin', isAdmin: true, participantId: null }; }
    if (p === '/auth/login') { signedIn = true; return { ok: true }; }
    if (p.startsWith('/records')) return { cursor: 0, records: [] };
    if (p === '/users') return [{ id: 1, username: 'admin', displayName: 'Admin' }];
    throw new Error(`unexpected ${m} ${p}`);
  });
  render(<AuthGate><div>app</div></AuthGate>);
  await userEvent.type(await screen.findByLabelText(/username/i), 'admin');
  await userEvent.type(screen.getByLabelText(/password/i), 'correct horse battery');
  await userEvent.click(screen.getByRole('button', { name: /sign in/i }));
  expect(await screen.findByText('app')).toBeInTheDocument();
  await waitFor(() => expect(useAuthStore.getState().status).toBe('authenticated'));
});

test('a wrong password shows an error and stays on the login screen', async () => {
  api.mockImplementation(async (m, p) => {
    if (p === '/auth/status') return { needsSetup: false };
    if (p === '/auth/me') { const e = new Error('401'); e.status = 401; throw e; }
    if (p === '/auth/login') { const e = new Error('bad'); e.status = 401; throw e; }
    throw new Error(`unexpected ${m} ${p}`);
  });
  render(<AuthGate><div>app</div></AuthGate>);
  await userEvent.type(await screen.findByLabelText(/username/i), 'admin');
  await userEvent.type(screen.getByLabelText(/password/i), 'wrongwrongwrong');
  await userEvent.click(screen.getByRole('button', { name: /sign in/i }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/invalid username or password/i);
  expect(screen.queryByText('app')).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `CI=true npx react-scripts test --watchAll=false src/components/AuthGate.test.js`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement `src/storage/rehydrateOnRemote.js`**

```js
import { onRemoteChange } from './syncEngine';
import { storeNameOf } from './diff';

const stores = new Map(); // persist name -> zustand store
export const registerStoreForRehydrate = (store) => {
  const name = store.persist?.getOptions?.().name;
  if (name) stores.set(name, store);
};

export function whenAllHydrated() {
  return Promise.all([...stores.values()].map((s) =>
    s.persist.hasHydrated() ? Promise.resolve() : new Promise((resolve) => { const off = s.persist.onFinishHydration(() => { off(); resolve(); }); })
  )).then(() => undefined);
}

let wired = false;
export function wireRemoteRehydration() {
  if (wired) return;
  wired = true;
  onRemoteChange((collections) => {
    const names = new Set([...collections].map(storeNameOf));
    names.forEach((n) => { stores.get(n)?.persist.rehydrate(); });
  });
}
```

(`wireRemoteRehydration` is called once from `AuthGate` after bootstrap. Because `engine.reset()` clears listeners, tests re-wire by resetting the `wired` flag is unnecessary — tests do not call it. Stores register themselves in Task 10 via `src/storage/registerStores.js`.)

- [ ] **Step 4: Implement `src/storage/authStore.js`**

```js
import { create } from 'zustand';
import { api, setUnauthorizedHandler } from './serverClient';
import { bootstrap, start } from './syncEngine';
import { wireRemoteRehydration } from './rehydrateOnRemote';

const loadDirectory = async () => {
  const users = await api('GET', '/users');
  return new Map(users.map((u) => [u.id, { displayName: u.displayName, username: u.username, participantId: u.participantId ?? null }]));
};

const enter = async (set, user) => {
  await bootstrap();
  wireRemoteRehydration();
  start();
  const directory = await loadDirectory().catch(() => new Map());
  set({ status: 'authenticated', user, directory, error: null });
};

const useAuthStore = create((set, get) => ({
  status: 'unknown',
  user: null,
  directory: new Map(),
  error: null,

  async init() {
    try {
      const { needsSetup } = await api('GET', '/auth/status');
      if (needsSetup) return set({ status: 'needsSetup' });
      try {
        const user = await api('GET', '/auth/me');
        await enter(set, user);
      } catch (e) {
        if (e.status === 401) set({ status: 'anonymous' });
        else throw e;
      }
    } catch (e) {
      set({ status: 'anonymous', error: 'Cannot reach the server. Check your connection and reload.' });
    }
    return undefined;
  },

  async login(username, password) {
    set({ error: null });
    try {
      await api('POST', '/auth/login', { username, password });
      const user = await api('GET', '/auth/me');
      await enter(set, user);
    } catch (e) {
      set({ error: e.status === 401 ? 'Invalid username or password.' : 'Could not sign in. Try again.' });
    }
  },

  async setup(username, displayName, password) {
    set({ error: null });
    try {
      await api('POST', '/auth/setup', { username, displayName, password });
      const user = await api('GET', '/auth/me');
      await enter(set, user);
    } catch (e) {
      set({ error: e.status === 400 ? (e.body?.error || 'Check the fields and try again.') : 'Could not create the account.' });
    }
  },

  async logout() {
    try { await api('POST', '/auth/logout', {}); } catch { /* ignore */ }
    window.location.reload();
  }
}));

// Any 401 after sign-in (expired session, disabled account) returns to the login screen.
// The unsent outbox stays in localStorage and is replayed after the next sign-in.
setUnauthorizedHandler(() => {
  if (useAuthStore.getState().status === 'authenticated') useAuthStore.setState({ status: 'anonymous', user: null });
});

export default useAuthStore;
```

- [ ] **Step 5: Implement `src/pages/Login.js` and `src/components/AuthGate.js`**

`src/pages/Login.js` (one component, two modes):

```js
import React, { useState } from 'react';
import useAuthStore from '../storage/authStore';

export default function Login({ mode }) {
  const { login, setup, error } = useAuthStore();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const isSetup = mode === 'setup';

  const submit = (e) => {
    e.preventDefault();
    return isSetup ? setup(username, displayName, password) : login(username, password);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
      <form onSubmit={submit} className="w-full max-w-sm bg-white dark:bg-gray-800 p-6 rounded-lg shadow space-y-4">
        <h1 className="text-xl font-semibold">{isSetup ? 'Create the admin account' : 'Sign in'}</h1>
        {isSetup && (
          <p className="text-sm text-gray-600 dark:text-gray-300">
            This server has no accounts yet. The first account becomes the administrator and can add everyone else.
          </p>
        )}
        <label className="block text-sm">Username
          <input className="mt-1 w-full border rounded px-2 py-1 dark:bg-gray-700" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
        </label>
        {isSetup && (
          <label className="block text-sm">Display name
            <input className="mt-1 w-full border rounded px-2 py-1 dark:bg-gray-700" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
          </label>
        )}
        <label className="block text-sm">Password
          <input type="password" className="mt-1 w-full border rounded px-2 py-1 dark:bg-gray-700" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={isSetup ? 'new-password' : 'current-password'} required minLength={isSetup ? 10 : undefined} />
        </label>
        {error && <div role="alert" className="text-sm text-red-600">{error}</div>}
        <button type="submit" className="w-full bg-blue-600 text-white rounded py-2">{isSetup ? 'Create account' : 'Sign in'}</button>
      </form>
    </div>
  );
}
```

`src/components/AuthGate.js`:

```js
import React, { useEffect, useState } from 'react';
import useAuthStore from '../storage/authStore';
import { isServerMode } from '../storage/createStorage';
import { whenAllHydrated } from '../storage/rehydrateOnRemote';
import Login from '../pages/Login';

const Centered = ({ children }) => <div className="min-h-screen flex items-center justify-center text-gray-600">{children}</div>;

export default function AuthGate({ children }) {
  const serverMode = isServerMode();
  const status = useAuthStore((s) => s.status);
  const init = useAuthStore((s) => s.init);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => { if (serverMode && status === 'unknown') init(); }, [serverMode, status, init]);
  useEffect(() => {
    if (serverMode && status === 'authenticated') whenAllHydrated().then(() => setHydrated(true));
  }, [serverMode, status]);

  if (!serverMode) return children;
  if (status === 'unknown') return <Centered>Loading…</Centered>;
  if (status === 'needsSetup') return <Login mode="setup" />;
  if (status === 'anonymous') return <Login mode="login" />;
  if (!hydrated) return <Centered>Loading workspace…</Centered>;
  return children;
}
```

- [ ] **Step 6: Conflict dialog, indicator and App wiring**

`src/components/SyncConflictDialog.js` (shows when `useSyncStatus().conflicts.length > 0`):

```js
import React from 'react';
import { useSyncStatus, resolveConflict } from '../storage/syncEngine';

const preview = (v) => (v === null ? '(deleted)' : JSON.stringify(v, null, 2).slice(0, 600));

export default function SyncConflictDialog() {
  const conflicts = useSyncStatus((s) => s.conflicts);
  if (!conflicts.length) return null;
  const c = conflicts[0];
  return (
    <div role="dialog" aria-modal="true" aria-label="Someone else changed this" className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow max-w-3xl w-full p-4 space-y-3">
        <h2 className="text-lg font-semibold">Someone else changed this record</h2>
        <p className="text-sm">
          A teammate saved <code>{c.collection.split('.').pop()}</code> “{c.id}” while you were editing it
          ({conflicts.length} conflict{conflicts.length > 1 ? 's' : ''} to review).
        </p>
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div><div className="font-semibold mb-1">Yours</div><pre className="bg-gray-100 dark:bg-gray-900 p-2 overflow-auto max-h-64">{preview(c.mine)}</pre></div>
          <div><div className="font-semibold mb-1">Theirs</div><pre className="bg-gray-100 dark:bg-gray-900 p-2 overflow-auto max-h-64">{preview(c.theirs)}</pre></div>
        </div>
        <div className="flex justify-end gap-2">
          <button className="px-3 py-1 border rounded" onClick={() => resolveConflict(c.key, 'theirs')}>Take theirs</button>
          <button className="px-3 py-1 bg-blue-600 text-white rounded" onClick={() => resolveConflict(c.key, 'mine')}>Keep mine</button>
        </div>
      </div>
    </div>
  );
}
```

`AutoSaveIndicator.js`: at the top of the component add the server-mode branch (hooks must be unconditional, so read both stores first):

```js
import { useSyncStatus } from '../storage/syncEngine';
import { isServerMode } from '../storage/createStorage';
// inside AutoSaveIndicator(), after the existing three useCSFStore selectors:
  const sync = useSyncStatus();
  if (isServerMode()) {
    if (sync.error) return <div className="flex items-center gap-2 text-red-600 text-sm" role="alert"><CloudOff size={14} /><span>{sync.error}</span></div>;
    if (sync.state === 'offline') return <div className="flex items-center gap-2 text-amber-600 text-sm"><CloudOff size={14} /><span>Unsaved changes ({sync.pending}) — retrying</span></div>;
    if (sync.state === 'saving' || sync.pending > 0) return <div className="flex items-center gap-2 text-blue-600 text-sm"><Loader size={14} className="animate-spin" /><span>Saving...</span></div>;
    if (sync.lastSaved) return <div className="flex items-center gap-2 text-green-600 text-sm"><Cloud size={14} /><span>Saved at {formatTime(sync.lastSaved)}</span></div>;
    return null;
  }
```

`App.js`: wrap the router tree: import `AuthGate` and `SyncConflictDialog`; render `<AuthGate><Router>…existing…</Router><SyncConflictDialog /></AuthGate>` (keep `<Toaster />` outside the gate so toasts work on the login screen). Also add a "Sign out" button (calls `useAuthStore.getState().logout()`) to `Navigation.js` shown only when `isServerMode()`, displaying `useAuthStore((s) => s.user)?.displayName`.

- [ ] **Step 7: Run tests**

Run: `CI=true npx react-scripts test --watchAll=false src/components/AuthGate.test.js src/App.test.js`
Expected: PASS (`App.test.js` runs in local mode and proves the gate is transparent).

- [ ] **Step 8: Commit**

```bash
git add src
git commit -m "feat(auth): login gate, auth store, conflict dialog and sync indicator"
```

---

### Task 10: Move the remaining stores and fix backup version reads

**Files:**
- Modify: `src/storage/storeConfigs.js`, `src/storage/rehydrateOnRemote.js` (add registration list), `src/utils/dataExport.js`, and one line in each store listed below.
- Create: `src/storage/registerStores.js`, `src/storage/storeConfigs.test.js`

**Interfaces:**
- Consumes: `createStorage`, `registerStoreForRehydrate`, `getPersistedVersion` (Tasks 8-9).
- Produces: every persisted store takes `storage: createStorage('<its persist name>')`; `STORE_CONFIGS` complete.

Decisions: **synced:** assessments, controls, findings, artifacts, comments, audit log, evaluations, frameworks, requirements, metrics, inventory, org profile, users (participants). **Per-browser (`local: true`):** ui, ai (LLM provider settings and chat history), csf (legacy catalog + download flag). Per-browser fields inside synced stores: `currentAssessmentId` (assessments), `currentUserId` (users).

- [ ] **Step 1: Write the failing test** — `src/storage/storeConfigs.test.js`

```js
import { STORE_CONFIGS } from './storeConfigs';
import { toRecords } from './diff';

const ALL_PERSIST_NAMES = [
  'csf-assessments-storage', 'csf-controls-storage', 'csf-findings-storage', 'csf-artifacts-storage',
  'csf-comments-storage', 'csf-audit-log', 'csf-evaluations-storage', 'csf-frameworks-storage',
  'csf-requirements-storage', 'csf-metrics-storage', 'csf-inventory-storage', 'csf-org-profile-storage',
  'csf-users-storage', 'csf-ui-storage', 'csf-ai-storage', 'csf-data-storage'
];

test('every persisted store has an explicit sync decision', () => {
  ALL_PERSIST_NAMES.forEach((n) => expect(STORE_CONFIGS).toHaveProperty([n]));
});

test('per-browser stores are marked local', () => {
  ['csf-ui-storage', 'csf-ai-storage', 'csf-data-storage'].forEach((n) => expect(STORE_CONFIGS[n].local).toBe(true));
});

// Default (seed) state of every synced collection must carry unique keys, or syncing would drop data.
const loaders = {
  'csf-assessments-storage': () => require('../stores/assessmentsStore').default,
  'csf-controls-storage': () => require('../stores/controlsStore').default,
  'csf-findings-storage': () => require('../stores/findingsStore').default,
  'csf-artifacts-storage': () => require('../stores/artifactStore').default,
  'csf-comments-storage': () => require('../stores/commentsStore').default,
  'csf-audit-log': () => require('../stores/auditLogStore').default,
  'csf-evaluations-storage': () => require('../stores/evaluationsStore').default,
  'csf-frameworks-storage': () => require('../stores/frameworksStore').default,
  'csf-requirements-storage': () => require('../stores/requirementsStore').default,
  'csf-metrics-storage': () => require('../stores/metricsStore').default,
  'csf-inventory-storage': () => require('../stores/inventoryStore').default,
  'csf-users-storage': () => require('../stores/userStore').default
};

Object.entries(loaders).forEach(([name, load]) => {
  test(`${name}: default state items all have unique keys`, () => {
    const store = load();
    const options = store.persist.getOptions();
    const partial = options.partialize ? options.partialize(store.getState()) : store.getState();
    const { problems } = toRecords(name, STORE_CONFIGS[name], { state: partial, version: options.version ?? 0 });
    expect(problems).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `CI=true npx react-scripts test --watchAll=false src/storage/storeConfigs.test.js`
Expected: FAIL (missing configs).

- [ ] **Step 3: Fill `src/storage/storeConfigs.js`**

```js
export const STORE_CONFIGS = {
  'csf-assessments-storage': { collections: { assessments: 'id' }, localFields: ['currentAssessmentId'] },
  'csf-controls-storage': { collections: { controls: 'id' } },
  'csf-findings-storage': { collections: { findings: 'id' } },
  'csf-artifacts-storage': { collections: { artifacts: 'id' } },
  'csf-comments-storage': { collections: { comments: 'id' } },
  'csf-audit-log': { collections: { entries: 'id' } },
  'csf-evaluations-storage': { collections: { evaluations: 'id' } },
  'csf-frameworks-storage': { collections: { frameworks: 'id' } },
  'csf-requirements-storage': { collections: { requirements: (r) => `${r.frameworkId}::${r.id}` } },
  'csf-metrics-storage': { collections: { metrics: 'id' } },
  'csf-inventory-storage': { collections: { systems: 'id' } },
  'csf-org-profile-storage': {},
  'csf-users-storage': { collections: { users: 'id' }, localFields: ['currentUserId'] },
  'csf-ui-storage': { local: true },
  'csf-ai-storage': { local: true },
  'csf-data-storage': { local: true }
};
```

- [ ] **Step 4: Run; fix any real key problems**

Run: `CI=true npx react-scripts test --watchAll=false src/storage/storeConfigs.test.js`
Expected: PASS. If a store's default state reports `problems` (an item without `id`, e.g. metrics `metricId` or requirements `frameworkId` missing), change **that store's config key** to the property that is actually unique (check the store's record shape), not the data. Re-run until green.

- [ ] **Step 5: Point each store at `createStorage`**

In each of these files add `import { createStorage } from '../storage/createStorage';` and add `storage: createStorage('<name>')` to the persist options (assessmentsStore: replace its existing `storage: createJSONStorage(() => quotaSafeLocalStorage)` line; remove the now-unused `createJSONStorage`/`quotaSafeLocalStorage` imports **only if** nothing else in the file uses them):

| File | persist name |
|------|--------------|
| `src/stores/assessmentsStore.js` | `csf-assessments-storage` |
| `src/stores/controlsStore.js` | `csf-controls-storage` |
| `src/stores/findingsStore.js` | `csf-findings-storage` |
| `src/stores/artifactStore.js` | `csf-artifacts-storage` |
| `src/stores/auditLogStore.js` | `csf-audit-log` |
| `src/stores/evaluationsStore.js` | `csf-evaluations-storage` |
| `src/stores/frameworksStore.js` | `csf-frameworks-storage` |
| `src/stores/requirementsStore.js` | `csf-requirements-storage` |
| `src/stores/metricsStore.js` | `csf-metrics-storage` |
| `src/stores/inventoryStore.js` | `csf-inventory-storage` |
| `src/stores/orgProfileStore.js` | `csf-org-profile-storage` |
| `src/stores/userStore.js` | `csf-users-storage` |
| `src/stores/uiStore.js`, `aiStore.js`, `csfStore.js` | same call; configs mark them `local`, so behavior is unchanged |

- [ ] **Step 6: Register stores for remote rehydration**

`src/storage/registerStores.js`:

```js
import { registerStoreForRehydrate } from './rehydrateOnRemote';
import useAssessmentsStore from '../stores/assessmentsStore';
import useControlsStore from '../stores/controlsStore';
import useFindingsStore from '../stores/findingsStore';
import useArtifactStore from '../stores/artifactStore';
import useCommentsStore from '../stores/commentsStore';
import useAuditLogStore from '../stores/auditLogStore';
import useEvaluationsStore from '../stores/evaluationsStore';
import useFrameworksStore from '../stores/frameworksStore';
import useRequirementsStore from '../stores/requirementsStore';
import useMetricsStore from '../stores/metricsStore';
import useInventoryStore from '../stores/inventoryStore';
import useOrgProfileStore from '../stores/orgProfileStore';
import useUserStore from '../stores/userStore';

[
  useAssessmentsStore, useControlsStore, useFindingsStore, useArtifactStore, useCommentsStore,
  useAuditLogStore, useEvaluationsStore, useFrameworksStore, useRequirementsStore, useMetricsStore,
  useInventoryStore, useOrgProfileStore, useUserStore
].forEach(registerStoreForRehydrate);
```

Add `import './storage/registerStores';` to `src/index.js` before the app renders.

- [ ] **Step 7: Make backup version reads work in server mode**

In `src/utils/dataExport.js`, change `readPersistedVersion` to consult the server-mode registry first:

```js
import { getPersistedVersion } from '../storage/persistedVersions';
// ...
export const readPersistedVersion = (persistKey) => {
  const fromServer = getPersistedVersion(persistKey);
  if (fromServer !== null) return fromServer;
  try {
    const raw = window.localStorage.getItem(persistKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed?.version === 'number' ? parsed.version : null;
  } catch {
    return null;
  }
};
```

Add a test to `src/utils/dataExport.test.js` (create it if missing, matching the file's existing test conventions) asserting `readPersistedVersion('k')` returns the value after `setPersistedVersion('k', 7)`.

- [ ] **Step 8: Run the whole client suite**

Run: `CI=true npx react-scripts test --watchAll=false`
Expected: PASS. Local mode must be unchanged; investigate any failure rather than editing assertions.

- [ ] **Step 9: Commit**

```bash
git add src
git commit -m "feat(storage): sync all shared stores; keep ui/ai/legacy stores per-browser"
```

---

### Task 11: Accounts page (admin user management and own password)

**Files:**
- Create: `src/pages/Accounts.js`, `src/pages/Accounts.test.js`
- Modify: `src/App.js` (route `/accounts`), `src/components/Navigation.js` (link, server mode only)

**Interfaces:**
- Consumes: `api` (Task 7), `useAuthStore` (Task 9), server routes (Tasks 2-3), `useUserStore` participants (existing).
- Produces: route `/accounts` (title "Accounts"); admin sees the list/create/reset/disable/link controls; everyone sees "Change my password".

- [ ] **Step 1: Write the failing tests** — `src/pages/Accounts.test.js`

```js
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Accounts from './Accounts';
import { api } from '../storage/serverClient';
import useAuthStore from '../storage/authStore';

jest.mock('../storage/serverClient', () => ({ api: jest.fn(), ApiError: class extends Error {}, setUnauthorizedHandler: jest.fn() }));

const users = [
  { id: 1, username: 'admin', displayName: 'Admin', isAdmin: true, disabled: false, participantId: null },
  { id: 2, username: 'sam', displayName: 'Sam', isAdmin: false, disabled: false, participantId: null }
];

beforeEach(() => {
  api.mockReset();
  api.mockImplementation(async (m, p) => (m === 'GET' && p === '/users' ? users : { ok: true }));
  useAuthStore.setState({ status: 'authenticated', user: { id: 1, username: 'admin', displayName: 'Admin', isAdmin: true, participantId: null }, directory: new Map() });
});

test('admin sees all accounts and can create one', async () => {
  render(<Accounts />);
  expect(await screen.findByText('sam')).toBeInTheDocument();
  await userEvent.type(screen.getByLabelText(/new username/i), 'kim');
  await userEvent.type(screen.getByLabelText(/new display name/i), 'Kim');
  await userEvent.type(screen.getByLabelText(/temporary password/i), 'temporary password 1');
  await userEvent.click(screen.getByRole('button', { name: /add account/i }));
  expect(api).toHaveBeenCalledWith('POST', '/users', expect.objectContaining({ username: 'kim', displayName: 'Kim' }));
});

test('admin can disable another account', async () => {
  render(<Accounts />);
  const row = (await screen.findByText('sam')).closest('tr');
  await userEvent.click(within(row).getByRole('button', { name: /disable/i }));
  expect(api).toHaveBeenCalledWith('PATCH', '/users/2', { disabled: true });
});

test('non-admins do not see admin controls but can change their own password', async () => {
  useAuthStore.setState({ user: { id: 2, username: 'sam', displayName: 'Sam', isAdmin: false, participantId: null } });
  render(<Accounts />);
  expect(screen.queryByLabelText(/new username/i)).not.toBeInTheDocument();
  await userEvent.type(screen.getByLabelText(/current password/i), 'old password long');
  await userEvent.type(screen.getByLabelText(/^new password/i), 'new password long');
  await userEvent.click(screen.getByRole('button', { name: /change my password/i }));
  expect(api).toHaveBeenCalledWith('POST', '/auth/password', { currentPassword: 'old password long', newPassword: 'new password long' });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `CI=true npx react-scripts test --watchAll=false src/pages/Accounts.test.js`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `src/pages/Accounts.js`**

```js
import React, { useEffect, useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { api } from '../storage/serverClient';
import useAuthStore from '../storage/authStore';
import useUserStore from '../stores/userStore';

const input = 'mt-1 w-full border rounded px-2 py-1 dark:bg-gray-700';

function ChangePassword() {
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/auth/password', { currentPassword, newPassword });
      toast.success('Password changed');
      setCurrent(''); setNew('');
    } catch { toast.error('Could not change the password. Check the current password.'); }
  };
  return (
    <form onSubmit={submit} className="space-y-2 max-w-sm">
      <h2 className="font-semibold">Change my password</h2>
      <label className="block text-sm">Current password
        <input type="password" className={input} value={currentPassword} onChange={(e) => setCurrent(e.target.value)} required />
      </label>
      <label className="block text-sm">New password (10+ characters)
        <input type="password" className={input} value={newPassword} onChange={(e) => setNew(e.target.value)} required minLength={10} />
      </label>
      <button className="px-3 py-1 bg-blue-600 text-white rounded">Change my password</button>
    </form>
  );
}

export default function Accounts() {
  const me = useAuthStore((s) => s.user);
  const participants = useUserStore((s) => s.users);
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState({ username: '', displayName: '', password: '' });

  const load = useCallback(async () => { if (me?.isAdmin) setUsers(await api('GET', '/users')); }, [me]);
  useEffect(() => { load(); }, [load]);

  const patch = async (id, body) => {
    try { await api('PATCH', `/users/${id}`, body); await load(); }
    catch (e) { toast.error(e.body?.error === 'last-admin' ? 'There must be at least one active administrator.' : 'Update failed.'); }
  };
  const create = async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/users', form);
      setForm({ username: '', displayName: '', password: '' });
      await load();
    } catch (err) { toast.error(err.body?.error === 'username-taken' ? 'That username is taken.' : 'Could not add the account.'); }
  };
  const reset = (id) => {
    const password = window.prompt('New temporary password (10+ characters):');
    if (password) patch(id, { password });
  };

  return (
    <div className="p-4 space-y-8">
      <h1 className="text-xl font-semibold">Accounts</h1>
      {me?.isAdmin && (
        <>
          <table className="w-full text-sm">
            <thead><tr className="text-left"><th>Username</th><th>Name</th><th>Linked participant</th><th>Status</th><th /></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-t">
                  <td>{u.username}</td>
                  <td>{u.displayName}{u.isAdmin ? ' (admin)' : ''}</td>
                  <td>
                    <select aria-label={`Participant for ${u.username}`} value={u.participantId ?? ''} onChange={(e) => patch(u.id, { participantId: e.target.value === '' ? null : Number(e.target.value) })} className="border rounded dark:bg-gray-700">
                      <option value="">— none —</option>
                      {participants.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </td>
                  <td>{u.disabled ? 'Disabled' : 'Active'}</td>
                  <td className="space-x-2">
                    <button onClick={() => reset(u.id)}>Reset password</button>
                    {u.id !== me.id && <button onClick={() => patch(u.id, { disabled: !u.disabled })}>{u.disabled ? 'Enable' : 'Disable'}</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <form onSubmit={create} className="space-y-2 max-w-sm">
            <h2 className="font-semibold">Add an account</h2>
            <label className="block text-sm">New username<input className={input} value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required /></label>
            <label className="block text-sm">New display name<input className={input} value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} required /></label>
            <label className="block text-sm">Temporary password (10+ characters)<input type="password" className={input} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required minLength={10} /></label>
            <button className="px-3 py-1 bg-blue-600 text-white rounded">Add account</button>
          </form>
        </>
      )}
      <ChangePassword />
    </div>
  );
}
```

Add `const Accounts = lazy(() => import('./pages/Accounts'));` and `<Route path="/accounts" element={<Accounts />} />` in `src/App.js`; in `Navigation.js` add an "Accounts" link guarded by `isServerMode()`.

- [ ] **Step 4: Run tests**

Run: `CI=true npx react-scripts test --watchAll=false src/pages/Accounts.test.js`
Expected: PASS. (If the "Reset password" test is later added, mock `window.prompt`.)

- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "feat(auth): accounts page for admins and password change"
```

---

### Task 12: Import this browser's data into the server

**Files:**
- Create: `src/storage/importLocalData.js`, `src/storage/importLocalData.test.js`, `src/components/ImportLocalDataPrompt.js`
- Modify: `src/App.js` (render the prompt in server mode)

**Interfaces:**
- Consumes: `toRecords` (Task 6), `STORE_CONFIGS` (Task 10), `api`, `bootstrap` (Task 7), `setPersistedVersion`.
- Produces: `collectLocalRecords(): { records: Array<{collection,id,data}>, storeNames: string[] }` reads every synced `csf-*` localStorage key; `hasLocalData(): boolean`; `importLocalData(): Promise<{imported:number}>` (POSTs to `/import`, then re-bootstraps and rehydrates all stores). `IMPORT_DECLINED_KEY = 'csf-import-declined'`.

Why this is safe: the local JSON `{state, version}` is passed through the same `toRecords` path with its **old** `version` stored in the `:state` record, so when stores rehydrate, zustand runs each store's existing `migrate` — no migration code is duplicated.

- [ ] **Step 1: Write the failing tests** — `src/storage/importLocalData.test.js`

```js
import { collectLocalRecords, hasLocalData, importLocalData } from './importLocalData';
import { api } from './serverClient';

jest.mock('./serverClient', () => ({ api: jest.fn(), ApiError: class extends Error {}, setUnauthorizedHandler: jest.fn() }));
jest.mock('./syncEngine', () => ({ bootstrap: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./rehydrateOnRemote', () => ({ rehydrateAll: jest.fn().mockResolvedValue(undefined) }));

beforeEach(() => { localStorage.clear(); api.mockReset(); });

const seed = () => {
  localStorage.setItem('csf-comments-storage', JSON.stringify({ state: { comments: [{ id: 'c1', text: 'hi' }] }, version: 1 }));
  localStorage.setItem('csf-ui-storage', JSON.stringify({ state: { darkMode: true }, version: 0 })); // per-browser: never imported
};

test('no local data means nothing to import', () => {
  expect(hasLocalData()).toBe(false);
});

test('collects records for synced stores only, keeping the old schema version', () => {
  seed();
  expect(hasLocalData()).toBe(true);
  const { records } = collectLocalRecords();
  const state = records.find((r) => r.collection === 'csf-comments-storage:state');
  expect(state.data.version).toBe(1);
  expect(records.some((r) => r.collection === 'csf-comments-storage.comments' && r.id === 'c1')).toBe(true);
  expect(records.some((r) => r.collection.startsWith('csf-ui-storage'))).toBe(false);
});

test('corrupt local JSON is skipped, not fatal', () => {
  localStorage.setItem('csf-comments-storage', '{not json');
  expect(collectLocalRecords().records).toEqual([]);
});

test('importLocalData posts to /import and leaves localStorage untouched', async () => {
  seed();
  api.mockResolvedValue({ imported: 2 });
  const res = await importLocalData();
  expect(api).toHaveBeenCalledWith('POST', '/import', expect.objectContaining({ records: expect.any(Array) }));
  expect(res.imported).toBe(2);
  expect(localStorage.getItem('csf-comments-storage')).toBeTruthy();
});

test('a refused import (workspace not empty) rejects and keeps local data', async () => {
  seed();
  const err = new Error('conflict'); err.status = 409; err.body = { error: 'workspace-not-empty' };
  api.mockRejectedValue(err);
  await expect(importLocalData()).rejects.toMatchObject({ status: 409 });
  expect(localStorage.getItem('csf-comments-storage')).toBeTruthy();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `CI=true npx react-scripts test --watchAll=false src/storage/importLocalData.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add to `src/storage/rehydrateOnRemote.js`:

```js
export const rehydrateAll = () => Promise.all([...stores.values()].map((s) => s.persist.rehydrate()));
```

`src/storage/importLocalData.js`:

```js
import { api } from './serverClient';
import { bootstrap } from './syncEngine';
import { rehydrateAll } from './rehydrateOnRemote';
import { STORE_CONFIGS } from './storeConfigs';
import { toRecords } from './diff';

export const IMPORT_DECLINED_KEY = 'csf-import-declined';
const syncedNames = () => Object.entries(STORE_CONFIGS).filter(([, c]) => !c.local).map(([n]) => n);

export function collectLocalRecords() {
  const records = [];
  const storeNames = [];
  syncedNames().forEach((name) => {
    let persisted;
    try { persisted = JSON.parse(localStorage.getItem(name) || 'null'); } catch { return; }
    if (!persisted || typeof persisted !== 'object' || !persisted.state) return;
    // Fold the per-browser fields back in: on the server they are not stored, so drop them here too.
    const { records: recs } = toRecords(name, STORE_CONFIGS[name], persisted);
    Object.values(recs).forEach((r) => records.push({ collection: r.collection, id: r.id, data: r.data }));
    storeNames.push(name);
  });
  return { records, storeNames };
}

export const hasLocalData = () => collectLocalRecords().records.length > 0;

export async function importLocalData() {
  const { records } = collectLocalRecords();
  const result = await api('POST', '/import', { records });
  await bootstrap();
  await rehydrateAll(); // stores re-read from the server and run their normal migrate() on the old versions
  return result;
}
```

`src/components/ImportLocalDataPrompt.js`: shown only in server mode when `hasLocalData()` is true and `IMPORT_DECLINED_KEY` is not set. It must (1) first offer "Download a backup" using the existing export function path used by `Settings` (call `exportAllDataJSON` with the same store map Settings builds; copy that wiring from `src/pages/Settings.js` — find it with `grep -n "exportAllDataJSON" src/pages/Settings.js`); (2) on "Import into server" call `importLocalData()`, toast "Imported N records"; (3) on a 409 `workspace-not-empty`, toast "This workspace already has data, so your browser's data was not imported. It is still saved in this browser." and set `IMPORT_DECLINED_KEY`; (4) "Not now" sets `IMPORT_DECLINED_KEY`. Render it from `App.js` inside `AppContent` when `isServerMode()`.

- [ ] **Step 4: Add a component test** (`src/components/ImportLocalDataPrompt.test.js`) covering: hidden when no local data; hidden when declined; shows and calls `importLocalData` on click; 409 shows the "not imported" toast message. Mock `../storage/importLocalData` and `react-hot-toast`.

- [ ] **Step 5: Run tests and commit**

Run: `CI=true npx react-scripts test --watchAll=false src/storage src/components/ImportLocalDataPrompt.test.js`
Expected: PASS.

```bash
git add src
git commit -m "feat(storage): one-time import of a browser's data into the server"
```

---

### Task 13: Attribution and "who's working on this assessment"

**Files:**
- Modify: `src/stores/userStore.js`, `src/storage/authStore.js`
- Create: `src/storage/activity.js`, `src/storage/activity.test.js`
- Modify: `src/pages/Assessments.js` (display), `src/stores/userStore.migration.test.js` untouched

**Interfaces:**
- Consumes: `useAuthStore` (`user`, `directory`), `getEntries` (Task 7).
- Produces:
  - `userStore`: non-persisted `accountDisplayName: string|null` and `setAccountDisplayName(name)`; `getCurrentUserName()` returns the linked participant's name if `currentUserId` resolves, else `accountDisplayName`, else its existing fallback.
  - `authStore.enter(...)`: after sign-in, sets `useUserStore.setState({ accountDisplayName: user.displayName })` and, if `user.participantId` is set and exists in participants, `setCurrentUser(user.participantId)`.
  - `activity.js`: `getAssessmentActivity(assessmentId, directory): { lastEditor: string|null, lastEditedAt: string|null, recentEditors: string[] }` using server-side `updatedBy`/`updatedAt` of the assessment record and of records whose data has `assessmentId === assessmentId` in the `csf-controls-storage.controls`, `csf-findings-storage.findings`, `csf-evaluations-storage.evaluations`, `csf-artifacts-storage.artifacts` collections (collections whose items have no `assessmentId` simply contribute nothing). `recentEditors` is distinct display names edited within the last 24 h, most recent first.

- [ ] **Step 1: Read the current functions**

Run: `sed -n 85,125p src/stores/userStore.js` and confirm the exact current body of `getCurrentUser`/`getCurrentUserName` before editing; keep their existing behavior in local mode (where `accountDisplayName` is always null).

- [ ] **Step 2: Write the failing tests** — `src/storage/activity.test.js`

```js
import { getAssessmentActivity } from './activity';
import * as engine from './syncEngine';
import { api } from './serverClient';

jest.mock('./serverClient', () => ({ api: jest.fn(), ApiError: class extends Error {}, setUnauthorizedHandler: jest.fn() }));

const directory = new Map([[1, { displayName: 'Ann' }], [2, { displayName: 'Bo' }]]);
const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();

beforeEach(async () => {
  engine.reset();
  api.mockReset();
  api.mockResolvedValueOnce({
    cursor: 1,
    records: [
      { collection: 'csf-assessments-storage.assessments', id: 'A1', data: { id: 'A1' }, version: 1, updatedBy: 1, updatedAt: hoursAgo(30) },
      { collection: 'csf-findings-storage.findings', id: 'f1', data: { id: 'f1', assessmentId: 'A1' }, version: 1, updatedBy: 2, updatedAt: hoursAgo(1) },
      { collection: 'csf-findings-storage.findings', id: 'f2', data: { id: 'f2', assessmentId: 'OTHER' }, version: 1, updatedBy: 1, updatedAt: hoursAgo(0.1) }
    ]
  });
  await engine.bootstrap();
});

test('reports the last editor across the assessment and its linked records', () => {
  const a = getAssessmentActivity('A1', directory);
  expect(a.lastEditor).toBe('Bo');
  expect(new Date(a.lastEditedAt).getTime()).toBeGreaterThan(Date.now() - 2 * 3600 * 1000);
});

test('recent editors are limited to the last 24 hours and exclude other assessments', () => {
  expect(getAssessmentActivity('A1', directory).recentEditors).toEqual(['Bo']);
});

test('an assessment with no server activity has no editor', () => {
  expect(getAssessmentActivity('NOPE', directory)).toEqual({ lastEditor: null, lastEditedAt: null, recentEditors: [] });
});
```

Add a `userStore` test (new file `src/stores/userStore.account.test.js`): with `currentUserId` null and `accountDisplayName` "Kim", `getCurrentUserName()` returns "Kim"; with a resolvable participant it returns the participant's name.

- [ ] **Step 3: Run to verify failure**

Run: `CI=true npx react-scripts test --watchAll=false src/storage/activity.test.js src/stores/userStore.account.test.js`
Expected: FAIL.

- [ ] **Step 4: Implement**

`src/storage/activity.js`:

```js
import { getEntries } from './syncEngine';

const LINKED = [
  'csf-controls-storage.controls',
  'csf-findings-storage.findings',
  'csf-evaluations-storage.evaluations',
  'csf-artifacts-storage.artifacts'
];
const DAY = 24 * 3600 * 1000;

export function getAssessmentActivity(assessmentId, directory) {
  const touched = [];
  getEntries('csf-assessments-storage.assessments').forEach((e) => { if (e.id === assessmentId) touched.push(e); });
  LINKED.forEach((c) => getEntries(c).forEach((e) => { if (e.data?.assessmentId === assessmentId) touched.push(e); }));
  const dated = touched.filter((e) => e.updatedAt && e.updatedBy != null)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  if (!dated.length) return { lastEditor: null, lastEditedAt: null, recentEditors: [] };
  const name = (id) => directory.get(id)?.displayName || 'Unknown user';
  const recent = [];
  dated.forEach((e) => {
    if (Date.now() - new Date(e.updatedAt) > DAY) return;
    const n = name(e.updatedBy);
    if (!recent.includes(n)) recent.push(n);
  });
  return { lastEditor: name(dated[0].updatedBy), lastEditedAt: dated[0].updatedAt, recentEditors: recent };
}
```

Note: `flushNow` in Task 7 stores `updatedBy: null` for the author's own just-sent writes; the next poll replaces it (the poll skips records whose version is not newer, so change the skip rule in `pollNow` to: `if (have && have.version >= r.version && have.updatedBy !== null) return; if (have && have.version >= r.version) { have.updatedBy = r.updatedBy; have.updatedAt = r.updatedAt; return; }` so metadata is filled in without emitting a change). Add a test for that in `syncEngine.test.js`: after a successful flush, a poll echo of the same version fills `getEntries(...)[0].updatedBy` and does **not** call `onRemoteChange` listeners.

`userStore.js`: add `accountDisplayName: null`, `setAccountDisplayName: (name) => set({ accountDisplayName: name })` to the state (not in the persisted object: confirm `partialize` is absent for this store — it persists everything — so add `partialize: (s) => { const { accountDisplayName, ...rest } = s; return rest; }` is **not** needed because functions are not serialized, but `accountDisplayName` is a string and WOULD persist; add a `partialize` that returns `{ users: s.users, currentUserId: s.currentUserId }` after checking with `sed -n 85,100p` that these are the only persisted data fields, and keep `version`/`migrate` unchanged). Update `getCurrentUserName` to `return user?.name || get().accountDisplayName || <existing fallback>`.

`authStore.js` `enter(...)`: after `bootstrap()` add

```js
import useUserStore from '../stores/userStore';
// ...
  useUserStore.getState().setAccountDisplayName(user.displayName);
```
and after rehydration completes (in `AuthGate` once `whenAllHydrated` resolves), if `user.participantId` matches a participant, call `useUserStore.getState().setCurrentUser(user.participantId)`. Implement that second part inside `AuthGate`'s hydrated effect.

`Assessments.js`: where each assessment is rendered (find the card/row with `grep -n "assessment.name" src/pages/Assessments.js`), add in server mode a muted line `Last edited by {lastEditor} · {relative time}` and, if `recentEditors.length`, `Active in the last 24h: {names}`, using `getAssessmentActivity(a.id, directory)` with `directory` from `useAuthStore`. Hide the line when `lastEditor` is null.

- [ ] **Step 5: Run tests and commit**

Run: `CI=true npx react-scripts test --watchAll=false src/storage src/stores src/pages/Assessments`
Expected: PASS (existing user store tests still pass in local mode).

```bash
git add src
git commit -m "feat(auth): attribute edits to signed-in accounts; show assessment activity"
```

---

### Task 14: Docs, deployment and spec amendments

**Files:**
- Create: `docs/SELF_HOSTING.md`, `Dockerfile`, `.dockerignore`
- Modify: `README.md`, `PRIVATE_DATA.md`, `server/package.json` (nothing), `docs/superpowers/specs/2026-10-06-multi-user-server-storage-design.md`

- [ ] **Step 1: Write `docs/SELF_HOSTING.md`** covering, with exact commands:
  1. Build: `REACT_APP_SERVER_MODE=true INLINE_RUNTIME_CHUNK=false npm run build` (inline runtime chunk off because the server's CSP forbids inline scripts).
  2. Run: `cd server && npm ci && MULTIUSER=true STATIC_DIR=../build DATA_DIR=/var/lib/csf COOKIE_SECURE=true node index.js`; first visit shows "Create the admin account".
  3. HTTPS: terminate TLS at a reverse proxy (Caddy/nginx) and forward `X-Forwarded-Proto`; note `app.set('trust proxy', 1)` must be added to `server/app.js` when `COOKIE_SECURE` is unset behind a proxy (add this line now: `if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);` plus a test asserting `Secure` appears when `COOKIE_SECURE=true`).
  4. Backups: stop writes or use `sqlite3 csf.db ".backup csf-backup.db"`; copy `DATA_DIR`.
  5. Forgotten admin password: `node -e` snippet that opens the DB and runs `UPDATE users SET password_hash = ?` using `server/utils/passwords.js` (give the exact snippet).
  6. What stays per-browser (theme, AI settings, current assessment, current participant) and that the org profile now lives on the server and is visible to every account.

- [ ] **Step 2: `Dockerfile`**

```dockerfile
FROM node:18-bookworm AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ENV REACT_APP_SERVER_MODE=true INLINE_RUNTIME_CHUNK=false
RUN npm run build

FROM node:18-bookworm-slim
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY server/ ./
COPY --from=build /app/build /app/build
ENV MULTIUSER=true STATIC_DIR=/app/build DATA_DIR=/data PORT=4000
VOLUME /data
EXPOSE 4000
CMD ["node", "index.js"]
```

`.dockerignore`: `node_modules`, `server/node_modules`, `build`, `.git`, `server/data`.

- [ ] **Step 3: Reword privacy statements.** In `PRIVATE_DATA.md` (intro paragraph and the "Your pack never touches…" paragraph) and `README.md`, replace "stores … in your browser's localStorage. Nothing is uploaded." with wording that is true in both modes: in local mode data stays in this browser; in a self-hosted multi-user deployment data is stored in your own server's database and visible to everyone with an account. Also update the `orgProfileStore.js` header comment ("lives only in this browser's localStorage") to say it syncs to the server in multi-user mode, and note that `cloudConsent` still gates sending profile text to a cloud AI provider.

- [ ] **Step 4: Amend the spec** (`docs/superpowers/specs/2026-10-06-multi-user-server-storage-design.md`) so it matches what was built:
  - §2: password hashing is Node's built-in `crypto.scrypt` (no native dependency) instead of argon2id/bcrypt.
  - §3: mode is chosen at build time by `REACT_APP_SERVER_MODE=true` (not by probing); `localFields` keeps per-browser fields (current assessment, current participant) in localStorage; `ui`, `ai` and legacy `csf` stores are per-browser; collection keys may be functions; `:state` records (non-collection fields and array order) use last-write-wins (`force`) with no conflict prompt; only collection records raise 409 conflicts; the server adds a global `rev` cursor to `records`.
  - §1: the AI proxy requires a session in multi-user mode; the global 50/15min limiter now applies only to `/api/ai`.
  - §4: import re-uses the stores' existing `migrate()` by writing the old schema version into the `:state` record and rehydrating.

- [ ] **Step 5: Full verification**

Run: `cd server && npm test` → PASS. Run: `CI=true npx react-scripts test --watchAll=false` → PASS. Run a manual end-to-end pass:

```bash
REACT_APP_SERVER_MODE=true INLINE_RUNTIME_CHUNK=false npm run build
cd server && MULTIUSER=true STATIC_DIR=../build DATA_DIR=/tmp/csf-e2e node index.js
```

In a browser at `http://localhost:4000`: create the admin; edit a finding; open a second browser profile, sign in as a second account (create it in Accounts) and confirm the finding appears; edit the same finding in both and confirm the "Someone else changed this record" dialog; stop the server, edit, restart, confirm "Unsaved changes" then "Saved". Record what you observed in the PR description.

- [ ] **Step 6: Commit**

```bash
git add docs Dockerfile .dockerignore README.md PRIVATE_DATA.md src/stores/orgProfileStore.js server/app.js server/test
git commit -m "docs: self-hosting guide, Dockerfile, privacy wording, spec amendments"
```

---

## Self-Review

**Spec coverage**
- §1 server/data model/API → Tasks 1, 4, 5 (records, import), 2-3 (auth/users); `updated_by` stamping → Task 4 (`req.user.id`).
- §2 auth/users, first-run setup, admin screen, participant link, "who's working" → Tasks 2, 3, 9, 11, 13.
- §3 adapter/sync (diff, debounce, poll, 409 UX, outbox, local backend) → Tasks 6-9; failures/offline → Task 7 tests.
- §4 migration/import/testing/rollout/docs → Tasks 12, 14; test strategy is embedded per task; rollout order is the task order (server → adapter+pilot → remaining stores + login → import/attribution → docs).
- Out-of-scope items are not planned.

**Placeholder scan:** The only deliberately open items are verifications that need the real file (Task 10 step 4 key corrections; Task 12 step 3 backup wiring grep; Task 13 step 1 and the `Assessments.js` grep). Each states the exact command and the rule to apply.

**Type consistency:** `recordKey`, `toRecords`, `fromRecords`, `diffRecords` (Task 6) are used with the same signatures in Tasks 7, 8, 12. `enqueue({puts, deletes})`, `readCollection`, `getEntries`, `whenReady`, `resolveConflict`, `removeStoreRecords`, `reportSyncProblem`, `useSyncStatus` are defined in Task 7/8 and used consistently in 9, 12, 13. Server routes and body shapes (`baseVersion`, `force`, `/import`, `/users` fields) match the client calls.

**Review Focus coverage:** items without ids → Task 6 + Task 8 + Task 10 tests; mid-session 401 → Task 9 (`setUnauthorizedHandler`) with the outbox kept (Task 7 test "persisted outbox replayed"); second browser import → Task 5 + Task 12 tests; special-character ids → Task 4 and Task 7 tests; poll vs unsent edits → Task 7 test; last admin/disable → Task 3 tests.
