import { createServerStateStorage } from './serverStorage';
import * as engine from './syncEngine';
import { api } from './serverClient';

jest.mock('./serverClient', () => {
  class ApiError extends Error { constructor(s, b) { super('x'); this.status = s; this.body = b; } }
  return { api: jest.fn(), ApiError, setUnauthorizedHandler: jest.fn() };
});

const CONFIG = { collections: { items: 'id' }, localFields: ['selected'] };
const advance = async (ms) => { jest.advanceTimersByTime(ms); for (let i = 0; i < 30; i += 1) await Promise.resolve(); };

beforeEach(async () => {
  jest.useFakeTimers('modern');
  localStorage.clear();
  api.mockReset();
  engine.reset();
  api.mockResolvedValueOnce({ cursor: 0, records: [] });
  await engine.bootstrap();
});
afterEach(() => { engine.stop(); jest.useRealTimers(); });

const wrap = (state, version = 2) => JSON.stringify({ state, version });

test('getItem returns null when the server has nothing, so store defaults apply', async () => {
  const s = createServerStateStorage('s', CONFIG);
  expect(await s.getItem('s')).toBeNull();
});

test('setItem enqueues only changed records, then getItem reads them back with local fields', async () => {
  const s = createServerStateStorage('s', CONFIG);
  await s.getItem('s');
  api.mockResolvedValue({ version: 1, rev: 1 });
  await s.setItem('s', wrap({ items: [{ id: 'a', n: 1 }], theme: 'dark', selected: 'a' }));
  await advance(500);
  const puts = api.mock.calls.slice(1).map((c) => c[1]).sort();
  expect(puts).toEqual(['/records/s%3Astate/state', '/records/s.items/a'].sort());

  api.mockClear();
  await s.setItem('s', wrap({ items: [{ id: 'a', n: 1 }], theme: 'dark', selected: 'a' }));
  await advance(500);
  expect(api).not.toHaveBeenCalled();

  const back = JSON.parse(await s.getItem('s'));
  expect(back.state.items).toEqual([{ id: 'a', n: 1 }]);
  expect(back.state.selected).toBe('a');
  expect(back.version).toBe(2);
});

test('local-only fields are stored in <store>.local and never sent to the server', async () => {
  const s = createServerStateStorage('s', CONFIG);
  await s.getItem('s');
  api.mockResolvedValue({ version: 1, rev: 1 });
  await s.setItem('s', wrap({ items: [{ id: 'a' }], theme: 'dark', selected: 'zzz-secret' }));
  await advance(500);
  expect(JSON.parse(localStorage.getItem('s.local'))).toEqual({ selected: 'zzz-secret' });
  const puts = api.mock.calls.slice(1).filter((c) => c[0] === 'PUT');
  expect(puts.length).toBeGreaterThan(0);
  puts.forEach((c) => expect(JSON.stringify(c[2])).not.toContain('zzz-secret'));
});

test('getItem merges local fields from localStorage', async () => {
  localStorage.setItem('s.local', JSON.stringify({ selected: 'q' }));
  const s = createServerStateStorage('s', CONFIG);
  api.mockResolvedValue({ version: 1, rev: 1 });
  await s.setItem('s', wrap({ items: [{ id: 'a' }] }));
  localStorage.setItem('s.local', JSON.stringify({ selected: 'q' }));
  expect(JSON.parse(await s.getItem('s')).state.selected).toBe('q');
});

test('two quick setItem calls (second a superset) produce one PUT per changed record', async () => {
  const s = createServerStateStorage('s', CONFIG);
  await s.getItem('s');
  api.mockResolvedValue({ version: 1, rev: 1 });
  await s.setItem('s', wrap({ items: [{ id: 'a' }] }));
  await s.setItem('s', wrap({ items: [{ id: 'a' }, { id: 'b' }] }));
  await advance(500);
  const paths = api.mock.calls.slice(1).map((c) => `${c[0]} ${c[1]}`);
  expect(paths.filter((p) => p === 'PUT /records/s.items/a')).toHaveLength(1);
  expect(paths.filter((p) => p === 'PUT /records/s.items/b')).toHaveLength(1);
  expect(paths.filter((p) => p === 'PUT /records/s%3Astate/state')).toHaveLength(1);
});

test('removing an item sends a delete', async () => {
  const s = createServerStateStorage('s', CONFIG);
  await s.getItem('s');
  api.mockResolvedValue({ version: 1, rev: 1 });
  await s.setItem('s', wrap({ items: [{ id: 'a' }, { id: 'b' }] }));
  await advance(500);
  api.mockClear();
  await s.setItem('s', wrap({ items: [{ id: 'a' }] }));
  await advance(500);
  expect(api.mock.calls.map((c) => c[0] + ' ' + c[1])).toContain('DELETE /records/s.items/b');
});

test('removeItem deletes collection records but never the :state record', async () => {
  const s = createServerStateStorage('s', CONFIG);
  await s.getItem('s');
  api.mockResolvedValue({ version: 1, rev: 1 });
  await s.setItem('s', wrap({ items: [{ id: 'a' }] }));
  await advance(500);
  api.mockClear();
  await s.removeItem('s');
  await advance(500);
  const calls = api.mock.calls.map((c) => c[0] + ' ' + c[1]);
  expect(calls).toContain('DELETE /records/s.items/a');
  expect(calls.filter((c) => c.includes(':state') || c.includes('%3Astate'))).toEqual([]);
});

test('items without an id surface a visible sync error and are not sent; fixing clears it', async () => {
  const s = createServerStateStorage('s', CONFIG);
  await s.getItem('s');
  api.mockResolvedValue({ version: 1, rev: 1 });
  await s.setItem('s', wrap({ items: [{ id: 'a' }, { n: 1 }] }));
  await advance(500);
  expect(engine.useSyncStatus.getState().error).toMatch(/1 item.*no id/i);
  await s.setItem('s', wrap({ items: [{ id: 'a' }] }));
  expect(engine.useSyncStatus.getState().error).toBeNull();
});

test('a remote change is visible to the next getItem (rehydrate path)', async () => {
  const s = createServerStateStorage('s', CONFIG);
  await s.getItem('s');
  api.mockResolvedValueOnce({
    cursor: 3,
    records: [
      { collection: 's.items', id: 'z', data: { id: 'z' }, version: 1, deleted: false },
      { collection: 's:state', id: 'state', data: { version: 2, shared: {}, order: { items: ['z'] } }, version: 1, deleted: false }
    ]
  });
  await engine.pollNow();
  const back = JSON.parse(await s.getItem('s'));
  expect(back.state.items).toEqual([{ id: 'z' }]);
});
