// HTTP routes for lib/messages.mjs. Return undefined when the request is not handled here.
// ctx: { req, res, url, input, user, store, json, command, AppError, fail }
import { fingerprint } from '../commands.mjs';

// Like main.mjs command(), but the receipt stores only references ({resource,id,conversationId})
// and a replay re-reads the current message/appointment/conversation for the caller.
async function run(ctx, resource, work, status = 200, required = false) {
  const { req, res, url, input, user, store, json } = ctx, m = store.messages;
  const result = await store.commands.execute(user.id, req.headers['idempotency-key'], fingerprint(req.method, url.pathname + url.search, input), async () => {
    const value = await work();
    return { resource, id: value.id, conversationId: value.conversationId || value.id, status: value.created === false ? 200 : status };
  }, { required });
  res.setHeader('Idempotency-Status', result.idempotency);
  const conversation = await m.view(result.conversationId, user.id);
  const data = resource === 'message' ? { message: await m.message(result.id, user.id), conversation }
    : resource === 'appointment' ? { appointment: await m.appointment(result.id, user.id), conversation }
    : { conversation };
  return json(data, result.status);
}

// json() returns undefined, so report "handled" whenever this module wrote a response.
export default async function routes(ctx) {
  await handle(ctx);
  return ctx.res.headersSent ? true : undefined;
}

async function handle(ctx) {
  const { req, url, input, user, store, json, command, fail } = ctx, m = store.messages, method = req.method, path = url.pathname, q = url.searchParams;
  if (path === '/api/conversations' && method === 'GET') return json(await m.list(user.id));
  if (path === '/api/conversations/unread-count' && method === 'GET') return json({ unreadCount: await m.unreadCount(user.id) });
  if (path === '/api/inbox' && method === 'GET') return json(await m.inbox(user.id, q.get('before'), q.get('limit')));
  let match = path.match(/^\/api\/inbox\/([^/]+)$/);
  if (match && method === 'PATCH') {
    fail(input.read !== true, 'Only read:true is supported for a notice.');
    return await command('value', async () => await m.readInbox(user.id, match[1]));
  }
  match = path.match(/^\/api\/listings\/([^/]+)\/enquiry$/);
  if (match && method === 'POST') return await run(ctx, 'conversation', async () => await m.openEnquiry(match[1], user.id), 201);
  match = path.match(/^\/api\/bookings\/([^/]+)\/conversation$/);
  if (match && method === 'GET') return json(await m.forBooking(match[1], user.id));
  match = path.match(/^\/api\/conversations\/([^/]+)(?:\/(messages|read|appointments))?$/);
  if (match) {
    const [, id, sub] = match;
    if (!sub && method === 'GET') return json({ conversation: await m.view(id, user.id) });
    if (sub === 'messages' && method === 'GET') return json(await m.page(id, user.id, { before: q.get('before'), after: q.get('after'), limit: q.get('limit') }));
    if (sub === 'messages' && method === 'POST') return await run(ctx, 'message', async () => await m.send(id, user.id, input), 201, true);
    if (sub === 'read' && method === 'PUT') return await command('value', async () => await m.markRead(id, user.id, input.seq));
    if (sub === 'appointments' && method === 'POST') return await run(ctx, 'appointment', async () => await m.propose(id, user.id, input), 201);
  }
  if (path === '/api/settings/language' && method === 'GET') return json({ language: await m.language(user.id) });
  if (path === '/api/settings/language' && method === 'PUT') return await command('value', async () => await m.setLanguage(user.id, input.language));
  match = path.match(/^\/api\/messages\/([^/]+)\/translation$/);
  if (match && method === 'POST') {
    await store.accounts.limit(`translate:${user.id}`, 120, 600_000);
    return json(await m.translate(match[1], user.id));
  }
  match = path.match(/^\/api\/appointments\/([^/]+)$/);
  if (match && method === 'GET') return json({ appointment: await m.appointment(match[1], user.id) });
  if (match && method === 'PATCH') return await run(ctx, 'appointment', async () => await m.respond(match[1], user.id, input));
  return undefined;
}
