import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import toast from 'react-hot-toast';
import ImportLocalDataPrompt from './ImportLocalDataPrompt';
import * as local from '../storage/importLocalData';
import { isServerMode } from '../storage/createStorage';
import { downloadJSON } from '../utils/dataExport';
import useAuthStore from '../storage/authStore';

jest.mock('react-hot-toast', () => ({ __esModule: true, default: { success: jest.fn(), error: jest.fn() } }));
jest.mock('../storage/createStorage', () => ({ isServerMode: jest.fn() }));
jest.mock('../utils/dataExport', () => ({ downloadJSON: jest.fn() }));
jest.mock('../storage/importLocalData', () => ({
  hasLocalData: jest.fn(),
  importLocalData: jest.fn(),
  buildLocalBackup: jest.fn(() => ({ keys: {} })),
  IMPORT_DECLINED_KEY: 'csf-import-declined',
  IMPORT_DONE_KEY: 'csf-import-done'
}));

beforeEach(() => {
  localStorage.clear();
  jest.clearAllMocks();
  isServerMode.mockReturnValue(true);
  local.hasLocalData.mockReturnValue(true);
  useAuthStore.setState({ user: { id: 'u1' } });
});

const importBtn = () => screen.getByRole('button', { name: /import into server/i });

test('renders nothing and touches nothing in local mode', () => {
  isServerMode.mockReturnValue(false);
  localStorage.setItem('csf-comments-storage', 'x');
  const { container } = render(<ImportLocalDataPrompt />);
  expect(container).toBeEmptyDOMElement();
  expect(local.hasLocalData).not.toHaveBeenCalled();
  expect(local.importLocalData).not.toHaveBeenCalled();
  expect(localStorage.length).toBe(1);
});

test('hidden when there is no local data', () => {
  local.hasLocalData.mockReturnValue(false);
  const { container } = render(<ImportLocalDataPrompt />);
  expect(container).toBeEmptyDOMElement();
});

test.each(['csf-import-declined', 'csf-import-done'])('hidden when %s is set', (key) => {
  localStorage.setItem(key, '1');
  const { container } = render(<ImportLocalDataPrompt />);
  expect(container).toBeEmptyDOMElement();
});

test('import is unavailable until a backup is downloaded or skipped', () => {
  render(<ImportLocalDataPrompt />);
  expect(importBtn()).toBeDisabled();
  userEvent.click(screen.getByRole('button', { name: /download a backup/i }));
  expect(downloadJSON).toHaveBeenCalledTimes(1);
  expect(importBtn()).toBeEnabled();
});

test('skip backup enables import; success imports with the user id and sets the done flag', async () => {
  local.importLocalData.mockResolvedValue({ imported: 5 });
  const { container } = render(<ImportLocalDataPrompt />);
  userEvent.click(screen.getByRole('button', { name: /skip backup/i }));
  userEvent.click(importBtn());
  await waitFor(() => expect(container).toBeEmptyDOMElement());
  expect(local.importLocalData).toHaveBeenCalledWith({ userId: 'u1' });
  expect(toast.success).toHaveBeenCalledWith('Imported 5 records');
  expect(localStorage.getItem('csf-import-done')).toBe('1');
  expect(localStorage.getItem('csf-import-declined')).toBeNull();
});

test('409 workspace-not-empty shows the not-imported message, sets declined, hides', async () => {
  const err = new Error('conflict'); err.status = 409; err.body = { error: 'workspace-not-empty' };
  local.importLocalData.mockRejectedValue(err);
  const { container } = render(<ImportLocalDataPrompt />);
  userEvent.click(screen.getByRole('button', { name: /skip backup/i }));
  userEvent.click(importBtn());
  await waitFor(() => expect(container).toBeEmptyDOMElement());
  expect(toast.error).toHaveBeenCalledWith("This workspace already has data, so your browser's data was not imported. It is still saved in this browser.");
  expect(localStorage.getItem('csf-import-declined')).toBe('1');
});

test('other errors toast, keep the prompt, and allow a retry', async () => {
  local.importLocalData.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ imported: 1 });
  render(<ImportLocalDataPrompt />);
  userEvent.click(screen.getByRole('button', { name: /skip backup/i }));
  userEvent.click(importBtn());
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Import failed. Your browser data was not changed.'));
  expect(localStorage.getItem('csf-import-declined')).toBeNull();
  await waitFor(() => expect(importBtn()).toBeEnabled());
  userEvent.click(importBtn());
  await waitFor(() => expect(toast.success).toHaveBeenCalled());
  expect(local.importLocalData).toHaveBeenCalledTimes(2);
});

test('a second click while importing does not start a second import', async () => {
  let resolve;
  local.importLocalData.mockReturnValue(new Promise((r) => { resolve = r; }));
  render(<ImportLocalDataPrompt />);
  userEvent.click(screen.getByRole('button', { name: /skip backup/i }));
  userEvent.click(importBtn());
  userEvent.click(importBtn());
  expect(local.importLocalData).toHaveBeenCalledTimes(1);
  expect(importBtn()).toBeDisabled();
  expect(screen.getByRole('button', { name: /not now/i })).toBeDisabled();
  await act(async () => { resolve({ imported: 1 }); });
});

test('Not now sets the declined flag and hides', () => {
  const { container } = render(<ImportLocalDataPrompt />);
  userEvent.click(screen.getByRole('button', { name: /not now/i }));
  expect(container).toBeEmptyDOMElement();
  expect(localStorage.getItem('csf-import-declined')).toBe('1');
});
