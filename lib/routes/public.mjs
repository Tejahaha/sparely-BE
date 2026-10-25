// Unauthenticated health routes. Runs before the database is awaited and before sign-in:
// responses carry only build info, check outcomes and migration ids — never private data.
// ctx: { req, res, url, store, json }
import { build, readiness } from '../ops.mjs';

export default async function publicRoutes({ req, url, store, json }) {
  if (!['GET', 'HEAD'].includes(req.method)) return undefined;
  // Liveness: the process answers. No database access.
  if (url.pathname === '/api/health') return json({ ok: true, build: { version: build.version, runtime: build.runtime, startedAt: build.startedAt } });
  // Readiness: database reachable, startup finished, no pending migrations.
  if (url.pathname === '/api/ready') {
    const result = await readiness(store);
    return json(result, result.ready ? 200 : 503);
  }
  return undefined;
}
