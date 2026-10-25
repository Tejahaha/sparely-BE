import { timingSafeEqual } from 'node:crypto';
import { createApplication } from '../server.mjs';
import { apiHeaders, limitedBody } from './http-body.mjs';
import { frontendOrigin } from '../deployment.config.mjs';

const unavailable = () => Response.json({ error: 'Backend unavailable. Check the operation status before retrying.', code: 'BACKEND_UNAVAILABLE', retryable: true }, { status: 503, headers: { 'Retry-After': '1' } });

export function createVercelHandler({ applicationFactory = createApplication, productionChecks = true } = {}) {
  let starting;
  const application = () => {
    if (!starting) {
      starting = (async () => {
        if (productionChecks && !/^postgres(?:ql)?:\/\//.test(process.env.DATABASE_URL || '')) throw new Error('DATABASE_URL must be PostgreSQL on Vercel.');
        if (productionChecks && process.env.SPARELY_DEMO !== 'off') throw new Error('SPARELY_DEMO=off is required for a public Vercel API.');
        if (productionChecks && !(process.env.ALLOWED_ORIGINS || frontendOrigin)) throw new Error('The frontend HTTPS origin must be configured.');
        process.env.SPARELY_BEHIND_PROXY = '1';
        process.env.COOKIE_SECURE = '1';
        const app = applicationFactory({ watchdogInterval: 0 });
        try {
          await app.store.ready;
          await new Promise((resolve, reject) => {
            app.server.once('error', reject);
            app.server.listen(0, '127.0.0.1', resolve);
          });
          return app;
        } catch (error) { await app.store.close(); throw error; }
      })();
      starting.catch(() => { starting = undefined; });
    }
    return starting;
  };
  return {
    async fetch(request) {
      try {
        const incoming = new URL(request.url);
        const path = incoming.searchParams.get('sparelyPath');
        if (!path || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(path)) return Response.json({ error: 'Not found.' }, { status: 404 });
        incoming.searchParams.delete('sparelyPath');
        const body = await limitedBody(request.body);
        const app = await application();
        const target = new URL(`http://127.0.0.1:${app.server.address().port}/api/${path}${incoming.search}`);
        const headers = apiHeaders(request.headers);
        // Vercel overwrites this header with the client IP. Never trust a browser's
        // x-sparely-client header for abuse limits.
        headers.delete('x-sparely-client');
        const client = request.headers.get('x-vercel-forwarded-for');
        if (client && /^[0-9a-fA-F.:]{3,45}$/.test(client)) headers.set('x-sparely-client', client);
        if (request.headers.has('origin')) headers.set('origin', request.headers.get('origin'));
        const response = await fetch(target, { method: request.method, headers, body, redirect: 'manual' });
        const outgoing = new Headers(response.headers);
        for (const name of ['connection', 'keep-alive', 'transfer-encoding']) outgoing.delete(name);
        const cookies = response.headers.getSetCookie(); outgoing.delete('set-cookie');
        for (const cookie of cookies) outgoing.append('set-cookie', /;\s*Secure(?:;|$)/i.test(cookie) ? cookie : `${cookie}; Secure`);
        return new Response(response.body, { status: response.status, headers: outgoing });
      } catch (error) {
        console.error(JSON.stringify({ event: 'vercel_api_failed', code: String(error.code || 'unavailable').slice(0, 40) }));
        return error.status === 413 ? Response.json({ error: 'This upload is too large.' }, { status: 413 }) : unavailable();
      }
    },
    async runWatchdog(request) {
      const secret = process.env.CRON_SECRET;
      const supplied = request.headers.get('authorization')?.replace(/^Bearer /, '');
      if (request.method !== 'GET' || !secret || Buffer.byteLength(secret) < 32 || !supplied) return Response.json({ error: 'Unauthorized' }, { status: 401 });
      const a = Buffer.from(secret), b = Buffer.from(supplied);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
      try {
        const app = await application();
        const run = await app.store.ops.runWorker('schedule', { attempts: 2 });
        return Response.json({ ok: true, runId: run.id, durationMs: run.durationMs });
      } catch (error) {
        console.error(JSON.stringify({ event: 'vercel_watchdog_failed', code: String(error.code || 'unavailable').slice(0, 40) }));
        return unavailable();
      }
    },
    async close() {
      const app = await starting?.catch(() => null);
      if (app) {
        app.server.closeAllConnections();
        await new Promise(resolve => app.server.close(resolve));
        await app.store.close();
      }
    }
  };
}
