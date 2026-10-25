// M8: operational reliability — health/readiness, structured request logs, server-error
// events, background worker run records, operator diagnostics and local recovery-point
// retention. Nothing here stores or logs bodies, cookies, tokens, emails, addresses or images.
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrations } from './migration-registry.mjs';
import { verifyRecoveryPoint } from './pg-backup.mjs';
import { sendReminders } from './reminders.mjs';
import { sendAppointmentReminders } from './appointment-reminders.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const KEEP_WORKER_RUNS = 500, KEEP_ERROR_EVENTS = 1000;
export const DELAYED_AFTER_MS = 15 * 60_000;
export const build = Object.freeze({
  version: process.env.SPARELY_BUILD_ID || 'unlabelled-build',
  runtime: process.env.SPARELY_FUNCTION_RUNTIME ? 'neon-function' : 'node-server',
  node: process.version,
  startedAt: new Date().toISOString(),
});

export const isBusy = error => ['55P03', '40001', '40P01', '53300', '57P03'].includes(error?.code) || error?.errcode === 5 || error?.errcode === 6 || /database is (locked|busy)/i.test(error?.message || '');
// Short, non-identifying error label for logs and records (never the message: it can echo input).
export const errorCode = error => String(error?.code || error?.name || 'Error').replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 40) || 'Error';

// Route words that are kept in logged paths. Anything else (ids, keys, codes) becomes ":id",
// so an unknown segment can never leak into a log line.
const routeWords = new Set(['api', 'bootstrap', 'auth', 'signup', 'login', 'logout', 'reset', 'password', 'session', 'admin', 'password-resets',
  'incidents', 'safety-notices', 'commands', 'bookings', 'recovery', 'reviews', 'scenarios', 'listings', 'host', 'assist', 'favorite', 'quote',
  'profile', 'publish', 'blocks', 'operations', 'diagnostics', 'health', 'ready', 'messages', 'conversations', 'appointments', 'read',
  'capacity', 'intake', 'pricing', 'rates', 'caps', 'settlement', 'ledger', 'agreement', 'checklist', 'assets', 'index.html']);
export const routeTemplate = pathname => {
  if (!pathname.startsWith('/api/')) return '(static)';
  return pathname.split('/').map(part => !part || routeWords.has(part) ? part : ':id').join('/');
};

// Tests run quietly unless a test turns logging on; SPARELY_LOG=off silences production logs.
export const logger = { enabled: !process.env.NODE_TEST_CONTEXT && process.env.SPARELY_LOG !== 'off', write: line => console.log(line), error: line => console.error(line) };
export function logRequest({ requestId, method, path, status, ms, session }) {
  if (!logger.enabled) return;
  logger.write(JSON.stringify({ at: new Date().toISOString(), level: status >= 500 ? 'error' : 'info', event: 'request', requestId, method, route: routeTemplate(path), status, ms: Math.round(ms), session }));
}
export function logError(fields, error) {
  if (!logger.enabled && !fields.force) return;
  // Stack frames only (file:line). The message line is dropped because it can contain input.
  const frames = String(error?.stack || '').split('\n').slice(1, 4).map(l => l.trim());
  logger.error(JSON.stringify({ at: new Date().toISOString(), level: 'error', ...fields, force: undefined, error: errorCode(error), frames }));
}

const within = (promise, ms) => {
  promise.catch(() => {});
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('timed out'), { code: 'TIMEOUT' })), ms); })]).finally(() => clearTimeout(timer));
};

// Readiness: database ping (short timeout), startup and pending migrations. The worker age is
// reported but does not fail readiness: a stalled scheduler should alert an operator, not
// take the API out of service.
export async function readiness(store, { timeoutMs = 2000 } = {}) {
  const checks = { database: { ok: false }, startup: { ok: false }, migrations: { ok: false, pending: [] }, worker: null };
  const t0 = Date.now();
  try { await within(store.db.query('SELECT 1 AS ok', [], 'get'), timeoutMs); checks.database = { ok: true, latencyMs: Date.now() - t0 }; }
  catch (error) { checks.database = { ok: false, error: errorCode(error) }; }
  if (checks.database.ok) {
    try {
      const applied = new Set((await within(store.db.query('SELECT id FROM schema_migrations'), timeoutMs)).map(r => r.id));
      const pending = migrations.filter(m => !applied.has(m.id)).map(m => m.id);
      checks.migrations = { ok: pending.length === 0, pending };
    } catch (error) { checks.migrations = { ok: false, pending: migrations.map(m => m.id), error: errorCode(error) }; }
    try { await within(store.ready, timeoutMs); checks.startup = { ok: true }; }
    catch (error) { checks.startup = { ok: false, error: errorCode(error) }; }
    if (checks.startup.ok) { try { checks.worker = await workerSummary(store.db); } catch { checks.worker = null; } }
  }
  const ready = checks.database.ok && checks.startup.ok && checks.migrations.ok;
  return { ready, checks, build: { version: build.version, runtime: build.runtime } };
}

async function workerSummary(db, limit = 1) {
  const runs = (await db.query('SELECT id,trigger_kind,started_at,finished_at,outcome,error_code,duration_ms,counts FROM worker_runs ORDER BY started_at DESC LIMIT ?', [limit]))
    .map(r => ({ id: r.id, trigger: r.trigger_kind, startedAt: r.started_at, finishedAt: r.finished_at, outcome: r.outcome, errorCode: r.error_code, durationMs: r.duration_ms, counts: JSON.parse(r.counts || '{}') }));
  const success = await db.query("SELECT finished_at FROM worker_runs WHERE outcome='ok' ORDER BY finished_at DESC LIMIT 1", [], 'get');
  const ageMs = success ? Date.now() - Date.parse(success.finished_at) : null;
  const delayed = ageMs === null || ageMs > DELAYED_AFTER_MS;
  return {
    lastSuccessAt: success?.finished_at || null,
    lastSuccessAgeSeconds: ageMs === null ? null : Math.round(ageMs / 1000),
    delayed,
    warning: !delayed ? null : ageMs === null ? 'No successful background run has been recorded yet.' : 'Delayed processing: no successful background run in the last 15 minutes.',
    runs,
  };
}

export class Ops {
  constructor(store) { this.store = store; this.db = store.db; this.backupRoot = resolve(here, '../backups/pg'); }

  async #prune(table, order, keep) {
    await this.db.query(`DELETE FROM ${table} WHERE id NOT IN (SELECT id FROM ${table} ORDER BY ${order} DESC LIMIT ?)`, [keep], 'run');
  }

  // Server errors (5xx, storage busy). Route is a template; no body, user or message is kept.
  async recordError({ requestId, method, path, status, code }) {
    await this.db.query('INSERT INTO error_events(id,request_id,method,route,status,code,created_at) VALUES(?,?,?,?,?,?,?)',
      [randomUUID(), requestId, method, routeTemplate(path), status, code ? String(code).slice(0, 40) : null, new Date().toISOString()], 'run');
    await this.#prune('error_events', 'created_at', KEEP_ERROR_EVENTS);
  }

  // One evaluation pass with a durable record. Effects are idempotent (store.evaluate runs under
  // transactional guards), so a bounded retry of a busy database cannot duplicate them.
  async runWorker(trigger, { attempts = 1 } = {}) {
    if (!['schedule', 'local', 'request'].includes(trigger)) throw new Error('Unknown worker trigger');
    const id = randomUUID(), started = Date.now();
    await this.db.query('INSERT INTO worker_runs(id,trigger_kind,started_at,finished_at,outcome,error_code,duration_ms,counts) VALUES(?,?,?,?,?,?,?,?)',
      [id, trigger, new Date(started).toISOString(), null, 'running', null, null, '{}'], 'run');
    let failure = null, tries = 0;
    while (tries < Math.min(Math.max(attempts, 1), 3)) {
      tries++;
      try { await this.store.evaluate(); failure = null; break; }
      catch (error) { failure = error; if (!isBusy(error)) break; await new Promise(r => setTimeout(r, 250 * tries)); }
    }
    // Reminders run outside the evaluation transaction: wording may wait on the model.
    let reminders = 0, appointmentReminders = 0;
    // Timed appointments must not wait for optional model-generated return wording.
    if (!failure) try { appointmentReminders = await sendAppointmentReminders(this.store); } catch (error) { failure = error; logError({ event: 'appointment_reminders_failed', trigger, force: true }, error); }
    if (!failure) try { reminders = await sendReminders(this.store); } catch (error) { logError({ event: 'reminders_failed', trigger, force: true }, error); }
    const finished = Date.now(), outcome = failure ? 'error' : 'ok';
    try {
      const open = await this.db.query("SELECT COUNT(*) AS n FROM bookings WHERE status IN ('requested','confirmed','active','under_review')", [], 'get');
      await this.db.query('UPDATE worker_runs SET finished_at=?,outcome=?,error_code=?,duration_ms=?,counts=? WHERE id=?',
        [new Date(finished).toISOString(), outcome, failure ? errorCode(failure) : null, finished - started, JSON.stringify({ attempts: tries, openBookings: Number(open?.n || 0), reminders, appointmentReminders }), id], 'run');
      await this.#prune('worker_runs', 'started_at', KEEP_WORKER_RUNS);
    } catch (error) { logError({ event: 'worker_record_failed', trigger, force: true }, error); }
    if (failure) throw failure;
    return { id, outcome, durationMs: finished - started };
  }

  async diagnostics(userId) {
    const world = await this.store.accounts.world(userId);
    const ready = await readiness(this.store);
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    const byRoute = await this.db.query('SELECT method,route,status,code,COUNT(*) AS count,MAX(created_at) AS last_at FROM error_events WHERE created_at>=? GROUP BY method,route,status,code ORDER BY count DESC LIMIT 20', [since]);
    return {
      generatedAt: new Date().toISOString(),
      audience: world, // the same non-personal data for demo and account operators
      build,
      database: ready.checks.database,
      migrations: ready.checks.migrations,
      worker: await workerSummary(this.db, 10),
      errors: { windowHours: 24, total: byRoute.reduce((sum, r) => sum + Number(r.count), 0), byRoute: byRoute.map(r => ({ method: r.method, route: r.route, status: r.status, code: r.code, count: Number(r.count), lastAt: r.last_at })) },
      recoveryPoint: localRecoveryPoint(this.backupRoot),
    };
  }
}

// ---- Local recovery points (files on the machine that ran `npm run db:backup`) -------------
export function listRecoveryPoints(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && d.name.startsWith('pg-')).map(d => d.name).sort().reverse().map(name => {
    const dir = join(root, name);
    try { const check = verifyRecoveryPoint(dir); return { name, dir, createdAt: check.manifest.createdAt, verified: check.ok, tables: Object.keys(check.manifest.tables).length }; }
    catch { return { name, dir, createdAt: null, verified: false, tables: 0 }; }
  });
}

export function localRecoveryPoint(root) {
  const scope = 'this-machine-only';
  if (!existsSync(root)) return { scope, available: false, note: 'No local recovery points are visible to this server. Hosted runtimes cannot see files on the operator machine; local points are not off-site backups.' };
  const names = readdirSync(root).filter(n => n.startsWith('pg-')).sort();
  if (!names.length) return { scope, available: false, note: 'No recovery point has been taken on this machine.' };
  const latest = listRecoveryPoints(root)[0];
  return { scope, available: true, createdAt: latest.createdAt, verified: latest.verified, count: names.length, note: 'Files on this machine only; not an off-site backup.' };
}

// Keeps the newest `keep` points and always the newest verified one. Refuses if none verifies.
export function pruneRecoveryPoints(root, keep, { dryRun = false } = {}) {
  if (!Number.isInteger(keep) || keep < 1) throw new Error('--keep must be a whole number of at least 1.');
  const points = listRecoveryPoints(root);
  const newestVerified = points.find(p => p.verified);
  if (!newestVerified) throw new Error('No recovery point verifies. Refusing to delete anything.');
  const kept = new Set([...points.slice(0, keep).map(p => p.name), newestVerified.name]);
  const removed = points.filter(p => !kept.has(p.name));
  if (!dryRun) for (const p of removed) rmSync(p.dir, { recursive: true, force: true });
  return { kept: points.filter(p => kept.has(p.name)), removed, newestVerified };
}
