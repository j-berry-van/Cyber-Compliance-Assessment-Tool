import { merge3, deepEqual, diffPaths } from './merge';

test('changes to different fields combine', () => {
  const base = { a: 1, b: 1, nested: { x: 1, y: 1 } };
  const r = merge3(base, { ...base, a: 2, nested: { x: 2, y: 1 } }, { ...base, b: 2, nested: { x: 1, y: 2 } });
  expect(r).toEqual({ ok: true, value: { a: 2, b: 2, nested: { x: 2, y: 2 } } });
});

test('the same field changed to different values is a conflict; to the same value is not', () => {
  expect(merge3({ a: 1 }, { a: 2 }, { a: 3 }).ok).toBe(false);
  expect(merge3({ a: 1 }, { a: 2 }, { a: 2 })).toEqual({ ok: true, value: { a: 2 } });
});

test('id-keyed arrays merge per item: edits to different items, additions from both sides', () => {
  const base = { rows: [{ id: 1, v: 'a' }, { id: 2, v: 'b' }] };
  const mine = { rows: [{ id: 1, v: 'A' }, { id: 2, v: 'b' }, { id: 3, v: 'mine' }] };
  const theirs = { rows: [{ id: 1, v: 'a' }, { id: 2, v: 'B' }, { id: 4, v: 'theirs' }] };
  const r = merge3(base, mine, theirs);
  expect(r.ok).toBe(true);
  expect(r.value.rows).toEqual([{ id: 1, v: 'A' }, { id: 2, v: 'B' }, { id: 4, v: 'theirs' }, { id: 3, v: 'mine' }]);
});

test('a delete against an untouched item wins; a delete against an edited item conflicts', () => {
  const base = { rows: [{ id: 1, v: 'a' }, { id: 2, v: 'b' }] };
  expect(merge3(base, { rows: [{ id: 2, v: 'b' }] }, base).value.rows).toEqual([{ id: 2, v: 'b' }]);
  expect(merge3(base, { rows: [{ id: 2, v: 'b' }] }, { rows: [{ id: 1, v: 'X' }, { id: 2, v: 'b' }] }).ok).toBe(false);
});

test('arrays without unique ids are atomic', () => {
  expect(merge3({ t: [1] }, { t: [1, 2] }, { t: [1, 3] }).ok).toBe(false);
  expect(merge3({ t: [1] }, { t: [1, 2] }, { t: [1] }).value).toEqual({ t: [1, 2] });
});

test('deepEqual ignores undefined-valued keys', () => {
  expect(deepEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
  expect(deepEqual([1, { a: 2 }], [1, { a: 3 }])).toBe(false);
});

test('diffPaths names the differing fields and items', () => {
  const d = diffPaths({ a: 1, rows: [{ id: 'x', v: 1 }] }, { a: 1, rows: [{ id: 'x', v: 2 }] });
  expect(d).toEqual([{ path: 'rows[x].v', mine: '1', theirs: '2' }]);
});
