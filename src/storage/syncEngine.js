import { create } from 'zustand';
import { api, ApiError } from './serverClient';
import { recordKey, isStateRecord, storeNameOf } from './diff';

let userId = 'anonymous';
const outboxKey = () => `csf-sync-outbox:${userId}`;
const conflictsKey = () => `csf-sync-conflicts:${userId}`;
let cfg = { debounceMs: 500, pollMs: 20000 };
export const configureEngine = (next) => { cfg = { ...cfg, ...next }; };

export const useSyncStatus = create(() => ({ state: 'idle', pending: 0, conflicts: [], lastSaved: null, error: null }));

const problems = new Map(); // source -> message
const firstProblem = () => {
  for (const m of problems.values()) if (m) return m;
  return null;
};
export function setSyncProblem(source, message) {
  if (message) problems.set(source, message); else problems.delete(source);
  useSyncStatus.setState({ error: firstProblem() });
}

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
  try { localStorage.setItem(outboxKey(), JSON.stringify([...outbox.values()])); } catch { /* quota: keep in memory */ }
};
const loadOutbox = () => {
  try {
    return new Map(JSON.parse(localStorage.getItem(outboxKey()) || '[]').map((o) => [recordKey(o.collection, o.id), o]));
  } catch { return new Map(); }
};

const persistConflicts = () => {
  try { localStorage.setItem(conflictsKey(), JSON.stringify([...conflicts.values()])); } catch { /* quota: keep in memory */ }
};
const loadConflicts = () => {
  try {
    return new Map(JSON.parse(localStorage.getItem(conflictsKey()) || '[]').map((c) => [c.key, c]));
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

export async function bootstrap(forUser = 'anonymous') {
  userId = String(forUser ?? 'anonymous');
  const res = await api('GET', '/records?since=0');
  cache = new Map(res.records.map((r) => [recordKey(r.collection, r.id), entryOf(r)]));
  cursor = res.cursor;
  outbox = loadOutbox();
  conflicts = loadConflicts();
  conflicts.forEach((c, key) => {
    const have = cache.get(key);
    if (have && have.version > (c.theirsVersion ?? 0)) {
      c.theirs = have.deleted ? null : have.data;
      c.theirsVersion = have.version;
    }
  });
  persistConflicts();
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

// True when the server workspace has no live records and nothing is waiting to be sent.
export function isWorkspaceEmpty() {
  if (outbox.size) return false;
  for (const e of cache.values()) if (!e.deleted) return false;
  return true;
}

export function getEntries(collection) {
  const rows = [];
  cache.forEach((e) => { if (e.collection === collection && !e.deleted) rows.push(e); });
  return rows;
}

const queue = (collection, id, op, data) => {
  const key = recordKey(collection, id);
  if (conflicts.has(key)) { conflicts.get(key).mine = op === 'put' ? data : null; persistConflicts(); return; }
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
  let rejected = 0;
  refreshStatus({ state: 'saving' });
  try {
    for (const [key, op] of [...outbox]) {
      if (outbox.get(key) !== op) continue;
      const path = `/records/${encodeURIComponent(op.collection)}/${encodeURIComponent(op.id)}`;
      try {
        const result = op.op === 'put'
          ? await api('PUT', path, { data: op.data, baseVersion: op.baseVersion, force: isStateRecord(op.collection) })
          : await api('DELETE', path, { baseVersion: op.baseVersion });
        if (!(cache.get(key)?.version >= result.version)) {
          cache.set(key, {
            collection: op.collection, id: op.id, data: op.data, version: result.version,
            deleted: op.op === 'delete', updatedBy: null, updatedAt: null
          });
        }
        if (outbox.get(key) === op) outbox.delete(key);
        else if (outbox.get(key)) outbox.get(key).baseVersion = result.version;
      } catch (e) {
        const permanent = e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 409;
        if (permanent) {
          rejected += 1;
          if (outbox.get(key) === op) outbox.delete(key);
          continue;
        }
        if (!(e instanceof ApiError && e.status === 409)) throw e;
        const newest = outbox.get(key) || op;
        let theirs = e.body?.current;
        if (theirs) {
          const have = cache.get(key);
          if (have && have.version > theirs.version) theirs = have;
          else cache.set(key, entryOf({ collection: op.collection, id: op.id, ...theirs }));
        }
        conflicts.set(key, {
          key, collection: op.collection, id: op.id,
          mine: newest.op === 'put' ? newest.data : null,
          theirs: theirs && !theirs.deleted ? theirs.data : null,
          theirsVersion: theirs?.version ?? 0
        });
        outbox.delete(key);
        persistConflicts();
      }
    }
    backoff = 0;
    setSyncProblem('flush', rejected ? `${rejected} change(s) could not be saved (rejected by the server)` : null);
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
  persistConflicts();
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
  if (focusHandler && typeof window !== 'undefined') window.removeEventListener('focus', focusHandler);
  focusHandler = null;
}

export function reset() {
  stop();
  clearTimeout(flushTimer);
  cache = new Map(); outbox = new Map(); conflicts = new Map();
  cursor = 0; flushing = false; rerun = false; backoff = 0;
  listeners.clear();
  problems.clear();
  newReady();
  useSyncStatus.setState({ state: 'idle', pending: 0, conflicts: [], lastSaved: null, error: null });
}
