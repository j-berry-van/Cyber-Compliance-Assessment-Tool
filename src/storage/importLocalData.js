import { api } from './serverClient';
import { bootstrap } from './syncEngine';
import { rehydrateAll } from './rehydrateOnRemote';
import { STORE_CONFIGS } from './storeConfigs';
import { toRecords, isStateRecord } from './diff';

// Either key means "do not prompt again". The browser's localStorage copy is never deleted.
export const IMPORT_DECLINED_KEY = 'csf-import-declined';
export const IMPORT_DONE_KEY = 'csf-import-done';

const syncedNames = () => Object.entries(STORE_CONFIGS).filter(([, c]) => !c.local).map(([n]) => n);

function readPersisted(name) {
  try {
    const persisted = JSON.parse(localStorage.getItem(name) || 'null');
    if (!persisted || typeof persisted !== 'object' || !persisted.state || typeof persisted.state !== 'object') return null;
    return persisted;
  } catch {
    return null;
  }
}

// The persisted `version` is kept in the :state record, so each store's own migrate() runs on rehydrate.
export function collectLocalRecords() {
  const records = [];
  const storeNames = [];
  syncedNames().forEach((name) => {
    const persisted = readPersisted(name);
    if (!persisted) return;
    const { records: recs } = toRecords(name, STORE_CONFIGS[name], persisted);
    Object.values(recs).forEach((r) => records.push({ collection: r.collection, id: r.id, data: r.data }));
    storeNames.push(name);
  });
  return { records, storeNames };
}

// A store key that only holds empty collections and no shared fields is not "data".
export const hasLocalData = () => collectLocalRecords().records.some((r) => (
  !isStateRecord(r.collection) || Object.keys(r.data?.shared || {}).length > 0
));

// Raw copy of this browser's synced store keys (what is about to be imported), for the pre-import backup.
export function buildLocalBackup() {
  const keys = {};
  syncedNames().forEach((name) => {
    const raw = localStorage.getItem(name);
    if (raw !== null) keys[name] = raw;
  });
  return { format: 'csf-browser-local-backup', createdAt: new Date().toISOString(), keys };
}

export async function importLocalData({ userId } = {}) {
  const { records } = collectLocalRecords();
  const result = await api('POST', '/import', { records });
  await bootstrap(userId ?? 'anonymous');
  await rehydrateAll();
  return result;
}
