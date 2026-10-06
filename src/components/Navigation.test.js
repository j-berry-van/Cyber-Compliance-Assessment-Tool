import React from 'react';
import { render, screen, within } from '@testing-library/react';
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

test('server mode renders exactly one sign-out button even with the mobile drawer open', () => {
  process.env.REACT_APP_SERVER_MODE = 'true';
  useAuthStore.setState({ user: { id: 1, displayName: 'Ada' }, logout: jest.fn() });
  renderNav();
  userEvent.click(screen.getByRole('button', { name: /open navigation/i }));
  expect(screen.getByRole('menu')).toBeInTheDocument();
  // one in the rail (CSS-hidden on narrow screens) and exactly one in the drawer
  expect(within(screen.getByRole('menu')).getAllByRole('button', { name: /sign out/i })).toHaveLength(1);
  expect(screen.getAllByRole('button', { name: /sign out/i })).toHaveLength(2);
});
