import { createStorage, isServerMode } from './createStorage';
import { STORE_CONFIGS } from './storeConfigs';

afterEach(() => { delete process.env.REACT_APP_SERVER_MODE; localStorage.clear(); delete STORE_CONFIGS['local-store']; });

test('local mode round-trips through localStorage exactly like today', async () => {
  expect(isServerMode()).toBe(false);
  const storage = createStorage('csf-comments-storage');
  storage.setItem('csf-comments-storage', { state: { comments: [1] }, version: 1 });
  expect(JSON.parse(localStorage.getItem('csf-comments-storage'))).toEqual({ state: { comments: [1] }, version: 1 });
  expect(storage.getItem('csf-comments-storage')).toEqual({ state: { comments: [1] }, version: 1 });
});

test('server mode is switched by REACT_APP_SERVER_MODE', () => {
  process.env.REACT_APP_SERVER_MODE = 'true';
  expect(isServerMode()).toBe(true);
});

test('server mode falls back to localStorage for stores with no sync config', () => {
  process.env.REACT_APP_SERVER_MODE = 'true';
  const storage = createStorage('csf-ui-storage-not-configured');
  storage.setItem('k', { state: { a: 1 }, version: 0 });
  expect(localStorage.getItem('k')).toBeTruthy();
});

test('server mode uses localStorage for stores configured local: true', () => {
  process.env.REACT_APP_SERVER_MODE = 'true';
  STORE_CONFIGS['local-store'] = { local: true };
  const storage = createStorage('local-store');
  storage.setItem('k2', { state: { a: 1 }, version: 0 });
  expect(localStorage.getItem('k2')).toBeTruthy();
});
