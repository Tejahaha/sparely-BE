// HTTP routes for lib/handover.mjs. Return undefined when the request is not handled here.
// ctx: { req, res, url, input, user, store, json, command, AppError, fail }
import { fingerprint } from '../commands.mjs';

// Idempotent command whose receipt stores only a reference ({resource:'agreement', id}); a replay
// re-reads the current agreement view for the caller instead of returning a frozen copy.
async function run(ctx, bookingId, work, required = true) {
  const { req, res, url, input, user, store, json } = ctx;
  const result = await store.commands.execute(user.id, req.headers['idempotency-key'], fingerprint(req.method, url.pathname + url.search, input), async () => {
    await work();
    return { resource: 'agreement', id: bookingId, status: 200 };
  }, { required });
  res.setHeader('Idempotency-Status', result.idempotency);
  return json({ agreement: await store.handover.view(bookingId, user.id) }, result.status);
}

export default async function routes(ctx) {
  await handle(ctx);
  return ctx.res.headersSent ? true : undefined;
}

async function handle(ctx) {
  const { req, url, input, user, store, json } = ctx, h = store.handover, method = req.method, path = url.pathname;
  if (path === '/api/no-show-reports' && method === 'GET') return json(await h.openReports(user.id));
  const match = path.match(/^\/api\/bookings\/([^/]+)\/(agreement|agreement\/accept|agreement\/disagree|agreement\/revisions|reschedule|no-show)$/);
  if (!match) return undefined;
  const [, id, sub] = match;
  if (sub === 'agreement' && method === 'GET') return json({ agreement: await h.view(id, user.id) });
  if (sub === 'agreement/accept' && method === 'POST') return await run(ctx, id, () => h.accept(user.id, id, input));
  if (sub === 'agreement/disagree' && method === 'POST') return await run(ctx, id, () => h.disagree(user.id, id, input));
  if (sub === 'agreement/revisions' && method === 'POST') return await run(ctx, id, () => h.propose(user.id, id, input));
  if (sub === 'reschedule' && method === 'POST') return await run(ctx, id, () => h.proposeReschedule(user.id, id, input));
  if (sub === 'reschedule' && method === 'PATCH') return await run(ctx, id, () => h.decideReschedule(user.id, id, input));
  if (sub === 'no-show' && method === 'POST') return await run(ctx, id, () => h.reportNoShow(user.id, id, input));
  if (sub === 'no-show' && method === 'PATCH') return await run(ctx, id, () => h.actOnNoShow(user.id, id, input));
  return undefined;
}
