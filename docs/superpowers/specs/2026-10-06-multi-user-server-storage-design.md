# Multi-user server storage — design

Date: 2026-10-06
Status: draft, awaiting review

## Goals

1. Assessment data lives on a server, so the same state is visible from any browser or device.
2. Multiple people sign in with individual accounts.
3. Everyone has the same permissions. Accounts exist so the app knows who is working on an assessment (attribution in the audit log and comments, link to existing participants).

## Decisions made

| Question | Decision |
|----------|----------|
| Deployment | Small team (about 2-20 users), self-hosted, one shared workspace. No tenant isolation. |
| Local mode | Kept. The same app runs local-only (today's behavior, no login, Tauri desktop included) or connected to a server. |
| Concurrency | Last write wins per record, with stale-write detection. No live sync, no websockets. |
| Architecture | Per-record document storage underneath the existing zustand stores (approach C). |

## Current state (context)

- React SPA. About 15 Zustand stores persist to `localStorage` via `persist(...)` (keys `csf-*-storage`; `assessmentsStore` uses `quotaSafeLocalStorage`).
- `server/` is an Express app that only proxies AI calls. No database, no auth.
- `userStore` holds assessment participants (assignees), not login accounts.
- Docs (`PRIVATE_DATA.md`) promise data stays on the user's machine; this must be reworded to cover both modes.

## 1. Server, data model, API

**Stack.** `server/` grows into the API. SQLite via `better-sqlite3`, single file under a configurable data directory. In production the same server serves the built React app (one origin, one port).

**Tables**
- `users(id, username, display_name, password_hash, is_admin, created_at, disabled)`
- `sessions(id, user_id, expires_at)`
- `records(collection, id, data, version, updated_by, updated_at, deleted)`, primary key `(collection, id)`
- `meta(key, value)`: schema version, workspace id

**Records.** `data` is the JSON each store already produces. `version` is an integer incremented on every write. Deletes are soft so other clients learn of them on next sync.

**API** (under `/api`; session required except login and first-run setup)
- `POST /auth/setup`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`
- `GET /records?since=<cursor>`: everything changed since the client's last sync
- `PUT /records/:collection/:id` with `{data, baseVersion}`: 200 with the new version, or 409 with the current server copy if `baseVersion` is stale
- `DELETE /records/:collection/:id` with the same `baseVersion` rule
- `POST /import`: one-time upload of a browser's data; only accepted against an empty workspace
- Admin only: `GET/POST /users`, `PATCH /users/:id` (reset password, disable)

**Attribution.** The server stamps `updated_by` from the session; clients cannot forge it.

## 2. Auth and users

- Username and password, hashed with argon2id (bcrypt fallback if the native build is a problem).
- Opaque random session ID in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` over HTTPS). 14-day sliding expiry.
- Login attempts rate-limited, reusing `server/utils/rateLimiter.js`.
- CSRF: `SameSite` plus requiring a JSON content type on writes.
- Session secret from an env var, or a generated file in the data directory.
- First run: no users exist, so the app shows "create admin account"; `POST /auth/setup` works only while `users` is empty.
- Admins manage accounts in a new Settings → Users screen: create (username, display name, temporary password), reset password, disable. Users can change their own password.
- No roles beyond `is_admin`, which only gates user management. No self-signup, no email, no reset email. SSO/OIDC can be added later by replacing only session creation.
- A signed-in account can optionally be linked to a `userStore` participant so "assigned to me" and attribution resolve to the right person. Unlinked accounts show their display name.
- "Who is working on an assessment" (v1): last editor and last-edit time per assessment, plus a "recently active" list derived from `updated_by` on its records. No live presence.
- Local mode has no login and no account concept.

## 3. Storage adapter and sync

**Seam.** Each store keeps `persist(...)`; its `storage` option comes from `createStorage(storeName, collectionsConfig)`, which selects a backend at startup:
- Local backend: existing `quotaSafeLocalStorage`, unchanged.
- Server backend: the new adapter.

Mode is chosen by `REACT_APP_API_URL` or by probing same-origin `/api`. The Tauri build always uses local.

**Store declaration.** Each store declares which persisted fields are collections, e.g. `{ assessments: 'id', findings: 'id' }`. Everything else (settings, singletons such as the org profile) is saved as one record under `collection = "<store>:state"`.

**Writing**
1. zustand calls `setItem(key, nextState)`.
2. The adapter deep-diffs against its last-known snapshot per collection, by id.
3. Added or changed records go out as `PUT` with `baseVersion`; removed records as `DELETE`.
4. Writes are debounced (about 500 ms) and sent in order. `AutoSaveIndicator` shows saved, saving or failed.

**Reading**
1. After login, the adapter fetches `GET /records` and hydrates the stores, replacing localStorage as the source.
2. While the tab is open it polls `GET /records?since=cursor` every 15-30 s and on window focus, merging remote changes and skipping any record the user is mid-edit on.

**Conflicts (409).** The adapter keeps the server copy aside and shows a toast with a "Review" action: **keep mine** (re-send against the new version) or **take theirs**. The record stays flagged as conflicted until resolved, so retries cannot silently overwrite a teammate. No field-level merge in v1.

**Failures.** If the server is unreachable, changes queue in memory and the queue is persisted to localStorage so a refresh does not lose it. Retry with backoff; the indicator shows "unsaved changes" until they land. Long-lived offline editing is not a goal.

**Risks to handle in the plan**
- High-frequency writers (typing in text fields) rely on the debounce.
- Stores with cross-store references need a defined load order so hydration does not race.

## 4. Migration, testing, rollout

**Importing existing data**
- On first login to an empty workspace, if the browser holds local data, offer "Import this browser's data into the server". It reads the `csf-*` keys, runs them through the stores' existing migrations, and posts to `POST /import`.
- Refused if the workspace already has records; the second teammate's local data stays in their browser with a notice.
- localStorage is never deleted automatically. A JSON backup is exported before import.
- Encrypted export/import and private data packs keep working; packs merge through the stores and sync like any edit.

**Schema versions.** Store migrations still run client-side. `meta.schema_version` is stored on the server; a client older than the stored data is told to refresh. Server table migrations are a small numbered SQL list.

**Testing**
- Server: Jest and supertest against in-memory SQLite: auth, setup lock, `baseVersion` conflicts, soft deletes, `since` cursors, import-only-when-empty, user admin.
- Adapter: unit tests for diffing, debounce ordering, 409 handling, queue and retry, poll merging, using a fake server.
- Integration: two simulated clients editing different records and the same record.
- Existing store tests keep running against the local backend.

**Rollout order**
1. Server foundation: SQLite, records API, auth and users.
2. Adapter plus one pilot store (`commentsStore`) end to end.
3. Remaining stores moved over; login and Users screens.
4. Import flow; attribution in audit log and comments; "who's working on this" indicator.
5. Docs and deployment: Dockerfile or systemd example, backup guidance, reword the "nothing is uploaded" statements to cover both modes.

## Out of scope for v1

Live collaboration and presence, roles and permissions, SSO, field-level merge, multiple workspaces, password-reset email.
