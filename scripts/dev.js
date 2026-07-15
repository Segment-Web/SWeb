// One-command local development: starts an embedded PostgreSQL (no Docker, no
// admin rights), points the server at it, enables the test mail transport so
// login codes come back in the response, then boots the Segment server.
//
// Run: pnpm dev:local

import { existsSync } from 'node:fs';
import EmbeddedPostgres from 'embedded-postgres';

const DATA_DIR = './data/pgdata';
const USER = 'segment';
const PASSWORD = 'segment';
const DATABASE = 'segment';
const PORT = 5432;

const postgres = new EmbeddedPostgres({
  databaseDir: DATA_DIR,
  user: USER,
  password: PASSWORD,
  port: PORT,
  persistent: true,
  // The cluster must be UTF-8: room titles and icons are Russian text and emoji.
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
});

const fresh = !existsSync(DATA_DIR);
if (fresh) {
  console.log('[dev] initialising a local PostgreSQL cluster (first run only)...');
  await postgres.initialise();
}
await postgres.start();
if (fresh) await postgres.createDatabase(DATABASE);
console.log(`[dev] PostgreSQL ready on 127.0.0.1:${PORT} (data in ${DATA_DIR})`);

process.env.DATABASE_URL ||= `postgresql://${USER}:${PASSWORD}@localhost:${PORT}/${DATABASE}`;
process.env.SMTP_TEST ||= '1';

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  try { await postgres.stop(); } catch { /* already down */ }
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

console.log('[dev] login codes are returned in the response (SMTP_TEST) and auto-filled in the UI');
await import('../apps/server/src/index.js');
