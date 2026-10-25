import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store } from '../lib/store.mjs';
import { TABLE_COLUMNS } from '../lib/database.mjs';

const digest = rows => createHash('sha256').update(JSON.stringify(rows.map(row => Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))))
  .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))).digest('hex');

export async function migrateSnapshot(snapshot, connectionString) {
  if (!/^postgres(?:ql)?:\/\//.test(connectionString || '')) throw new Error('DATABASE_URL must be a PostgreSQL connection string.');
  if (!existsSync(snapshot) || !existsSync(`${snapshot}.json`)) throw new Error('Use a verified SQLite snapshot and its .json manifest.');
  const manifest = JSON.parse(readFileSync(`${snapshot}.json`, 'utf8'));
  const hash = createHash('sha256').update(readFileSync(snapshot)).digest('hex');
  if (hash !== manifest.sha256 || manifest.integrity !== 'ok') throw new Error('Snapshot hash/integrity manifest mismatch.');
  const source = new DatabaseSync(snapshot, { readOnly: true });
  const target = new Store(connectionString, { seed: false });
  try {
    await target.ready;
    const report = { snapshot: resolve(snapshot), snapshotSha256: hash, targetHost: new URL(connectionString).hostname,
      database: new URL(connectionString).pathname.slice(1), verifiedAt: new Date().toISOString(), tables: {} };
    await target.transaction(async () => {
      for (const [table, columns] of Object.entries(TABLE_COLUMNS)) {
        const selected = columns.map(c => `"${c}"`).join(',');
        const rows = source.prepare(`SELECT ${selected} FROM "${table}" ORDER BY rowid`).all();
        const insert = target.db.prepare(`INSERT OR IGNORE INTO ${table} VALUES(${columns.map(() => '?').join(',')})`);
        for (const row of rows) await insert.run(...columns.map(c => row[c]));
        const copied = await target.db.prepare(`SELECT ${selected} FROM "${table}"`).all();
        const expected = digest(rows), actual = digest(copied);
        if (rows.length !== copied.length || expected !== actual) throw new Error(`Data differs in ${table}; import rolled back instead of overwriting existing records.`);
        report.tables[table] = { count: rows.length, sha256: actual };
      }
    });
    return report;
  } finally { source.close(); await target.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const snapshot = process.argv[2];
    if (!snapshot) throw new Error('Supply the path of a verified SQLite snapshot.');
    const report = await migrateSnapshot(resolve(snapshot), process.env.DATABASE_URL);
    if (process.argv[3]) writeFileSync(resolve(process.argv[3]), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
  } catch (error) { console.error(`Migration failed: ${error.code || ''} ${error.message}`); process.exitCode = 1; }
}
