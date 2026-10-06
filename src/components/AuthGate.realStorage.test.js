import React from 'react';
import { render, screen, act } from '@testing-library/react';

// Unlike AuthGate.test.js this does NOT mock createStorage: the stores persist through the real
// sync engine, as in production, so any write made at sign-in shows up as a PUT or a non-empty outbox.
jest.mock('../storage/serverClient', () => {
  class ApiError extends Error { constructor(s, b) { super(b?.error || 'x'); this.status = s; this.body = b; } }
  return { api: jest.fn(), ApiError, setUnauthorizedHandler: () => {} };
});

process.env.REACT_APP_SERVER_MODE = 'true';
const { api } = require('../storage/serverClient');
const engine = require('../storage/syncEngine');
const AuthGate = require('./AuthGate').default;
const useAuthStore = require('../storage/authStore').default;
const useUserStore = require('../stores/userStore').default;

afterAll(() => { delete process.env.REACT_APP_SERVER_MODE; engine.stop(); });

test('first sign-in on an empty server shows the import prompt and writes nothing before the decision', async () => {
  const writes = [];
  api.mockImplementation(async (m, p) => {
    if (m !== 'GET') { writes.push(`${m} ${p}`); return { version: 1 }; }
    if (p === '/auth/status') return { needsSetup: false };
    if (p === '/auth/me') return { id: 1, username: 'admin', displayName: 'Admin', isAdmin: true, participantId: null };
    if (p.startsWith('/records')) return { cursor: 0, records: [] };
    if (p === '/users') return [];
    throw new Error(`unexpected ${m} ${p}`);
  });
  localStorage.setItem('csf-comments-storage', JSON.stringify({ state: { comments: [{ id: 'c1', text: 'hi' }] }, version: 1 }));
  useAuthStore.setState({ status: 'unknown', user: null, error: null });

  render(<AuthGate><div>app</div></AuthGate>);
  expect(await screen.findByRole('region', { name: /import this browser/i })).toBeInTheDocument();
  await act(async () => { await new Promise((r) => setTimeout(r, 700)); });
  expect(writes).toEqual([]);
  expect(engine.isWorkspaceEmpty()).toBe(true);
  expect(useUserStore.getState().currentUserId).toBeNull();
});
