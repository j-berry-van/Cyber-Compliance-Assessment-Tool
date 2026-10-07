# Architecture

CSF Profile is a NIST CSF 2.0 assessment tool: one React codebase that runs three ways. This page explains how the
pieces connect and what not to break. Setup and usage live elsewhere: [SELF_HOSTING.md](SELF_HOSTING.md) (admins),
[MULTI_USER.md](MULTI_USER.md) (teams), and the
[multi-user design spec](superpowers/specs/2026-10-06-multi-user-server-storage-design.md) (the reasoning).

## Run modes

| Mode | Where data lives | How it runs |
|---|---|---|
| Local / PWA | Browser localStorage | `npm start`, or the hosted demo |
| Desktop | localStorage inside the Tauri shell | `npm run desktop` (`src-tauri/`, wraps the `build/` output) |
| Multi-user | One SQLite file on your server | Client built with `REACT_APP_SERVER_MODE=true`; `server/` run with `MULTIUSER=true` |

The mode is fixed **when the client is built**. A normal build never talks to the server, and a server-mode build
always expects it. Local and desktop modes need no server at all.

## Layout

- `src/stores/` Zustand stores: all app state. `src/pages/`, `src/components/` are the UI over them.
- `src/storage/` persistence and sync. This is where local and server modes diverge.
- `server/` Express API. Without `MULTIUSER=true` it only serves the AI proxy (`/api/ai`); with it, `db.js` opens
  SQLite and `/api/auth`, `/api/users`, `/api/records` and `/api/import` are mounted.
- `ASSESSMENT_CATALOG/`, `data/`, `public/` framework content and templates.

## Data flow

Every persisted store gets its storage from `createStorage(name)`. It returns localStorage unless the build is
server mode **and** the store is listed in `STORE_CONFIGS` (`storeConfigs.js`) without `local: true`. Stores marked
`local` (UI, AI, data prefs) and fields in `localFields` (for example `currentAssessmentId`) stay per-browser.

In server mode a store write goes: store, `serverStorage.js` (diffs the store into per-record changes),
`syncEngine.js` (debounced outbox), `POST /api/records`, SQLite `records` table. The engine also polls for other
people's changes and rehydrates stores through `rehydrateOnRemote.js`.

Each record has a `version`. A save carries the `baseVersion` it was edited from and the server refuses a stale one.
The client then tries `merge3(base, mine, theirs)` (`merge.js`): different fields combine; the same field changed to
different values becomes a conflict that `SyncConflictDialog` puts to the person.

## Invariants (do not break)

Each is enforced in `src/storage/syncEngine.js` or `serverStorage.js` and pinned by tests next to them.

- Local mode never contacts the server.
- A store whose saved data cannot be adopted (version mismatch with no `migrate`) is not written, because the next
  write would overwrite or delete the whole team's records.
- The outbox is per user and per tab: a tab only sends its own entries.
- 408 and 429 are retried; other 4xx responses (except 401 and 409) are permanent and surfaced, not retried.
- Sign-out flushes pending writes before the session ends; a password change or reset revokes sessions.

## Security boundaries

- The server allows same-origin requests plus `ALLOWED_ORIGINS`, and sets a strict CSP (no inline scripts), which is
  why the server-mode build needs `INLINE_RUNTIME_CHUNK=false`.
- The AI proxy requires a session in multi-user mode.
- There are no per-assessment permissions: every account sees the whole workspace (`MULTI_USER.md`).

## Decisions

- `better-sqlite3` is pinned to `^11` in `server/package.json` because it is the last major that runs on Node 18.
- The mode is a build-time choice so a local-only build can never upload data by accident.

## Where to look

- Sync or conflict bug: `src/storage/syncEngine.js`, `merge.js`, `twoClients.integration.test.js`.
- Record API or schema: `server/routes/records.js`, `server/db.js` (migrations are the `MIGRATIONS` array).
- Sign-in or session bug: `server/middlewares/auth.js`, `src/storage/authStore.js`, `src/components/AuthGate.js`.
- "Why is this store not syncing?": `src/storage/storeConfigs.js`.
