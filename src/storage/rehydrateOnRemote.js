import { onRemoteChange } from './syncEngine';
import { storeNameOf } from './diff';

const stores = new Map(); // persist name -> zustand store
export const registerStoreForRehydrate = (store) => {
  const name = store.persist?.getOptions?.().name;
  if (name) stores.set(name, store);
};

export function whenAllHydrated() {
  return Promise.all([...stores.values()].map((s) =>
    s.persist.hasHydrated() ? Promise.resolve() : new Promise((resolve) => { const off = s.persist.onFinishHydration(() => { off(); resolve(); }); })
  )).then(() => undefined);
}

// Re-read every registered store from the (freshly bootstrapped) engine cache.
export function rehydrateAll() {
  return Promise.all([...stores.values()].map((s) => s.persist.rehydrate())).then(() => undefined);
}

let wired = false;
export function wireRemoteRehydration() {
  if (wired) return;
  wired = true;
  onRemoteChange((collections) => {
    const names = new Set([...collections].map(storeNameOf));
    names.forEach((n) => { stores.get(n)?.persist.rehydrate(); });
  });
}
