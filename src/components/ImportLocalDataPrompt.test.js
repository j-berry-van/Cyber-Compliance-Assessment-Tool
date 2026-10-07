import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import toast from 'react-hot-toast';
import ImportLocalDataPrompt from './ImportLocalDataPrompt';
import * as local from '../storage/importLocalData';
import { downloadJSON } from '../utils/dataExport';
import useAuthStore from '../storage/authStore';

jest.mock('react-hot-toast', () => ({ __esModule: true, default: { success: jest.fn(), error: jest.fn() } }));
jest.mock('../utils/dataExport', () => ({ downloadJSON: jest.fn() }));
jest.mock('../storage/importLocalData', () => ({
  collectLocalRecords: jest.fn(),
  importLocalData: jest.fn(),
  buildLocalBackup: jest.fn(() => ({ keys: {} })),
  IMPORT_DECLINED_KEY: 'csf-import-declined',
  IMPORT_DONE_KEY: 'csf-import-done'
}));

let onResolved;
beforeEach(() => {
  localStorage.clear();
  jest.clearAllMocks();
  onResolved = jest.fn();
  local.collectLocalRecords.mockReturnValue({ records: [], storeNames: [], problems: [] });
  useAuthStore.setState({ user: { id: 'u1' } });
});

const renderPrompt = () => render(<ImportLocalDataPrompt onResolved={onResolved} />);
const importBtn = () => screen.getByRole('button', { name: /import into server/i });
const skip = () => userEvent.click(screen.getByRole('button', { name: /skip backup/i }));
const apiErr = (status, body) => Object.assign(new Error('x'), { status, body });

test('is a labelled full-screen region and describes the backup as raw', () => {
  renderPrompt();
  expect(screen.getByRole('region', { name: /import this browser/i })).toBeInTheDocument();
  expect(screen.getByText(/raw copy of this browser's data \(not restorable through Settings/i)).toBeInTheDocument();
});

test('import is unavailable until a backup is downloaded or skipped', () => {
  renderPrompt();
  expect(importBtn()).toBeDisabled();
  userEvent.click(screen.getByRole('button', { name: /download a backup/i }));
  expect(downloadJSON).toHaveBeenCalledTimes(1);
  expect(importBtn()).toBeEnabled();
});

test('success imports with the user id, sets the done flag and resolves', async () => {
  local.importLocalData.mockResolvedValue({ imported: 5 });
  renderPrompt();
  skip();
  userEvent.click(importBtn());
  await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
  expect(local.importLocalData).toHaveBeenCalledWith({ userId: 'u1' });
  expect(toast.success).toHaveBeenCalledWith('Imported 5 records');
  expect(localStorage.getItem('csf-import-done')).toBe('1');
  expect(localStorage.getItem('csf-import-declined')).toBeNull();
});

test('409 workspace-not-empty shows the not-imported message, sets declined, resolves', async () => {
  local.importLocalData.mockRejectedValue(apiErr(409, { error: 'workspace-not-empty' }));
  renderPrompt();
  skip();
  userEvent.click(importBtn());
  await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
  expect(toast.error).toHaveBeenCalledWith("This workspace already has data, so your browser's data was not imported. It is still saved in this browser.");
  expect(localStorage.getItem('csf-import-declined')).toBe('1');
});

test('other errors toast, keep the prompt, and allow a retry', async () => {
  local.importLocalData.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ imported: 1 });
  renderPrompt();
  skip();
  userEvent.click(importBtn());
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Import failed. Your browser data was not changed.'));
  expect(onResolved).not.toHaveBeenCalled();
  expect(localStorage.getItem('csf-import-declined')).toBeNull();
  await waitFor(() => expect(importBtn()).toBeEnabled());
  userEvent.click(importBtn());
  await waitFor(() => expect(onResolved).toHaveBeenCalled());
  expect(local.importLocalData).toHaveBeenCalledTimes(2);
});

test('413 shows the too-large message and keeps the prompt', async () => {
  local.importLocalData.mockRejectedValue(apiErr(413, { error: 'too-large' }));
  renderPrompt();
  skip();
  userEvent.click(importBtn());
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Your browser data is too large to import in one step (limit 25 MB).'));
  expect(onResolved).not.toHaveBeenCalled();
  expect(toast.error).not.toHaveBeenCalledWith('Import failed. Your browser data was not changed.');
  await waitFor(() => expect(importBtn()).toBeEnabled());
});

test('a refresh failure after a successful POST never says "Import failed" and offers Reload', async () => {
  const reload = jest.fn();
  const original = window.location;
  Object.defineProperty(window, 'location', { configurable: true, value: { ...original, reload } });
  local.importLocalData.mockRejectedValue(Object.assign(new Error('r'), { refreshFailed: true, result: { imported: 4 } }));
  renderPrompt();
  skip();
  userEvent.click(importBtn());
  await screen.findByRole('button', { name: /reload/i });
  expect(toast.success).toHaveBeenCalledWith('Imported 4 records. Reload the page to see them.');
  expect(toast.error).not.toHaveBeenCalled();
  expect(localStorage.getItem('csf-import-done')).toBe('1');
  expect(onResolved).not.toHaveBeenCalled();
  userEvent.click(screen.getByRole('button', { name: /reload/i }));
  expect(reload).toHaveBeenCalled();
  Object.defineProperty(window, 'location', { configurable: true, value: original });
});

test('a second click while importing does not start a second import', async () => {
  let resolve;
  local.importLocalData.mockReturnValue(new Promise((r) => { resolve = r; }));
  renderPrompt();
  skip();
  userEvent.click(importBtn());
  userEvent.click(importBtn());
  expect(local.importLocalData).toHaveBeenCalledTimes(1);
  expect(importBtn()).toBeDisabled();
  expect(screen.getByRole('button', { name: /not now/i })).toBeDisabled();
  await act(async () => { resolve({ imported: 1 }); });
});

test('Not now sets the declined flag and resolves', () => {
  renderPrompt();
  userEvent.click(screen.getByRole('button', { name: /not now/i }));
  expect(onResolved).toHaveBeenCalled();
  expect(localStorage.getItem('csf-import-declined')).toBe('1');
  expect(local.importLocalData).not.toHaveBeenCalled();
});

test('warns with the count of items that cannot be synced; import stays allowed', () => {
  local.collectLocalRecords.mockReturnValue({ records: [], storeNames: [], problems: [{ store: 's', field: 'f', index: 0 }, { store: 's', field: 'f', index: 3 }] });
  renderPrompt();
  expect(screen.getByRole('alert')).toHaveTextContent("2 item(s) in this browser's data cannot be synced (missing or duplicate id) and will stay only in this browser");
  skip();
  expect(importBtn()).toBeEnabled();
});

test('no warning when every item can be synced', () => {
  renderPrompt();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
