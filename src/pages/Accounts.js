import React, { useEffect, useState, useCallback, useRef } from 'react';
import toast from 'react-hot-toast';
import { api } from '../storage/serverClient';
import useAuthStore from '../storage/authStore';
import useUserStore from '../stores/userStore';

const input = 'mt-1 w-full border rounded px-2 py-1 dark:bg-gray-700';
const MIN_PASSWORD = 10;

function ChangePassword() {
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/auth/password', { currentPassword, newPassword });
      toast.success('Password changed');
      setCurrent(''); setNew('');
    } catch (err) {
      toast.error(err?.status === 403
        ? 'Current password is incorrect.'
        : 'Could not change the password.');
    }
  };
  return (
    <form onSubmit={submit} className="space-y-2 max-w-sm">
      <h2 className="font-semibold">Change my password</h2>
      <label className="block text-sm">Current password
        <input type="password" className={input} value={currentPassword} onChange={(e) => setCurrent(e.target.value)} required />
      </label>
      <label className="block text-sm">New password (10+ characters)
        <input type="password" className={input} value={newPassword} onChange={(e) => setNew(e.target.value)} required minLength={MIN_PASSWORD} />
      </label>
      <button className="px-3 py-1 bg-blue-600 text-white rounded">Change my password</button>
    </form>
  );
}

export default function Accounts() {
  const me = useAuthStore((s) => s.user);
  const participants = useUserStore((s) => s.users) || [];
  const [users, setUsers] = useState([]);
  const [loadError, setLoadError] = useState(false);
  const [form, setForm] = useState({ username: '', displayName: '', password: '' });
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const isAdmin = Boolean(me?.isAdmin);
  const load = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const list = await api('GET', '/users');
      if (!mounted.current) return;
      setUsers(Array.isArray(list) ? list : []);
      setLoadError(false);
    } catch {
      if (mounted.current) setLoadError(true);
    }
  }, [isAdmin]);
  useEffect(() => { load(); }, [load]);

  // Send the participant's original id (number or uuid string) unchanged.
  const participantIdFor = (value) => {
    if (value === '') return null;
    const p = participants.find((x) => String(x.id) === value);
    return p ? p.id : null;
  };

  const patch = async (id, body) => {
    try { await api('PATCH', `/users/${id}`, body); await load(); }
    catch (e) { toast.error(e?.body?.error === 'last-admin' ? 'There must be at least one active administrator.' : 'Update failed.'); }
  };
  const create = async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/users', form);
      if (mounted.current) setForm({ username: '', displayName: '', password: '' });
      await load();
    } catch (err) { toast.error(err?.body?.error === 'username-taken' ? 'That username is taken.' : 'Could not add the account.'); }
  };
  const reset = (id) => {
    const password = window.prompt('New temporary password (10+ characters):');
    if (!password) return;
    if (password.length < MIN_PASSWORD) {
      toast.error('Password must be at least 10 characters.');
      return;
    }
    patch(id, { password });
  };

  return (
    <div className="p-4 space-y-8">
      <h1 className="text-xl font-semibold">Accounts</h1>
      {isAdmin && (
        <>
          {loadError && (
            <div role="alert" className="text-sm text-red-700 dark:text-red-400">
              Could not load accounts.{' '}
              <button type="button" className="underline" onClick={load}>Retry</button>
            </div>
          )}
          <table className="w-full text-sm">
            <thead><tr className="text-left"><th>Username</th><th>Name</th><th>Linked participant</th><th>Status</th><th /></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-t">
                  <td>{u.username}</td>
                  <td>{u.displayName}{u.isAdmin ? ' (admin)' : ''}</td>
                  <td>
                    <select aria-label={`Participant for ${u.username}`} value={String(u.participantId ?? '')} onChange={(e) => patch(u.id, { participantId: participantIdFor(e.target.value) })} className="border rounded dark:bg-gray-700">
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
            <label className="block text-sm">Temporary password (10+ characters)<input type="password" className={input} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required minLength={MIN_PASSWORD} /></label>
            <button className="px-3 py-1 bg-blue-600 text-white rounded">Add account</button>
          </form>
        </>
      )}
      <ChangePassword />
    </div>
  );
}
