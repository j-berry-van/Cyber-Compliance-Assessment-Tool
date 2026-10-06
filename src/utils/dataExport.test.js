import { readPersistedVersion } from './dataExport';
import { setPersistedVersion } from '../storage/persistedVersions';

describe('readPersistedVersion', () => {
  afterEach(() => localStorage.clear());

  test('reads the version from localStorage in local mode', () => {
    localStorage.setItem('local-key', JSON.stringify({ state: {}, version: 4 }));
    expect(readPersistedVersion('local-key')).toBe(4);
  });

  test('returns null for an absent key', () => {
    expect(readPersistedVersion('absent-key')).toBeNull();
  });

  test('prefers the server-mode registry over localStorage', () => {
    localStorage.setItem('k', JSON.stringify({ state: {}, version: 2 }));
    setPersistedVersion('k', 7);
    expect(readPersistedVersion('k')).toBe(7);
  });
});
