import React from 'react';
import { render, screen } from '@testing-library/react';
import AssessmentActivity from './AssessmentActivity';
import useAuthStore from '../storage/authStore';
import * as engine from '../storage/syncEngine';
import { api } from '../storage/serverClient';

jest.mock('../storage/serverClient', () => ({ api: jest.fn(), ApiError: class extends Error {}, setUnauthorizedHandler: jest.fn() }));

const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();

beforeEach(async () => {
  engine.reset();
  api.mockReset();
  api.mockResolvedValueOnce({ cursor: 1, records: [
    { collection: 'csf-assessments-storage.assessments', id: 'A1', data: { id: 'A1' }, version: 1, updatedBy: 2, updatedAt: hoursAgo(3) }
  ] });
  await engine.bootstrap();
  useAuthStore.setState({ directory: new Map([[2, { displayName: 'Bo' }]]) });
  process.env.REACT_APP_SERVER_MODE = 'true';
});
afterEach(() => { delete process.env.REACT_APP_SERVER_MODE; });

test('server mode shows last editor, relative time and recent editors', () => {
  render(<AssessmentActivity assessmentId="A1" />);
  expect(screen.getByText('Last edited by Bo · 3 hours ago')).toBeInTheDocument();
  expect(screen.getByText('Active in the last 24h: Bo')).toBeInTheDocument();
});

test('hidden when there is no server activity for the assessment', () => {
  const { container } = render(<AssessmentActivity assessmentId="NOPE" />);
  expect(container).toBeEmptyDOMElement();
});

test('hidden in local mode', () => {
  delete process.env.REACT_APP_SERVER_MODE;
  const { container } = render(<AssessmentActivity assessmentId="A1" />);
  expect(container).toBeEmptyDOMElement();
});
