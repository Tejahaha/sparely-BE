// Local recovery-point retention. Touches only files under backend/backups/pg; never the database.
//   npm run db:prune                      list points (newest first), age and verification
//   npm run db:prune -- --keep 7          delete all but the newest 7 (+ always the newest verified)
//   npm run db:prune -- --keep 7 --dry-run
// Local points are files on this machine: they are not an off-site backup.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listRecoveryPoints, pruneRecoveryPoints } from '../lib/ops.mjs';

const args = process.argv.slice(2);
const root = resolve(args.includes('--root') ? args[args.indexOf('--root') + 1] : resolve(dirname(fileURLToPath(import.meta.url)), '../backups/pg'));
const age = at => at ? `${Math.round((Date.now() - Date.parse(at)) / 3600_000)} h ago` : 'unknown age';
try {
  if (!args.includes('--keep')) {
    const points = listRecoveryPoints(root);
    if (!points.length) console.log('No local recovery points. Run `npm run db:backup` (PostgreSQL) to take one.');
    for (const p of points) console.log(`${p.verified ? 'verified' : 'FAILED  '}  ${p.createdAt || '?'}  (${age(p.createdAt)})  ${p.name}`);
    const last = points.find(p => p.verified);
    if (points.length) console.log(last ? `Last verified recovery point: ${last.createdAt} (${age(last.createdAt)}).` : 'No recovery point verifies.');
  } else {
    const keep = Number(args[args.indexOf('--keep') + 1]);
    const result = pruneRecoveryPoints(root, keep, { dryRun: args.includes('--dry-run') });
    for (const p of result.removed) console.log(`${args.includes('--dry-run') ? 'would remove' : 'removed'}  ${p.name}`);
    console.log(`Kept ${result.kept.length} point(s); newest verified: ${result.newestVerified.name}.`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
