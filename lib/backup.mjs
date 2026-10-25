import { backup, DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Use SQLite's snapshot backup, not a live copy of the .db file without its WAL.
export async function backupDatabase(source, destination) {
  const target = resolve(destination);
  if (!existsSync(source)) throw new Error('Source database does not exist; refusing to create an empty backup.');
  if (resolve(source) === target) throw new Error('Backup must not replace the live database.');
  mkdirSync(dirname(target), { recursive: true });
  closeSync(openSync(target, 'wx'));
  let input, check;
  try {
    input = new DatabaseSync(source, { readOnly: true });
    await backup(input, target);
    check = new DatabaseSync(target, { readOnly: true });
    const integrity = check.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') throw new Error('Backup failed SQLite integrity verification.');
    const counts = {};
    for (const name of ['listings', 'bookings', 'evidence', 'incidents', 'incident_entries', 'command_receipts', 'safety_notices']) {
      if (check.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)) counts[name] = check.prepare(`SELECT COUNT(*) AS count FROM ${name}`).get().count;
    }
    check.close(); check = undefined;
    const manifest = { createdAt: new Date().toISOString(), integrity: 'ok', sha256: createHash('sha256').update(readFileSync(target)).digest('hex'), counts };
    writeFileSync(`${target}.json`, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    return { path: target, ...manifest };
  } catch (error) {
    check?.close();
    unlinkSync(target);
    throw error;
  } finally { input?.close(); }
}
