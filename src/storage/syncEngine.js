import { create } from 'zustand';
import { api, ApiError } from './serverClient';
import { recordKey, isStateRecord, storeNameOf } from './diff';

const OUTBOX_KEY = 'csf-sync-outbox';
let cfg = { debounceMs: 500, pollMs: 20000 };
export const configureEngine = (next) => { cfg = { ...cfg, ...next }; };

export const useSyncStatus = create(() => ({ state: 'idle', pending: 0, conflicts: [], lastSaved: null }));

const listeners = new Set();
export const onRemoteChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

let cache = new Map();      // key -> {collection, id, data, version, deleted, updatedBy, updatedAt}
let outbox = new Map();     // key -> {collection, id, op, data, baseVersion}
let conflicts = new Map();  // key -> {key, collection, id, mine, theirs, theirsVersion}
let cursor = 0;
let flushTimer = null;
let pollTimer = null;
let flushing = false;
let rerun = false;
let backoff = 0;
let focusHandler = null;
let ready;
let markReady;
const newReady = () => { ready = new Promise((resolve) => { markReady = resolve; }); };
newReady();
export const whenReady = () => ready;

const entryOf = (r) => ({
  collection: r.collection, id: r.id, data: r.data, version: r.version, deleted: !!r.deleted,
  updatedBy: r.updatedBy ?? null, updatedAt: r.updatedAt ?? null
});

const persistOutbox = () => {
  try { localStorage.setItem(OUTBOX_KEY, JSON.stringify([...outbox.values()])); } catch { /* quota: keep in memory */ }
};
const loadOutbox = () => {
  try {
    return new Map(JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]').map((o) => [recordKey(o.collection, o.id), o]));
  } catch { return new Map(); }
};

const refreshStatus = (patch = {}) => {
  useSyncStatus.setState({
    pending: outbox.size,
    conflicts: [...conflicts.values()].map(({ key, collection, id, mine, theirs }) => ({ key, collection, id, mine, theirs })),
    ...patch
  });
};

const emit = (collections) => listeners.forEach((fn) => fn(collections));

export async function bootstrap() {
  const res = await api('GET', '/records?since=0');
  cache = new Map(res.records.map((r) => [recordKey(r.collection, r.id), entryOf(r)]));
  cursor = res.cursor;
  outbox = loadOutbox();
  conflicts = new Map();
  refreshStatus({ state: 'idle' });
  markReady();
  if (outbox.size) scheduleFlush(0);
}

export function readCollection(collection) {
  const out = new Map();
  cache.forEach((e) => { if (e.collection === collection && !e.deleted) out.set(e.id, e.data); });
  outbox.forEach((o) => {
    if (o.collection !== collection) return;
    if (o.op === 'put') out.set(o.id, o.data); else out.delete(o.id);
  });
  conflicts.forEach((c) => {
    if (c.collection !== collection) return;
    if (c.mine === null) out.delete(c.id); else out.set(c.id, c.mine);
  });
  return out;
}

export function getEntries(collection) {
  const rows = [];
  cache.forEach((e) => { if (e.collection === collection && !e.deleted) rows.push(e); });
  return rows;
}

const queue = (collection, id, op, data) => {
  const key = recordKey(collection, id);
  if (conflicts.has(key)) { conflicts.get(key).mine = op === 'put' ? data : null; return; }
  const prev = outbox.get(key);
  const baseVersion = prev ? prev.baseVersion : (cache.get(key)?.version ?? 0);
  outbox.set(key, { collection, id, op, data: op === 'put' ? data : null, baseVersion });
};

export function enqueue({ puts = [], deletes = [] }) {
  puts.forEach((p) => queue(p.collection, p.id, 'put', p.data));
  deletes.forEach((d) => queue(d.collection, d.id, 'delete', null));
  persistOutbox();
  refreshStatus();
  scheduleFlush(cfg.debounceMs);
}

function scheduleFlush(ms) {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => { flushNow(); }, ms);
}

export async function flushNow() {
  if (flushing) { rerun = true; return; }
  flushing = true;
  let failed = false;
  refreshStatus({ state: 'saving' });
  try {
    for (const [key, op] of [...outbox]) {
      if (outbox.get(key) !== op) continue;
      const path = `/records/${encodeURIComponent(op.collection)}/${encodeURIComponent(op.id)}`;
      try {
        const result = op.op === 'put'
          ? await api('PUT', path, { data: op.data, baseVersion: op.baseVersion, force: isStateRecord(op.collection) })
          : await api('DELETE', path, { baseVersion: op.baseVersion });
        cache.set(key, {
          collection: op.collection, id: op.id, data: op.data, version: result.version,
          deleted: op.op === 'delete', updatedBy: null, updatedAt: null
        });
        if (outbox.get(key) === op) outbox.delete(key);
        else if (outbox.get(key)) outbox.get(key).baseVersion = result.version;
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 409)) throw e;
        const newest = outbox.get(key) || op;
        const theirs = e.body?.current;
        if (theirs) cache.set(key, entryOf({ collection: op.collection, id: op.id, ...theirs }));
        conflicts.set(key, {
          key, collection: op.collection, id: op.id,
          mine: newest.op === 'put' ? newest.data : null,
          theirs: theirs && !theirs.deleted ? theirs.data : null,
          theirsVersion: theirs?.version ?? 0
        });
        outbox.delete(key);
      }
    }
    backoff = 0;
    refreshStatus({ state: 'idle', lastSaved: Date.now() });
  } catch (e) {
    failed = true;
    if (e instanceof ApiError && e.status === 401) {
      refreshStatus({ state: 'offline' }); // unauthorized handler (authStore) shows the login screen; outbox is kept
    } else {
      backoff = Math.min(backoff ? backoff * 2 : 2000, 60000);
      refreshStatus({ state: 'offline' });
      scheduleFlush(backoff);
    }
  } finally {
    flushing = false;
    persistOutbox();
    refreshStatus();
    if (rerun && !failed && outbox.size) scheduleFlush(cfg.debounceMs);
    rerun = false;
  }
}

export async function pollNow() {
  const res = await api('GET', `/records?since=${cursor}`);
  const changed = new Set();
  res.records.forEach((r) => {
    const key = recordKey(r.collection, r.id);
    const have = cache.get(key);
    if (have && have.version >= r.version) return;
    cache.set(key, entryOf(r));
    changed.add(r.collection);
    const c = conflicts.get(key);
    if (c) { c.theirs = r.deleted ? null : r.data; c.theirsVersion = r.version; }
  });
  cursor = res.cursor;
  refreshStatus();
  if (changed.size) emit(changed);
}

export function resolveConflict(key, choice) {
  const c = conflicts.get(key);
  if (!c) return;
  conflicts.delete(key);
  if (choice === 'mine') {
    outbox.set(key, { collection: c.collection, id: c.id, op: c.mine === null ? 'delete' : 'put', data: c.mine, baseVersion: c.theirsVersion });
    persistOutbox();
    refreshStatus();
    scheduleFlush(cfg.debounceMs);
  } else {
    refreshStatus();
    emit(new Set([c.collection]));
  }
}

export function removeStoreRecords(storeName) {
  const deletes = [];
  cache.forEach((e) => {
    if (storeNameOf(e.collection) === storeName && !e.deleted && !isStateRecord(e.collection)) {
      deletes.push({ collection: e.collection, id: e.id });
    }
  });
  enqueue({ deletes });
}

export function start() {
  stop();
  pollTimer = setInterval(() => { pollNow().catch(() => {}); }, cfg.pollMs);
  focusHandler = () => { pollNow().catch(() => {}); };
  if (typeof window !== 'undefined') window.addEventListener('focus', focusHandler);
}

export function stop() {
  clearInterval(pollTimer);
  clearTimeout(flushTimer);
  if (focusHandler && typeof window !== 'undefined') window.removeEventListener('focus', focusHandler);
  focusHandler = null;
}

export function reset() {
  stop();
  cache = new Map(); outbox = new Map(); conflicts = new Map();
  cursor = 0; flushing = false; rerun = false; backoff = 0;
  listeners.clear();
  newReady();
  useSyncStatus.setState({ state: 'idle', pending: 0, conflicts: [], lastSaved: null });
}
