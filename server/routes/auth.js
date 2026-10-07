import { Router } from 'express';
import { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } from '../utils/passwords.js';
import { createSession, destroySession, requireAuth, COOKIE_NAME, hashToken } from '../middlewares/auth.js';
import { loginLimiter } from '../utils/rateLimiter.js';

// Verified against when the username is unknown so both paths cost exactly one scrypt operation.
const DUMMY_HASH = hashPassword('dummy-password');

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
    // Unknown user: run one verify against DUMMY_HASH (result discarded) so timing matches a known user's single verify.
    let ok = false;
    if (row) ok = verifyPassword(String(password || ''), row.password_hash);
    else verifyPassword(String(password || ''), DUMMY_HASH);
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
    const current = req.cookies?.[COOKIE_NAME];
    db.transaction(() => {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), req.user.id);
      // A changed password signs out every other device/browser, keeping this one.
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(req.user.id, current ? hashToken(current) : '');
    })();
    return res.json({ ok: true });
  });

  return r;
}
