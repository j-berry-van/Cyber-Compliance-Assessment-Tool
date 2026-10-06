# Self-hosting CSF Profile for a team (multi-user mode)

CSF Profile has two ways to run. This guide is for the second one.

| | Local / desktop mode (default) | Multi-user server mode |
|---|---|---|
| Where data lives | In each person's browser (localStorage). Nothing is uploaded. | In one SQLite file on **your own server**. |
| Accounts | None | Admin-created accounts, sign-in required |
| Sharing | Export / import files | Everyone sees the same workspace and each other's edits |
| How you get it | `npm start`, the Tauri desktop app, or the hosted demo | Build with `REACT_APP_SERVER_MODE=true`, run `server/` with `MULTIUSER=true` |

The mode is chosen **when the app is built**: a build made with `REACT_APP_SERVER_MODE=true` always expects the
multi-user server, and a normal build never talks to it. The two are not interchangeable at run time. For how a team
uses the result, see the [multi-user guide](MULTI_USER.md).

Nothing here sends data to anyone else. Your server holds your assessment data, including the organization profile
(crown jewels, security tooling), and every account on the server can see it. The only outbound traffic the server
makes on its own is the optional AI proxy, if you configure a Claude API key.

## Requirements

- Node.js 18 or newer on the machine that builds and runs it (the Docker image uses Node 18).
- A place to keep the data directory and back it up.
- A way to serve HTTPS (reverse proxy such as Caddy or nginx) if anyone reaches it over a network.

`better-sqlite3` is pinned to `^11` in `server/package.json` because it is the last major version that runs on
Node 18; newer majors need Node 22 or later. If you move to a newer Node, update that dependency in the same change
and re-run the server tests.

## 1. Build the client

From the repository root:

```bash
npm ci
REACT_APP_SERVER_MODE=true INLINE_RUNTIME_CHUNK=false npm run build
```

`INLINE_RUNTIME_CHUNK=false` is required: the server's Content-Security-Policy forbids inline scripts, so the
runtime chunk must be a separate file. The result is in `build/`.

## 2. Run the server

```bash
cd server
npm ci
MULTIUSER=true STATIC_DIR=../build DATA_DIR=/var/lib/csf COOKIE_SECURE=true PORT=4000 node index.js
```

The server serves the built app and the API from one port and creates `DATA_DIR/csf.db` on first start. Database
migrations run automatically at startup.

Open the address in a browser. The first visit shows **Create the admin account**: the first account created becomes
the administrator and adds everyone else (there is no self-signup). Do this before exposing the server to anyone you do
not trust, because whoever reaches an empty server first becomes its admin.

If you prefer a file, copy `server/env.example` to `server/.env` and edit it. The server reads `.env` from its working
directory, so start it from `server/`.

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `MULTIUSER` | unset | `true` turns on accounts, the database and the records API. Without it the server is only the AI proxy. |
| `PORT` | `4000` | Port to listen on. |
| `DATA_DIR` | `./data` | Directory for `csf.db` (created if missing). Needs read/write for the server user. |
| `STATIC_DIR` | unset | Directory of the built app (`../build`). When unset the server serves only the API. |
| `COOKIE_SECURE` | `false` | `true` marks the session cookie `Secure`. Set it whenever the site is served over HTTPS. |
| `TRUST_PROXY` | unset | `true` makes the server trust one proxy hop (`X-Forwarded-Proto`, `X-Forwarded-For`). Set it behind a reverse proxy: it makes the cookie `Secure` when the proxy reports https, and it makes login rate limiting count each client's own IP instead of the proxy's. |
| `ALLOWED_ORIGINS` | `http://localhost:3000,http://127.0.0.1:3000` | Comma-separated browser origins allowed to call the API cross-origin. Not needed when the app and API share one origin (the normal setup). |
| `REACT_APP_API_URL` | empty (same origin) | **Build-time.** Base URL the client uses for `/api`. Leave empty when the server serves the app. If you split them, keep both on the same site (the session cookie is `SameSite=Lax`) and list the app's origin in `ALLOWED_ORIGINS`. |
| `CLAUDE_API_KEY` | unset | Optional. Anthropic key used only by the server-side AI proxy; the browser never sees it. |
| `CLAUDE_MODEL` | `claude-sonnet-4-20250514` | Optional model override for the proxy. |
| `CLAUDE_TIMEOUT_MS` | `60000` | Optional upstream timeout for the proxy. |

In multi-user mode the AI proxy (`/api/ai/*`) requires a signed-in session, and is still rate limited per IP
(50 requests per 15 minutes). Without a key the proxy returns a mock response, as in local development.

## 3. HTTPS with a reverse proxy

Sessions are cookies, so serve the app over HTTPS anywhere beyond your own machine. The simplest setup is to let a
reverse proxy terminate TLS and forward to the server on localhost. With Caddy (it gets certificates itself and sends
`X-Forwarded-Proto`):

```
csf.example.com {
    reverse_proxy 127.0.0.1:4000
}
```

nginx equivalent (TLS configuration omitted):

```
location / {
    proxy_pass http://127.0.0.1:4000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 30m;   # the server accepts bodies up to 25 MB
}
```

Then start the server with `TRUST_PROXY=true` (or `COOKIE_SECURE=true`, which does not depend on the proxy headers).
Bind the Node server to localhost or a private network so people cannot bypass the proxy.

## Security behaviour you can rely on

- Passwords are hashed with Node's built-in scrypt (salted). Minimum length is 10 characters.
- Sessions are random tokens stored hashed in the database, valid for 14 days and extended while in use. The cookie
  is `HttpOnly`, `SameSite=Lax`, and `Secure` over HTTPS.
- Sign-in and first-run setup are rate limited to 20 attempts per 15 minutes per IP.
- State-changing API calls must be `application/json` (this plus `SameSite=Lax` is the CSRF guard).
- Disabling an account or resetting its password signs it out everywhere.

See [SECURITY.md](../SECURITY.md) for the wider threat model.

## 4. Docker

The repository root has a `Dockerfile` that builds the client in server mode and runs the server:

```bash
docker build -t csf-profile .
docker run -d --name csf -p 127.0.0.1:4000:4000 -v csf-data:/data -e TRUST_PROXY=true csf-profile
```

Data lives in the `/data` volume (`/data/csf.db`). Pass `COOKIE_SECURE=true` or `TRUST_PROXY=true` as above, and any
`CLAUDE_*` variables you want. The image uses Node 18 with `better-sqlite3` ^11.

## Backups and restore

Everything the server holds is in `DATA_DIR/csf.db` (SQLite, write-ahead logging). There is no built-in backup
schedule and the in-app "Export" features are personal copies, so **backups are your job**.

Take a consistent copy while the server runs:

```bash
sqlite3 /var/lib/csf/csf.db ".backup '/backups/csf-$(date +%F).db'"
```

Do not just `cp csf.db` while the server is running: with write-ahead logging, recent writes can sit in
`csf.db-wal`. If you copy files instead, stop the server first and copy the whole `DATA_DIR`.

Restore: stop the server, put the backup at `DATA_DIR/csf.db`, delete any `csf.db-wal` and `csf.db-shm` next to it,
and start the server again. Sessions are in the same file, so people will be signed in or out as of the backup.
Anything edited after the backup was taken is lost.

Keep the data directory readable only by the server's user (for example `chmod 700 /var/lib/csf`), and encrypt or
protect your backup copies: they contain every assessment, the organization profile and the password hashes.

## Forgotten admin password

Any admin can reset another account from the Accounts page. If **no** admin can sign in, reset a password directly in
the database. Run this from the `server/` directory on the host while the server keeps running (it uses the same hashing as the app,
sets a new password, re-enables the account and signs it out everywhere):

```bash
cd server
read -rs -p "New password (10+ chars): " CSF_NEW_PASSWORD; echo; export CSF_NEW_PASSWORD
DATA_DIR=/var/lib/csf CSF_USER=admin node --input-type=module -e "
import Database from 'better-sqlite3';
import path from 'node:path';
import { hashPassword } from './utils/passwords.js';
const user = process.env.CSF_USER;
const pw = process.env.CSF_NEW_PASSWORD;
if (!user || !pw || pw.length < 10) throw new Error('need CSF_USER and a password of at least 10 characters');
const db = new Database(path.join(process.env.DATA_DIR || './data', 'csf.db'));
const res = db.prepare('UPDATE users SET password_hash = ?, disabled = 0 WHERE username = ?').run(hashPassword(pw), user);
if (res.changes === 0) throw new Error('no such user: ' + user);
db.prepare('DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = ?)').run(user);
console.log('password reset for', user);
"
unset CSF_NEW_PASSWORD
```

Use the same `DATA_DIR` the server uses. In Docker, open a shell in the container with `docker exec -it csf bash`; the
image already has `better-sqlite3` and the server code in `/app/server` (the working directory), and `DATA_DIR` is
already `/data`, so drop the `DATA_DIR=...` prefix.

## Upgrading

1. Back up `csf.db` (see above).
2. Pull the new version, then rebuild the client (`REACT_APP_SERVER_MODE=true INLINE_RUNTIME_CHUNK=false npm run build`)
   and run `npm ci` in `server/`. With Docker, rebuild the image.
3. Restart the server. It applies database migrations itself on startup.
4. Reload open browser tabs so they pick up the new client.

Deploy the client and server from the same version. Going back to an older version after a newer one has migrated the
database is not supported; restore the backup instead.

## What stays per-browser

Server mode shares assessment data, not everything. These stay in each person's own browser and are never sent to the
server:

- Theme and other UI preferences, and the AI Assistant settings (provider choice and so on).
- Which assessment is currently selected, and which participant is the current "acting user".
- The cloud-AI consent checkbox for the organization profile.
- Backup-reminder timestamps and the one-time browser import flags (`csf-import-done`, `csf-import-declined`).
- The sync outbox (edits not yet delivered) and the last signed-in account marker (`csf-last-account`).

Everything else is on the server and shared: assessments, controls, evaluations, findings, artifacts, comments,
frameworks and requirements, metrics, the system inventory, the participant list, the audit log, and the
**organization profile**. The organization profile is the sensitive record (crown jewels, security tooling): in local
mode it never leaves the browser, but in server mode it is saved to your server and every account can read it. It is
still excluded from share exports.

## Known limitations

- There is no per-assessment access control: every active account can read and edit everything.
- Exports and the Settings full-database restore work from and write to the shared stores. A restore replaces the shared
  workspace for everyone, so treat it as an administrator action.
- Editing offline queues changes in the browser and delivers them when the server is reachable again (the header shows
  **Unsaved changes** until then); it is not a full offline mode for a fresh sign-in.
- One SQLite file on one server: this is for a team's shared workspace, not for horizontal scaling.
