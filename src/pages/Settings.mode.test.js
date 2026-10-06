import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import Settings from './Settings';

const renderSettings = () => render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><Settings /></MemoryRouter>);

describe('Settings backup and storage wording', () => {
  const prev = process.env.REACT_APP_SERVER_MODE;
  afterEach(() => {
    if (prev === undefined) delete process.env.REACT_APP_SERVER_MODE; else process.env.REACT_APP_SERVER_MODE = prev;
  });

  test('local mode warns that data lives in this browser', () => {
    delete process.env.REACT_APP_SERVER_MODE;
    renderSettings();
    expect(screen.getByText(/Important: Local Data Storage/)).toBeInTheDocument();
    expect(screen.getByText(/stored in your browser's local storage/)).toBeInTheDocument();
    expect(screen.getByText(/Pack data stays on this machine/)).toBeInTheDocument();
    expect(screen.getByText(/separate local file that stays on this machine/)).toBeInTheDocument();
  });

  test('server mode says data is on the server and backups are the administrator\'s job', () => {
    process.env.REACT_APP_SERVER_MODE = 'true';
    renderSettings();
    expect(screen.getByText('Your data is saved on the server')).toBeInTheDocument();
    expect(screen.getByText(/administrator's responsibility/)).toBeInTheDocument();
    expect(screen.queryByText(/Important: Local Data Storage/)).not.toBeInTheDocument();
    expect(screen.queryByText(/stored in your browser's local storage/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Pack data stays on this machine/)).not.toBeInTheDocument();
    expect(screen.getByText(/Imported pack data is saved to your organization/)).toBeInTheDocument();
    expect(screen.queryByText(/separate local file that stays on this machine/)).not.toBeInTheDocument();
    expect(screen.getByText(/separate local file that is saved to your organization/)).toBeInTheDocument();
  });
});
