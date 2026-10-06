import { toRecords, fromRecords, diffRecords } from './diff';
import { enqueue, readCollection, whenReady, removeStoreRecords, setSyncProblem } from './syncEngine';
import { setPersistedVersion } from './persistedVersions';

const readLocal = (key) => {
  try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch { return {}; }
};
const writeLocal = (key, obj) => {
  try { localStorage.setItem(key, JSON.stringify(obj)); } catch { /* per-device prefs only */ }
};

export function createServerStateStorage(storeName, config) {
  const localKey = `${storeName}.local`;
  let snapshot = {};
  let loaded = false;
  let warned = false;

  return {
    async getItem() {
      await whenReady();
      const persisted = fromRecords(storeName, config, readCollection, readLocal(localKey));
      if (!persisted) { snapshot = {}; loaded = true; return null; }
      snapshot = toRecords(storeName, config, persisted).records;
      if (typeof persisted.version === 'number') setPersistedVersion(storeName, persisted.version);
      loaded = true;
      return JSON.stringify(persisted);
    },

    async setItem(_name, value) {
      await whenReady();
      if (!loaded) {
        // zustand does not gate setItem on hydration; diffing now would delete server records.
        if (!warned) { warned = true; console.warn(`[sync] ignoring write to ${storeName} before it was loaded from the server`); }
        return;
      }
      const persisted = JSON.parse(value);
      const local = {};
      (config.localFields || []).forEach((f) => { if (f in persisted.state) local[f] = persisted.state[f]; });
      writeLocal(localKey, local);

      const { records, problems } = toRecords(storeName, config, persisted);
      setSyncProblem(storeName, problems.length
        ? `${problems.length} item(s) in ${storeName} have no id (or a duplicate id) and were not saved to the server`
        : null);
      const { puts, deletes } = diffRecords(snapshot, records);
      snapshot = records;
      if (typeof persisted.version === 'number') setPersistedVersion(storeName, persisted.version);
      if (puts.length || deletes.length) enqueue({ puts, deletes });
    },

    async removeItem() {
      await whenReady();
      snapshot = {};
      removeStoreRecords(storeName);
    }
  };
}
