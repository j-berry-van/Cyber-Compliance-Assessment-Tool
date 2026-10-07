import './env.js';
import path from 'node:path';
import fs from 'node:fs';
import { createApp } from './app.js';
import { openDb } from './db.js';

const PORT = process.env.PORT || 4000;
const multiuser = process.env.MULTIUSER === 'true';
let db = null;
if (multiuser) {
  const dir = path.resolve(process.env.DATA_DIR || './data');
  fs.mkdirSync(dir, { recursive: true });
  db = openDb(path.join(dir, 'csf.db'));
}
const staticDir = process.env.STATIC_DIR ? path.resolve(process.env.STATIC_DIR) : null;
createApp({ db, staticDir }).listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}${multiuser ? ' (multi-user)' : ''}`);
});
