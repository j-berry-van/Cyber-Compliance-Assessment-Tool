# Multi-user guide

This guide is for people using a CSF Profile server that someone has set up for the team (administrators: see
[SELF_HOSTING.md](SELF_HOSTING.md)). Everyone signs in with their own account and works in one shared workspace.

Keep in mind what "shared" means: assessments, findings, comments, the participant list and the **organization
profile** are saved on your organization's server and every account can read and edit them. There are no per-assessment
permissions.

## First run (administrator)

1. Open the server's address. A fresh server shows **Create the admin account**.
2. Enter a username, a display name and a password of at least 10 characters. This first account is the administrator.
3. You are signed in. Open **Accounts** in the navigation to add everyone else.

Do this straight away: whoever reaches an empty server first becomes its administrator.

## Adding teammates (administrator)

There is no self-signup. In **Accounts**, under **Add an account**, enter a username, display name and a temporary
password (10+ characters) and choose **Add account**. Tell the person the temporary password through a channel you
trust; they can change it themselves under **Change my password**.

From the accounts table an administrator can also:

- **Reset password**: sets a new temporary password and signs that person out everywhere.
- **Disable / Enable**: a disabled account cannot sign in and is signed out immediately. The server refuses to disable
  the last active administrator.
- Set the **Linked participant** (next section).

## Linking an account to an assessment participant

Assessments have a list of participants (the people named in the assessment). Linking an account to a participant
connects the two: when that person signs in, the app selects that participant as the "acting user", so their comments
and audit entries carry that name. An administrator sets it in **Accounts**, in the **Linked participant** column.

What this does and does not do:

- The server records which **account** made each change (shown as "Last edited by" under an assessment, with who was
  active in the last 24 hours). That is the account identity and is set by the server, not by the browser.
- The participant shown on comments and audit entries comes from the acting-user selector in the navigation. It is
  still an honor system: a signed-in person can pick a different participant there. Do not treat comment or audit
  author names as proof of who typed something; the "Last edited by" account name is the more reliable signal.
- If a different account signs in on a browser that another account used, the acting user is cleared (unless the new
  account has a linked participant), so one person does not inherit another's identity by accident.

## Saving and the Saving / Unsaved indicator

Your edits are saved to the server automatically a moment after you make them, and the browser checks for other
people's changes about every 20 seconds and whenever you return to the tab. The indicator in the header shows:

- **Saved at 14:32**: everything you did has reached the server.
- **Saving...**: changes are on their way.
- **Unsaved changes (3) — retrying**: the server could not be reached. Your edits are kept in this browser and are
  sent automatically when the connection comes back. Keep working; do not clear this browser's site data meanwhile, or
  you would lose the unsent edits.
- A red message: something needs attention (for example a change the server rejected, or your session ended). If your
  session ended, sign in again; unsent edits are kept and sent after you sign in.

## "Someone else changed this record"

If you and a teammate change the **same item** (for example the same finding) at nearly the same time, the second save
cannot be applied silently. A dialog appears showing **Yours** and **Theirs**:

- **Take theirs**: discard your version and keep what your teammate saved.
- **Keep mine**: save your version over theirs.

If several are waiting, the dialog works through them one at a time. Open the item afterwards to check the result.

This prompt applies to individual records (an assessment, a finding, a control and so on). A few shared settings are
simpler: where two people change the same setting of a store, or reorder a list, the most recent save wins and no
prompt appears.

## Importing a browser's existing data

If you used the app in local mode before, your assessments are still in that browser. The first time you sign in to an
**empty** server workspace from a browser that holds local data, a full-screen step asks **Import this browser's data
into the server?**

- **Download a backup first** saves a raw copy of the browser's data. It is a safety copy only; it cannot be loaded
  through Settings → Import. You must download it or choose **Skip backup** before **Import into server** is enabled.
- **Import into server** copies the data into the workspace.
- **Not now** skips it, and this browser will not ask again.
- Items with no id, or with duplicate ids, cannot be synced. They are listed as a count and stay only in the browser.

Rules worth knowing: only an empty workspace accepts an import, so a workspace that already has data never offers
it, and a second browser can never overwrite what is there. Your browser's own data is never deleted or modified,
whichever you choose. Because the workspace becomes shared, everything you import is visible to every account.
The choice is remembered per browser (flags `csf-import-done` and `csf-import-declined`).

## What stays on your own browser

Theme and other UI preferences, AI Assistant settings, which assessment you currently have open, which participant is
your acting user, the cloud-AI consent checkbox for the organization profile, and any edits not yet sent. The
organization profile itself is on the server and visible to every account.

## Signing out and passwords

- **Sign out** is in the navigation, next to your name ("Signed in as ..."). Sessions last 14 days from
  your last activity.
- **Accounts → Change my password** needs your current password and a new one of 10+ characters.
- Forgot your password? Ask an administrator to use **Reset password**. If no administrator can sign in, the person
  running the server can reset one from the command line; see "Forgotten admin password" in
  [SELF_HOSTING.md](SELF_HOSTING.md).

## Backups

The workspace is saved on the server, so clearing your browser does not delete it. Backing up the server's database is
the administrator's responsibility. The export buttons in Settings still give you a personal copy of what you can see.
