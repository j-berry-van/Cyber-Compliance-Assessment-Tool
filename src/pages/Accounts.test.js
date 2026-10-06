import React from 'react';
import { render, screen, within, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import toast from 'react-hot-toast';
import Accounts from './Accounts';
import { api } from '../storage/serverClient';
import useAuthStore from '../storage/authStore';
import useUserStore from '../stores/userStore';

jest.mock('../storage/serverClient', () => ({ api: jest.fn(), ApiError: class extends Error {}, setUnauthorizedHandler: jest.fn() }));
jest.mock('react-hot-toast', () => ({ __esModule: true, default: { success: jest.fn(), error: jest.fn() } }));

const users = [
  { id: 1, username: 'admin', displayName: 'Admin', isAdmin: true, disabled: false, participantId: null },
  { id: 2, username: 'sam', displayName: 'Sam', isAdmin: false, disabled: false, participantId: 7 }
];

beforeEach(() => {
  api.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  api.mockImplementation(async (m, p) => (m === 'GET' && p === '/users' ? users : { ok: true }));
  useAuthStore.setState({ status: 'authenticated', user: { id: 1, username: 'admin', displayName: 'Admin', isAdmin: true, participantId: null }, directory: new Map() });
  useUserStore.setState({ users: [{ id: 7, name: 'Pat' }] });
});

afterEach(() => { jest.restoreAllMocks(); });

// user-event v13 clicks are synchronous; flush the async handlers they start.
const click = async (el) => { userEvent.click(el); await act(async () => {}); };
const choose = async (el, v) => { userEvent.selectOptions(el, v); await act(async () => {}); };

test('admin sees all accounts and can create one', async () => {
  render(<Accounts />);
  expect(await screen.findByText('sam')).toBeInTheDocument();
  await userEvent.type(screen.getByLabelText(/new username/i), 'kim');
  await userEvent.type(screen.getByLabelText(/new display name/i), 'Kim');
  await userEvent.type(screen.getByLabelText(/temporary password/i), 'temporary password 1');
  await click(screen.getByRole('button', { name: /add account/i }));
  expect(api).toHaveBeenCalledWith('POST', '/users', expect.objectContaining({ username: 'kim', displayName: 'Kim' }));
  await waitFor(() => expect(screen.getByLabelText(/new username/i)).toHaveValue(''));
});

test('username conflict on create shows a message', async () => {
  api.mockImplementation(async (m, p) => {
    if (m === 'GET') return users;
    throw Object.assign(new Error('x'), { status: 409, body: { error: 'username-taken' } });
  });
  render(<Accounts />);
  await screen.findByText('sam');
  await userEvent.type(screen.getByLabelText(/new username/i), 'sam');
  await userEvent.type(screen.getByLabelText(/new display name/i), 'Sam');
  await userEvent.type(screen.getByLabelText(/temporary password/i), 'temporary password 1');
  await click(screen.getByRole('button', { name: /add account/i }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('That username is taken.'));
});

test('admin can disable another account but not their own', async () => {
  render(<Accounts />);
  const row = (await screen.findByText('sam')).closest('tr');
  await click(within(row).getByRole('button', { name: /disable/i }));
  expect(api).toHaveBeenCalledWith('PATCH', '/users/2', { disabled: true });
  const own = screen.getByText('admin').closest('tr');
  expect(within(own).queryByRole('button', { name: /disable|enable/i })).not.toBeInTheDocument();
});

test('last-admin conflict shows a specific message', async () => {
  api.mockImplementation(async (m) => {
    if (m === 'GET') return users;
    throw Object.assign(new Error('x'), { status: 409, body: { error: 'last-admin' } });
  });
  render(<Accounts />);
  const row = (await screen.findByText('sam')).closest('tr');
  await click(within(row).getByRole('button', { name: /disable/i }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('There must be at least one active administrator.'));
});

test('participant select shows the current link and PATCHes null for none', async () => {
  render(<Accounts />);
  await screen.findByText('sam');
  const select = screen.getByLabelText('Participant for sam');
  expect(select).toHaveValue('7');
  await choose(select, '');
  expect(api).toHaveBeenCalledWith('PATCH', '/users/2', { participantId: null });
});

test('participant select sends the original id type (number stays number, string stays string)', async () => {
  useUserStore.setState({ users: [{ id: 7, name: 'Pat' }, { id: 'abc-123', name: 'Uma' }] });
  render(<Accounts />);
  await screen.findByText('sam');
  const select = screen.getByLabelText('Participant for sam');
  await choose(select, 'abc-123');
  expect(api).toHaveBeenCalledWith('PATCH', '/users/2', { participantId: 'abc-123' });
  await choose(select, '7');
  expect(api).toHaveBeenCalledWith('PATCH', '/users/2', { participantId: 7 });
});

test('a string participant link is shown as selected', async () => {
  useUserStore.setState({ users: [{ id: 'abc-123', name: 'Uma' }] });
  api.mockImplementation(async (m, p) => (m === 'GET' ? [{ ...users[1], participantId: 'abc-123' }] : { ok: true }));
  render(<Accounts />);
  await screen.findByText('sam');
  expect(screen.getByLabelText('Participant for sam')).toHaveValue('abc-123');
});

test('works with an empty participants list', async () => {
  useUserStore.setState({ users: [] });
  render(<Accounts />);
  await screen.findByText('sam');
  const options = within(screen.getByLabelText('Participant for sam')).getAllByRole('option');
  expect(options).toHaveLength(1);
  expect(options[0]).toHaveTextContent('— none —');
});

describe('reset password', () => {
  test('cancel or empty does nothing', async () => {
    const prompt = jest.spyOn(window, 'prompt').mockReturnValueOnce(null).mockReturnValueOnce('');
    render(<Accounts />);
    const row = (await screen.findByText('sam')).closest('tr');
    await click(within(row).getByRole('button', { name: /reset password/i }));
    await click(within(row).getByRole('button', { name: /reset password/i }));
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(api).not.toHaveBeenCalledWith('PATCH', expect.anything(), expect.anything());
    expect(toast.error).not.toHaveBeenCalled();
  });

  test('short password toasts an error and does not call the API', async () => {
    jest.spyOn(window, 'prompt').mockReturnValue('short');
    render(<Accounts />);
    const row = (await screen.findByText('sam')).closest('tr');
    await click(within(row).getByRole('button', { name: /reset password/i }));
    expect(toast.error).toHaveBeenCalledWith('Password must be at least 10 characters.');
    expect(api).not.toHaveBeenCalledWith('PATCH', expect.anything(), expect.anything());
  });

  test('valid password PATCHes the right user', async () => {
    jest.spyOn(window, 'prompt').mockReturnValue('a long enough password');
    render(<Accounts />);
    const row = (await screen.findByText('sam')).closest('tr');
    await click(within(row).getByRole('button', { name: /reset password/i }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('PATCH', '/users/2', { password: 'a long enough password' }));
  });
});

test('a failed GET /users shows an inline error with retry', async () => {
  let fail = true;
  api.mockImplementation(async (m, p) => {
    if (m === 'GET' && fail) throw new Error('boom');
    return users;
  });
  render(<Accounts />);
  expect(await screen.findByRole('alert')).toHaveTextContent(/could not load accounts/i);
  fail = false;
  await click(screen.getByRole('button', { name: /retry/i }));
  expect(await screen.findByText('sam')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

describe('change own password', () => {
  beforeEach(() => {
    useAuthStore.setState({ user: { id: 2, username: 'sam', displayName: 'Sam', isAdmin: false, participantId: null } });
  });

  const fill = async () => {
    await userEvent.type(screen.getByLabelText(/current password/i), 'old password long');
    await userEvent.type(screen.getByLabelText(/^new password/i), 'new password long');
    await click(screen.getByRole('button', { name: /change my password/i }));
  };

  test('non-admins do not see admin controls; success clears fields and toasts', async () => {
    render(<Accounts />);
    expect(screen.queryByLabelText(/new username/i)).not.toBeInTheDocument();
    await fill();
    expect(api).toHaveBeenCalledWith('POST', '/auth/password', { currentPassword: 'old password long', newPassword: 'new password long' });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Password changed'));
    expect(screen.getByLabelText(/current password/i)).toHaveValue('');
    expect(screen.getByLabelText(/^new password/i)).toHaveValue('');
    expect(api).not.toHaveBeenCalledWith('GET', '/users');
  });

  test('wrong current password (403) toasts and keeps the fields', async () => {
    api.mockRejectedValue(Object.assign(new Error('x'), { status: 403, body: { error: 'forbidden' } }));
    render(<Accounts />);
    await fill();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Current password is incorrect.'));
    expect(screen.getByLabelText(/current password/i)).toHaveValue('old password long');
    expect(screen.getByLabelText(/^new password/i)).toHaveValue('new password long');
  });
});
