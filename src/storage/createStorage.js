import { createJSONStorage } from 'zustand/middleware';
import { quotaSafeLocalStorage } from '../utils/safeStorage';
import { STORE_CONFIGS } from './storeConfigs';
import { createServerStateStorage } from './serverStorage';

export const isServerMode = () => process.env.REACT_APP_SERVER_MODE === 'true';

export function createStorage(storeName) {
  const config = STORE_CONFIGS[storeName];
  if (!isServerMode() || !config || config.local) {
    return createJSONStorage(() => quotaSafeLocalStorage);
  }
  return createJSONStorage(() => createServerStateStorage(storeName, config));
}
