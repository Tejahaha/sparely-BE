import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApplication } from '../server.mjs';
import { photo } from './fixtures.mjs';

const dates = (offset = 2, days = 1) => ({ start: new Date(Date.now() + offset * 86400_000).toISOString(), end: new Date(Date.now() + (offset + days) * 86400_000).toISOString() });

async function app(callback) {
  const { server, store } = createApplication({ dbPath: ':memory:', watchdogInterval: 0 });
  await store.ready;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const as = async id => {
    let cookie = '';
    const call = async (path, { method = 'GET', body, key = method === 'GET' ? undefined : randomUUID() } = {}) => {
      const response = await fetch(origin + '/api' + path, { method, headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(method !== 'GET' ? { 'X-Sparely-Actor': id } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const data = await response.json().catch(() => ({}));
      const next = response.headers.get('set-cookie')?.split(';')[0];
      if (next) cookie = next;
      return { status: response.status, data, idempotency: response.headers.get('idempotency-status') };
    };
    await call('/session', { method: 'POST', body: { userId: id } });
    return { call };
  };
  try { await callback({ store, as }); } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

const book = async (store, range = dates()) => await store.createBooking('teja', { listingId: 'light-kit', ...range, agreed: true, note: 'Settlement test.' });
const accept = async (store, id) => await store.transition('aanya', id, { action: 'accept' });
const collect = async (store, id) => await store.transition('aanya', id, { action: 'collect', code: (await store.booking(id, 'teja')).pickupCode, image: photo, note: 'All parts present.' });
const giveBack = async (store, id, extra = {}) => await store.transition('aanya', id, { action: 'return', code: (await store.booking(id, 'teja')).returnCode, image: photo, note: 'Returned in good order.', ...extra });
const rows = async (store, id) => await store.settlement.entries(id);
const keys = async (store, id) => (await rows(store, id)).map(e => e.entryKey.slice(id.length + 1));
const ledger = async (store, id, as = 'teja') => await store.settlement.ledger(id, as);

test('happy path: confirm → collect → return charges rental and releases the deposit exactly once', async () => await app(async ({ store }) => {
  const b = await book(store);
  assert.deepEqual(await keys(store, b.id), [], 'requested: nothing posted');
  await accept(store, b.id);
  let l = await ledger(store, b.id);
  assert.deepEqual(l.entries.map(e => [e.kind, e.state]), [['rental_charge', 'pending'], ['deposit_hold', 'pending']]);
  assert.equal(l.balances.renter, 0, 'pending entries move nothing');
  assert.equal(l.liveMoney, false); assert.equal(l.label, 'Simulated — no real money');
  await collect(store, b.id);
  l = await ledger(store, b.id);
  assert.deepEqual(l.balances, { renter: -1350, host: 350, held: 1000 });
  assert.equal(l.summary.pending.length, 0, 'collection supersedes the authorisations');
  await giveBack(store, b.id);
  for (let i = 0; i < 5; i++) await store.settlement.sync(b.id);
  l = await ledger(store, b.id);
  assert.deepEqual(l.balances, { renter: -350, host: 350, held: 0 });
  assert.equal(l.entries.filter(e => e.kind === 'deposit_release').length, 1);
  assert.equal(l.summary.depositReleased, 1000); assert.equal(l.summary.rentalCharged, 350);
  assert.equal(l.attention, null);
  assert.equal(new Set(l.entries.map(e => e.seq)).size, l.entries.length, 'append-only sequence');
}));

test('reordered and duplicated syncs: a skipped intermediate state still settles once', async () => await app(async ({ store }) => {
  const b = await book(store);
  const sync = store.settlement.sync.bind(store.settlement);
  store.settlement.sync = async () => {}; // simulate missed events
  await accept(store, b.id); await collect(store, b.id); await giveBack(store, b.id);
  store.settlement.sync = sync;
  await Promise.all([sync(b.id), sync(b.id), sync(b.id)]);
  await sync(b.id);
  assert.deepEqual(await keys(store, b.id), ['rental_charge:completed', 'deposit_hold:completed', 'deposit_release']);
  assert.deepEqual((await ledger(store, b.id)).balances, { renter: -350, host: 350, held: 0 });
  // A duplicate insert of an existing key is rejected by the UNIQUE constraint.
  const before = (await rows(store, b.id)).length;
  await store.db.prepare("INSERT OR IGNORE INTO settlement_entries(id,booking_id,entry_key,seq,kind,state,amount,from_party,to_party,reverses_key,label,detail,source,created_at) VALUES(?,?,?,99,'deposit_release','completed',1000,'held','renter',NULL,'dup','dup','test',?)").run(randomUUID(), b.id, `${b.id}:deposit_release`, new Date().toISOString());
  assert.equal((await rows(store, b.id)).length, before);
}));

test('approved extension posts its extra charge once', async () => await app(async ({ store }) => {
  const b = await book(store); await accept(store, b.id); await collect(store, b.id);
  await store.transition('teja', b.id, { action: 'request-extension', end: new Date(Date.parse(b.end) + 86400_000).toISOString() });
  await store.transition('aanya', b.id, { action: 'approve-extension' });
  await store.settlement.sync(b.id);
  const l = await ledger(store, b.id);
  assert.deepEqual(l.entries.filter(e => e.kind === 'extension_charge').map(e => e.amount), [350]);
  assert.equal(l.summary.rentalCharged, 700);
}));

test('approved claim: deduction and remainder release exactly once even if the decision is replayed', async () => await app(async ({ store, as }) => {
  const b = await book(store); await accept(store, b.id); await collect(store, b.id);
  await giveBack(store, b.id, { issue: 'damage', amount: 300, note: 'Cracked diffuser panel, replacement estimate.' });
  let l = await ledger(store, b.id);
  assert.equal(l.attention.kind, 'disputed'); assert.equal(l.balances.held, 1000, 'deposit stays held while disputed');
  await store.transition('teja', b.id, { action: 'respond-claim', accepted: true, note: '' });
  const mira = await as('mira'), key = randomUUID(), body = { action: 'resolve-claim', amount: 200, note: 'Photos show the crack; partial deduction.' };
  assert.equal((await mira.call(`/bookings/${b.id}`, { method: 'PATCH', body, key })).status, 200);
  assert.equal((await mira.call(`/bookings/${b.id}`, { method: 'PATCH', body, key })).idempotency, 'replayed');
  assert.equal((await mira.call(`/bookings/${b.id}`, { method: 'PATCH', body })).status, 409, 'a second decision is refused');
  for (let i = 0; i < 3; i++) await store.settlement.sync(b.id);
  l = await ledger(store, b.id);
  assert.deepEqual(l.entries.filter(e => ['deduction', 'deposit_release'].includes(e.kind)).map(e => [e.kind, e.amount]), [['deduction', 200], ['deposit_release', 800]]);
  assert.deepEqual(l.balances, { renter: -550, host: 550, held: 0 });
  assert.equal(l.attention, null);
}));

test('cancellation with a recorded outcome posts the stated refunds once', async () => await app(async ({ store }) => {
  // Renter cancels within 24 h of collection (M6 late stage: half the rental to the host).
  const b = await book(store, dates(0.5)); await accept(store, b.id);
  await store.transition('teja', b.id, { action: 'cancel' });
  const meta = await store.metadata(b.id);
  if (!meta.details.cancellation) { // M6 absent: record its contract directly
    meta.details.cancellation = { by: 'renter', stage: 'confirmed_late', at: new Date().toISOString(), reason: 'Late cancellation', policyVersion: 'demo-v2', rentalRefund: 175, depositRefund: 1000, hostCompensation: 175 };
    await store.saveMetadata(b.id, meta);
  }
  const c = meta.details.cancellation;
  assert.deepEqual([c.rentalRefund, c.depositRefund, c.hostCompensation], [175, 1000, 175]);
  for (let i = 0; i < 4; i++) await store.settlement.sync(b.id);
  const l = await ledger(store, b.id);
  assert.deepEqual(l.balances, { renter: -175, host: 175, held: 0 });
  assert.equal(l.summary.refunds, 175); assert.equal(l.summary.depositReleased, 1000); assert.equal(l.summary.hostCompensation, 175);
  assert.equal(l.entries.filter(e => e.kind === 'reversal').length, 2, 'pending authorisations are reversed, never edited');
  for (const kind of ['cancellation_capture', 'rental_refund', 'deposit_release', 'host_compensation']) assert.equal(l.entries.filter(e => e.kind === kind).length, 1, kind);
  assert.equal(l.summary.pending.length, 0);
  assert.equal(l.attention, null);
}));

// A confirmed booking that ended without any recorded outcome (pre-M6 data or an unsupported path).
const legacyCancel = async (store, id) => {
  await store.db.prepare("UPDATE bookings SET status='cancelled' WHERE id=?").run(id);
  const meta = await store.metadata(id); delete meta.details.cancellation; await store.saveMetadata(id, meta);
  await store.settlement.sync(id);
};

test('cancellation before an outcome is unresolved; a later outcome closes it; an unbalanced outcome stays unresolved', async () => await app(async ({ store }) => {
  const b = await book(store); await accept(store, b.id);
  await legacyCancel(store, b.id);
  assert.equal((await ledger(store, b.id)).attention.kind, 'unresolved');
  const meta = await store.metadata(b.id);
  meta.details.cancellation = { by: 'host', rentalRefund: 350, depositRefund: 1000, hostCompensation: 100 };
  await store.saveMetadata(b.id, meta);
  await store.settlement.sync(b.id);
  let l = await ledger(store, b.id);
  assert.equal(l.attention.kind, 'unresolved', 'refunds + compensation exceed the authorised total');
  assert.equal(l.balances.renter, 0);
  meta.details.cancellation.hostCompensation = 0;
  await store.saveMetadata(b.id, meta);
  await store.settlement.sync(b.id); await store.settlement.sync(b.id);
  l = await ledger(store, b.id);
  assert.equal(l.attention, null);
  assert.deepEqual(l.balances, { renter: 0, host: 0, held: 0 });
  assert.equal(l.entries.filter(e => e.kind === 'resolution').length, 1);
  // Never confirmed: declined requests post nothing.
  const d = await book(store, dates(10));
  await store.transition('aanya', d.id, { action: 'decline' });
  assert.deepEqual(await keys(store, d.id), []);
}));

test('operator settles an unresolved cancellation once: reason, parties, stale versions, append-only history', async () => await app(async ({ store, as }) => {
  const b = await book(store); await accept(store, b.id);
  await legacyCancel(store, b.id);
  const mira = await as('mira'), aanya = await as('aanya'), teja = await as('teja'), kabir = await as('kabir');
  const review = (await mira.call('/settlement/review')).data;
  assert.equal(review.liveMoney, false);
  const item = review.items.find(i => i.bookingId === b.id);
  assert.equal(item.attention.kind, 'unresolved'); assert.ok(item.attention.deadline);
  assert.equal((await aanya.call('/settlement/review')).status, 403);
  const detail = (await mira.call(`/bookings/${b.id}/ledger`)).data.ledger;
  assert.equal(detail.review.agreement.quote.rental, 350); assert.ok(detail.review.timeline.length >= 3);
  const path = `/settlement/${b.id}/decisions`, good = { kind: 'settle', version: detail.version, rentalRefund: 200, depositRefund: 1000, reason: 'Renter cancelled a day ahead; host keeps a small share.' };
  assert.equal((await aanya.call(path, { method: 'POST', body: good })).status, 403, 'host is a party');
  assert.equal((await mira.call(path, { method: 'POST', body: { ...good, reason: 'short' } })).status, 400);
  assert.equal((await mira.call(path, { method: 'POST', body: { ...good, rentalRefund: 351 } })).status, 400);
  assert.equal((await mira.call(path, { method: 'POST', body: { ...good, version: detail.version - 1 } })).data.code, 'STALE_SETTLEMENT');
  assert.equal((await mira.call(path, { method: 'POST', body: good, key: null })).data.code, 'IDEMPOTENCY_KEY_REQUIRED');
  const key = randomUUID();
  const done = await mira.call(path, { method: 'POST', body: good, key });
  assert.equal(done.status, 201);
  assert.equal(done.data.decision.hostCompensation, 150);
  assert.deepEqual(done.data.ledger.balances, { renter: -150, host: 150, held: 0 });
  assert.equal(done.data.ledger.attention, null);
  const replay = await mira.call(path, { method: 'POST', body: good, key });
  assert.equal(replay.idempotency, 'replayed'); assert.equal(replay.data.decision.id, done.data.decision.id);
  const receipt = JSON.parse((await store.db.prepare('SELECT result FROM command_receipts WHERE key=?').get(key)).result);
  assert.deepEqual(Object.keys(receipt).sort(), ['bookingId', 'id', 'resource', 'status'], 'receipt references records only');
  const again = await mira.call(path, { method: 'POST', body: { ...good, version: done.data.ledger.version } });
  assert.equal(again.data.code, 'NOT_UNRESOLVED');
  assert.equal((await mira.call(path, { method: 'POST', body: { kind: 'note', version: done.data.ledger.version, reason: 'Both parties notified in-app.' } })).status, 201);
  const history = (await teja.call(path)).data.decisions;
  assert.deepEqual(history.map(d => d.kind), ['settle', 'note']);
  assert.equal((await kabir.call(path)).status, 403);
  assert.equal((await store.db.prepare("SELECT COUNT(*) AS n FROM settlement_entries WHERE booking_id=? AND kind='host_compensation'").get(b.id)).n, 1);
  assert.equal((await store.db.prepare("SELECT COUNT(*) AS n FROM notices WHERE kind='settlement_decided'").get()).n, 2);
  assert.ok(!(await mira.call('/settlement/review')).data.items.some(i => i.bookingId === b.id), 'resolved bookings leave the queue');
}));

test('ledger privacy: participants and same-world operators only', async () => await app(async ({ store, as }) => {
  const b = await book(store); await accept(store, b.id);
  const teja = await as('teja'), aanya = await as('aanya'), kabir = await as('kabir'), mira = await as('mira');
  assert.equal((await teja.call(`/bookings/${b.id}/ledger`)).data.ledger.viewerRole, 'renter');
  assert.equal((await aanya.call(`/bookings/${b.id}/ledger`)).data.ledger.viewerRole, 'host');
  assert.equal((await aanya.call(`/bookings/${b.id}/ledger`)).data.ledger.review, undefined, 'review details are operator-only');
  assert.equal((await kabir.call(`/bookings/${b.id}/ledger`)).status, 403);
  assert.equal((await mira.call(`/bookings/${b.id}/ledger`)).data.ledger.viewerRole, 'operator');
  assert.equal((await teja.call(`/bookings/${b.id}/ledger`)).data.ledger.liveMoney, false);
}));

test('an operator who is a party to the booking cannot review its settlement', async () => await app(async ({ store, as }) => {
  const b = await store.createBooking('mira', { listingId: 'light-kit', ...dates(5), agreed: true, note: 'Operator renting privately.' });
  await accept(store, b.id);
  await legacyCancel(store, b.id);
  const mira = await as('mira'), l = (await mira.call(`/bookings/${b.id}/ledger`)).data.ledger;
  assert.equal(l.viewerRole, 'renter'); assert.equal(l.attention.kind, 'unresolved');
  const r = await mira.call(`/settlement/${b.id}/decisions`, { method: 'POST', body: { kind: 'settle', version: l.version, rentalRefund: 350, depositRefund: 1000, reason: 'Deciding my own booking.' } });
  assert.equal(r.status, 403);
  assert.ok(!(await mira.call('/settlement/review')).data.items.some(i => i.bookingId === b.id));
}));
