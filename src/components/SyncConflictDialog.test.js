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
  expect(screen.getByText(/a teammate deleted this record, but you changed it/i)).toBeInTheDocument();
  userEvent.click(screen.getByRole('button', { name: /keep mine/i }));
  expect(engine.resolveConflict).toHaveBeenLastCalledWith('k1', 'mine');
  userEvent.click(screen.getByRole('button', { name: /take theirs/i }));
  expect(engine.resolveConflict).toHaveBeenLastCalledWith('k1', 'theirs');
});

describe('field-level preview', () => {
  const show = (c) => { act(() => { useSyncStatus.setState({ conflicts: [{ ...conflict, ...c }] }); }); return render(<SyncConflictDialog />); };
  test('undefined and null never throw and say which side deleted the record', () => {
    show({ mine: undefined, theirs: null });
    expect(screen.getByText(/you deleted this record/i)).toBeInTheDocument();
  });
  test('lists only the fields that differ, with both values', () => {
    show({ mine: { title: 'same', status: 'open', n: 1 }, theirs: { title: 'same', status: 'closed', n: 1 } });
    expect(screen.getByText('status')).toBeInTheDocument();
    expect(screen.getByText('"open"')).toBeInTheDocument();
    expect(screen.getByText('"closed"')).toBeInTheDocument();
    expect(screen.queryByText('title')).not.toBeInTheDocument();
  });
  test('long values are truncated with an ellipsis', () => {
    show({ mine: { text: 'x'.repeat(2000) }, theirs: { text: 'y' } });
    const cell = screen.getByText(/xxxx/);
    expect(cell.textContent.endsWith('…')).toBe(true);
    expect(cell.textContent.length).toBeLessThan(100);
  });
});
