import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { createServerStateStorage } from './serverStorage';
import { STORE_CONFIGS } from './storeConfigs';
import * as engine from './syncEngine';
import { registerStoreForRehydrate } from './rehydrateOnRemote';
import { importLocalData } from './importLocalData';
import { api } from './serverClient';

jest.mock('./serverClient', () => {
  class ApiError extends Error { constructor(s, b) { super('x'); this.status = s; this.body = b; } }
  return { api: jest.fn(), ApiError, setUnauthorizedHandler: jest.fn() };
});

const NAME = 'csf-assessments-storage';
const advance = async (ms) => { jest.advanceTimersByTime(ms); for (let i = 0; i < 50; i += 1) await Promise.resolve(); };

afterEach(() => { engine.stop(); jest.useRealTimers(); });

test('an imported v1 state is migrated by the store and written back as PUTs; local fields stay out of the server', async () => {
  jest.useFakeTimers('modern');
  localStorage.clear();
  api.mockReset();
  engine.reset();

  const oldRaw = JSON.stringify({
    state: { assessments: [{ id: 'a1', name: 'Old' }], currentAssessmentId: 'a1', theme: 'x' },
    version: 1
  });
  localStorage.setItem(NAME, oldRaw);

  // tiny fake server
  const server = new Map();
  const puts = [];
  api.mockImplementation(async (method, path, body) => {
    if (method === 'GET') return { cursor: server.size, records: [...server.values()] };
    if (method === 'POST' && path === '/import') {
      body.records.forEach((r) => server.set(`${r.collection}|${r.id}`, { ...r, version: 1, deleted: false }));
      return { imported: body.records.length };
    }
    if (method === 'PUT') {
      puts.push({ path, body });
      return { version: (body.baseVersion || 0) + 1 };
    }
    throw new Error(`unexpected ${method} ${path}`);
  });

  await engine.bootstrap('u1');
  const migrate = jest.fn((state, version) => (version < 2
    ? { ...state, assessments: state.assessments.map((a) => ({ ...a, schema: 2 })) }
    : state));
  const useStore = create(persist(
    () => ({ assessments: [], currentAssessmentId: null, theme: 'default' }),
    { name: NAME, version: 2, migrate, storage: createJSONStorage(() => createServerStateStorage(NAME, STORE_CONFIGS[NAME])) }
  ));
  registerStoreForRehydrate(useStore);
  await advance(0);
  expect(useStore.persist.hasHydrated()).toBe(true);
  expect(migrate).not.toHaveBeenCalled(); // empty workspace: nothing to migrate yet

  await importLocalData({ userId: 'u1' });
  await advance(0);
  await advance(600);

  // the :state record was imported with the OLD version and without per-browser fields
  const imported = api.mock.calls.find(([m, p]) => m === 'POST' && p === '/import')[2].records;
  const stateRec = imported.find((r) => r.collection === `${NAME}:state`);
  expect(stateRec.data.version).toBe(1);
  expect(stateRec.data.shared).not.toHaveProperty('currentAssessmentId');
  expect(stateRec.data.shared).toEqual({ theme: 'x' });

  // zustand ran the store's own migrate on the old version
  expect(migrate).toHaveBeenCalledWith(expect.anything(), 1);
  expect(useStore.getState().assessments).toEqual([{ id: 'a1', name: 'Old', schema: 2 }]);

  // and the migrated result was written back with the imported record versions as baseVersion
  const byPath = Object.fromEntries(puts.map((p) => [decodeURIComponent(p.path), p.body]));
  expect(byPath[`/records/${NAME}:state/state`].baseVersion).toBe(1);
  expect(byPath[`/records/${NAME}:state/state`].data.version).toBe(2);
  expect(byPath[`/records/${NAME}.assessments/a1`].baseVersion).toBe(1);
  expect(byPath[`/records/${NAME}.assessments/a1`].data.schema).toBe(2);
  puts.forEach((p) => expect(JSON.stringify(p.body)).not.toContain('currentAssessmentId'));

  // the browser's original key is never rewritten
  expect(localStorage.getItem(NAME)).toBe(oldRaw);
});
