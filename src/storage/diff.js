export const STATE_ID = 'state';

export const isStateRecord = (collection) => collection.endsWith(':state');
export const storeNameOf = (collection) => collection.split(/[.:]/)[0];
export const recordKey = (collection, id) => `${collection}\u0000${id}`;
const collectionName = (storeName, field) => `${storeName}.${field}`;
const stateCollection = (storeName) => `${storeName}:state`;

const stable = (value) => JSON.stringify(value, (_k, v) =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? Object.keys(v).sort().reduce((o, k) => { o[k] = v[k]; return o; }, {})
    : v
);

const keyFn = (spec) => (typeof spec === 'function' ? spec : (item) => item?.[spec]);

export function toRecords(storeName, config, persisted) {
  const { state = {}, version = 0 } = persisted || {};
  const collections = config.collections || {};
  const local = config.localFields || [];
  const records = {};
  const order = {};
  const problems = [];

  Object.entries(collections).forEach(([field, spec]) => {
    const list = state[field];
    if (!Array.isArray(list)) return;
    const idOf = keyFn(spec);
    const seen = new Set();
    order[field] = [];
    list.forEach((item, index) => {
      let raw;
      try { raw = idOf(item); } catch (e) { raw = null; }
      const id = raw === undefined || raw === null || raw === '' ? null : String(raw);
      if (id === null || seen.has(id)) { problems.push({ field, index, id }); return; }
      seen.add(id);
      order[field].push(id);
      const collection = collectionName(storeName, field);
      records[recordKey(collection, id)] = { collection, id, data: item };
    });
  });

  const shared = {};
  Object.entries(state).forEach(([field, value]) => {
    if (!(field in collections) && !local.includes(field)) shared[field] = value;
  });
  const sc = stateCollection(storeName);
  records[recordKey(sc, STATE_ID)] = { collection: sc, id: STATE_ID, data: { version, shared, order } };
  return { records, problems };
}

export function fromRecords(storeName, config, readCollection, local = {}) {
  const collections = config.collections || {};
  const stateRec = readCollection(stateCollection(storeName)).get(STATE_ID);
  const fieldItems = {};
  let any = !!stateRec;
  Object.keys(collections).forEach((field) => {
    fieldItems[field] = readCollection(collectionName(storeName, field));
    if (fieldItems[field].size) any = true;
  });
  if (!any) return null;

  const state = { ...(stateRec?.shared || {}), ...local };
  Object.keys(collections).forEach((field) => {
    const items = fieldItems[field];
    const ordered = stateRec?.order?.[field];
    if (!ordered && items.size === 0) return; // never written: keep the store's default
    const list = [];
    const used = new Set();
    (Array.isArray(ordered) ? ordered : []).forEach((id) => {
      if (items.has(id) && !used.has(id)) { list.push(items.get(id)); used.add(id); }
    });
    items.forEach((data, id) => { if (!used.has(id)) list.push(data); });
    state[field] = list;
  });
  // No state record: omit `version` so zustand adopts the state instead of trying to migrate from 0.
  return stateRec ? { state, version: stateRec.version ?? 0 } : { state };
}

export function diffRecords(prev, next) {
  const puts = [];
  const deletes = [];
  Object.entries(next).forEach(([key, rec]) => {
    const old = prev[key];
    if (!old || stable(old.data) !== stable(rec.data)) puts.push({ collection: rec.collection, id: rec.id, data: rec.data });
  });
  Object.entries(prev).forEach(([key, rec]) => {
    if (!next[key] && !isStateRecord(rec.collection)) deletes.push({ collection: rec.collection, id: rec.id });
  });
  return { puts, deletes };
}
