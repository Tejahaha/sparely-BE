import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApplication } from '../main.mjs';

const dates = (days = 1) => ({ start: new Date(Date.now() + days * 86400000).toISOString(), end: new Date(Date.now() + (days + 1) * 86400000).toISOString() });
const later = (hours = 24) => new Date(Date.now() + hours * 3600000).toISOString();

async function app(callback) {
  const { server, store } = createApplication({ dbPath: ':memory:', watchdogInterval: 0 });
  await store.ready;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const device = () => {
    let cookie = '', actor = '';
    const call = async (path, { method = 'GET', body, key = method === 'GET' ? undefined : randomUUID() } = {}) => {
      const response = await fetch(origin + '/api' + path, { method, headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(method !== 'GET' && actor ? { 'X-Sparely-Actor': actor } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const data = await response.json().catch(() => ({}));
      const next = response.headers.get('set-cookie')?.split(';')[0];
      if (next) { cookie = next.endsWith('=') ? '' : next; actor = data.user?.id || ''; }
      return { status: response.status, data, idempotency: response.headers.get('idempotency-status') };
    };
    return { call, get actor() { return actor; } };
  };
  const as = async id => { const d = device(); await d.call('/session', { method: 'POST', body: { userId: id } }); return d; };
  try { await callback({ device, as, store }); } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('enquiry: participants only, owner cannot enquire, open-or-get, cross-world denied', async () => await app(async ({ as, device }) => {
  const teja = await as('teja'), aanya = await as('aanya'), kabir = await as('kabir');
  assert.equal((await aanya.call('/listings/drill-kit/enquiry', { method: 'POST', body: {} })).data.code, 'OWN_LISTING');
  const first = await teja.call('/listings/drill-kit/enquiry', { method: 'POST', body: {} });
  assert.equal(first.status, 201);
  const conv = first.data.conversation;
  assert.equal(conv.kind, 'enquiry'); assert.equal(conv.viewerRole, 'renter'); assert.equal(conv.delivery, 'in_app_only'); assert.equal(conv.bindingTerms, false);
  const again = await teja.call('/listings/drill-kit/enquiry', { method: 'POST', body: {} });
  assert.equal(again.status, 200); assert.equal(again.data.conversation.id, conv.id, 'one enquiry per listing + renter');
  assert.equal((await aanya.call(`/conversations/${conv.id}`)).data.conversation.viewerRole, 'host');
  assert.equal((await kabir.call(`/conversations/${conv.id}`)).status, 404, 'outsider cannot read an enquiry');
  assert.equal((await kabir.call(`/conversations/${conv.id}/messages`)).status, 404);
  assert.equal((await kabir.call(`/conversations/${conv.id}/messages`, { method: 'POST', body: { body: 'hi' } })).status, 404);
  const mira = await as('mira');
  assert.equal((await mira.call(`/conversations/${conv.id}`)).status, 404, 'operators cannot read enquiries');
  const account = device();
  await account.call('/auth/signup', { method: 'POST', body: { name: 'Real Person', email: 'real@example.com', password: 'real password 123' } });
  assert.equal((await account.call(`/conversations/${conv.id}`)).status, 404, 'cross-world access denied');
  assert.equal((await account.call('/listings/drill-kit/enquiry', { method: 'POST', body: {} })).status, 404);
  assert.deepEqual((await kabir.call('/conversations')).data.conversations, []);
}));

test('messages: retry-safe send, validation, stable pagination, per-participant unread and read markers', async () => await app(async ({ as, store }) => {
  const teja = await as('teja'), aanya = await as('aanya');
  const id = (await teja.call('/listings/drill-kit/enquiry', { method: 'POST', body: {} })).data.conversation.id;
  const key = randomUUID();
  const sent = await teja.call(`/conversations/${id}/messages`, { method: 'POST', body: { body: 'Is the drill free this Saturday?' }, key });
  assert.equal(sent.status, 201); assert.equal(sent.idempotency, 'created'); assert.equal(sent.data.message.seq, 1); assert.equal(sent.data.message.delivery, 'in_app');
  const replay = await teja.call(`/conversations/${id}/messages`, { method: 'POST', body: { body: 'Is the drill free this Saturday?' }, key });
  assert.equal(replay.status, 201); assert.equal(replay.idempotency, 'replayed'); assert.equal(replay.data.message.id, sent.data.message.id);
  assert.equal((await store.db.prepare('SELECT COUNT(*) AS n FROM conversation_messages WHERE conversation_id=?').get(id)).n, 1, 'same key creates exactly one message');
  const receipt = JSON.parse((await store.db.prepare('SELECT result FROM command_receipts WHERE key=?').get(key)).result);
  assert.deepEqual(Object.keys(receipt).sort(), ['conversationId', 'id', 'resource', 'status'], 'receipt references, never copies content');
  assert.equal((await teja.call(`/conversations/${id}/messages`, { method: 'POST', body: { body: 'x' }, key: null })).data.code, 'IDEMPOTENCY_KEY_REQUIRED');
  assert.equal((await teja.call(`/conversations/${id}/messages`, { method: 'POST', body: { body: '   ' } })).status, 400);
  assert.equal((await teja.call(`/conversations/${id}/messages`, { method: 'POST', body: { body: 'a'.repeat(2001) } })).status, 400);
  assert.equal((await aanya.call('/conversations/unread-count')).data.unreadCount, 1);
  assert.equal((await teja.call('/conversations/unread-count')).data.unreadCount, 0, 'own messages are not unread');
  for (let i = 2; i <= 7; i++) await (i % 2 ? teja : aanya).call(`/conversations/${id}/messages`, { method: 'POST', body: { body: `message ${i}` } });
  const conv = (await aanya.call(`/conversations/${id}`)).data.conversation;
  assert.equal(conv.revision, 7); assert.equal(conv.reference, `${id}@7`);
  assert.equal(conv.unreadCount, 1, 'aanya replied after message 1, then teja sent 3, 5, 7; her own sends marked earlier read');
  // Pagination by sequence: stable while new messages arrive.
  const p1 = (await aanya.call(`/conversations/${id}/messages?limit=3`)).data;
  assert.deepEqual(p1.messages.map(m => m.seq), [5, 6, 7]); assert.equal(p1.nextBefore, '5');
  await teja.call(`/conversations/${id}/messages`, { method: 'POST', body: { body: 'new while paging' } });
  const p2 = (await aanya.call(`/conversations/${id}/messages?limit=3&before=${p1.nextBefore}`)).data;
  assert.deepEqual(p2.messages.map(m => m.seq), [2, 3, 4]);
  const p3 = (await aanya.call(`/conversations/${id}/messages?limit=3&before=${p2.nextBefore}`)).data;
  assert.deepEqual(p3.messages.map(m => m.seq), [1]); assert.equal(p3.nextBefore, null);
  assert.deepEqual((await aanya.call(`/conversations/${id}/messages?after=7`)).data.messages.map(m => m.seq), [8]);
  assert.equal((await aanya.call(`/conversations/${id}/messages?before=abc`)).status, 400);
  assert.equal((await aanya.call('/conversations/unread-count')).data.unreadCount, 2);
  const read = await aanya.call(`/conversations/${id}/read`, { method: 'PUT', body: { seq: 8 } });
  assert.equal(read.data.unreadCount, 0);
  await aanya.call(`/conversations/${id}/read`, { method: 'PUT', body: { seq: 2 } });
  assert.equal((await aanya.call(`/conversations/${id}`)).data.conversation.readSeq, 8, 'read marker never moves backwards');
  assert.equal((await aanya.call('/conversations')).data.conversations[0].lastMessage.body, 'new while paging');
}));

test('notices: deduplicated per unread burst; unified inbox merges safety notices and marks either read', async () => await app(async ({ as, store }) => {
  const teja = await as('teja'), aanya = await as('aanya');
  const id = (await teja.call('/listings/drill-kit/enquiry', { method: 'POST', body: {} })).data.conversation.id;
  for (const body of ['one', 'two', 'three']) await teja.call(`/conversations/${id}/messages`, { method: 'POST', body: { body } });
  let inbox = (await aanya.call('/inbox')).data;
  assert.equal(inbox.items.filter(i => i.kind === 'message').length, 1, 'three unread messages make one notice');
  assert.equal(inbox.delivery, 'in_app_only'); assert.equal(inbox.items[0].link, `conversation/${id}`);
  await aanya.call(`/conversations/${id}/read`, { method: 'PUT', body: {} });
  await teja.call(`/conversations/${id}/messages`, { method: 'POST', body: { body: 'four' } });
  assert.equal((await aanya.call('/inbox')).data.items.filter(i => i.kind === 'message').length, 2, 'a new burst after reading makes a new notice');
  assert.equal(await store.messages.notify({ recipientId: 'aanya', kind: 'test', dedupeKey: 'k1', title: 'Once' }), true);
  assert.equal(await store.messages.notify({ recipientId: 'aanya', kind: 'test', dedupeKey: 'k1', title: 'Once' }), false, 'same dedupe key is stored once');
  // A recovery safety notice for aanya (host of a demo booking).
  const booking = (await teja.call('/bookings', { method: 'POST', body: { listingId: 'drill-kit', ...dates(), agreed: true } })).data.booking;
  await store.db.prepare('INSERT INTO safety_notices VALUES(?,?,?,?,?,?,?,?,NULL)').run('safety-test-1', 'aanya', 'test:aanya', booking.id, null, 'incident_opened', 'A safety notice.', new Date(Date.now() + 1000).toISOString());
  inbox = (await aanya.call('/inbox?limit=2')).data;
  assert.equal(inbox.items[0].source, 'safety'); assert.equal(inbox.items[0].bookingId, booking.id);
  assert.equal(inbox.unreadCount, 4);
  const rest = (await aanya.call(`/inbox?limit=2&before=${inbox.nextCursor}`)).data;
  assert.equal(rest.items.length, 2); assert.equal(rest.nextCursor, null);
  assert.equal(new Set([...inbox.items, ...rest.items].map(i => i.id)).size, 4, 'pages do not overlap');
  assert.equal((await aanya.call('/inbox/safety-test-1', { method: 'PATCH', body: { read: true } })).status, 200);
  assert.equal((await aanya.call(`/inbox/${rest.items[0].id}`, { method: 'PATCH', body: { read: true } })).status, 200);
  assert.equal((await aanya.call('/inbox')).data.unreadCount, 2);
  assert.equal((await teja.call(`/inbox/${rest.items[0].id}`, { method: 'PATCH', body: { read: true } })).status, 404, 'cannot mark another person’s notice');
  assert.equal((await aanya.call('/inbox?before=bad')).status, 400);
}));

test('appointments: both see the same confirmed time; reschedule supersedes; stale version rejected; proposer cannot confirm', async () => await app(async ({ as }) => {
  const teja = await as('teja'), aanya = await as('aanya');
  const id = (await teja.call('/listings/drill-kit/enquiry', { method: 'POST', body: {} })).data.conversation.id;
  assert.equal((await teja.call(`/conversations/${id}/appointments`, { method: 'POST', body: { kind: 'call', startsAt: new Date(Date.now() - 3600000).toISOString() } })).status, 400);
  assert.equal((await teja.call(`/conversations/${id}/appointments`, { method: 'POST', body: { kind: 'call', startsAt: later(), timezone: 'Mars/Base' } })).status, 400);
  const proposed = await teja.call(`/conversations/${id}/appointments`, { method: 'POST', body: { kind: 'viewing', startsAt: later(), accessQuestions: 'Is there a lift?' } });
  assert.equal(proposed.status, 201);
  const a = proposed.data.appointment;
  assert.equal(a.status, 'proposed'); assert.equal(a.timezone, 'Asia/Kolkata'); assert.equal(a.canConfirm, false);
  assert.equal((await teja.call(`/appointments/${a.id}`, { method: 'PATCH', body: { action: 'confirm', expectedVersion: 1 } })).status, 403, 'only the other participant confirms');
  // Reschedule by the host: supersedes the old proposal.
  const moved = await aanya.call(`/conversations/${id}/appointments`, { method: 'POST', body: { kind: 'viewing', startsAt: later(48), supersedes: a.id, expectedVersion: 1 } });
  assert.equal(moved.status, 201);
  const b = moved.data.appointment;
  assert.equal(b.supersedesId, a.id);
  const old = (await teja.call(`/appointments/${a.id}`)).data.appointment;
  assert.equal(old.status, 'superseded'); assert.equal(old.supersededById, b.id);
  const stale = await teja.call(`/appointments/${a.id}`, { method: 'PATCH', body: { action: 'confirm', expectedVersion: 1 } });
  assert.equal(stale.status, 409); assert.equal(stale.data.code, 'STALE_APPOINTMENT');
  assert.equal((await aanya.call(`/conversations/${id}/appointments`, { method: 'POST', body: { kind: 'viewing', startsAt: later(72), supersedes: a.id, expectedVersion: 1 } })).data.code, 'STALE_APPOINTMENT');
  const confirmed = await teja.call(`/appointments/${b.id}`, { method: 'PATCH', body: { action: 'confirm', expectedVersion: b.version } });
  assert.equal(confirmed.status, 200); assert.equal(confirmed.data.appointment.status, 'confirmed');
  const seenByHost = (await aanya.call(`/conversations/${id}`)).data.conversation.appointments.find(x => x.status === 'confirmed');
  const seenByRenter = (await teja.call(`/conversations/${id}`)).data.conversation.appointments.find(x => x.status === 'confirmed');
  assert.equal(seenByHost.id, b.id); assert.equal(seenByHost.startsAt, seenByRenter.startsAt); assert.equal(seenByHost.version, seenByRenter.version);
  const inbox = (await aanya.call('/inbox')).data.items.map(i => i.kind);
  assert.ok(inbox.includes('appointment_confirmed') && (await teja.call('/inbox')).data.items.some(i => i.kind === 'appointment_proposed'));
  assert.equal((await teja.call(`/appointments/${b.id}`, { method: 'PATCH', body: { action: 'confirm', expectedVersion: b.version } })).status, 409, 'old version after confirm');
  const cancelled = await aanya.call(`/appointments/${b.id}`, { method: 'PATCH', body: { action: 'cancel', expectedVersion: confirmed.data.appointment.version } });
  assert.equal(cancelled.data.appointment.status, 'cancelled');
  assert.ok((await teja.call('/inbox')).data.items.some(i => i.kind === 'appointment_cancelled'));
}));

test('booking conversation: participants open it; reviewing operator reads only; outsiders denied', async () => await app(async ({ as }) => {
  const teja = await as('teja');
  const booking = (await teja.call('/scenarios', { method: 'POST', body: { kind: 'damage' } })).data.booking;
  const host = await as(booking.listing.ownerId), kabir = await as(booking.listing.ownerId === 'kabir' ? 'aanya' : 'kabir'), mira = await as('mira');
  const open = (await teja.call(`/bookings/${booking.id}/conversation`)).data;
  assert.equal(open.conversation.kind, 'booking'); assert.equal(open.conversation.bookingId, booking.id);
  assert.equal((await host.call(`/bookings/${booking.id}/conversation`)).data.conversation.id, open.conversation.id, 'one conversation per booking');
  await host.call(`/conversations/${open.conversation.id}/messages`, { method: 'POST', body: { body: 'The charger was missing on return.' } });
  assert.equal((await kabir.call(`/bookings/${booking.id}/conversation`)).status, 403);
  assert.equal((await kabir.call(`/conversations/${open.conversation.id}`)).status, 404);
  const observed = (await mira.call(`/bookings/${booking.id}/conversation`)).data;
  assert.equal(observed.conversation.readOnly, true); assert.equal(observed.conversation.viewerRole, 'observer');
  assert.equal(observed.messages.length, 1);
  assert.equal((await mira.call(`/conversations/${open.conversation.id}/messages`)).status, 200);
  assert.equal((await mira.call(`/conversations/${open.conversation.id}/messages`, { method: 'POST', body: { body: 'operator' } })).data.code, 'READ_ONLY');
  assert.equal((await mira.call(`/conversations/${open.conversation.id}/appointments`, { method: 'POST', body: { kind: 'call', startsAt: later() } })).status, 403);
  assert.equal((await mira.call('/conversations')).data.conversations.length, 0, 'observing does not add it to the operator inbox');
  // A message never changes the booking's price or terms.
  assert.deepEqual((await teja.call(`/bookings/${booking.id}`)).data.booking.quote, booking.quote);
}));

test('message sends are rate limited', async () => await app(async ({ as }) => {
  const teja = await as('teja');
  const id = (await teja.call('/listings/drill-kit/enquiry', { method: 'POST', body: {} })).data.conversation.id;
  for (let i = 0; i < 60; i++) assert.equal((await teja.call(`/conversations/${id}/messages`, { method: 'POST', body: { body: `m${i}` } })).status, 201);
  const limited = await teja.call(`/conversations/${id}/messages`, { method: 'POST', body: { body: 'one too many' } });
  assert.equal(limited.status, 429); assert.equal(limited.data.code, 'RATE_LIMITED');
}));
