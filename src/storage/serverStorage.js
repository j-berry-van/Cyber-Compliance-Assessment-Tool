import { toRecords, fromRecords, diffRecords } from './diff';
import { enqueue, readCollection, whenReady, removeStoreRecords, setSyncProblem } from './syncEngine';
import { setPersistedVersion } from './persistedVersions';
import { getRegisteredStore } from './rehydrateOnRemote';

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
  let blocked = false; // the loaded data cannot be adopted by the store, so nothing may be diffed against it

  return {
    async getItem() {
      await whenReady();
      const persisted = fromRecords(storeName, config, readCollection, readLocal(localKey));
      if (!persisted) { snapshot = {}; blocked = false; loaded = true; return null; }
      snapshot = toRecords(storeName, config, persisted).records;
      // zustand discards persisted data whose version differs from the store's when there is no
      // migrate(); the store would then start from defaults and the next write would delete (or
      // overwrite) the whole team's records. Refuse to write this store instead.
      const opts = getRegisteredStore(storeName)?.persist?.getOptions?.();
      blocked = !!opts && typeof persisted.version === 'number' && typeof opts.version === 'number'
        && persisted.version !== opts.version && typeof opts.migrate !== 'function';
      setSyncProblem(storeName, blocked
        ? `${storeName} was saved by a different app version and cannot be loaded. Changes to it are not being saved.`
        : null);
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
      if (blocked) return;
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
      if (blocked) return;
      snapshot = {};
      removeStoreRecords(storeName);
    }
  };
}
