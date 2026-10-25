import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, extname, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, AppError, fail, quote, timeRange } from './lib/store.mjs';
import { categories } from './lib/seed.mjs';
import { assist } from './lib/assistant.mjs';
import { llmEnabled } from './lib/llm.mjs';
import { fingerprint } from './lib/commands.mjs';
import { createRemoteProxy } from './lib/remote-proxy.mjs';
import { publicRouteModules, routeModules } from './lib/routes/index.mjs';
import { errorCode, logError, logRequest, routeTemplate } from './lib/ops.mjs';
import { acceptRequestId } from './lib/http-body.mjs';
import { frontendOrigin } from './deployment.config.mjs';
const root = dirname(fileURLToPath(import.meta.url));
// Extra browser origins allowed to mutate, e.g. a remote frontend dev proxy. Comma-separated exact origins.
const allowedOrigins = String(process.env.ALLOWED_ORIGINS || frontendOrigin).split(',').map(o => o.trim()).filter(Boolean);
// The shared demo world (profile switching, scenarios, demo clock). SPARELY_DEMO=off disables it.
const demoEnabled = process.env.SPARELY_DEMO !== 'off';
const SESSION_SECONDS = 7 * 86400;
const frontendRoot = resolve(root, existsSync(resolve(root, '../frontend/package.json')) ? '../frontend' : '../../frontend');
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.json': 'application/json'
};
export function createApplication({
  dbPath = process.env.SPARELY_DATABASE_URL || process.env.DATABASE_URL || resolve(root, 'data/sparely.db'),
  allowCreate = false,
  watchdogInterval = 30_000
} = {}) {
  fail(!/^postgres(?:ql)?:\/\//.test(dbPath) && dbPath !== ':memory:' && !existsSync(dbPath) && !allowCreate, 'Persistent database is missing. Restore the verified backup, or explicitly initialize a new installation. Refusing to silently create a fresh database.', 503);
  const store = new Store(dbPath);
  const watchdog = watchdogInterval > 0 ? setInterval(async () => {
    try {
      await store.ready;
      await store.ops.runWorker('local');
    } catch (error) {
      logError({ event: 'watchdog_failed', trigger: 'local', force: true }, error);
    }
  }, watchdogInterval) : null;
  watchdog?.unref();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const requestId = acceptRequestId(req.headers['x-request-id']), startedAt = performance.now();
    res.setHeader('X-Request-Id', requestId);
    // One line per request; "session" means a session cookie was presented (no values logged).
    res.on('finish', () => logRequest({ requestId, method: req.method, path: url.pathname, status: res.statusCode, ms: performance.now() - startedAt, session: /(?:^|;\s*)sparely_session=[a-f0-9]/.test(String(req.headers.cookie || '')) }));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    const json = (value, status = 200) => {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(JSON.stringify(value));
    };
    try {
      for (const handle of publicRouteModules) {
        const handled = await handle({ req, res, url, store, json });
        if (handled !== undefined || res.headersSent) return handled;
      }
      await store.ready;
      if (!url.pathname.startsWith('/api/')) {
        if (!['GET', 'HEAD'].includes(req.method)) return json({
          error: 'Method not allowed.'
        }, 405);
        const staticRoot = existsSync(resolve(frontendRoot, 'dist/index.html')) ? resolve(frontendRoot, 'dist') : resolve(frontendRoot, 'public');
        const path = resolve(staticRoot, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
        if (!path.startsWith(staticRoot + sep)) return json({
          error: 'Not found.'
        }, 404);
        try {
          await stat(path);
        } catch {
          return json({
            error: 'Not found.'
          }, 404);
        }
        const body = await readFile(path);
        res.writeHead(200, {
          'Content-Type': mime[extname(path)] || 'application/octet-stream',
          'Content-Length': body.length,
          'Cache-Control': 'no-cache'
        });
        return res.end(req.method === 'HEAD' ? undefined : body);
      }
      let input = {};
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && !allowedOrigins.includes(req.headers.origin)) throw new AppError('Request origin is not allowed.', 403);
        fail(!String(req.headers['content-type'] || '').startsWith('application/json'), 'Send a JSON request.', 415);
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          fail(size > 5_000_000, 'This upload is too large.', 413);
          chunks.push(chunk);
        }
        try {
          input = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        } catch {
          throw new AppError('The request JSON is invalid.');
        }
        fail(input === null || typeof input !== 'object' || Array.isArray(input), 'Send a JSON object.');
      }
      const token = String(req.headers.cookie || '').match(/(?:^|;\s*)sparely_session=([a-f0-9]{64})(?:;|$)/)?.[1];
      let user = await store.session(token);
      // Behind the trusted Function proxy every request arrives from loopback; the proxy supplies the caller address.
      const clientKey = (process.env.SPARELY_BEHIND_PROXY === '1' && req.headers['x-sparely-client']) || req.socket.remoteAddress || 'unknown';
      const secure = process.env.COOKIE_SECURE === '1' || req.headers['x-forwarded-proto'] === 'https';
      const setSession = value => res.setHeader('Set-Cookie', `sparely_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${value ? SESSION_SECONDS : 0}${secure ? '; Secure' : ''}`);
      const bootstrap = async current => {
        const world = current ? await store.accounts.world(current.id) : null;
        return {
          user: current || null,
          account: current && world === 'account' ? await store.accounts.account(current.id) : null,
          mode: world,
          demoEnabled,
          users: world === 'demo' ? await store.users() : current ? [current] : [],
          categories,
          cities: ['Hyderabad', 'Bengaluru'],
          demo: world === 'demo',
          // 'local_model' = a self-hosted model (LLM_URL) helps search and reminder wording.
          modelCalls: llmEnabled() ? 'local_model' : 'disabled',
          assistantMode: llmEnabled() ? 'model' : 'local'
        };
      };
      // Rotate: a new sign-in or profile replaces the old session token.
      const startSession = async (userId, status = 200) => {
        if (token) await store.endSession(token);
        setSession(await store.createSession(userId));
        return json(await bootstrap(await store.user(userId)), status);
      };
      const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
      if (url.pathname === '/api/bootstrap' && req.method === 'GET') return json(await bootstrap(user));
      if (url.pathname === '/api/auth/signup' && req.method === 'POST') return await startSession(await store.accounts.signup(input, clientKey), 201);
      if (url.pathname === '/api/auth/login' && req.method === 'POST') return await startSession(await store.accounts.login(input, clientKey));
      if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
        if (token) await store.endSession(token);
        setSession('');
        return json(await bootstrap(null));
      }
      if (url.pathname === '/api/auth/reset' && req.method === 'POST') {
        await store.accounts.reset(input, clientKey);
        return json({ ok: true });
      }
      if (url.pathname === '/api/session' && req.method === 'POST') {
        fail(!demoEnabled, 'The demo is turned off on this server.', 403);
        const target = await store.user(String(input.userId || ''));
        fail((await store.accounts.world(target.id)) !== 'demo', 'Only shared demo profiles can be switched to.', 403);
        fail(user && (await store.accounts.world(user.id)) === 'account', 'Sign out of your account before trying the demo.', 409);
        return await startSession(target.id);
      }
      fail(!user, 'Sign in to continue.', 401);
      // Every write names the account it was started under. A mismatch means the session
      // changed while the request was in flight: refuse rather than act as someone else.
      if (mutating) {
        const expected = req.headers['x-sparely-actor'];
        if (!expected) throw new AppError('This request is missing its account check. Reload and try again.', 428, 'ACTOR_REQUIRED');
        if (expected !== user.id) throw new AppError('You switched accounts before this finished. Nothing was changed.', 409, 'ACTOR_CHANGED');
        // Quotas (shared across instances): uploads, publishing and reports.
        if (input.image || input.photo) await store.accounts.limit(`upload:${user.id}`, 60, 3600_000);
        if (url.pathname === '/api/listings' && req.method === 'POST') await store.accounts.limit(`publish:${user.id}`, 20, 86400_000);
        if (/^\/api\/bookings\/[^/]+\/incidents$/.test(url.pathname)) await store.accounts.limit(`report:${user.id}`, 10, 86400_000);
      }
      if (url.pathname === '/api/auth/password' && req.method === 'POST') {
        await store.accounts.changePassword(user.id, input, token);
        return json({ ok: true });
      }
      if (url.pathname === '/api/admin/password-resets' && req.method === 'POST') return json(await store.accounts.issueReset(user.id, input), 201);
      await store.evaluate();
      const command = async (resource, work, status = 200, required = false) => {
        const result = await store.commands.execute(user.id, req.headers['idempotency-key'], fingerprint(req.method, url.pathname + url.search, input), async () => {
          const value = await work();
          return resource === 'value' ? {
            resource,
            data: value,
            status
          } : {
            resource,
            id: value.id,
            status
          };
        }, {
          required
        });
        res.setHeader('Idempotency-Status', result.idempotency);
        const data = result.resource === 'booking' ? {
          booking: await store.booking(result.id, user.id)
        } : result.resource === 'listing' ? {
          listing: await store.listing(result.id, user.id)
        } : result.resource === 'incident' ? {
          incident: await store.recovery.get(result.id, user.id)
        } : result.resource === 'profile' ? {
          profile: await store.profiles.ownerView(user.id, result.id)
        } : result.data;
        return json(data, result.status);
      };
      if (url.pathname === '/api/incidents' && req.method === 'GET') return json({
        incidents: await store.recovery.list(user.id)
      });
      if (url.pathname === '/api/safety-notices' && req.method === 'GET') return json(await store.recovery.notices(user.id, await url.searchParams.get('before')));
      let safetyMatch = url.pathname.match(/^\/api\/commands\/([A-Za-z0-9._:-]{16,128})$/);
      if (safetyMatch && req.method === 'GET') {
        const receipt = await store.db.prepare('SELECT result,created_at FROM command_receipts WHERE actor_id=? AND key=?').get(user.id, safetyMatch[1]);
        fail(!receipt, 'No committed operation was found for this key.', 404);
        const result = JSON.parse(receipt.result);
        return json({
          committed: true,
          resource: result.resource,
          id: result.id || null,
          httpStatus: result.status,
          createdAt: receipt.created_at
        });
      }
      safetyMatch = url.pathname.match(/^\/api\/bookings\/([^/]+)\/(incidents|recovery)$/);
      if (safetyMatch?.[2] === 'incidents' && req.method === 'POST') return await command('incident', async () => await store.recovery.open(user.id, safetyMatch[1], input), 201, true);
      if (safetyMatch?.[2] === 'recovery' && req.method === 'GET') return json(await store.recovery.plan(safetyMatch[1], user.id));
      safetyMatch = url.pathname.match(/^\/api\/incidents\/([^/]+)$/);
      if (safetyMatch && req.method === 'GET') return json({
        incident: await store.recovery.get(safetyMatch[1], user.id)
      });
      if (safetyMatch && req.method === 'PATCH') return await command('incident', async () => await store.recovery.action(user.id, safetyMatch[1], input), 200, true);
      safetyMatch = url.pathname.match(/^\/api\/safety-notices\/([^/]+)$/);
      if (safetyMatch && req.method === 'PATCH') {
        fail(input.read !== true, 'Only read:true is supported for a notice.');
        return await command('value', async () => await store.recovery.readNotice(user.id, safetyMatch[1]));
      }
      if (url.pathname === '/api/reviews' && req.method === 'GET') return json({
        bookings: await store.reviews(user.id)
      });
      if (url.pathname === '/api/scenarios' && req.method === 'POST') {
        fail(!demoEnabled || (await store.accounts.world(user.id)) !== 'demo', 'Scenarios are only available in the demo.', 403);
        const booking = await store.createScenario(input.kind);
        if (token) await store.endSession(token);
        setSession(await store.createSession('teja'));
        return json({
          booking
        }, 201);
      }
      if (url.pathname === '/api/listings' && req.method === 'GET') return json({
        listings: await store.search(Object.fromEntries(url.searchParams), user.id)
      });
      if (url.pathname === '/api/listings' && req.method === 'POST') return await command('listing', async () => await store.createListing(user.id, input), 201);
      if (url.pathname === '/api/host' && req.method === 'GET') return json({
        listings: await store.hosted(user.id),
        bookings: await store.bookings(user.id, true)
      });
      if (url.pathname === '/api/bookings' && req.method === 'GET') return json({
        bookings: await store.bookings(user.id)
      });
      if (url.pathname === '/api/bookings' && req.method === 'POST') return await command('booking', async () => await store.createBooking(user.id, input), 201);
      if (url.pathname === '/api/assist' && req.method === 'POST') return json(await assist(store, user.id, input));
      let match = url.pathname.match(/^\/api\/listings\/([^/]+)(?:\/(favorite|quote))?$/);
      if (match) {
        const [, id, action] = match;
        if (action === 'favorite' && req.method === 'PUT') return await command('value', async () => {
          await store.favorite(user.id, id, input.saved === true);
          return {
            saved: input.saved === true
          };
        });
        if (action === 'quote' && req.method === 'POST') {
          await store.expire();
          const l = await store.visibleListing(id, user.id),
            dates = timeRange(input.start, input.end);
          // Storage: price and capacity depend on the renter's requested floor area (M4).
          // Without a valid intake yet, area-priced storage returns availability only.
          let intake = null;
          if (l.category === 'storage' && input.intake) try { intake = store.capacity.normaliseIntake(input.intake, l); } catch { intake = null; }
          const priced = intake ? await store.capacity.storageQuote(l, dates.start, dates.end, intake) : null;
          return json({
            ...(priced || (store.capacity.isAreaPriced(l) ? { units: null, rental: null, deposit: l.deposit, total: null, currency: 'INR', pricingVersion: 'area-v1', needsIntake: true } : quote(l, dates.start, dates.end))),
            available: l.active && (await store.available(id, dates.start, dates.end, '', intake?.footprintTenths ?? null)),
            ...(store.capacity.shared(l) ? { availableSqft: await store.capacity.availableSqft(l, dates.start, dates.end) } : {})
          });
        }
        if (!action && req.method === 'GET') {
          await store.expire();
          return json({
            listing: await store.visibleListing(id, user.id)
          });
        }
        if (!action && req.method === 'PATCH') return await command('listing', async () => await store.toggleListing(user.id, id, input.active === true));
        if (!action && req.method === 'PUT') return await command('listing', async () => await store.editListing(user.id, id, input));
      }
      match = url.pathname.match(/^\/api\/listings\/([^/]+)\/(profile|publish)$/);
      if (match?.[2] === 'profile' && req.method === 'GET') return json({ profile: await store.profiles.ownerView(user.id, match[1]) });
      if (match?.[2] === 'profile' && req.method === 'PUT') return await command('profile', async () => { await store.profiles.save(user.id, match[1], input); return { id: match[1] }; });
      if (match?.[2] === 'publish' && req.method === 'POST') return await command('listing', async () => await store.profiles.publish(user.id, match[1]));
      match = url.pathname.match(/^\/api\/listings\/([^/]+)\/blocks(?:\/([^/]+))?$/);
      if (match && !match[2] && req.method === 'POST') return await command('listing', async () => await store.addBlock(user.id, match[1], input), 201);
      if (match && match[2] && req.method === 'DELETE') return await command('listing', async () => await store.removeBlock(user.id, match[1], match[2]));
      match = url.pathname.match(/^\/api\/bookings\/([^/]+)$/);
      if (match && req.method === 'GET') {
        await store.expire();
        return json({
          booking: await store.booking(match[1], user.id)
        });
      }
      if (match && req.method === 'PATCH') return await command('booking', async () => await store.transition(user.id, match[1], input));
      for (const handle of routeModules) {
        const handled = await handle({ req, res, url, input, user, store, json, command, AppError, fail });
        if (handled !== undefined || res.headersSent) return handled;
      }
      json({
        error: 'Not found.'
      }, 404);
    } catch (error) {
      const busy = ['55P03', '40001', '40P01', '53300', '57P03'].includes(error.code) || error.errcode === 5 || error.errcode === 6 || /database is (locked|busy)/i.test(error.message);
      const status = busy ? 503 : error.status || 500;
      if (status >= 500) {
        // Structured, PII-free: request id, route template, status and an error code only.
        logError({ event: 'server_error', requestId, method: req.method, route: routeTemplate(url.pathname), status, force: !(error instanceof AppError) && !busy }, error);
        store.ops?.recordError({ requestId, method: req.method, path: url.pathname, status, code: busy ? 'STORAGE_BUSY' : error instanceof AppError ? error.code : errorCode(error) }).catch(() => {});
      }
      if (!res.headersSent) {
        if (busy) res.setHeader('Retry-After', '1');
        if (error.code === 'RATE_LIMITED') res.setHeader('Retry-After', String(error.details?.retryAfterSeconds || 60));
        json(busy ? {
          error: 'Storage is busy. Retry the same operation with the same Idempotency-Key.',
          code: 'STORAGE_BUSY',
          retryable: true
        } : {
          error: error instanceof AppError ? error.message : 'Something went wrong. Check the operation status before retrying.',
          ...(error.code && error instanceof AppError ? {
            code: error.code
          } : {}),
          ...(error.details ? {
            details: error.details
          } : {})
        }, status);
      }
    }
  });
  server.on('close', async () => {
    clearInterval(watchdog);
    await store.close();
  });
  return {
    server,
    store
  };
}
if (!process.env.SPARELY_FUNCTION_RUNTIME && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.NEON_FUNCTION_URL) {
    // Keep the existing Vite /api target while the business API runs on Neon.
    const server = createRemoteProxy({ functionUrl: process.env.NEON_FUNCTION_URL, secret: process.env.ORIGIN_SECRET, appOrigin: process.env.APP_ORIGIN, frontendRoot, allowedOrigins });
    server.listen(Number(process.env.PORT || 4173), process.env.HOST || '127.0.0.1', () => console.log(`Sparely proxy is ready at http://127.0.0.1:${server.address().port}; API runs on Neon Functions.`));
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
  } else {
  const {
    server, store
  } = createApplication();
  await store.ready;
  server.listen(Number(process.env.PORT || 4173), process.env.HOST || '127.0.0.1', () => console.log(`Sparely is ready at http://127.0.0.1:${server.address().port}\nDemo profiles and sample listings are enabled. No real payments are processed.`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(async () => { await store.close(); process.exit(0); }));
  }
}
