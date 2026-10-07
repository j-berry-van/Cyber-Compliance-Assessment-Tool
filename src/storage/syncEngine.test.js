import * as engine from './syncEngine';
import { api, ApiError } from './serverClient';

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
  expect(JSON.parse(localStorage.getItem('csf-sync-outbox:anonymous'))).toHaveLength(1);
  await advance(2500);
  expect(engine.useSyncStatus.getState().pending).toBe(0);
});

test('a persisted outbox is replayed after bootstrap', async () => {
  localStorage.setItem('csf-sync-outbox:anonymous', JSON.stringify([{ collection: 'c', id: 'a', op: 'put', data: { n: 1 }, baseVersion: 0 }]));
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
  await advance(500); // debounce timer fires while the first PUT is still in flight
  expect(api).toHaveBeenCalledTimes(2);
  release({ version: 6, rev: 10 });
  await advance(0);
  expect(engine.readCollection('c').get('a')).toEqual({ n: 3 });
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
  expect(JSON.parse(localStorage.getItem('csf-sync-outbox:anonymous'))).toHaveLength(1);
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

const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const conflict409 = (data, version) => new ApiError(409, { error: 'conflict', current: { data, version, deleted: false } });

test('start() after bootstrap does not kill the replay of a persisted outbox', async () => {
  localStorage.setItem('csf-sync-outbox:anonymous', JSON.stringify([{ collection: 'c', id: 'a', op: 'put', data: { n: 1 }, baseVersion: 0 }]));
  api.mockResolvedValueOnce({ cursor: 1, records: [] });
  await engine.bootstrap();
  engine.start();
  api.mockResolvedValue({ version: 1, rev: 2 });
  await advance(10);
  expect(api.mock.calls[1][0]).toBe('PUT');
});

test('a late PUT response does not lower a newer cached version', async () => {
  await boot([rec('c', 'a', { n: 1 }, 1)], 5);
  const d = deferred();
  api.mockImplementationOnce(() => d.promise);
  engine.enqueue({ puts: [{ collection: 'c', id: 'a', data: { n: 'mine' } }], deletes: [] });
  await advance(500);
  api.mockResolvedValueOnce({ cursor: 9, records: [rec('c', 'a', { n: 'teammate' }, 5)] });
  await engine.pollNow();
  d.resolve({ version: 2, rev: 7 });
  await advance(0);
  expect(engine.getEntries('c')[0].version).toBe(5);
  expect(engine.getEntries('c')[0].data).toEqual({ n: 'teammate' });
});

test('a late 409 does not lower a newer cached version', async () => {
  await boot([rec('c', 'a', { n: 1 }, 1)], 5);
  const d = deferred();
  api.mockImplementationOnce(() => d.promise);
  engine.enqueue({ puts: [{ collection: 'c', id: 'a', data: { n: 'mine' } }], deletes: [] });
  await advance(500);
  api.mockResolvedValueOnce({ cursor: 9, records: [rec('c', 'a', { n: 'newest' }, 5)] });
  await engine.pollNow();
  d.reject(conflict409({ n: 'stale' }, 2));
  await advance(0);
  expect(engine.getEntries('c')[0].version).toBe(5);
  expect(engine.useSyncStatus.getState().conflicts[0].theirs).toEqual({ n: 'newest' });
});

test('conflicts survive a reload and keep mine, including later edits', async () => {
  await boot([rec('c', 'a', { n: 1 }, 1)]);
  api.mockRejectedValueOnce(conflict409({ n: 'theirs' }, 2));
  engine.enqueue({ puts: [{ collection: 'c', id: 'a', data: { n: 'mine' } }], deletes: [] });
  await advance(500);
  engine.enqueue({ puts: [{ collection: 'c', id: 'a', data: { n: 'mine later' } }], deletes: [] });
  engine.reset();
  await boot([rec('c', 'a', { n: 'theirs' }, 2)]);
  const { conflicts } = engine.useSyncStatus.getState();
  expect(conflicts).toHaveLength(1);
  expect(conflicts[0].mine).toEqual({ n: 'mine later' });
  expect(conflicts[0].theirs).toEqual({ n: 'theirs' });
  engine.resolveConflict(conflicts[0].key, 'theirs');
  engine.reset();
  await boot([rec('c', 'a', { n: 'theirs' }, 2)]);
  expect(engine.useSyncStatus.getState().conflicts).toHaveLength(0);
});

test('a restored conflict refreshes theirs when the server has moved on', async () => {
  await boot([rec('c', 'a', { n: 1 }, 1)]);
  api.mockRejectedValueOnce(conflict409({ n: 'theirs' }, 2));
  engine.enqueue({ puts: [{ collection: 'c', id: 'a', data: { n: 'mine' } }], deletes: [] });
  await advance(500);
  engine.reset();
  await boot([rec('c', 'a', { n: 'newer' }, 4)]);
  const c = engine.useSyncStatus.getState().conflicts[0];
  expect(c.theirs).toEqual({ n: 'newer' });
});

test('a permanently rejected record is dropped and does not block the rest', async () => {
  await boot();
  api.mockRejectedValueOnce(new ApiError(400, { error: 'bad' })).mockResolvedValue({ version: 1, rev: 1 });
  engine.enqueue({ puts: [{ collection: 'c', id: 'bad', data: 1 }, { collection: 'c', id: 'good', data: 2 }], deletes: [] });
  await advance(500);
  expect(api).toHaveBeenCalledTimes(3);
  expect(engine.useSyncStatus.getState().pending).toBe(0);
  expect(engine.useSyncStatus.getState().error).toMatch(/1 change\(s\) could not be saved/);
  expect(engine.getEntries('c').map((e) => e.id)).toEqual(['good']);
});

test('a 5xx stays queued and is retried', async () => {
  await boot();
  api.mockRejectedValueOnce(new ApiError(503, { error: 'down' })).mockResolvedValue({ version: 1, rev: 1 });
  engine.enqueue({ puts: [{ collection: 'c', id: 'a', data: 1 }], deletes: [] });
  await advance(500);
  expect(engine.useSyncStatus.getState().pending).toBe(1);
  expect(engine.useSyncStatus.getState().error).toBeNull();
  await advance(2500);
  expect(engine.useSyncStatus.getState().pending).toBe(0);
});

test('the outbox is per user', async () => {
  const stored = [{ collection: 'c', id: 'a', op: 'put', data: { n: 1 }, baseVersion: 0 }];
  localStorage.setItem('csf-sync-outbox:1', JSON.stringify(stored));
  api.mockResolvedValueOnce({ cursor: 1, records: [] });
  await engine.bootstrap(2);
  await advance(1000);
  expect(api).toHaveBeenCalledTimes(1);
  expect(engine.useSyncStatus.getState().pending).toBe(0);
  engine.reset();
  api.mockResolvedValueOnce({ cursor: 1, records: [] });
  await engine.bootstrap(1);
  api.mockResolvedValue({ version: 1, rev: 2 });
  await advance(10);
  expect(api.mock.calls[api.mock.calls.length - 1][0]).toBe('PUT');
});

describe('source-keyed sync problems', () => {
  test('flush rejection error clears after a clean flush', async () => {
    await boot();
    api.mockRejectedValueOnce(new ApiError(400, { error: 'bad' })).mockResolvedValue({ version: 1, rev: 1 });
    engine.enqueue({ puts: [{ collection: 'c', id: 'a', data: { n: 1 } }], deletes: [] });
    await advance(500);
    expect(engine.useSyncStatus.getState().error).toMatch(/1 change\(s\) could not be saved/);
    engine.enqueue({ puts: [{ collection: 'c', id: 'b', data: { n: 1 } }], deletes: [] });
    await advance(500);
    expect(engine.useSyncStatus.getState().error).toBeNull();
  });

  test('problems from two sources coexist and clear independently without touching state', async () => {
    await boot();
    engine.setSyncProblem('s1', 'one');
    engine.setSyncProblem('s2', 'two');
    expect(engine.useSyncStatus.getState().error).toBe('one');
    expect(engine.useSyncStatus.getState().state).toBe('idle');
    engine.setSyncProblem('s1', null);
    expect(engine.useSyncStatus.getState().error).toBe('two');
    engine.setSyncProblem('s2', '');
    expect(engine.useSyncStatus.getState().error).toBeNull();
  });

  test('reset clears all problems', async () => {
    engine.setSyncProblem('s1', 'one');
    engine.reset();
    expect(engine.useSyncStatus.getState().error).toBeNull();
    await boot();
    expect(engine.useSyncStatus.getState().error).toBeNull();
  });
});

test('isWorkspaceEmpty: true after bootstrap with no records', async () => {
  await boot([]);
  expect(engine.isWorkspaceEmpty()).toBe(true);
});

test('isWorkspaceEmpty: false with a cached record, true when it is only a tombstone', async () => {
  await boot([rec('c', 'a', { n: 1 })]);
  expect(engine.isWorkspaceEmpty()).toBe(false);
  await boot([{ ...rec('c', 'a', null), deleted: true }]);
  expect(engine.isWorkspaceEmpty()).toBe(true);
});

test('isWorkspaceEmpty is decided at bootstrap: later writes do not hide an empty workspace', async () => {
  await boot([]);
  engine.enqueue({ puts: [{ collection: 'c', id: 'a', data: { n: 1 } }], deletes: [] });
  expect(engine.isWorkspaceEmpty()).toBe(true);
});

test('isWorkspaceEmpty: false when a stale outbox was waiting at bootstrap', async () => {
  localStorage.setItem('csf-sync-outbox:anonymous', JSON.stringify([{ collection: 'c', id: 'a', op: 'put', data: { n: 1 }, baseVersion: 0 }]));
  await boot([]);
  expect(engine.isWorkspaceEmpty()).toBe(false);
});

test('bootstrap with hold sends nothing until releaseFlush; clearOutbox drops unsent changes', async () => {
  api.mockResolvedValueOnce({ cursor: 0, records: [] });
  await engine.bootstrap('anonymous', { hold: true });
  engine.enqueue({ puts: [{ collection: 'c', id: 'a', data: { n: 1 } }], deletes: [] });
  await advance(2000);
  expect(api.mock.calls.filter(([m]) => m === 'PUT')).toHaveLength(0);
  api.mockResolvedValue({ version: 1, rev: 1 });
  engine.releaseFlush();
  await advance(10);
  expect(api.mock.calls.filter(([m]) => m === 'PUT')).toHaveLength(1);
  engine.reset();
  api.mockClear();
  api.mockResolvedValueOnce({ cursor: 0, records: [] });
  await engine.bootstrap('anonymous', { hold: true });
  engine.enqueue({ puts: [{ collection: 'c', id: 'b', data: { n: 1 } }], deletes: [] });
  engine.clearOutbox();
  engine.releaseFlush();
  await advance(2000);
  expect(api.mock.calls.filter(([m]) => m === 'PUT')).toHaveLength(0);
});

test('a poll echo of our own flushed write fills server metadata without emitting a change', async () => {
  await boot([rec('c', 'a', { n: 1 }, 1)], 5);
  api.mockResolvedValueOnce({ version: 2, rev: 6 });
  engine.enqueue({ puts: [{ collection: 'c', id: 'a', data: { n: 2 } }], deletes: [] });
  await advance(500);
  expect(engine.getEntries('c')[0]).toMatchObject({ version: 2, updatedBy: null, updatedAt: null });
  const heard = jest.fn();
  engine.onRemoteChange(heard);
  api.mockResolvedValueOnce({ cursor: 6, records: [{ ...rec('c', 'a', { n: 2 }, 2), updatedBy: 7, updatedAt: '2026-01-01T00:00:00.000Z' }] });
  await engine.pollNow();
  expect(engine.getEntries('c')[0]).toMatchObject({ data: { n: 2 }, version: 2, updatedBy: 7, updatedAt: '2026-01-01T00:00:00.000Z' });
  expect(heard).not.toHaveBeenCalled();
});

test('a poll with a higher version still replaces the entry and emits', async () => {
  await boot([rec('c', 'a', { n: 1 }, 1)], 5);
  const heard = jest.fn();
  engine.onRemoteChange(heard);
  api.mockResolvedValueOnce({ cursor: 6, records: [{ ...rec('c', 'a', { n: 3 }, 3), updatedBy: 9 }] });
  await engine.pollNow();
  expect(engine.getEntries('c')[0]).toMatchObject({ data: { n: 3 }, version: 3, updatedBy: 9 });
  expect(heard).toHaveBeenCalledTimes(1);
});

test('a stale poll result (lower version) never stamps our newer own write; the real echo does', async () => {
  await boot([rec('c', 'a', { n: 1 }, 1)], 5);
  api.mockResolvedValueOnce({ version: 3, rev: 7 });
  engine.enqueue({ puts: [{ collection: 'c', id: 'a', data: { n: 3 } }], deletes: [] });
  await advance(500);
  expect(engine.getEntries('c')[0]).toMatchObject({ version: 3, updatedBy: null });
  const heard = jest.fn();
  engine.onRemoteChange(heard);
  api.mockResolvedValueOnce({ cursor: 6, records: [{ ...rec('c', 'a', { n: 2 }, 2), updatedBy: 99, updatedAt: 'teammate' }] });
  await engine.pollNow();
  expect(engine.getEntries('c')[0]).toMatchObject({ data: { n: 3 }, version: 3, updatedBy: null, updatedAt: null });
  api.mockResolvedValueOnce({ cursor: 7, records: [{ ...rec('c', 'a', { n: 3 }, 3), updatedBy: 1, updatedAt: 'me' }] });
  await engine.pollNow();
  expect(engine.getEntries('c')[0]).toMatchObject({ version: 3, updatedBy: 1, updatedAt: 'me' });
  expect(heard).not.toHaveBeenCalled();
});

test.each([408, 429])('a %i stays queued and is retried rather than dropped', async (status) => {
  await boot();
  api.mockRejectedValueOnce(new ApiError(status, {})).mockResolvedValue({ version: 1, rev: 1 });
  engine.enqueue({ puts: [{ collection: 'c', id: 'a', data: 1 }], deletes: [] });
  await advance(500);
  expect(engine.useSyncStatus.getState().pending).toBe(1);
  await advance(2500);
  expect(engine.useSyncStatus.getState().pending).toBe(0);
  expect(engine.useSyncStatus.getState().error).toBeNull();
});

test('two tabs of one user do not overwrite each other\'s persisted outbox', async () => {
  await boot();
  const foreign = { collection: 'c', id: 'other-tab', op: 'put', data: { n: 9 }, baseVersion: 0, owner: 'another-tab' };
  localStorage.setItem('csf-sync-outbox:anonymous', JSON.stringify([foreign]));
  engine.enqueue({ puts: [{ collection: 'c', id: 'mine', data: { n: 1 } }], deletes: [] });
  const stored = JSON.parse(localStorage.getItem('csf-sync-outbox:anonymous'));
  expect(stored.map((o) => o.id).sort()).toEqual(['mine', 'other-tab']);
  expect(stored.find((o) => o.id === 'other-tab').owner).toBe('another-tab');
  // this tab sends only its own entry; once sent it is removed while the other tab's entry stays
  api.mockResolvedValue({ version: 1, rev: 1 });
  await advance(500);
  expect(api.mock.calls.filter(([m]) => m === 'PUT')).toHaveLength(1);
  expect(JSON.parse(localStorage.getItem('csf-sync-outbox:anonymous')).map((o) => o.id)).toEqual(['other-tab']);
});

test('a reloaded tab adopts entries left behind by an earlier tab', async () => {
  localStorage.setItem('csf-sync-outbox:anonymous', JSON.stringify([
    { collection: 'c', id: 'left', op: 'put', data: { n: 1 }, baseVersion: 0, owner: 'dead-tab' }
  ]));
  api.mockResolvedValue({ version: 1, rev: 1 });
  await boot();
  await advance(10);
  expect(api.mock.calls.filter(([m]) => m === 'PUT')).toHaveLength(1);
});

test('flushNow resolves only after the flush in progress completes', async () => {
  await boot();
  let release;
  api.mockImplementationOnce(() => new Promise((r) => { release = () => r({ version: 1, rev: 1 }); }));
  engine.enqueue({ puts: [{ collection: 'c', id: 'a', data: 1 }], deletes: [] });
  await advance(500); // flush is now in flight
  let done = false;
  const p = engine.flushNow().then(() => { done = true; });
  await advance(10);
  expect(done).toBe(false);
  release();
  await p;
  expect(engine.useSyncStatus.getState().pending).toBe(0);
});

describe('conflict auto-resolution', () => {
  const conflict409 = (current) => new ApiError(409, { error: 'conflict', current });
  const edit = (data) => engine.enqueue({ puts: [{ collection: 'c', id: 'a', data }], deletes: [] });

  test('edits to different fields are merged and re-sent on top of their version, with no dialog', async () => {
    await boot([rec('c', 'a', { x: 1, y: 1 }, 1)]);
    const heard = jest.fn();
    engine.onRemoteChange(heard);
    api.mockRejectedValueOnce(conflict409({ data: { x: 1, y: 2 }, version: 2, deleted: false }))
      .mockResolvedValue({ version: 3, rev: 9 });
    edit({ x: 5, y: 1 });
    await advance(500);
    await advance(600);
    const puts = api.mock.calls.filter(([m]) => m === 'PUT');
    expect(puts).toHaveLength(2);
    expect(puts[1][2]).toMatchObject({ data: { x: 5, y: 2 }, baseVersion: 2 });
    expect(engine.useSyncStatus.getState().conflicts).toEqual([]);
    expect(engine.useSyncStatus.getState().pending).toBe(0);
    expect(heard).toHaveBeenCalled();
  });

  test('both sides ending with identical content adopts theirs silently (nothing re-sent)', async () => {
    await boot([rec('c', 'a', { x: 1 }, 1)]);
    api.mockRejectedValueOnce(conflict409({ data: { x: 2 }, version: 2, deleted: false })).mockResolvedValue({ version: 3, rev: 9 });
    edit({ x: 2 });
    await advance(500);
    await advance(600);
    expect(api.mock.calls.filter(([m]) => m === 'PUT')).toHaveLength(1);
    expect(engine.useSyncStatus.getState().conflicts).toEqual([]);
    expect(engine.useSyncStatus.getState().pending).toBe(0);
  });

  test('the same field changed differently still raises a conflict', async () => {
    await boot([rec('c', 'a', { x: 1 }, 1)]);
    api.mockRejectedValueOnce(conflict409({ data: { x: 3 }, version: 2, deleted: false }));
    edit({ x: 2 });
    await advance(500);
    expect(engine.useSyncStatus.getState().conflicts).toHaveLength(1);
    expect(engine.useSyncStatus.getState().conflicts[0]).toMatchObject({ mine: { x: 2 }, theirs: { x: 3 } });
  });

  test('without a recorded base (older outbox entry) a differing record still raises a conflict', async () => {
    localStorage.setItem('csf-sync-outbox:anonymous', JSON.stringify([{ collection: 'c', id: 'a', op: 'put', data: { x: 2 }, baseVersion: 1 }]));
    await boot([rec('c', 'a', { x: 1 }, 1)]);
    api.mockRejectedValueOnce(conflict409({ data: { x: 3 }, version: 2, deleted: false }));
    await advance(10);
    expect(engine.useSyncStatus.getState().conflicts).toHaveLength(1);
  });
});
