import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AuthGate from './AuthGate';
import { api } from '../storage/serverClient';
import * as engine from '../storage/syncEngine';
import useAuthStore from '../storage/authStore';

jest.mock('../storage/serverClient', () => {
  class ApiError extends Error { constructor(s, b) { super(b?.error || 'x'); this.status = s; this.body = b; } }
  return { api: jest.fn(), ApiError, setUnauthorizedHandler: (fn) => { global.__unauthorized = fn; } };
});

const err401 = () => { const e = new Error('401'); e.status = 401; return e; };

beforeEach(() => {
  api.mockReset();
  engine.reset();
  localStorage.clear();
  useAuthStore.setState({ status: 'unknown', user: null, error: null, directory: new Map() });
  process.env.REACT_APP_SERVER_MODE = 'true';
});
afterEach(() => { delete process.env.REACT_APP_SERVER_MODE; engine.stop(); });

test('local mode renders children with no auth calls', () => {
  delete process.env.REACT_APP_SERVER_MODE;
  render(<AuthGate><div>app</div></AuthGate>);
  expect(screen.getByText('app')).toBeInTheDocument();
  expect(api).not.toHaveBeenCalled();
});

test('first run shows the create-admin screen', async () => {
  api.mockImplementation(async (m, p) => {
    if (p === '/auth/status') return { needsSetup: true };
    throw new Error(`unexpected ${m} ${p}`);
  });
  render(<AuthGate><div>app</div></AuthGate>);
  expect(await screen.findByRole('heading', { name: /create the admin account/i })).toBeInTheDocument();
});

const signedInApi = (state) => async (m, p) => {
  if (p === '/auth/status') return { needsSetup: false };
  if (p === '/auth/me') { if (!state.signedIn) throw err401(); return { id: 1, username: 'admin', displayName: 'Admin', isAdmin: true, participantId: null }; }
  if (p === '/auth/login') { state.signedIn = true; return { ok: true }; }
  if (p.startsWith('/records')) return { cursor: 0, records: [] };
  if (p === '/users') return [{ id: 1, username: 'admin', displayName: 'Admin' }];
  throw new Error(`unexpected ${m} ${p}`);
};

const signIn = async () => {
  await userEvent.type(await screen.findByLabelText(/username/i), 'admin');
  await userEvent.type(screen.getByLabelText(/password/i), 'correct horse battery');
  await act(async () => { userEvent.click(screen.getByRole('button', { name: /sign in/i })); });
};

test('signing in loads the workspace and then shows the app', async () => {
  api.mockImplementation(signedInApi({ signedIn: false }));
  render(<AuthGate><div>app</div></AuthGate>);
  await signIn();
  expect(await screen.findByText('app')).toBeInTheDocument();
  await waitFor(() => expect(useAuthStore.getState().status).toBe('authenticated'));
});

test('a wrong password shows an error and stays on the login screen', async () => {
  api.mockImplementation(async (m, p) => {
    if (p === '/auth/status') return { needsSetup: false };
    if (p === '/auth/me') throw err401();
    if (p === '/auth/login') throw err401();
    throw new Error(`unexpected ${m} ${p}`);
  });
  render(<AuthGate><div>app</div></AuthGate>);
  await signIn();
  expect(await screen.findByRole('alert')).toHaveTextContent(/invalid username or password/i);
  expect(screen.queryByText('app')).not.toBeInTheDocument();
});

test('a 401 during an authenticated session returns to the login screen', async () => {
  api.mockImplementation(signedInApi({ signedIn: true }));
  render(<AuthGate><div>app</div></AuthGate>);
  expect(await screen.findByText('app')).toBeInTheDocument();
  act(() => { global.__unauthorized(); });
  expect(await screen.findByRole('heading', { name: /sign in/i })).toBeInTheDocument();
  expect(screen.queryByText('app')).not.toBeInTheDocument();
  expect(useAuthStore.getState().status).toBe('anonymous');
});

test('an unsent outbox survives a 401 and is replayed after the next login', async () => {
  const state = { signedIn: true };
  const puts = [];
  const base = signedInApi(state);
  api.mockImplementation(async (m, p, b) => {
    if (m === 'PUT') { puts.push(p); return { version: 1 }; }
    return base(m, p, b);
  });
  localStorage.setItem('csf-sync-outbox:1', JSON.stringify([{ collection: 'commentsStore.comments', id: 'c1', op: 'put', data: { a: 1 }, baseVersion: 0 }]));
  render(<AuthGate><div>app</div></AuthGate>);
  expect(await screen.findByText('app')).toBeInTheDocument();
  await waitFor(() => expect(puts).toHaveLength(1)); // replayed on first bootstrap too
  // session expires with a new unsent change
  act(() => { engine.enqueue({ puts: [{ collection: 'commentsStore.comments', id: 'c2', data: { b: 2 } }] }); });
  state.signedIn = false;
  act(() => { global.__unauthorized(); });
  await screen.findByRole('heading', { name: /sign in/i });
  expect(JSON.parse(localStorage.getItem('csf-sync-outbox:1')).map((o) => o.id)).toContain('c2');
  puts.length = 0;
  await signIn();
  expect(await screen.findByText('app')).toBeInTheDocument();
  await waitFor(() => expect(puts.some((p) => p.endsWith('/c2'))).toBe(true));
});

test('React StrictMode double effects only call init once', async () => {
  api.mockImplementation(async (m, p) => {
    if (p === '/auth/status') return { needsSetup: true };
    throw new Error('unexpected');
  });
  render(<React.StrictMode><AuthGate><div>app</div></AuthGate></React.StrictMode>);
  await screen.findByRole('heading', { name: /create the admin account/i });
  expect(api.mock.calls.filter(([, p]) => p === '/auth/status')).toHaveLength(1);
});

describe('blocking import step', () => {
  const putSpy = [];
  const seedLocal = () => localStorage.setItem('csf-comments-storage', JSON.stringify({ state: { comments: [{ id: 'c1', text: 'hi' }] }, version: 1 }));
  const setup = (records = []) => {
    putSpy.length = 0;
    const base = signedInApi({ signedIn: true });
    api.mockImplementation(async (m, p, b) => {
      if (m === 'PUT') { putSpy.push(p); return { version: 1 }; }
      if (p.startsWith('/records')) return { cursor: 0, records };
      return base(m, p, b);
    });
  };
  const Child = () => { React.useEffect(() => { api('PUT', '/records/seed/x', {}); }, []); return <div>app</div>; };

  test('empty workspace + local data: prompt shown, children not mounted, no PUT issued; skip mounts children', async () => {
    seedLocal();
    setup();
    render(<AuthGate><Child /></AuthGate>);
    expect(await screen.findByRole('region', { name: /import this browser/i })).toBeInTheDocument();
    expect(screen.queryByText('app')).not.toBeInTheDocument();
    await act(async () => { await new Promise((r) => setTimeout(r, 700)); });
    expect(putSpy).toHaveLength(0);
    userEvent.click(screen.getByRole('button', { name: /not now/i }));
    expect(await screen.findByText('app')).toBeInTheDocument();
    expect(localStorage.getItem('csf-import-declined')).toBe('1');
    expect(localStorage.getItem('csf-comments-storage')).toBeTruthy();
  });

  test('non-empty workspace + local data: children mount directly', async () => {
    seedLocal();
    setup([{ collection: 'x.items', id: '1', data: {}, version: 1, deleted: false }]);
    render(<AuthGate><div>app</div></AuthGate>);
    expect(await screen.findByText('app')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /import this browser/i })).not.toBeInTheDocument();
  });

  test('empty workspace + no local data: children mount directly', async () => {
    setup();
    render(<AuthGate><div>app</div></AuthGate>);
    expect(await screen.findByText('app')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /import this browser/i })).not.toBeInTheDocument();
  });

  test.each(['csf-import-done', 'csf-import-declined'])('flag %s: children mount directly', async (flag) => {
    seedLocal();
    localStorage.setItem(flag, '1');
    setup();
    render(<AuthGate><div>app</div></AuthGate>);
    expect(await screen.findByText('app')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /import this browser/i })).not.toBeInTheDocument();
  });
});
