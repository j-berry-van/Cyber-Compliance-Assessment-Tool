// Three-way merge of JSON records, used when a save hits a version conflict. `base` is what the
// editor started from, `mine` is their edit and `theirs` is what the server holds now. Changes to
// different fields (or different items of an id-keyed array) combine; the same field changed to
// different values is a real conflict and the caller falls back to asking the person.
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

const keyedById = (arr) => {
  if (!Array.isArray(arr) || !arr.every((x) => isObj(x) && (typeof x.id === 'string' || typeof x.id === 'number'))) return null;
  const map = new Map(arr.map((x) => [x.id, x]));
  return map.size === arr.length ? map : null;
};

const FAIL = { ok: false };
const ok = (value) => ({ ok: true, value });

export function merge3(base, mine, theirs) {
  if (deepEqual(mine, theirs)) return ok(mine);
  if (deepEqual(mine, base)) return ok(theirs);
  if (deepEqual(theirs, base)) return ok(mine);

  if (isObj(mine) && isObj(theirs)) {
    const b = isObj(base) ? base : {};
    const out = {};
    const keys = new Set([...Object.keys(b), ...Object.keys(mine), ...Object.keys(theirs)]);
    for (const k of keys) {
      const r = merge3(b[k], mine[k], theirs[k]);
      if (!r.ok) return FAIL;
      if (r.value !== undefined) out[k] = r.value;
    }
    return ok(out);
  }

  const bm = keyedById(base ?? []);
  const mm = keyedById(mine);
  const tm = keyedById(theirs);
  if (bm && mm && tm) {
    const merged = new Map();
    const order = [...tm.keys(), ...[...mm.keys()].filter((id) => !tm.has(id))];
    for (const id of [...new Set([...bm.keys(), ...order])]) {
      const r = merge3(bm.get(id), mm.get(id), tm.get(id));
      if (!r.ok) return FAIL;
      if (r.value !== undefined) merged.set(id, r.value);
    }
    return ok(order.filter((id) => merged.has(id)).map((id) => merged.get(id))
      .concat([...merged.keys()].filter((id) => !order.includes(id)).map((id) => merged.get(id))));
  }
  return FAIL;
}

const show = (v) => {
  if (v === undefined) return '(not set)';
  const text = JSON.stringify(v);
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
};

// The fields where two versions differ, as short readable lines for the conflict dialog.
export function diffPaths(mine, theirs, prefix = '', out = [], limit = 12) {
  if (out.length >= limit) return out;
  if (isObj(mine) && isObj(theirs)) {
    for (const k of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
      diffPaths(mine[k], theirs[k], prefix ? `${prefix}.${k}` : k, out, limit);
    }
    return out;
  }
  const mm = keyedById(mine);
  const tm = keyedById(theirs);
  if (mm && tm) {
    for (const id of new Set([...mm.keys(), ...tm.keys()])) {
      diffPaths(mm.get(id), tm.get(id), `${prefix}[${id}]`, out, limit);
    }
    return out;
  }
  if (!deepEqual(mine, theirs)) out.push({ path: prefix || '(record)', mine: show(mine), theirs: show(theirs) });
  return out;
}
