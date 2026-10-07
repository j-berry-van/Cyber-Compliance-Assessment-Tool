import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
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
  await s.getItem('s');
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

const seedItemsOnly = async () => {
  api.mockResolvedValueOnce({
    cursor: 3,
    records: [
      { collection: 's.items', id: 'x', data: { id: 'x' }, version: 1, deleted: false },
      { collection: 's.items', id: 'y', data: { id: 'y' }, version: 1, deleted: false }
    ]
  });
  await engine.pollNow();
};

test('with item records but no :state record, getItem omits version and a real store adopts the items without deleting them', async () => {
  await seedItemsOnly();
  const storage = createServerStateStorage('s', CONFIG);
  const parsed = JSON.parse(await storage.getItem('s'));
  expect(parsed.state.items.map((i) => i.id)).toEqual(['x', 'y']);
  expect('version' in parsed).toBe(false);

  const useStore = create(persist(
    (set) => ({ items: [], add: (item) => set((st) => ({ items: [...st.items, item] })) }),
    { name: 's', version: 1, storage: createJSONStorage(() => createServerStateStorage('s', CONFIG)) }
  ));
  await advance(0);
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
  expect(useStore.getState().items.map((i) => i.id)).toEqual(['x', 'y']);

  api.mockClear();
  api.mockResolvedValue({ version: 2, rev: 2 });
  useStore.getState().add({ id: 'new' });
  await advance(0); // let the async setItem enqueue before the debounce timer runs
  await advance(500);
  const calls = api.mock.calls.map((c) => `${c[0]} ${c[1]}`);
  expect(calls).toContain('PUT /records/s.items/new');
  expect(calls.filter((c) => c.startsWith('DELETE'))).toEqual([]);
});

test('setItem before the first getItem completes sends nothing', async () => {
  await seedItemsOnly();
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const storage = createServerStateStorage('s', CONFIG);
  api.mockClear();
  api.mockResolvedValue({ version: 1, rev: 1 });
  await storage.setItem('s', wrap({ items: [{ id: 'default' }] }));
  await advance(1000);
  expect(api).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledTimes(1);

  await storage.getItem('s');
  await storage.setItem('s', wrap({ items: [{ id: 'x' }, { id: 'y' }, { id: 'z' }] }));
  await advance(500);
  const calls = api.mock.calls.map((c) => `${c[0]} ${c[1]}`);
  expect(calls).toContain('PUT /records/s.items/z');
  expect(calls.filter((c) => c.startsWith('DELETE'))).toEqual([]);
  warn.mockRestore();
});

describe('a version mismatch the store cannot migrate', () => {
  const { registerStoreForRehydrate } = require('./rehydrateOnRemote');
  const seeded = async (storeVersion, migrate) => {
    api.mockReset();
    engine.reset();
    api.mockResolvedValueOnce({ cursor: 3, records: [
      { collection: 'mm.items', id: 'a', data: { id: 'a', n: 1 }, version: 1, deleted: false },
      { collection: 'mm.items', id: 'b', data: { id: 'b', n: 2 }, version: 1, deleted: false },
      { collection: 'mm:state', id: 'state', data: { version: 1, shared: {}, order: {} }, version: 1, deleted: false }
    ] });
    await engine.bootstrap();
    const useStore = create(persist(() => ({ items: [{ id: 'default', n: 0 }] }), {
      name: 'mm',
      version: storeVersion,
      migrate,
      storage: createJSONStorage(() => createServerStateStorage('mm', CONFIG))
    }));
    registerStoreForRehydrate(useStore);
    await useStore.persist.rehydrate();
    api.mockClear();
    return useStore;
  };

  test('without migrate, nothing is written (no mass delete of teammates\' records) and a problem is shown', async () => {
    const useStore = await seeded(2, undefined);
    expect(useStore.getState().items.map((i) => i.id)).toEqual(['default']); // zustand discarded the server data
    useStore.setState({ items: [{ id: 'default', n: 5 }] });
    await advance(2000);
    expect(api).not.toHaveBeenCalled();
    expect(engine.useSyncStatus.getState().pending).toBe(0);
    expect(engine.useSyncStatus.getState().error).toMatch(/different app version/);
  });

  test('with migrate, the migrated data is adopted and edits are saved as normal', async () => {
    const useStore = await seeded(2, (s) => s);
    expect(useStore.getState().items.map((i) => i.id)).toEqual(['a', 'b']);
    api.mockResolvedValue({ version: 2, rev: 4 });
    useStore.setState({ items: [{ id: 'a', n: 1 }, { id: 'b', n: 99 }] });
    await advance(0);
    await advance(600);
    expect(api.mock.calls.some(([m, p]) => m === 'PUT' && p.includes('/b'))).toBe(true);
    expect(api.mock.calls.some(([m]) => m === 'DELETE')).toBe(false);
  });
});
