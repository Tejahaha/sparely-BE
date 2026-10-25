import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { Database } from './database.mjs';

// Logical PostgreSQL recovery points: every table in the current schema, with
// per-table row counts and canonical hashes. Files are private (backups/ is
// git-ignored) and contain user data: never print or commit their contents.

const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}` : JSON.stringify(value);
export const tableHash = rows => createHash('sha256').update(rows.map(canonical).sort().join('\n')).digest('hex');
const quote = name => `"${name.replaceAll('"', '""')}"`;

export async function tablesInOrder(db) {
  const tables = (await db.query("SELECT table_name AS name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE'")).map(r => r.name);
  const edges = await db.query("SELECT cl.relname AS child, pl.relname AS parent FROM pg_constraint c JOIN pg_class cl ON cl.oid=c.conrelid JOIN pg_class pl ON pl.oid=c.confrelid WHERE c.contype='f' AND c.connamespace=current_schema()::regnamespace");
  const ordered = [], seen = new Set();
  const visit = (table, path = new Set()) => {
    if (seen.has(table) || path.has(table)) return;
    path.add(table);
    for (const e of edges) if (e.child === table && e.parent !== table && tables.includes(e.parent)) visit(e.parent, path);
    seen.add(table); ordered.push(table);
  };
  for (const t of tables.sort()) visit(t);
  return ordered;
}

export async function primaryKeys(db, table) {
  return (await db.query("SELECT k.column_name AS name FROM information_schema.table_constraints t JOIN information_schema.key_column_usage k ON k.constraint_name=t.constraint_name AND k.table_schema=t.table_schema WHERE t.table_schema=current_schema() AND t.table_name=? AND t.constraint_type='PRIMARY KEY' ORDER BY k.ordinal_position", [table])).map(r => r.name);
}

export async function exportDatabase(db) {
  const tables = await tablesInOrder(db), data = {}, manifest = { format: 'sparely-logical-v1', createdAt: new Date().toISOString(), order: tables, tables: {} };
  // The transaction holds the app's write advisory lock, so business writes pause
  // while tables are read. (Session rows and notice read-marks are written outside
  // that lock; a restore may differ from live in those two only.)
  await db.transaction(async () => {
    for (const table of tables) {
      const rows = await db.query(`SELECT * FROM ${quote(table)}`);
      data[table] = rows;
      manifest.tables[table] = { rows: rows.length, sha256: tableHash(rows) };
    }
  });
  return { manifest, data };
}

export function writeRecoveryPoint(root, { manifest, data }) {
  const dir = join(root, `pg-${manifest.createdAt.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  for (const [table, rows] of Object.entries(data)) writeFileSync(join(dir, `${table}.json.gz`), gzipSync(JSON.stringify(rows)));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

export function readRecoveryPoint(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const data = {};
  for (const table of manifest.order) data[table] = JSON.parse(gunzipSync(readFileSync(join(dir, `${table}.json.gz`))).toString());
  return { manifest, data };
}

// Re-reads the files from disk and checks every table against the manifest.
export function verifyRecoveryPoint(dir) {
  const { manifest, data } = readRecoveryPoint(dir), problems = [];
  for (const table of manifest.order) {
    const expected = manifest.tables[table], rows = data[table];
    if (rows.length !== expected.rows || tableHash(rows) !== expected.sha256) problems.push(table);
  }
  return { ok: problems.length === 0, problems, manifest };
}

export function latestRecoveryPoint(root) {
  const dirs = readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && d.name.startsWith('pg-')).map(d => d.name).sort();
  return dirs.length ? join(root, dirs.at(-1)) : null;
}

export const scopedUrl = (url, schema) => { const u = new URL(url); u.searchParams.set('options', `-c search_path=${schema}`); return u.toString(); };

// Restores a recovery point into a NEW schema and verifies every table.
// The live schema is never written. Returns the schema name and per-table results.
export async function restoreIntoNewSchema(url, dir, { createSchema }) {
  const { manifest, data } = readRecoveryPoint(dir);
  const schema = `sparely_restore_${Date.now()}`;
  const admin = new Database(url);
  try { await admin.exec(`CREATE SCHEMA ${quote(schema)}`); } finally { await admin.close(); }
  const target = scopedUrl(url, schema);
  await createSchema(target); // builds the current application schema in the new schema
  const db = new Database(target), results = {};
  try {
    await db.transaction(async () => {
      const existing = await tablesInOrder(db);
      for (const table of [...existing].reverse()) await db.exec(`DELETE FROM ${quote(table)}`);
      for (const table of manifest.order) {
        for (const row of data[table]) {
          const cols = Object.keys(row);
          await db.query(`INSERT INTO ${quote(table)} (${cols.map(quote).join(',')}) VALUES (${cols.map(() => '?').join(',')})`, cols.map(c => row[c]), 'run');
        }
        if ((await db.query("SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=? AND column_name='_seq'", [table], 'get')) && data[table].length)
          await db.query(`SELECT setval(pg_get_serial_sequence('${table}','_seq'), (SELECT MAX(_seq) FROM ${quote(table)}))`);
      }
    });
    for (const table of manifest.order) {
      const rows = await db.query(`SELECT * FROM ${quote(table)}`);
      results[table] = { expected: manifest.tables[table].rows, restored: rows.length, hashMatches: tableHash(rows) === manifest.tables[table].sha256 };
    }
  } finally { await db.close(); }
  return { schema, results, ok: Object.values(results).every(r => r.expected === r.restored && r.hashMatches) };
}

export async function dropSchema(url, schema) {
  if (!/^sparely_(restore|test)_[a-z0-9_]+$/.test(schema)) throw new Error('Refusing to drop a schema that this tool did not create.');
  const admin = new Database(url);
  try { await admin.exec(`DROP SCHEMA ${quote(schema)} CASCADE`); } finally { await admin.close(); }
}
