import * as engine from './syncEngine';
import { api, ApiError } from './serverClient';
import { recordKey } from './diff';

jest.mock('./serverClient', () => {
  class ApiError extends Error {
    constructor(status, body) { super(body?.error || `HTTP ${status}`); this.status = status; this.body = body; }
  }
  return { api: jest.fn(), ApiError, setUnauthorizedHandler: jest.fn() };
});

const rec = (collection, id, data, version = 1) => ({ collection, id, data, version, deleted: false, updatedBy: 1, updatedAt: 't' });

const advance = async (ms) => { jest.advanceTimersByTime(ms); for (let i = 0; i < 30; i += 1) await Promise.resolve(); };

beforeEach(() => {
  jest.useFakeTimers('modern');
  localStorage.clear();
  api.mockReset();
  engine.reset();
  engine.configureEngine({ debounceMs: 500, pollMs: 20000 });
});
afterEach(() => { engine.stop(); jest.useRealTimers(); });

const boot = async (records = [], cursor = 5) => {
  api.mockResolvedValueOnce({ cursor, records });
  await engine.bootstrap();
};

test('bootstrap loads the full snapshot and resolves whenReady', async () => {
  await boot([rec('c', 'a', { n: 1 })]);
  await engine.whenReady();
  expect(engine.readCollection('c').get('a')).toEqual({ n: 1 });
});

test('writes are debounced and sent with the cached baseVersion', async () => {
  await boot([rec('c', 'a', { n: 1 }, 4)]);
  api.mockResolvedValue({ version: 5, rev: 9 });
  engine.enqueue({ puts: [{ collection: 'c', id: 'a', data: { n: 2 } }], deletes: [] });
  engine.enqueue({ puts: [{ collection: 'c', id: 'a', data: { n: 3 } }], deletes: [] });
  expect(api).toHaveBeenCalledTimes(1); // only the bootstrap so far
  await advance(500);
  const call = api.mock.calls[1];
  expect(call[0]).toBe('PUT');
  expect(call[1]).toBe('/records/c/a');
  expect(call[2]).toEqual({ data: { n: 3 }, baseVersion: 4, force: false });
  expect(engine.useSyncStatus.getState().pending).toBe(0);
});

test('unsent edits overlay the cache for readers', async () => {
  await boot([rec('c', 'a', { n: 1 })]);
  engine.enqueue({ puts: [{ collection: 'c', id: 'a', data: { n: 9 } }, { collection: 'c', id: 'b', data: { n: 1 } }], deletes: [] });
  expect(engine.readCollection('c').get('a')).toEqual({ n: 9 });
  expect(engine.readCollection('c').has('b')).toBe(true);
  engine.enqueue({ puts: [], deletes: [{ collection: 'c', id: 'a' }] });
  expect(engine.readCollection('c').has('a')).toBe(false);
});

test('ids are URL-encoded', async () => {
  await boot();
  api.mockResolvedValue({ version: 1, rev: 1 });
  engine.enqueue({ puts: [{ collection: 'c', id: 'GV.SC-04/x ?#', data: 1 }], deletes: [] });
  await advance(500);
  expect(api.mock.calls[1][1]).toBe('/records/c/GV.SC-04%2Fx%20%3F%23');
});

test('a 409 becomes a conflict, keeps my copy on screen, and does not retry', async () => {
  await boot([rec('c', 'a', { n: 1 }, 1)]);
  api.mockRejectedValueOnce(new ApiError(409, { error: 'conflict', current: { data: { n: 'theirs' }, version: 2, deleted: false } }));
  engine.enqueue({ puts: [{ collection: 'c', id: 'a', data: { n: 'mine' } }], deletes: [] });
  await advance(500);
  const { conflicts } = engine.useSyncStatus.getState();
  expect(conflicts).toHaveLength(1);
  expect(conflicts[0].mine).toEqual({ n: 'mine' });
  expect(conflicts[0].theirs).toEqual({ n: 'theirs' });
  expect(engine.readCollection('c').get('a')).toEqual({ n: 'mine' });
  await advance(5000);
  expect(api).toHaveBeenCalledTimes(2); // bootstrap + one failed PUT
});

test('keep mine resends against the new version; take theirs drops mine', async () => {
  await boot([rec('c', 'a', { n: 1 }, 1)]);
  api.mockRejectedValueOnce(new ApiError(409, { error: 'conflict', current: { data: { n: 'theirs' }, version: 2, deleted: false } }));
  engine.enqueue({ puts: [{ collection: 'c', id: 'a', data: { n: 'mine' } }], deletes: [] });
  await advance(500);
  const key = engine.useSyncStatus.getState().conflicts[0].key;
  api.mockResolvedValueOnce({ version: 3, rev: 12 });
  engine.resolveConflict(key, 'mine');
  await advance(500);
  expect(api.mock.calls[2][2]).toEqual({ data: { n: 'mine' }, baseVersion: 2, force: false });
  expect(engine.useSyncStatus.getState().conflicts).toHaveLength(0);

  // take theirs on a fresh conflict
  api.mockRejectedValueOnce(new ApiError(409, { error: 'conflict', current: { data: { n: 'again' }, version: 4, deleted: false } }));
  engine.enqueue({ puts: [{ collection: 'c', id: 'a', data: { n: 'mine2' } }], deletes: [] });
  await advance(500);
  const heard = jest.fn();
  engine.onRemoteChange(heard);
  engine.resolveConflict(engine.useSyncStatus.getState().conflicts[0].key, 'theirs');
  expect(engine.readCollection('c').get('a')).toEqual({ n: 'again' });
  expect(heard).toHaveBeenCalled();
});

test(':state records are force-written', async () => {
  await boot();
  api.mockResolvedValue({ version: 1, rev: 1 });
  engine.enqueue({ puts: [{ collection: 's:state', id: 'state', data: { version: 1 } }], deletes: [] });
  await advance(500);
  expect(api.mock.calls[1][2].force).toBe(true);
});

test('network failure keeps the outbox, persists it, and retries with backoff', async () => {
  await boot();
  api.mockRejectedValueOnce(new Error('network down')).mockResolvedValue({ version: 1, rev: 1 });
  engine.enqueue({ puts: [{ collection: 'c', id: 'a', data: 1 }], deletes: [] });
  await advance(500);
  expect(engine.useSyncStatus.getState().state).toBe('offline');
  expect(JSON.parse(localStorage.getItem('csf-sync-outbox'))).toHaveLength(1);
  await advance(2500);
  expect(engine.useSyncStatus.getState().pending).toBe(0);
});

test('a persisted outbox is replayed after bootstrap', async () => {
  localStorage.setItem('csf-sync-outbox', JSON.stringify([{ collection: 'c', id: 'a', op: 'put', data: { n: 1 }, baseVersion: 0 }]));
  api.mockResolvedValueOnce({ cursor: 1, records: [] });
  await engine.bootstrap();
  api.mockResolvedValue({ version: 1, rev: 2 });
  await advance(10);
  expect(api.mock.calls[1][0]).toBe('PUT');
});

test('poll merges remote changes, ignores echoes of our own writes, and notifies listeners', async () => {
  await boot([rec('c', 'a', { n: 1 }, 1)], 5);
  const heard = jest.fn();
  engine.onRemoteChange(heard);
  api.mockResolvedValueOnce({ cursor: 8, records: [rec('c', 'a', { n: 1 }, 1), rec('c', 'b', { n: 2 }, 1)] });
  await engine.pollNow();
  expect(heard).toHaveBeenCalledTimes(1);
  expect([...heard.mock.calls[0][0]]).toEqual(['c']);
  expect(engine.readCollection('c').get('b')).toEqual({ n: 2 });
  expect(api.mock.calls[1][1]).toBe('/records?since=5');

  api.mockResolvedValueOnce({ cursor: 9, records: [rec('c', 'b', { n: 2 }, 1)] }); // echo, same version
  await engine.pollNow();
  expect(heard).toHaveBeenCalledTimes(1);
});

test('a poll does not wipe unsent local edits', async () => {
  await boot([rec('c', 'a', { n: 1 }, 1)], 5);
  engine.enqueue({ puts: [{ collection: 'c', id: 'a', data: { n: 'typing' } }], deletes: [] });
  api.mockResolvedValueOnce({ cursor: 6, records: [rec('c', 'a', { n: 'remote' }, 2)] });
  await engine.pollNow();
  expect(engine.readCollection('c').get('a')).toEqual({ n: 'typing' });
});

test('remote tombstones remove records', async () => {
  await boot([rec('c', 'a', { n: 1 }, 1)], 5);
  api.mockResolvedValueOnce({ cursor: 6, records: [{ ...rec('c', 'a', null, 2), deleted: true }] });
  await engine.pollNow();
  expect(engine.readCollection('c').has('a')).toBe(false);
});

test('removeStoreRecords queues deletes for every record of a store', async () => {
  await boot([rec('s.items', 'a', 1), rec('s:state', 'state', {}), rec('other.items', 'z', 1)]);
  engine.removeStoreRecords('s');
  expect(engine.readCollection('s.items').size).toBe(0);
  expect(engine.readCollection('other.items').size).toBe(1);
});

test('an enqueue while the earlier PUT is in flight keeps the newer edit and sends it next with the bumped baseVersion', async () => {
  await boot([rec('c', 'a', { n: 1 }, 4)]);
  let release;
  api.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  api.mockResolvedValue({ version: 7, rev: 11 });
  engine.enqueue({ puts: [{ collection: 'c', id: 'a', data: { n: 2 } }], deletes: [] });
  await advance(500);
  expect(api).toHaveBeenCalledTimes(2);
  engine.enqueue({ puts: [{ collection: 'c', id: 'a', data: { n: 3 } }], deletes: [] });
  release({ version: 6, rev: 10 });
  await advance(0);
  expect(engine.readCollection('c').get('a')).toEqual({ n: 3 });
  expect(engine.useSyncStatus.getState().pending).toBe(1);
  await advance(500);
  expect(api).toHaveBeenCalledTimes(3);
  expect(api.mock.calls[2][2]).toEqual({ data: { n: 3 }, baseVersion: 6, force: false });
  expect(engine.useSyncStatus.getState().pending).toBe(0);
});

test('a 401 keeps the outbox and does not retry', async () => {
  await boot();
  api.mockRejectedValueOnce(new ApiError(401, { error: 'unauthorized' }));
  engine.enqueue({ puts: [{ collection: 'c', id: 'a', data: 1 }], deletes: [] });
  await advance(500);
  expect(engine.useSyncStatus.getState().pending).toBe(1);
  expect(JSON.parse(localStorage.getItem('csf-sync-outbox'))).toHaveLength(1);
  await advance(120000);
  expect(api).toHaveBeenCalledTimes(2);
});

test('editing a record already in conflict updates mine and does not send', async () => {
  await boot([rec('c', 'a', { n: 1 }, 1)]);
  api.mockRejectedValueOnce(new ApiError(409, { error: 'conflict', current: { data: { n: 'theirs' }, version: 2, deleted: false } }));
  engine.enqueue({ puts: [{ collection: 'c', id: 'a', data: { n: 'mine' } }], deletes: [] });
  await advance(500);
  engine.enqueue({ puts: [{ collection: 'c', id: 'a', data: { n: 'mine again' } }], deletes: [] });
  await advance(5000);
  expect(api).toHaveBeenCalledTimes(2);
  expect(engine.useSyncStatus.getState().conflicts[0].mine).toEqual({ n: 'mine again' });
  expect(engine.useSyncStatus.getState().pending).toBe(0);
  expect(engine.readCollection('c').get('a')).toEqual({ n: 'mine again' });
});

test('start registers a poll interval and focus listener; stop removes them', async () => {
  await boot();
  const add = jest.spyOn(window, 'addEventListener');
  const remove = jest.spyOn(window, 'removeEventListener');
  engine.start();
  expect(add).toHaveBeenCalledWith('focus', expect.any(Function));
  api.mockResolvedValue({ cursor: 6, records: [] });
  await advance(20000);
  expect(api).toHaveBeenCalledTimes(2);
  expect(api.mock.calls[1][1]).toBe('/records?since=5');
  const handler = add.mock.calls.find((c) => c[0] === 'focus')[1];
  engine.stop();
  expect(remove).toHaveBeenCalledWith('focus', handler);
  await advance(60000);
  expect(api).toHaveBeenCalledTimes(2);
  add.mockRestore();
  remove.mockRestore();
});
