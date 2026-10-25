// Database operations: `backup`, `migrate`, `restore-check [dir] [--keep]`, `status`.
// Output is counts/hashes/ids only; never row contents.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { Database } from '../lib/database.mjs';
import { Store } from '../lib/store.mjs';
import { applyMigrations, migrationStatus } from '../lib/migrations.mjs';
import { dropSchema, exportDatabase, latestRecoveryPoint, primaryKeys, readRecoveryPoint, restoreIntoNewSchema, verifyRecoveryPoint, writeRecoveryPoint } from '../lib/pg-backup.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../backups/pg');
const url = process.env.SPARELY_DATABASE_URL || process.env.DATABASE_URL;
const [command, ...args] = process.argv.slice(2);

async function recoveryPoint(db) {
  const dir = writeRecoveryPoint(root, await exportDatabase(db));
  const check = verifyRecoveryPoint(dir);
  if (!check.ok) throw new Error(`Recovery point failed verification for: ${check.problems.join(', ')}`);
  console.log(`Recovery point verified: ${dir}`);
  for (const [t, m] of Object.entries(check.manifest.tables)) console.log(`  ${t}: ${m.rows} rows`);
  return dir;
}

// Every primary key present in the recovery point must still exist afterwards.
async function preservedCheck(db, dir) {
  const { manifest, data } = readRecoveryPoint(dir), missing = {};
  for (const table of manifest.order) {
    const keys = await primaryKeys(db, table);
    if (!keys.length) continue;
    const present = new Set((await db.query(`SELECT ${keys.map(k => `"${k}"`).join(',')} FROM "${table}"`)).map(r => keys.map(k => r[k]).join('\u0000')));
    const lost = data[table].filter(r => !present.has(keys.map(k => r[k]).join('\u0000'))).length;
    if (lost) missing[table] = lost;
  }
  return missing;
}

const createSchema = async target => { const store = new Store(target, { seed: false, autoMigrate: true }); await store.ready; await store.close(); };

try {
  if (!url || !/^postgres/.test(url)) throw new Error('DATABASE_URL (PostgreSQL) is not configured.');
  const db = new Database(url);
  try {
    if (command === 'status') {
      console.log(JSON.stringify(await migrationStatus(db), null, 2));
    } else if (command === 'backup') {
      await recoveryPoint(db);
    } else if (command === 'migrate') {
      const status = await migrationStatus(db);
      if (status.changed.length) throw new Error(`Applied migrations were edited: ${status.changed.join(', ')}. Add a new migration instead.`);
      if (!status.pending.length) { console.log('No pending migrations.'); }
      else {
        console.log(`Pending: ${status.pending.join(', ')}`);
        const dir = await recoveryPoint(db);
        const applied = await applyMigrations(db, line => console.log(`  ${line}`));
        const missing = await preservedCheck(db, dir);
        // Owner-approved deletions must be named explicitly: --approved-removal=<table>[,<table>]
        const approved = new Set(args.filter(x => x.startsWith('--approved-removal=')).flatMap(x => x.split('=')[1].split(',')));
        const unexpected = Object.fromEntries(Object.entries(missing).filter(([t]) => !approved.has(t)));
        const report = { at: new Date().toISOString(), recoveryPoint: dir, applied, missingRecords: missing, approvedRemovals: [...approved] };
        writeFileSync(resolve(dir, 'migration-report.json'), JSON.stringify(report, null, 2));
        if (Object.keys(missing).length && !Object.keys(unexpected).length) console.log(`Approved removals: ${JSON.stringify(missing)}`);
        if (Object.keys(unexpected).length) throw new Error(`Records from the recovery point are missing after migration: ${JSON.stringify(unexpected)}. Do not reopen writes; restore from ${dir}.`);
        console.log(`Applied ${applied.length} migration(s). ${Object.keys(missing).length ? 'Only the approved removals are missing; every other record is still present.' : 'Every record in the recovery point is still present.'}`);
      }
    } else if (command === 'restore-check') {
      const dir = args.find(a => !a.startsWith('--')) || latestRecoveryPoint(root);
      if (!dir) throw new Error('No recovery point found. Run `npm run db:backup` first.');
      const check = verifyRecoveryPoint(dir);
      if (!check.ok) throw new Error(`Recovery point files failed verification: ${check.problems.join(', ')}`);
      const result = await restoreIntoNewSchema(url, dir, { createSchema });
      for (const [t, r] of Object.entries(result.results)) console.log(`  ${t}: ${r.restored}/${r.expected} rows, hash ${r.hashMatches ? 'matches' : 'MISMATCH'}`);
      console.log(result.ok ? `Restore drill passed into separate schema ${result.schema}.` : `Restore drill FAILED in schema ${result.schema}.`);
      if (!args.includes('--keep')) { await dropSchema(url, result.schema); console.log(`Dropped drill schema ${result.schema} (use --keep to retain it).`); }
      if (!result.ok) process.exitCode = 1;
    } else {
      console.log('Usage: db-tools.mjs status | backup | migrate | restore-check [dir] [--keep]');
      process.exitCode = 2;
    }
  } finally { await db.close(); }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
