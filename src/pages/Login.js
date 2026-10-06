import React, { useState } from 'react';
import useAuthStore from '../storage/authStore';

export default function Login({ mode }) {
  const login = useAuthStore((s) => s.login);
  const setup = useAuthStore((s) => s.setup);
  const error = useAuthStore((s) => s.error);
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
