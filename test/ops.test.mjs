import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server.mjs';
import { createNeonHandler } from '../functions/handler.mjs';
import { checkImage } from '../lib/images.mjs';
import { validImage } from '../lib/store.mjs';
import { logger, readiness, routeTemplate, pruneRecoveryPoints, localRecoveryPoint } from '../lib/ops.mjs';
import { tableHash, writeRecoveryPoint } from '../lib/pg-backup.mjs';
// The frontend host lives in the monorepo's deploy/ folder; a standalone backend clone skips its test.
const { createFrontendHost } = await import('../../deploy/frontend-host/server.mjs').catch(() => ({}));
import { photo as png } from './fixtures.mjs';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const shut = async server => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
const until = async check => { for (let i = 0; i < 50; i++) { const v = await check(); if (v) return v; await new Promise(r => setTimeout(r, 20)); } return null; };

async function app(callback) {
  const { server, store } = createApplication({ dbPath: ':memory:', watchdogInterval: 0 });
  await store.ready;
  const origin = await listen(server);
  const device = () => {
    let cookie = '', actor = '';
    return async (path, { method = 'GET', body, headers = {} } = {}) => {
      const response = await fetch(origin + '/api' + path, { method, headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(method !== 'GET' && actor ? { 'X-Sparely-Actor': actor } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const data = await response.json().catch(() => ({}));
      const next = response.headers.get('set-cookie')?.split(';')[0];
      if (next) { cookie = next.endsWith('=') ? '' : next; actor = data.user?.id || ''; }
      return { status: response.status, data, headers: response.headers, cookie };
    };
  };
  try { await callback({ store, device, origin }); } finally { await shut(server); }
}

test('health needs no database; readiness is 503 when the database is unreachable', async () => {
  const { server, store } = createApplication({ dbPath: 'postgresql://nobody:nothing@127.0.0.1:1/none', watchdogInterval: 0 });
  store.ready.catch(() => {});
  const origin = await listen(server);
  try {
    const health = await fetch(origin + '/api/health');
    assert.equal(health.status, 200);
    const body = await health.json();
    assert.equal(body.ok, true); assert.ok(body.build.version);
    const ready = await fetch(origin + '/api/ready');
    assert.equal(ready.status, 503);
    const r = await ready.json();
    assert.equal(r.ready, false); assert.equal(r.checks.database.ok, false);
    assert.doesNotMatch(JSON.stringify(r), /nobody|nothing|postgresql/, 'no connection details are exposed');
  } finally { await shut(server); }
  // A hung database times out quickly instead of hanging the probe.
  const hung = await readiness({ db: { query: () => new Promise(() => {}) }, ready: Promise.resolve() }, { timeoutMs: 50 });
  assert.equal(hung.ready, false); assert.equal(hung.checks.database.error, 'TIMEOUT');
});

test('readiness is 200 when migrated and 503 with a pending migration', async () => await app(async ({ store, origin }) => {
  const ok = await fetch(origin + '/api/ready');
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).checks.migrations.pending, []);
  await store.db.query("DELETE FROM schema_migrations WHERE id='0007_operations'", [], 'run');
  const pending = await fetch(origin + '/api/ready');
  assert.equal(pending.status, 503);
  assert.deepEqual((await pending.json()).checks.migrations.pending, ['0007_operations']);
}));

test('request ids are generated, kept when safe, replaced when unsafe; logs hold no cookies, emails or bodies', async () => await app(async ({ device }) => {
  const lines = [], errors = [];
  const saved = { ...logger };
  Object.assign(logger, { enabled: true, write: line => lines.push(line), error: line => errors.push(line) });
  try {
    const call = device();
    const generated = await call('/bootstrap');
    assert.match(generated.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
    assert.equal((await call('/bootstrap', { headers: { 'X-Request-Id': 'client-trace-0001' } })).headers.get('x-request-id'), 'client-trace-0001');
    const unsafe = (await call('/bootstrap', { headers: { 'X-Request-Id': 'bad id <script>' } })).headers.get('x-request-id');
    assert.notEqual(unsafe, 'bad id <script>'); assert.match(unsafe, /^[0-9a-f-]{36}$/);
    const signup = await call('/auth/signup', { method: 'POST', body: { name: 'Log Tester', email: 'log.tester@example.com', password: 'a long secret password 1' } });
    assert.equal(signup.status, 201);
    await call('/listings/drill-kit/favorite', { method: 'PUT', body: { saved: true } });
    const all = lines.join('\n');
    assert.ok(lines.length >= 5);
    for (const line of lines) JSON.parse(line);
    assert.doesNotMatch(all, /log\.tester|example\.com|secret password|Log Tester/);
    assert.doesNotMatch(all, new RegExp(signup.cookie.split('=')[1]), 'no session token');
    assert.match(all, /"route":"\/api\/listings\/:id\/favorite"/, 'ids are removed from routes');
    assert.match(all, /"session":true/);
    assert.match(all, /"requestId":"client-trace-0001"/);
  } finally { Object.assign(logger, saved); }
  assert.equal(routeTemplate('/api/bookings/0b1c-77/incidents'), '/api/bookings/:id/incidents');
  assert.equal(routeTemplate('/api/commands/abcdef0123456789'), '/api/commands/:id');
}));

test('a forced 500 is recorded as an error event without personal data', async () => await app(async ({ store, device }) => {
  const errors = [];
  const saved = { ...logger };
  Object.assign(logger, { error: line => errors.push(line) });
  try {
    const mira = device();
    await mira('/session', { method: 'POST', body: { userId: 'mira' } });
    store.reviews = async () => { throw new Error('boom for someone@example.com'); };
    const failed = await mira('/reviews', { headers: { 'X-Request-Id': 'forced-failure-01' } });
    assert.equal(failed.status, 500);
    assert.doesNotMatch(JSON.stringify(failed.data), /someone/);
    const row = await until(() => store.db.query("SELECT * FROM error_events WHERE request_id='forced-failure-01'", [], 'get'));
    assert.ok(row, 'error event recorded');
    assert.equal(row.route, '/api/reviews'); assert.equal(row.status, 500); assert.equal(row.method, 'GET'); assert.equal(row.code, 'Error');
    assert.equal(errors.length, 1);
    assert.doesNotMatch(errors.join(''), /someone|example\.com/, 'the message (which can echo input) is never logged');
    assert.match(errors[0], /forced-failure-01/);
    // Visible to operators in diagnostics.
    const diag = await mira('/operations/diagnostics');
    assert.equal(diag.data.errors.total, 1);
    assert.deepEqual(diag.data.errors.byRoute.map(r => [r.route, r.status, r.count]), [['/api/reviews', 500, 1]]);
  } finally { Object.assign(logger, saved); }
}));

test('worker runs are recorded for success, failure and bounded busy retries', async () => await app(async ({ store }) => {
  const ok = await store.ops.runWorker('local');
  assert.equal(ok.outcome, 'ok');
  let row = await store.db.query('SELECT * FROM worker_runs WHERE id=?', [ok.id], 'get');
  assert.equal(row.outcome, 'ok'); assert.equal(row.trigger_kind, 'local'); assert.ok(row.finished_at); assert.equal(JSON.parse(row.counts).attempts, 1);
  const real = store.evaluate.bind(store);
  store.evaluate = async () => { throw Object.assign(new Error('relation missing'), { code: 'XX000' }); };
  await assert.rejects(store.ops.runWorker('local', { attempts: 3 }), /relation missing/);
  row = await store.db.query("SELECT * FROM worker_runs WHERE outcome='error'", [], 'get');
  assert.equal(row.error_code, 'XX000'); assert.equal(JSON.parse(row.counts).attempts, 1, 'non-busy failures are not retried');
  let calls = 0;
  store.evaluate = async () => { if (++calls === 1) throw Object.assign(new Error('busy'), { code: '40001' }); return real(); };
  const retried = await store.ops.runWorker('local', { attempts: 9 });
  row = await store.db.query('SELECT * FROM worker_runs WHERE id=?', [retried.id], 'get');
  assert.equal(row.outcome, 'ok'); assert.equal(JSON.parse(row.counts).attempts, 2);
  store.evaluate = async () => { calls++; throw Object.assign(new Error('busy'), { code: '40001' }); };
  calls = 0;
  await assert.rejects(store.ops.runWorker('local', { attempts: 9 }));
  assert.equal(calls, 3, 'retries are capped at three attempts');
  await assert.rejects(store.ops.runWorker('cron'), /Unknown worker trigger/);
}));

test('the Function schedule records a worker run', async () => {
  let app;
  const handler = createNeonHandler({ secret: 'test-only-server-secret-that-is-long-enough', applicationFactory: () => (app = createApplication({ dbPath: ':memory:', watchdogInterval: 0 })) });
  try {
    const delivery = { version: 1, invocation_id: 'ops-delivery', trigger: { type: 'schedule', id: 'trigger-test', name: 'sparely-watchdog' }, data: { scheduled_at: new Date().toISOString() } };
    const tick = await handler.fetch(new Request('https://function.example/internal/watchdog', { method: 'POST', headers: { 'x-neon-trigger-invocation-id': 'ops-delivery', 'content-type': 'application/json' }, body: JSON.stringify(delivery) }));
    assert.equal(tick.status, 200);
    const body = await tick.json();
    const row = await app.store.db.query('SELECT * FROM worker_runs WHERE id=?', [body.runId], 'get');
    assert.equal(row.trigger_kind, 'schedule'); assert.equal(row.outcome, 'ok');
  } finally { await handler.close(); }
});

test('diagnostics are operator-only and flag delayed processing', async () => await app(async ({ store, device }) => {
  assert.equal((await device()('/operations/diagnostics')).status, 401);
  const teja = device();
  await teja('/session', { method: 'POST', body: { userId: 'teja' } });
  assert.equal((await teja('/operations/diagnostics')).status, 403);
  const mira = device();
  await mira('/session', { method: 'POST', body: { userId: 'mira' } });
  let diag = (await mira('/operations/diagnostics')).data;
  assert.equal(diag.worker.delayed, true); assert.match(diag.worker.warning, /No successful/);
  assert.equal(diag.database.ok, true); assert.deepEqual(diag.migrations.pending, []);
  assert.equal(diag.recoveryPoint.scope, 'this-machine-only');
  assert.equal(diag.audience, 'demo');
  const old = new Date(Date.now() - 20 * 60_000).toISOString();
  await store.db.query("INSERT INTO worker_runs(id,trigger_kind,started_at,finished_at,outcome,error_code,duration_ms,counts) VALUES('old-run','schedule',?,?,'ok',NULL,5,'{}')", [old, old], 'run');
  diag = (await mira('/operations/diagnostics')).data;
  assert.equal(diag.worker.delayed, true); assert.match(diag.worker.warning, /Delayed processing/);
  await store.ops.runWorker('local');
  diag = (await mira('/operations/diagnostics')).data;
  assert.equal(diag.worker.delayed, false); assert.equal(diag.worker.runs[0].trigger, 'local');
  assert.doesNotMatch(JSON.stringify(diag), /sparely_session|password|@/);
}));

test('image check verifies real PNG/JPEG/WebP bytes and rejects SVG, HTML and relabelled files', () => {
  const url = (type, bytes) => `data:image/${type};base64,${Buffer.from(bytes).toString('base64')}`;
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
  assert.deepEqual(checkImage(png).ok, true);
  assert.equal(checkImage(url('jpeg', jpeg)).type, 'jpeg');
  assert.equal(checkImage(url('webp', webp)).ok, true);
  assert.equal(checkImage(url('svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"/>')).ok, false);
  assert.equal(checkImage(url('png', '<html><script>alert(1)</script></html>')).reason, 'content_does_not_match_type');
  assert.equal(checkImage(url('png', jpeg)).reason, 'content_does_not_match_type', 'a PNG label over JPEG bytes');
  assert.equal(checkImage(`data:text/html;base64,${Buffer.from('<p>').toString('base64')}`).ok, false);
  assert.equal(checkImage(url('jpeg', Buffer.concat([jpeg, Buffer.alloc(3_000_001)]))).ok, false, 'over 3 MB decoded');
  assert.equal(checkImage(url('jpeg', jpeg), { maxBytes: 4 }).ok, false);
  assert.equal(checkImage(null).ok, false);
  assert.equal(validImage(url('png', jpeg)), false, 'store validator uses the shared check');
});

test('local recovery-point pruning keeps the newest verified point and refuses when none verify', () => {
  const root = mkdtempSync(join(tmpdir(), 'sparely-prune-'));
  try {
    const point = (at, rows = [{ id: 1 }]) => writeRecoveryPoint(root, { manifest: { format: 'sparely-logical-v1', createdAt: at, order: ['t'], tables: { t: { rows: rows.length, sha256: tableHash(rows) } } }, data: { t: rows } });
    point('2026-01-01T00:00:00.000Z'); point('2026-01-02T00:00:00.000Z'); point('2026-01-03T00:00:00.000Z');
    const newest = point('2026-01-04T00:00:00.000Z');
    writeFileSync(join(newest, 'manifest.json'), JSON.stringify({ format: 'sparely-logical-v1', createdAt: '2026-01-04T00:00:00.000Z', order: ['t'], tables: { t: { rows: 9, sha256: 'x' } } }));
    const dry = pruneRecoveryPoints(root, 1, { dryRun: true });
    assert.equal(dry.removed.length, 2); assert.equal(readdirSync(root).length, 4);
    const result = pruneRecoveryPoints(root, 1);
    assert.equal(result.newestVerified.createdAt, '2026-01-03T00:00:00.000Z', 'the newest corrupt point does not count as verified');
    assert.deepEqual(result.kept.map(p => p.createdAt), ['2026-01-04T00:00:00.000Z', '2026-01-03T00:00:00.000Z']);
    assert.equal(readdirSync(root).length, 2);
    assert.throws(() => pruneRecoveryPoints(root, 0), /at least 1/);
    const visible = localRecoveryPoint(root);
    assert.equal(visible.available, true); assert.equal(visible.scope, 'this-machine-only');
    const broken = mkdtempSync(join(tmpdir(), 'sparely-prune-bad-'));
    mkdirSync(join(broken, 'pg-unreadable'));
    assert.throws(() => pruneRecoveryPoints(broken, 1), /Refusing/);
    rmSync(broken, { recursive: true, force: true });
    assert.equal(localRecoveryPoint(join(root, 'missing')).available, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('frontend host: SPA fallback, security headers, secret added server-side only, demo gate, refuses bad config', { skip: !createFrontendHost && 'deploy/ folder not present' }, async () => {
  const secret = 'host-test-secret-that-is-at-least-32-bytes';
  const dist = mkdtempSync(join(tmpdir(), 'sparely-dist-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
  writeFileSync(join(dist, 'assets', 'app.js'), 'console.log(1)');
  const seen = [];
  const upstream = createServer((req, res) => {
    seen.push(req.headers);
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'sparely_session=abc; HttpOnly; SameSite=Strict; Path=/; Secure' });
    res.end(JSON.stringify({ path: req.url }));
  });
  const functionUrl = (await listen(upstream)) + '/';
  const env = { NEON_FUNCTION_URL: functionUrl, ORIGIN_SECRET: secret, APP_ORIGIN: 'https://app.example' };
  assert.throws(() => createFrontendHost({ env: {}, distRoot: dist }), /NEON_FUNCTION_URL, ORIGIN_SECRET, APP_ORIGIN/);
  assert.throws(() => createFrontendHost({ env: { ...env, APP_ORIGIN: 'https://*.example' }, distRoot: dist }), /exact origin/);
  assert.throws(() => createFrontendHost({ env: { ...env, APP_ORIGIN: 'http://app.example' }, distRoot: dist }), /HTTPS/);
  assert.throws(() => createFrontendHost({ env: { ...env, NEON_FUNCTION_URL: 'http://function.example/' }, distRoot: dist }), /HTTPS/);
  assert.throws(() => createFrontendHost({ env: { ...env, ORIGIN_SECRET: 'short' }, distRoot: dist }), /ORIGIN_SECRET/);
  const host = createFrontendHost({ env, distRoot: dist });
  const origin = await listen(host);
  try {
    const page = await fetch(origin + '/operations/anything');
    assert.equal(page.status, 200); assert.match(await page.text(), /id="root"/, 'SPA fallback');
    assert.match(page.headers.get('content-security-policy'), /script-src 'self';/);
    assert.doesNotMatch(page.headers.get('content-security-policy'), /script-src[^;]*unsafe-inline/);
    assert.match(page.headers.get('strict-transport-security'), /max-age=\d+/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.equal((await fetch(origin + '/assets/app.js')).headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal((await fetch(origin + '/assets/missing.js')).status, 404);
    assert.equal((await fetch(origin + '/%2e%2e/%2e%2e/package.json')).status, 404);
    const api = await fetch(origin + '/api/bootstrap?x=1', { headers: { 'X-Request-Id': 'host-trace-0001', 'x-secret': 'browser-supplied' } });
    assert.equal(api.status, 200);
    assert.equal(seen.at(-1)['x-secret'], secret, 'the host adds the real secret');
    assert.equal(seen.at(-1)['x-request-id'], 'host-trace-0001');
    assert.equal(api.headers.get('x-request-id'), 'host-trace-0001');
    assert.equal(api.headers.get('x-secret'), null);
    assert.match(api.headers.get('set-cookie'), /; Secure/, 'Secure cookies are kept over HTTPS');
    assert.doesNotMatch(await api.text(), new RegExp(secret));
    assert.equal((await fetch(origin + '/api/session', { method: 'POST', headers: { Origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' })).status, 403);
  } finally { await shut(host); }
  const gated = createFrontendHost({ env: { ...env, DEMO_ACCESS_TOKEN: 'demo-access-code-123' }, distRoot: dist });
  const gatedOrigin = await listen(gated);
  try {
    assert.equal((await fetch(gatedOrigin + '/')).status, 401);
    assert.equal((await fetch(gatedOrigin + '/api/bootstrap')).status, 401);
    assert.equal((await fetch(gatedOrigin + '/healthz')).status, 200);
    const auth = { Authorization: 'Basic ' + Buffer.from('demo:demo-access-code-123').toString('base64') };
    assert.equal((await fetch(gatedOrigin + '/', { headers: auth })).status, 200);
    assert.equal((await fetch(gatedOrigin + '/', { headers: { Authorization: 'Basic ' + Buffer.from('demo:wrong-code-000000').toString('base64') } })).status, 401);
    assert.equal((await fetch(gatedOrigin + '/api/bootstrap', { headers: auth })).status, 200);
    assert.equal(seen.at(-1).authorization, undefined, 'the demo gate credential is not forwarded upstream');
  } finally { await shut(gated); await shut(upstream); rmSync(dist, { recursive: true, force: true }); }
});
