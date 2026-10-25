// HTTP routes for lib/settlement.mjs. Return undefined when the request is not handled here.
// ctx: { req, res, url, input, user, store, json, command, AppError, fail }
import { fingerprint } from '../commands.mjs';

export default async function routes(ctx) {
  const { req, res, url, input, user, store, json } = ctx, s = store.settlement, path = url.pathname, method = req.method;
  let match = path.match(/^\/api\/bookings\/([^/]+)\/ledger$/);
  if (match && method === 'GET') return json({ ledger: await s.ledger(match[1], user.id) }) ?? true;
  if (path === '/api/settlement/review' && method === 'GET') return json(await s.review(user.id)) ?? true;
  match = path.match(/^\/api\/settlement\/([^/]+)\/decisions$/);
  if (match && method === 'GET') {
    await s.access(match[1], user.id);
    return json({ decisions: await s.decisions(match[1]) }) ?? true;
  }
  if (match && method === 'POST') {
    // Idempotency-Key required; the receipt stores references only and a replay re-reads them.
    const result = await store.commands.execute(user.id, req.headers['idempotency-key'], fingerprint(method, path, input),
      async () => ({ resource: 'settlement_decision', ...(await s.decide(user.id, match[1], input)), status: 201 }), { required: true });
    res.setHeader('Idempotency-Status', result.idempotency);
    return json({ decision: await s.decision(result.id), ledger: await s.ledger(result.bookingId, user.id) }, result.status) ?? true;
  }
  return undefined;
}
