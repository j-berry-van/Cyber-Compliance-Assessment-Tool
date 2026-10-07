import React from 'react';
import { render, screen, act } from '@testing-library/react';
import AutoSaveIndicator from './AutoSaveIndicator';
import { useSyncStatus } from '../storage/syncEngine';
import useCSFStore from '../stores/csfStore';

const setSync = (patch) => act(() => { useSyncStatus.setState({ state: 'idle', pending: 0, lastSaved: null, error: null, ...patch }); });

afterEach(() => {
  delete process.env.REACT_APP_SERVER_MODE;
  setSync({});
  act(() => { useCSFStore.setState({ hasUnsavedChanges: false, isSaving: false, lastSaved: null }); });
});

describe('server mode', () => {
  beforeEach(() => { process.env.REACT_APP_SERVER_MODE = 'true'; });

  test('error', () => {
    setSync({ error: 'boom' });
    render(<AutoSaveIndicator />);
    expect(screen.getByRole('alert')).toHaveTextContent('boom');
  });
  test('offline shows pending count', () => {
    setSync({ state: 'offline', pending: 3 });
    render(<AutoSaveIndicator />);
    expect(screen.getByText(/Unsaved changes \(3\)/)).toBeInTheDocument();
  });
  test('saving', () => {
    setSync({ state: 'saving' });
    render(<AutoSaveIndicator />);
    expect(screen.getByText('Saving...')).toBeInTheDocument();
  });
  test('saved', () => {
    setSync({ lastSaved: Date.now() });
    render(<AutoSaveIndicator />);
    expect(screen.getByText(/Saved at/)).toBeInTheDocument();
  });
  test('ignores the local csfStore', () => {
    act(() => { useCSFStore.setState({ isSaving: true }); });
    const { container } = render(<AutoSaveIndicator />);
    expect(container).toBeEmptyDOMElement();
  });
});

test('local mode still renders from useCSFStore', () => {
  act(() => { useCSFStore.setState({ isSaving: true }); });
  render(<AutoSaveIndicator />);
  expect(screen.getByText('Saving...')).toBeInTheDocument();
});
