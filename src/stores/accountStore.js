import { create } from 'zustand';

// Signed-in server account's display name (server mode only). Deliberately NOT part of userStore:
// that store persists through the sync engine, so any set() on it can queue writes before the
// first-sign-in import decision has been made.
const useAccountStore = create((set) => ({
  accountDisplayName: null,
  setAccountDisplayName: (name) => set({ accountDisplayName: name ?? null })
}));

export default useAccountStore;
