import { getRegisteredStoreNames, whenAllHydrated } from './rehydrateOnRemote';
import './registerStores';

test('importing registerStores registers every synced store (and no per-browser one)', async () => {
  expect([...getRegisteredStoreNames()].sort()).toEqual([
    'csf-artifacts-storage', 'csf-assessments-storage', 'csf-audit-log', 'csf-comments-storage',
    'csf-controls-storage', 'csf-evaluations-storage', 'csf-findings-storage', 'csf-frameworks-storage',
    'csf-inventory-storage', 'csf-metrics-storage', 'csf-org-profile-storage', 'csf-requirements-storage',
    'csf-users-storage'
  ]);
  await expect(whenAllHydrated()).resolves.toBeUndefined();
});
