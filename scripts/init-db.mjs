import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../lib/store.mjs';
const path = resolve(dirname(fileURLToPath(import.meta.url)), '../data/sparely.db');
try {
  if (process.env.SPARELY_DATABASE_URL || process.env.DATABASE_URL) throw new Error('A cloud database is configured. Refusing to initialize an unrelated SQLite database.');
  mkdirSync(dirname(path), {
    recursive: true
  });
  // Exclusive creation: this command can never reset an existing database.
  closeSync(openSync(path, 'wx'));
  const store = new Store(path);
  await store.ready;
  await store.close();
  console.log('Initialized a new demo database. Existing databases are never overwritten.');
} catch (error) {
  console.error(error.code === 'EEXIST' ? 'Database already exists. Initialization was not performed.' : `Initialization failed: ${error.message}`);
  process.exitCode = 1;
}
