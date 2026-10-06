import toast from 'react-hot-toast';
import { api } from './serverClient';
import useAuthStore from './authStore';
import { flushNow } from './syncEngine';

jest.mock('./syncEngine', () => ({ ...jest.requireActual('./syncEngine'), flushNow: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./serverClient', () => ({ api: jest.fn(), setUnauthorizedHandler: () => {} }));
jest.mock('react-hot-toast', () => ({ __esModule: true, default: { error: jest.fn() } }));

const realLocation = window.location;
let reload;
beforeEach(() => {
  reload = jest.fn();
  delete window.location;
  window.location = { ...realLocation, reload };
  useAuthStore.setState({ error: null });
});
afterEach(() => { window.location = realLocation; });

test('failed logout does not reload and surfaces the error', async () => {
  api.mockRejectedValue(new Error('net'));
  await useAuthStore.getState().logout();
  expect(reload).not.toHaveBeenCalled();
  expect(useAuthStore.getState().error).toMatch(/could not sign out/i);
  expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/could not sign out/i));
});

test('successful logout reloads', async () => {
  api.mockResolvedValue({ ok: true });
  await useAuthStore.getState().logout();
  expect(api).toHaveBeenCalledWith('POST', '/auth/logout', {});
  expect(reload).toHaveBeenCalledTimes(1);
});

test('logout flushes unsent changes before signing out', async () => {
  const order = [];
  flushNow.mockImplementationOnce(async () => { order.push('flush'); });
  api.mockImplementation(async (m, p) => { order.push(`${m} ${p}`); return { ok: true }; });
  await useAuthStore.getState().logout();
  expect(order).toEqual(['flush', 'POST /auth/logout']);
});

test('logout still signs out when the flush fails', async () => {
  flushNow.mockRejectedValueOnce(new Error('offline'));
  api.mockResolvedValue({ ok: true });
  await useAuthStore.getState().logout();
  expect(reload).toHaveBeenCalledTimes(1);
});
