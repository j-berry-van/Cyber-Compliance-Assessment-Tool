import { toRecords, fromRecords, diffRecords, storeNameOf, isStateRecord, recordKey } from './diff';

const CONFIG = { collections: { items: 'id' }, localFields: ['selected'] };
const persisted = (items, extra = {}) => ({
  version: 3,
  state: { items, theme: 'dark', selected: 'a', ...extra }
});
const reader = (records) => (collection) => {
  const m = new Map();
  Object.values(records).forEach((r) => { if (r.collection === collection) m.set(r.id, r.data); });
  return m;
};

describe('toRecords', () => {
  it('splits a collection into per-record entries plus a state record', () => {
    const { records, problems } = toRecords('s', CONFIG, persisted([{ id: 'a', n: 1 }, { id: 'b', n: 2 }]));
    expect(problems).toEqual([]);
    expect(records[recordKey('s.items', 'a')].data).toEqual({ id: 'a', n: 1 });
    const state = records[recordKey('s:state', 'state')].data;
    expect(state.version).toBe(3);
    expect(state.shared).toEqual({ theme: 'dark' }); // local field "selected" is excluded
    expect(state.order).toEqual({ items: ['a', 'b'] });
  });

  it('reports items with a missing or duplicate key instead of dropping them silently', () => {
    const { records, problems } = toRecords('s', CONFIG, persisted([{ id: 'a' }, { n: 1 }, { id: 'a' }]));
    expect(problems.map((p) => p.index)).toEqual([1, 2]);
    expect(Object.keys(records).filter((k) => k.startsWith('s.items'))).toHaveLength(1);
  });

  it('supports function keys', () => {
    const cfg = { collections: { reqs: (r) => `${r.frameworkId}::${r.id}` } };
    const { records } = toRecords('s', cfg, { version: 1, state: { reqs: [{ id: 'x', frameworkId: 'f' }] } });
    expect(records[recordKey('s.reqs', 'f::x')]).toBeTruthy();
  });

  it('skips a missing or non-array collection field without error', () => {
    const missing = toRecords('s', CONFIG, { version: 1, state: { theme: 'dark' } });
    expect(missing.problems).toEqual([]);
    expect(Object.keys(missing.records)).toEqual([recordKey('s:state', 'state')]);
    expect(missing.records[recordKey('s:state', 'state')].data.order).toEqual({});
    const bad = toRecords('s', CONFIG, { version: 1, state: { items: { id: 'a' } } });
    expect(bad.problems).toEqual([]);
    expect(Object.keys(bad.records)).toEqual([recordKey('s:state', 'state')]);
  });

  it('stringifies numeric ids', () => {
    const { records } = toRecords('s', CONFIG, persisted([{ id: 5 }]));
    expect(records[recordKey('s.items', '5')].id).toBe('5');
  });

  it('treats numeric 5 and string "5" as a duplicate', () => {
    const { records, problems } = toRecords('s', CONFIG, persisted([{ id: 5 }, { id: '5' }]));
    expect(problems).toEqual([{ field: 'items', index: 1, id: '5' }]);
    expect(Object.keys(records).filter((k) => k.startsWith('s.items'))).toHaveLength(1);
  });

  it('reports items that cannot be keyed (null, primitives) as problems', () => {
    const fnCfg = { collections: { items: (x) => x.id } };
    const { problems } = toRecords('s', fnCfg, { version: 1, state: { items: [null, 7, { id: 'a' }] } });
    expect(problems.map((p) => p.index)).toEqual([0, 1]);
  });
});

describe('fromRecords', () => {
  it('returns null when the server has nothing for the store', () => {
    expect(fromRecords('s', CONFIG, reader({}), {})).toBeNull();
  });

  it('round-trips state, preserving order and merging local fields', () => {
    const original = persisted([{ id: 'b' }, { id: 'a' }]);
    const { records } = toRecords('s', CONFIG, original);
    const back = fromRecords('s', CONFIG, reader(records), { selected: 'a' });
    expect(back).toEqual(original);
  });

  it('appends records missing from the order and drops order ids with no record', () => {
    const { records } = toRecords('s', CONFIG, persisted([{ id: 'a' }, { id: 'b' }]));
    delete records[recordKey('s.items', 'a')];
    records[recordKey('s.items', 'c')] = { collection: 's.items', id: 'c', data: { id: 'c' } };
    const back = fromRecords('s', CONFIG, reader(records), {});
    expect(back.state.items.map((i) => i.id)).toEqual(['b', 'c']);
  });

  it('keeps an explicitly emptied collection empty', () => {
    const { records } = toRecords('s', CONFIG, persisted([]));
    expect(fromRecords('s', CONFIG, reader(records), {}).state.items).toEqual([]);
  });

  it('does not duplicate an item when order lists an id twice', () => {
    const { records } = toRecords('s', CONFIG, persisted([{ id: 'a' }, { id: 'b' }]));
    records[recordKey('s:state', 'state')].data.order.items = ['a', 'b', 'a'];
    const back = fromRecords('s', CONFIG, reader(records), {});
    expect(back.state.items.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('round-trips array and primitive items', () => {
    const cfg = { collections: { arrs: (a) => a[0], nums: (n) => String(n) } };
    const original = { version: 2, state: { arrs: [['x', 1], ['y', 2]], nums: [3, 1, 2] } };
    const { records, problems } = toRecords('s', cfg, original);
    expect(problems).toEqual([]);
    expect(fromRecords('s', cfg, reader(records), {})).toEqual(original);
  });
});

describe('diffRecords', () => {
  it('finds adds, changes and deletes, and ignores unchanged records', () => {
    const prev = toRecords('s', CONFIG, persisted([{ id: 'a', n: 1 }, { id: 'b', n: 1 }, { id: 'c', n: 1 }])).records;
    const next = toRecords('s', CONFIG, persisted([{ id: 'a', n: 1 }, { id: 'b', n: 2 }, { id: 'd', n: 1 }])).records;
    const { puts, deletes } = diffRecords(prev, next);
    expect(puts.map((p) => p.id).sort()).toEqual(['b', 'd', 'state'].sort());
    expect(deletes.map((d) => d.id)).toEqual(['c']);
  });

  it('treats key order inside an object as irrelevant', () => {
    const a = toRecords('s', CONFIG, persisted([{ id: 'a', x: 1, y: 2 }])).records;
    const b = toRecords('s', CONFIG, persisted([{ y: 2, id: 'a', x: 1 }])).records;
    expect(diffRecords(a, b)).toEqual({ puts: [], deletes: [] });
  });

  it('never deletes the state record', () => {
    const prev = toRecords('s', CONFIG, persisted([])).records;
    expect(diffRecords(prev, {}).deletes).toEqual([]);
  });

  it('detects a changed order as a put of the state record only', () => {
    const prev = toRecords('s', CONFIG, persisted([{ id: 'a' }, { id: 'b' }])).records;
    const next = toRecords('s', CONFIG, persisted([{ id: 'b' }, { id: 'a' }])).records;
    const { puts, deletes } = diffRecords(prev, next);
    expect(puts.map((p) => `${p.collection}/${p.id}`)).toEqual(['s:state/state']);
    expect(deletes).toEqual([]);
  });
});

describe('helpers', () => {
  it('derives the store name and detects state records', () => {
    expect(storeNameOf('csf-comments-storage.comments')).toBe('csf-comments-storage');
    expect(storeNameOf('csf-comments-storage:state')).toBe('csf-comments-storage');
    expect(isStateRecord('csf-comments-storage:state')).toBe(true);
    expect(isStateRecord('csf-comments-storage.comments')).toBe(false);
  });
});
