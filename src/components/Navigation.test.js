import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Navigation from './Navigation';
import useAuthStore from '../storage/authStore';

jest.mock('../storage/serverClient', () => ({ api: jest.fn(), setUnauthorizedHandler: jest.fn() }));

const renderNav = () => render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><Navigation /></MemoryRouter>);

afterEach(() => { delete process.env.REACT_APP_SERVER_MODE; });

test('local mode has no sign-out button', () => {
  renderNav();
  expect(screen.queryByRole('button', { name: /sign out/i })).not.toBeInTheDocument();
});

test('server mode shows the display name and signs out', () => {
  process.env.REACT_APP_SERVER_MODE = 'true';
  const logout = jest.fn();
  useAuthStore.setState({ user: { id: 1, displayName: 'Ada' }, logout });
  renderNav();
  expect(screen.getByText(/Signed in as Ada/)).toBeInTheDocument();
  userEvent.click(screen.getByRole('button', { name: /sign out/i }));
  expect(logout).toHaveBeenCalled();
});
