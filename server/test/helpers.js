import request from 'supertest';
import { openDb } from '../db.js';
import { createApp } from '../app.js';

export function makeApp() {
  const db = openDb(':memory:');
  const app = createApp({ db });
  return { app, db };
}

export const JSON_HEADERS = { 'Content-Type': 'application/json' };

export async function setupAdmin(app, overrides = {}) {
  const agent = request.agent(app);
  const body = { username: 'admin', displayName: 'Admin', password: 'correct horse battery', ...overrides };
  await agent.post('/api/auth/setup').set(JSON_HEADERS).send(body).expect(200);
  return agent;
}
