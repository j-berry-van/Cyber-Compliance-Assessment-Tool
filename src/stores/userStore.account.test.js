import useUserStore from './userStore';

beforeEach(() => {
  localStorage.clear();
  useUserStore.setState({ users: [{ id: 1, name: 'Pat' }], currentUserId: null, accountDisplayName: null });
});

test('local mode: no account name falls back to System', () => {
  expect(useUserStore.getState().getCurrentUserName()).toBe('System');
});

test('uses the account display name when no participant is selected', () => {
  useUserStore.getState().setAccountDisplayName('Kim');
  expect(useUserStore.getState().getCurrentUserName()).toBe('Kim');
});

test('a resolvable participant wins over the account display name', () => {
  useUserStore.getState().setAccountDisplayName('Kim');
  useUserStore.getState().setCurrentUser(1);
  expect(useUserStore.getState().getCurrentUserName()).toBe('Pat');
});

test('accountDisplayName is never persisted; the persisted shape is unchanged', () => {
  useUserStore.getState().setAccountDisplayName('Kim');
  useUserStore.getState().setCurrentUser(1);
  const raw = localStorage.getItem('csf-users-storage');
  expect(raw).not.toContain('Kim');
  expect(raw).not.toContain('accountDisplayName');
  const persisted = JSON.parse(raw);
  expect(Object.keys(persisted.state).sort()).toEqual(['currentUserId', 'users']);
  expect(persisted.version).toBe(3);
});
