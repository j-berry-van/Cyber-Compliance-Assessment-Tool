import { create } from 'zustand';
import toast from 'react-hot-toast';
import { api, setUnauthorizedHandler } from './serverClient';
import { bootstrap, start, stop } from './syncEngine';
import { wireRemoteRehydration, rehydrateAll } from './rehydrateOnRemote';

const loadDirectory = async () => {
  const users = await api('GET', '/users');
  return new Map(users.map((u) => [u.id, { displayName: u.displayName, username: u.username, participantId: u.participantId ?? null }]));
};

let enteredBefore = false;

const enter = async (set, user) => {
  // The engine's outbox/conflicts are keyed per signed-in user.
  await bootstrap(user.id);
  wireRemoteRehydration();
  // After a session expiry (possibly a different user) the in-memory stores may hold stale data.
  if (enteredBefore) await rehydrateAll();
  enteredBefore = true;
  start(); // start() stops any previous timers/listeners first
  const directory = await loadDirectory().catch(() => new Map());
  set({ status: 'authenticated', user, directory, error: null });
};

let initPromise = null;

const useAuthStore = create((set) => ({
  status: 'unknown',
  user: null,
  directory: new Map(),
  error: null,

  init() {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      try {
        const { needsSetup } = await api('GET', '/auth/status');
        if (needsSetup) { set({ status: 'needsSetup' }); return; }
        try {
          const user = await api('GET', '/auth/me');
          await enter(set, user);
        } catch (e) {
          if (e.status === 401) set({ status: 'anonymous' });
          else throw e;
        }
      } catch (e) {
        set({ status: 'anonymous', error: 'Cannot reach the server. Check your connection and reload.' });
      } finally {
        initPromise = null;
      }
    })();
    return initPromise;
  },

  async login(username, password) {
    set({ error: null });
    try {
      await api('POST', '/auth/login', { username, password });
      const user = await api('GET', '/auth/me');
      await enter(set, user);
    } catch (e) {
      set({ error: e.status === 401 ? 'Invalid username or password.' : 'Could not sign in. Try again.' });
    }
  },

  async setup(username, displayName, password) {
    set({ error: null });
    try {
      await api('POST', '/auth/setup', { username, displayName, password });
      const user = await api('GET', '/auth/me');
      await enter(set, user);
    } catch (e) {
      set({ error: e.status === 400 ? (e.body?.error || 'Check the fields and try again.') : 'Could not create the account.' });
    }
  },

  async logout() {
    try {
      await api('POST', '/auth/logout', {});
    } catch {
      // Reloading now would let the still-valid cookie sign the user straight back in.
      const message = 'Could not sign out. Check your connection and try again.';
      set({ error: message });
      toast.error(message);
      return;
    }
    window.location.reload();
  }
}));

// Any 401 after sign-in (expired session, disabled account) returns to the login screen.
// The unsent outbox stays in localStorage and is replayed after the next sign-in.
setUnauthorizedHandler(() => {
  if (useAuthStore.getState().status === 'authenticated') {
    stop();
    useAuthStore.setState({ status: 'anonymous', user: null, error: 'Your session expired. Sign in again to continue.' });
  }
});

export default useAuthStore;
