import { create } from 'zustand';
import { api, ApiError } from './serverClient';
import { recordKey, isStateRecord, storeNameOf } from './diff';
import { merge3, deepEqual } from './merge';

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
let flushPromise = Promise.resolve();
let rerun = false;
let backoff = 0;
let held = false;             // sends paused (AuthGate decides about importing before anything is written)
let emptyAtBootstrap = false; // server workspace had no live records and the outbox was empty at bootstrap
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

// Several tabs of one user share this key. Each entry records the tab that queued it; a tab rewrites
// only its own entries and keeps the others' (loadOutbox at bootstrap adopts everything left behind).
const tabId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const readStoredOutbox = () => {
  try { return JSON.parse(localStorage.getItem(outboxKey()) || '[]'); } catch { return []; }
};
const persistOutbox = () => {
  try {
    const mine = [...outbox.values()].map((o) => ({ ...o, owner: tabId }));
    const keys = new Set(mine.map((o) => recordKey(o.collection, o.id)));
    const foreign = readStoredOutbox().filter((o) => o.owner && o.owner !== tabId && !keys.has(recordKey(o.collection, o.id)));
    localStorage.setItem(outboxKey(), JSON.stringify([...foreign, ...mine]));
  } catch { /* quota: keep in memory */ }
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

export async function bootstrap(forUser = 'anonymous', { hold = false } = {}) {
  userId = String(forUser ?? 'anonymous');
  const res = await api('GET', '/records?since=0');
  cache = new Map(res.records.map((r) => [recordKey(r.collection, r.id), entryOf(r)]));
  cursor = res.cursor;
  outbox = loadOutbox();
  conflicts = loadConflicts();
  if (hold) { held = true; clearTimeout(flushTimer); }
  emptyAtBootstrap = outbox.size === 0 && ![...cache.values()].some((e) => !e.deleted);
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

// True when the server workspace had no live records and nothing was waiting to be sent when it was
// loaded. Recorded at bootstrap so writes made afterwards (e.g. first-sign-in store defaults) cannot
// hide an empty workspace from the import check.
export const isWorkspaceEmpty = () => emptyAtBootstrap;

export function releaseFlush() {
  if (!held) return;
  held = false;
  if (outbox.size) scheduleFlush(0);
}

// Drops unsent changes. Used after a successful import into an empty workspace: whatever was queued
// since bootstrap is store defaults, which must not overwrite the imported records.
export function clearOutbox() {
  outbox = new Map();
  persistOutbox();
  refreshStatus();
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
  const have = cache.get(key);
  const baseVersion = prev ? prev.baseVersion : (have?.version ?? 0);
  // What the editor started from, so a version conflict can be merged field by field.
  const base = prev ? prev.base : (have && !have.deleted ? have.data : undefined);
  outbox.set(key, { collection, id, op, data: op === 'put' ? data : null, baseVersion, base });
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
  if (held) return;
  flushTimer = setTimeout(() => { flushNow(); }, ms);
}

// Resolves when the flush in progress (or the one started now) finishes; sign-out awaits it.
export function flushNow() {
  if (held) return Promise.resolve();
  if (flushing) { rerun = true; return flushPromise; }
  flushPromise = runFlush();
  return flushPromise;
}

async function runFlush() {
  flushing = true;
  let failed = false;
  let rejected = 0;
  const mergedCollections = new Set();
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
        const permanent = e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 409 && e.status !== 408 && e.status !== 429;
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
        const mine = newest.op === 'put' ? newest.data : null;
        const theirData = theirs && !theirs.deleted ? theirs.data : null;
        if (deepEqual(mine, theirData)) { // both sides ended up identical: adopt the server's copy
          if (outbox.get(key) === newest) outbox.delete(key);
          continue;
        }
        if (newest.op === 'put' && theirs && !theirs.deleted && newest.base !== undefined) {
          const merged = merge3(newest.base, newest.data, theirs.data);
          if (merged.ok) { // different fields changed: combine and send again on top of their version
            outbox.set(key, { ...newest, data: merged.value, baseVersion: theirs.version, base: theirs.data });
            mergedCollections.add(op.collection);
            rerun = true;
            continue;
          }
        }
        conflicts.set(key, {
          key, collection: op.collection, id: op.id,
          mine,
          theirs: theirData,
          theirsVersion: theirs?.version ?? 0
        });
        outbox.delete(key);
        persistConflicts();
      }
    }
    if (mergedCollections.size) emit(mergedCollections); // stores pick up the merged result
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
    if (have && have.version >= r.version) {
      // Our own echoed write (same version): fill the server metadata without emitting a change.
      // A LOWER polled version is stale (a flush landed after the poll was sent) and is ignored.
      if (have.version === r.version && have.updatedBy == null) { have.updatedBy = r.updatedBy; have.updatedAt = r.updatedAt; }
      return;
    }
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
    outbox.set(key, { collection: c.collection, id: c.id, op: c.mine === null ? 'delete' : 'put', data: c.mine, baseVersion: c.theirsVersion, base: c.theirs ?? undefined });
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
  cursor = 0; flushing = false; rerun = false; backoff = 0; held = false; emptyAtBootstrap = false;
  listeners.clear();
  problems.clear();
  newReady();
  useSyncStatus.setState({ state: 'idle', pending: 0, conflicts: [], lastSaved: null, error: null });
}
