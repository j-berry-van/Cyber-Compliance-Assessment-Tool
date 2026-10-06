# Multi-user server storage — design

Date: 2026-10-06
Status: implemented (amended after implementation; see "Deviations from the original design" at the end)

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

- React SPA. About 15 Zustand stores persist to `localStorage` via `persist(...)` (keys `csf-*-storage`; most use `quotaSafeLocalStorage`).
- `server/` is an Express app that only proxies AI calls. No database, no auth.
- `userStore` holds assessment participants (assignees), not login accounts.
- Docs (`PRIVATE_DATA.md`) promise data stays on the user's machine; this must be reworded to cover both modes.

## 1. Server, data model, API

**Stack.** `server/` grows into the API. SQLite via `better-sqlite3`, single file under a configurable data directory. In production the same server serves the built React app (one origin, one port).

**Tables**
- `users(id, username, display_name, password_hash, is_admin, created_at, disabled, participant_id)`; `participant_id` may be an integer or a string (participant ids are numbers or uuid strings)
- `sessions(id, user_id, expires_at)`; `id` is the SHA-256 of the cookie token, never the token itself
- `records(collection, id, data, version, rev, updated_by, updated_at, deleted)`, primary key `(collection, id)`; `rev` is a global, monotonically increasing change counter
- `meta(key, value)`: the current `rev` and a workspace id. The schema version is SQLite's `PRAGMA user_version`

**Records.** `data` is the JSON each store already produces. `version` is an integer incremented on every write. Deletes are soft so other clients learn of them on next sync. Every write also takes the next global `rev`, and `GET /records?since=<rev>` returns everything with a higher `rev` plus the new cursor (a first sync with `since=0` omits deleted records).

**API** (under `/api`; session required except login and first-run setup)
- `POST /auth/setup`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`
- `GET /records?since=<cursor>`: everything changed since the client's last sync
- `PUT /records/:collection/:id` with `{data, baseVersion}`: 200 with the new version, or 409 with the current server copy if `baseVersion` is stale. A `:state` record (see section 3) may be sent with `force: true`, which skips the version check (last write wins)
- `DELETE /records/:collection/:id` with the same `baseVersion` rule
- `POST /import`: one-time upload of a browser's data; only accepted against an empty workspace
- `GET /auth/status` (is first-run setup needed) and `POST /auth/password` (change own password)
- `GET /users` (any signed-in account, used to show editor names), admin only: `POST /users`, `PATCH /users/:id` (reset password, disable, link participant, last active admin protected)
- The AI proxy (`/api/ai`) requires a session in multi-user mode, and the global 50-requests-per-15-minutes limiter now applies only to `/api/ai`, where the AI routes' own `aiLimiter` (10 requests per 15 minutes per IP, shared by `/status` and `/claude`) is the tighter, effective limit. Without `MULTIUSER` the server remains an unauthenticated, localhost-style AI proxy

**Attribution.** The server stamps `updated_by` from the session; clients cannot forge it.

## 2. Auth and users

- Username and password (minimum 10 characters), hashed with Node's built-in `crypto.scrypt` with a per-password salt. No native hashing dependency; the only native dependency is `better-sqlite3`.
- Opaque random session ID in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` over HTTPS). 14-day sliding expiry.
- Login and first-run setup are rate-limited to 20 attempts per 15 minutes per IP (`loginLimiter` in `server/utils/rateLimiter.js`).
- CSRF: `SameSite` plus requiring a JSON content type on writes.
- Session tokens are random and stored hashed, so there is no session secret to configure. `COOKIE_SECURE=true`, or `TRUST_PROXY=true` behind a proxy that sets `X-Forwarded-Proto`, makes the cookie `Secure`.
- First run: no users exist, so the app shows "create admin account"; `POST /auth/setup` works only while `users` is empty.
- Admins manage accounts on a new Accounts page: create (username, display name, temporary password), reset password, disable, link a participant. Users can change their own password there. Resetting a password or disabling an account ends that account's sessions.
- No roles beyond `is_admin`, which only gates user management. No self-signup, no email, no reset email. SSO/OIDC can be added later by replacing only session creation.
- A signed-in account can optionally be linked to a `userStore` participant so "assigned to me" and attribution resolve to the right person. Unlinked accounts show their display name.
- "Who is working on an assessment" (v1): last editor and last-edit time per assessment, plus a "recently active" list derived from `updated_by` on its records. No live presence.
- The organization profile syncs to the server like other stores in multi-user mode (accepted: that data now lives on the team's own server and is visible to every account). Its `cloudConsent` flag stays per-browser.
- The "acting user" selector remains an honor system: a signed-in person can still pick another participant as the author of a comment or audit entry. The account identity (`updated_by`) is the server-stamped record. Linking an account selects its participant at sign-in; if a different account signs in on the same browser (tracked with `csf-last-account`), the acting user is cleared unless that account is linked.
- Local mode has no login and no account concept.

## 3. Storage adapter and sync

**Seam.** Each store keeps `persist(...)`; its `storage` option comes from `createStorage(storeName)`, which looks the store up in `STORE_CONFIGS` (`src/storage/storeConfigs.js`) and selects a backend:
- Local backend: existing `quotaSafeLocalStorage`, unchanged.
- Server backend: the new adapter.

Mode is chosen at **build time** by `REACT_APP_SERVER_MODE=true` (`isServerMode()`); there is no probing. A normal build, including the Tauri build, is always local.

**Store declaration.** `STORE_CONFIGS` declares, per store, which persisted fields are collections, e.g. `{ assessments: 'id', findings: 'id' }`. A collection key is a property name or a function returning a unique string: requirements use `${frameworkId}::${id}`, metrics use `${catalogSlug}::${id}`, controls are keyed by `controlId`. Everything else (settings, singletons such as the org profile, and the order of each collection's array) is saved as one record under `collection = "<store>:state"`, id `state`. `localFields` lists fields kept per-browser in localStorage even in server mode (`currentAssessmentId`, `currentUserId`, the org profile's `cloudConsent`). The `ui`, `ai` and legacy `csf` (`csf-data-storage`) stores are marked `local: true` and stay per-browser in every mode. Every persisted store must have an entry; `storeConfigs.test.js` checks it.

**Writing**
1. zustand calls `setItem(key, nextState)`.
2. The adapter deep-diffs against its last-known snapshot per collection, by id.
3. Added or changed records go out as `PUT` with `baseVersion`; removed records as `DELETE`. `:state` records are sent with `force: true`.
4. Writes are debounced (about 500 ms) and sent in order. `AutoSaveIndicator` shows Saved, Saving or Unsaved changes (plus an error line for rejected changes).

**Reading**
1. After login, the adapter fetches `GET /records` and hydrates the stores, replacing localStorage as the source.
2. While the tab is open it polls `GET /records?since=cursor` (the global `rev`) every 20 s and on window focus, merging remote changes and skipping any record the user is mid-edit on.

**Conflicts (409).** Only collection records raise conflicts. The adapter keeps the server copy aside and shows a dialog, "Someone else changed this record", with **Take theirs** or **Keep mine** (re-send against the new version). The record stays flagged as conflicted until resolved, so retries cannot silently overwrite a teammate. `:state` records are last-write-wins (`force`) with no conflict prompt. No field-level merge in v1.

**Failures.** If the server is unreachable, changes queue in an outbox that is persisted to localStorage per signed-in user (as are unresolved conflicts), so a refresh or a sign-out and sign-in does not lose it. Retry with backoff; the indicator shows "unsaved changes" until they land. Long-lived offline editing is not a goal.

**Risks to handle in the plan**
- High-frequency writers (typing in text fields) rely on the debounce.
- Stores with cross-store references need a defined load order so hydration does not race.

## 4. Migration, testing, rollout

**Importing existing data**
- Import is a **blocking step in `AuthGate`**, shown before the app mounts so seed loaders cannot fill the workspace first. It appears only on a sign-in to an **empty** workspace from a browser that holds local data and has not already imported or declined (per-browser flags `csf-import-done` and `csf-import-declined`). It reads the `csf-*` keys, re-uses each store's existing `migrate()` by writing the old schema version into the `:state` record and rehydrating, and posts to `POST /import`.
- The server refuses an import when any record exists. A non-empty workspace never offers it, so a second teammate's local data stays in their browser untouched.
- localStorage is never deleted or modified. A raw backup of the browser's data (not restorable through Settings) is offered first and must be taken or skipped before importing. Items with a missing or duplicate id cannot be synced and are listed as not synced.
- Encrypted export/import and private data packs keep working; packs merge through the stores and sync like any edit.

**Schema versions.** Store migrations still run client-side; each `:state` record carries the store's schema version. Server table migrations are a small numbered SQL list tracked with `PRAGMA user_version` and applied at startup. There is no client-version handshake.

**Testing**
- Server: Node's built-in test runner (`node --test`) and supertest against in-memory SQLite: auth, setup lock, `baseVersion` conflicts, soft deletes, `since` cursors, import-only-when-empty, user admin.
- Adapter: unit tests for diffing, debounce ordering, 409 handling, queue and retry, poll merging, using a fake server.
- Integration: two simulated clients editing different records and the same record.
- Existing store tests keep running against the local backend.
- In-app wording that depends on where data lives is gated on `isServerMode()` (first-visit note, backup reminder, quota toast, Settings storage, organization-profile and pack text) and tested in both modes. Server-mode first-visit data seeding is skipped when the workspace already has data.

**Rollout order**
1. Server foundation: SQLite, records API, auth and users.
2. Adapter plus one pilot store (`commentsStore`) end to end.
3. Remaining stores moved over; login and Users screens.
4. Import flow; attribution in audit log and comments; "who's working on this" indicator.
5. Docs and deployment: `Dockerfile`, `docs/SELF_HOSTING.md` (Caddy example, backup, password recovery), `docs/MULTI_USER.md`, and the "nothing is uploaded" statements reworded to cover both modes.

## Out of scope for v1

Live collaboration and presence, roles and permissions, SSO, field-level merge, multiple workspaces, password-reset email.

## Deviations from the original design

What was built differs from the draft above in these ways; the sections above have been updated to match.

- Password hashing is Node's built-in `crypto.scrypt`, not argon2id/bcrypt; minimum length 10.
- Mode is a build-time switch (`REACT_APP_SERVER_MODE=true`), not probing or `REACT_APP_API_URL`.
- Per-store sync config lives in `STORE_CONFIGS`; `localFields` keep per-browser fields (`currentAssessmentId`, `currentUserId`, org-profile `cloudConsent`) in localStorage, and the `ui`, `ai` and legacy `csf` stores are per-browser.
- Collection keys can be functions: requirements `${frameworkId}::${id}`, metrics `${catalogSlug}::${id}`; controls are keyed by `controlId`.
- `:state` records (non-collection fields and array order) are last-write-wins with `force` and no conflict prompt; only collection records raise 409 conflicts and the conflict dialog.
- The server adds a global `rev` cursor to `records`; the polling cursor is `rev`, and polling is every 20 s plus on focus.
- The outbox and unresolved conflicts are persisted per user in localStorage.
- `participantId` is an integer or a string (participant ids may be numbers or uuid strings).
- Import is a blocking `AuthGate` step with an empty-workspace-only rule (a non-empty workspace never offers it), a raw backup offered first, an unsyncable-items list, and per-browser done/declined flags. It re-uses stores' `migrate()` via the `:state` record.
- Seed loaders (requirements and assessments) are skipped in server mode when data already exists.
- The AI proxy requires a session in multi-user mode, and the global 50/15 min limiter now applies only to `/api/ai`; the AI routes' `aiLimiter` (10 per 15 minutes per IP, status checks included) is the effective limit there.
- Login and setup have their own limiter (20 per 15 minutes per IP).
- `TRUST_PROXY=true` makes Express trust one proxy hop so `Secure` cookies and per-client rate limiting work behind a TLS-terminating proxy.
- The organization profile syncs to the server in multi-user mode (accepted: it lives on the team's own server and is visible to every account); `cloudConsent` stays per-browser.
- The "acting user" selector remains an honor system; the server-side `updated_by` account is the attribution that cannot be forged. `csf-last-account` clears the acting user when a different account signs in on the same browser unless that account is linked.
- Account management is an Accounts page (not Settings → Users). There is no session secret (tokens are random and stored hashed), no `meta.schema_version` (SQLite `user_version` is used), and no client-version handshake.
- Backup and quota wording is gated on `isServerMode()`: in server mode the app says data is saved to the server and backups are the administrator's responsibility.
- `better-sqlite3` is pinned to `^11` because it must run on Node 18 (newer majors drop Node 18 support). The server tests use `node --test`, not Jest.
