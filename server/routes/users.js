import { Router } from 'express';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../utils/passwords.js';
import { requireAuth, requireAdmin } from '../middlewares/auth.js';

const shape = (u) => ({
  id: u.id, username: u.username, displayName: u.display_name, isAdmin: !!u.is_admin,
  disabled: !!u.disabled, participantId: u.participant_id ?? null
});

const trimmed = (v) => (typeof v === 'string' ? v.trim() : '');
const validParticipantId = (v) =>
  v === null || Number.isInteger(v) || (typeof v === 'string' && v.trim().length > 0 && v.length <= 100);

export default function userRoutes(db) {
  const r = Router();
  r.use(requireAuth);

  r.get('/', (req, res) => {
    res.json(db.prepare('SELECT * FROM users ORDER BY display_name COLLATE NOCASE').all().map(shape));
  });

  r.post('/', requireAdmin, (req, res) => {
    const { password, isAdmin = false, participantId = null } = req.body || {};
    const username = trimmed(req.body?.username);
    const displayName = trimmed(req.body?.displayName);
    if (!username || !displayName || typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `username, displayName and a password of at least ${MIN_PASSWORD_LENGTH} characters are required` });
    }
    if (!validParticipantId(participantId)) {
      return res.status(400).json({ error: 'participantId must be an integer, a non-empty string (max 100 characters) or null' });
    }
    if (typeof isAdmin !== 'boolean') {
      return res.status(400).json({ error: 'isAdmin must be a boolean' });
    }
    try {
      const info = db.prepare(
        `INSERT INTO users(username, display_name, password_hash, is_admin, participant_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(username, displayName, hashPassword(password), isAdmin ? 1 : 0, participantId, new Date().toISOString());
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
    const { password, disabled, isAdmin, participantId } = req.body || {};
    const displayName = req.body?.displayName !== undefined ? trimmed(req.body.displayName) : undefined;

    if (displayName !== undefined && !displayName) {
      return res.status(400).json({ error: 'displayName must not be blank' });
    }
    if (password !== undefined && (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH)) {
      return res.status(400).json({ error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }
    if (participantId !== undefined && !validParticipantId(participantId)) {
      return res.status(400).json({ error: 'participantId must be an integer, a non-empty string (max 100 characters) or null' });
    }

    for (const [k, v] of [['isAdmin', isAdmin], ['disabled', disabled]]) {
      if (v !== undefined && typeof v !== 'boolean') {
        return res.status(400).json({ error: `${k} must be a boolean` });
      }
    }

    const nextAdmin = isAdmin !== undefined ? isAdmin : !!row.is_admin;
    const nextDisabled = disabled !== undefined ? disabled : !!row.disabled;
    const willBeActiveAdmin = nextAdmin && !nextDisabled;
    if (row.is_admin && !row.disabled && !willBeActiveAdmin) {
      const others = db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND disabled = 0 AND id != ?').get(id).n;
      if (others === 0) return res.status(409).json({ error: 'last-admin' });
    }

    db.prepare(
      `UPDATE users SET display_name = ?, password_hash = ?, disabled = ?, is_admin = ?, participant_id = ? WHERE id = ?`
    ).run(
      displayName !== undefined ? displayName : row.display_name,
      password !== undefined ? hashPassword(password) : row.password_hash,
      nextDisabled ? 1 : 0,
      nextAdmin ? 1 : 0,
      participantId !== undefined ? participantId : row.participant_id,
      id
    );
    if (disabled || password !== undefined) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    return res.json(shape(db.prepare('SELECT * FROM users WHERE id = ?').get(id)));
  });

  return r;
}
