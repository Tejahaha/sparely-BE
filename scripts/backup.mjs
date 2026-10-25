import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backupDatabase } from '../lib/backup.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const name = `sparely-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.db`;
try {
  if (/^postgres(?:ql)?:\/\//.test(process.env.SPARELY_DATABASE_URL || process.env.DATABASE_URL || '')) {
    throw new Error('Active storage is PostgreSQL. Use Neon restore/branch snapshots or a private pg_dump; this SQLite command cannot back up the active database.');
  }
  const result = await backupDatabase(resolve(root, 'data/sparely.db'), resolve(root, 'backups', name));
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(`Backup failed: ${error.message}`); process.exitCode = 1; }
