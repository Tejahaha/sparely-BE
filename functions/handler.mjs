import { timingSafeEqual } from 'node:crypto';
import { attachDatabasePool } from '@neon/functions';
import { parseTriggerDelivery } from '@neon/functions/triggers';
import { createApplication } from '../server.mjs';
import { apiHeaders, limitedBody } from '../lib/http-body.mjs';

export function createNeonHandler({ secret = process.env.ORIGIN_SECRET, applicationFactory = createApplication } = {}) {
  if (!secret || Buffer.byteLength(secret) < 32) throw new Error('ORIGIN_SECRET of at least 32 bytes is required.');
  const expected = Buffer.from(secret);
  // Requests reach the API over isolate loopback; trust the authenticated proxy's caller address.
  process.env.SPARELY_BEHIND_PROXY = '1';
  let starting, application;
  const authorized = request => {
    const supplied = request.headers.get('x-secret');
    if (!supplied) return false;
    const bytes = Buffer.from(supplied);
    return bytes.length === expected.length && timingSafeEqual(bytes, expected);
  };
  const getApplication = () => {
    if (starting) return starting;
    starting = (async () => {
    let app;
    try {
      app = applicationFactory({ watchdogInterval: 0 });
      await app.store.ready;
      if (app.store.db.pool) attachDatabasePool(app.store.db.pool);
      await new Promise((resolve, reject) => {
        app.server.once('error', reject);
        app.server.listen(0, '127.0.0.1', resolve);
      });
      application = app; return app;
    } catch (error) { await app?.store.close(); throw error; }
    })();
    starting.catch(() => { starting = undefined; });
    return starting;
  };
  return {
    async fetch(request) {
      const incoming = new URL(request.url);
      try {
        if (incoming.pathname === '/internal/watchdog') {
          // Native Neon ingress strips caller-supplied x-neon-* headers.
          if (request.method !== 'POST' || !request.headers.get('x-neon-trigger-invocation-id')) return Response.json({ error: 'Unauthorized' }, { status: 401 });
          const body = await limitedBody(request.body, 64_000);
          let json;
          try { json = JSON.parse(body.toString()); } catch { return Response.json({ error: 'Invalid trigger body' }, { status: 400 }); }
          const parsed = parseTriggerDelivery({ headers: request.headers, body: json });
          if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.error === 'invalid_body' ? 400 : 401 });
          if (parsed.invocation.type !== 'schedule' || parsed.invocation.trigger.name !== 'sparely-watchdog') return Response.json({ error: 'Unexpected trigger' }, { status: 403 });
          const app = await getApplication();
          // Durable evidence: a worker_runs row (ok|error) per delivery; busy retries are bounded.
          const run = await app.store.ops.runWorker('schedule', { attempts: 2 });
          return Response.json({ ok: true, invocationId: parsed.invocation.invocationId, runId: run.id, durationMs: run.durationMs });
        }
        // Reject before reading the body, starting the API, or connecting to Postgres.
        if (!authorized(request)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
        if (!incoming.pathname.startsWith('/api/')) return Response.json({ error: 'Not found.' }, { status: 404 });
        const body = await limitedBody(request.body);
        const app = await getApplication();
        const target = new URL(`http://127.0.0.1:${app.server.address().port}`);
        target.pathname = incoming.pathname; target.search = incoming.search;
        const headers = apiHeaders(request.headers);
        // The authenticated server proxy has checked the browser-facing origin.
        if (request.headers.has('origin')) headers.set('origin', target.origin);
        const result = await fetch(target, { method: request.method, headers, body, redirect: 'manual' });
        const outgoing = new Headers(result.headers);
        outgoing.delete('connection'); outgoing.delete('keep-alive'); outgoing.delete('transfer-encoding');
        const cookies = result.headers.getSetCookie(); outgoing.delete('set-cookie');
        for (const cookie of cookies) outgoing.append('set-cookie', /;\s*Secure(?:;|$)/i.test(cookie) ? cookie : `${cookie}; Secure`);
        return new Response(result.body, { status: result.status, headers: outgoing });
      } catch (error) {
        console.error(JSON.stringify({ at: new Date().toISOString(), level: 'error', event: incoming.pathname === '/internal/watchdog' ? 'watchdog_failed' : 'function_request_failed', requestId: request.headers.get('x-request-id') || null, error: String(error.code || error.status || 'upstream_error').slice(0, 40) }));
        return Response.json({ error: error.status === 413 ? error.message : 'Backend unavailable. Reconcile the operation before retrying.', retryable: error.status !== 413 }, { status: error.status === 413 ? 413 : 503, headers: error.status === 413 ? {} : { 'Retry-After': '1' } });
      }
    },
    async close() {
      if (starting) await starting.catch(() => {});
      if (application) {
        application.server.closeAllConnections();
        await new Promise(resolve => application.server.close(resolve));
        await application.store.close();
      }
    }
  };
}
