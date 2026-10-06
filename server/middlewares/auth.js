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
