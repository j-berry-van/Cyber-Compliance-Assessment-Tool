import { shouldLoadSeed } from './seedGuard';

test('server mode with existing data skips the seed load', () => {
  expect(shouldLoadSeed({ serverMode: true, existingCount: 5 })).toBe(false);
});
test('server mode with an empty store loads the seed', () => {
  expect(shouldLoadSeed({ serverMode: true, existingCount: 0 })).toBe(true);
});
test('local mode always loads the seed', () => {
  expect(shouldLoadSeed({ serverMode: false, existingCount: 5 })).toBe(true);
  expect(shouldLoadSeed({ serverMode: false, existingCount: 0 })).toBe(true);
});
