import { collectLocalRecords, hasLocalData, importLocalData, buildLocalBackup, IMPORT_DONE_KEY } from './importLocalData';
import { api } from './serverClient';
import { bootstrap, clearOutbox } from './syncEngine';
import { rehydrateAll } from './rehydrateOnRemote';

jest.mock('./serverClient', () => ({ api: jest.fn(), ApiError: class extends Error {}, setUnauthorizedHandler: jest.fn() }));
jest.mock('./syncEngine', () => ({ bootstrap: jest.fn().mockResolvedValue(undefined), clearOutbox: jest.fn() }));
jest.mock('./rehydrateOnRemote', () => ({ rehydrateAll: jest.fn().mockResolvedValue(undefined) }));

beforeEach(() => { localStorage.clear(); api.mockReset(); bootstrap.mockClear(); clearOutbox.mockClear(); rehydrateAll.mockClear(); });

const put = (k, state, version = 1) => localStorage.setItem(k, JSON.stringify({ state, version }));
const seed = () => {
  put('csf-comments-storage', { comments: [{ id: 'c1', text: 'hi' }] });
  put('csf-ui-storage', { darkMode: true }, 0); // per-browser: never imported
};

test('no local data means nothing to import', () => {
  expect(hasLocalData()).toBe(false);
});

test('a store key holding only empty collections is not data', () => {
  put('csf-comments-storage', { comments: [] });
  expect(hasLocalData()).toBe(false);
});

test('one comment counts as data', () => {
  put('csf-comments-storage', { comments: [{ id: 'c1' }] });
  expect(hasLocalData()).toBe(true);
});

test('a populated org profile counts as data', () => {
  put('csf-org-profile-storage', { profile: { name: 'Acme' }, cloudConsent: true });
  expect(hasLocalData()).toBe(true);
});

test('per-browser-only stores do not count as data', () => {
  put('csf-ui-storage', { darkMode: true }, 0);
  expect(hasLocalData()).toBe(false);
});

test('collects records for synced stores only, keeping the old schema version', () => {
  seed();
  expect(hasLocalData()).toBe(true);
  const { records } = collectLocalRecords();
  const state = records.find((r) => r.collection === 'csf-comments-storage:state');
  expect(state.data.version).toBe(1);
  expect(records.some((r) => r.collection === 'csf-comments-storage.comments' && r.id === 'c1')).toBe(true);
  expect(records.some((r) => r.collection.startsWith('csf-ui-storage'))).toBe(false);
});

test('corrupt local JSON is skipped, not fatal', () => {
  localStorage.setItem('csf-comments-storage', '{not json');
  expect(collectLocalRecords().records).toEqual([]);
});

test('local backup holds the raw synced keys only', () => {
  seed();
  const b = buildLocalBackup();
  expect(Object.keys(b.keys)).toEqual(['csf-comments-storage']);
  expect(b.keys['csf-comments-storage']).toBe(localStorage.getItem('csf-comments-storage'));
});

test('importLocalData posts to /import, re-bootstraps for the user, rehydrates, and leaves localStorage untouched', async () => {
  seed();
  const before = localStorage.getItem('csf-comments-storage');
  api.mockResolvedValue({ imported: 2 });
  const res = await importLocalData({ userId: 'u7' });
  expect(api).toHaveBeenCalledWith('POST', '/import', expect.objectContaining({ records: expect.any(Array) }));
  expect(res.imported).toBe(2);
  expect(bootstrap).toHaveBeenCalledWith('u7');
  expect(rehydrateAll).toHaveBeenCalled();
  expect(localStorage.getItem('csf-comments-storage')).toBe(before);
});

test('bootstrap defaults to anonymous without a user id', async () => {
  seed();
  api.mockResolvedValue({ imported: 1 });
  await importLocalData();
  expect(bootstrap).toHaveBeenCalledWith('anonymous');
});

test('a refused import (workspace not empty) rejects, keeps local data, and does not re-bootstrap', async () => {
  seed();
  const err = new Error('conflict'); err.status = 409; err.body = { error: 'workspace-not-empty' };
  api.mockRejectedValue(err);
  await expect(importLocalData({ userId: 'u7' })).rejects.toMatchObject({ status: 409 });
  expect(localStorage.getItem('csf-comments-storage')).toBeTruthy();
  expect(bootstrap).not.toHaveBeenCalled();
  expect(clearOutbox).not.toHaveBeenCalled();
  expect(rehydrateAll).not.toHaveBeenCalled();
});

test('items without an id are reported as problems and left out of the upload', async () => {
  put('csf-comments-storage', { comments: [{ id: 'c1' }, { text: 'no id' }, { id: 'c1' }] });
  const { records, problems } = collectLocalRecords();
  expect(problems).toEqual([
    { store: 'csf-comments-storage', field: 'comments', index: 1, id: null },
    { store: 'csf-comments-storage', field: 'comments', index: 2, id: 'c1' }
  ]);
  expect(records.filter((r) => r.collection === 'csf-comments-storage.comments')).toHaveLength(1);
  api.mockResolvedValue({ imported: 2 });
  await importLocalData();
  const sent = api.mock.calls[0][2].records.filter((r) => r.collection === 'csf-comments-storage.comments');
  expect(sent).toHaveLength(1);
});

test('a successful POST sets the done flag', async () => {
  seed();
  api.mockResolvedValue({ imported: 2 });
  await importLocalData();
  expect(localStorage.getItem(IMPORT_DONE_KEY)).toBe('1');
});

test('a failed POST does not set the done flag', async () => {
  seed();
  api.mockRejectedValue(new Error('down'));
  await expect(importLocalData()).rejects.toThrow('down');
  expect(localStorage.getItem(IMPORT_DONE_KEY)).toBeNull();
});

test('a refresh failure after a successful POST is reported as refreshFailed with the result, not as a plain error', async () => {
  seed();
  api.mockResolvedValue({ imported: 2 });
  bootstrap.mockRejectedValueOnce(new Error('net'));
  await expect(importLocalData()).rejects.toMatchObject({ refreshFailed: true, result: { imported: 2 } });
  expect(localStorage.getItem(IMPORT_DONE_KEY)).toBe('1');
});
