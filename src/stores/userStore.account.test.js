import useUserStore from './userStore';
import useAccountStore from './accountStore';

beforeEach(() => {
  localStorage.clear();
  useUserStore.setState({ users: [{ id: 1, name: 'Pat' }], currentUserId: null });
  useAccountStore.setState({ accountDisplayName: null });
});

test('local mode: no account name falls back to System', () => {
  expect(useUserStore.getState().getCurrentUserName()).toBe('System');
});

test('uses the account display name when no participant is selected', () => {
  useAccountStore.getState().setAccountDisplayName('Kim');
  expect(useUserStore.getState().getCurrentUserName()).toBe('Kim');
});

test('a resolvable participant wins over the account display name', () => {
  useAccountStore.getState().setAccountDisplayName('Kim');
  useUserStore.getState().setCurrentUser(1);
  expect(useUserStore.getState().getCurrentUserName()).toBe('Pat');
});

test('accountDisplayName is never persisted; the persisted shape is unchanged', () => {
  useAccountStore.getState().setAccountDisplayName('Kim');
  useUserStore.getState().setCurrentUser(1);
  const raw = localStorage.getItem('csf-users-storage');
  expect(raw).not.toContain('Kim');
  expect(raw).not.toContain('accountDisplayName');
  const persisted = JSON.parse(raw);
  expect(Object.keys(persisted.state).sort()).toEqual(['currentUserId', 'users']);
  expect(persisted.version).toBe(3);
});

describe('comment authorship', () => {
  const useCommentsStore = require('./commentsStore').default;
  const add = () => {
    useCommentsStore.setState({ comments: [] });
    useCommentsStore.getState().addComment({ targetType: 'finding', targetId: 'f1', text: 'hello' });
    return useCommentsStore.getState().comments[0];
  };
  test('account name with no participant', () => {
    useAccountStore.getState().setAccountDisplayName('Kim');
    expect(add().authorName).toBe('Kim');
  });
  test('participant name wins and authorId is the participant id', () => {
    useAccountStore.getState().setAccountDisplayName('Kim');
    useUserStore.getState().setCurrentUser(1);
    const c = add();
    expect(c.authorName).toBe('Pat');
    expect(c.authorId).toBe(1);
  });
  test('neither gives System with null authorId', () => {
    const c = add();
    expect(c.authorName).toBe('System');
    expect(c.authorId).toBeNull();
  });
});
