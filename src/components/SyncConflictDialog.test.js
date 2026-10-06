import React from 'react';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SyncConflictDialog from './SyncConflictDialog';
import { useSyncStatus } from '../storage/syncEngine';
import * as engine from '../storage/syncEngine';

jest.mock('../storage/syncEngine', () => {
  const actual = jest.requireActual('../storage/syncEngine');
  return { ...actual, resolveConflict: jest.fn() };
});

const conflict = { key: 'k1', collection: 'commentsStore.comments', id: 'c1', mine: { a: 1 }, theirs: null };

afterEach(() => { act(() => { useSyncStatus.setState({ conflicts: [] }); }); });

test('renders nothing without conflicts', () => {
  const { container } = render(<SyncConflictDialog />);
  expect(container).toBeEmptyDOMElement();
});

test('buttons resolve the first conflict', async () => {
  act(() => { useSyncStatus.setState({ conflicts: [conflict] }); });
  render(<SyncConflictDialog />);
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(screen.getByText('(deleted)')).toBeInTheDocument();
  userEvent.click(screen.getByRole('button', { name: /keep mine/i }));
  expect(engine.resolveConflict).toHaveBeenLastCalledWith('k1', 'mine');
  userEvent.click(screen.getByRole('button', { name: /take theirs/i }));
  expect(engine.resolveConflict).toHaveBeenLastCalledWith('k1', 'theirs');
});

describe('preview robustness', () => {
  const show = (c) => { act(() => { useSyncStatus.setState({ conflicts: [{ ...conflict, ...c }] }); }); return render(<SyncConflictDialog />); };
  test('undefined and null render as deleted without throwing', () => {
    show({ mine: undefined, theirs: null });
    expect(screen.getAllByText('(deleted)')).toHaveLength(2);
  });
  test('long values are truncated with an ellipsis', () => {
    show({ mine: { text: 'x'.repeat(2000) } });
    const pre = screen.getAllByText(/xxxx/)[0];
    expect(pre.textContent.length).toBe(601);
    expect(pre.textContent.endsWith('…')).toBe(true);
  });
});
