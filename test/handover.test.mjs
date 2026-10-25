import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../lib/store.mjs';
import { createApplication } from '../server.mjs';
import { rentalPolicy } from '../lib/rental-policy.mjs';
import { photo, storageIntake, storageProfile } from './fixtures.mjs';

const at = (days, hours = 0) => new Date(Date.now() + days * 86400000 + hours * 3600000).toISOString();
async function withStore(fn) { const store = new Store(':memory:'); await store.ready; try { await fn(store); } finally { await store.close(); } }
const book = (store, start = at(2), end = at(3), listingId = 'light-kit', renter = 'teja', extra = {}) => store.createBooking(renter, { listingId, start, end, agreed: true, ...extra });
const code = async (store, id, kind = 'pickupCode') => (await store.booking(id, 'teja'))[kind];
const collect = async (store, id, host = 'aanya') => store.transition(host, id, { action: 'collect', code: await code(store, id), image: photo, note: 'Both lights and stands present.' });
const view = (store, id, user = 'teja') => store.handover.view(id, user);
const advance = async (store, id, ms) => { const meta = await store.metadata(id); meta.details.offsetMs = (meta.details.offsetMs || 0) + ms; await store.saveMetadata(id, meta); };
const sharedStorage = store => store.createListing('kabir', { title: 'Shared box room in Kondapur', description: 'A dry shared box room with shelving for sealed boxes and suitcases.', category: 'storage', city: 'Hyderabad', area: 'Kondapur', rate: 40, unit: 'day', deposit: 200, profile: storageProfile({ usableArea: 20 }), storageRatePaise: 200 });

test('revision 1 is derived per category; a changed checklist cannot be accepted with an old version', async () => await withStore(async store => {
  const b = await book(store);
  let v = await view(store, b.id);
  assert.equal(v.current.revision, 1);
  assert.equal(v.current.terms.category, 'equipment');
  assert.deepEqual(v.current.terms.checklist.accessories.map(a => a.name), b.listing.included);
  assert.equal(v.current.acceptances.renter.via, 'request', 'the request accepts revision 1');
  assert.equal(v.current.acceptances.host, null);
  await store.transition('aanya', b.id, { action: 'accept' });
  v = await view(store, b.id);
  assert.equal(v.current.acceptances.host.via, 'confirm');
  assert.equal(v.gate.ok, true);
  // The renter proposes a change: revision 2; the host's acceptance of revision 1 no longer counts.
  const checklist = { ...v.current.terms.checklist, accessories: [...v.current.terms.checklist.accessories, { name: 'Spare bulb', present: false }] };
  await store.handover.propose('teja', b.id, { baseRevision: 1, checklist, note: 'One spare bulb is missing.' });
  await assert.rejects(() => store.handover.accept('aanya', b.id, { revision: 1 }), e => e.code === 'STALE_AGREEMENT' && e.status === 409 && e.details.currentRevision === 2);
  await assert.rejects(() => store.handover.propose('aanya', b.id, { baseRevision: 1, checklist }), e => e.code === 'STALE_AGREEMENT');
  await assert.rejects(() => store.handover.propose('teja', b.id, { baseRevision: 2, checklist }), e => e.status === 409, 'no-op revision refused');
  v = await view(store, b.id);
  assert.equal(v.revisions.length, 2);
  assert.equal(v.revisions[0].acceptances.host.via, 'confirm', 'old acceptances stay recorded on their revision');
  assert.equal(v.current.acceptances.renter.via, 'proposed');
  assert.equal(v.current.acceptances.host, null);
  await store.handover.accept('aanya', b.id, { revision: 2 });
  assert.equal((await view(store, b.id, 'aanya')).gate.ok, true);
  // Pinned confirmation is checked too.
  const c = await book(store, at(5), at(6));
  await store.handover.propose('teja', c.id, { baseRevision: 1, checklist: { ...checklist, condition: 'Light scuff on one stand.' } });
  await assert.rejects(() => store.transition('aanya', c.id, { action: 'accept', agreementRevision: 1 }), e => e.code === 'STALE_AGREEMENT');
  assert.equal((await store.booking(c.id, 'teja')).status, 'requested');
  // Parking never implies custody; storage items come from the renter's intake.
  const p = await book(store, at(2), at(2, 3), 'covered-parking');
  const pv = await view(store, p.id);
  assert.match(pv.current.terms.checklist.custodyNote, /Neither the host nor Sparely takes custody/);
  await store.handover.propose('teja', p.id, { baseRevision: 1, checklist: { ...pv.current.terms.checklist, vehicleRegistration: 'ts09ab1234', custodyNote: 'Host guards the car' } });
  const pv2 = await view(store, p.id);
  assert.equal(pv2.current.terms.checklist.vehicleRegistration, 'TS09AB1234');
  assert.equal(pv2.current.terms.checklist.custodyNote, pv.current.terms.checklist.custodyNote, 'custody wording cannot be edited away');
  const l = await sharedStorage(store);
  const s = await store.createBooking('teja', { listingId: l.id, start: at(2), end: at(4), agreed: true, intake: storageIntake(4) });
  const sv = await view(store, s.id);
  assert.deepEqual(sv.current.terms.checklist.items, [{ id: 'S1', description: 'Sealed boxes', quantity: 2, seal: '' }]);
  assert.equal(sv.current.terms.reservedSqft, 4);
  assert.ok(sv.current.terms.declaredConditions.some(c => c.startsWith('Condition:')));
  await assert.rejects(() => store.handover.propose('kabir', s.id, { baseRevision: 1, checklist: { ...sv.current.terms.checklist, items: [{ id: 'A', description: 'Box', quantity: 1 }, { id: 'A', description: 'Box', quantity: 1 }] } }), /own identifier/);
}));

test('collection fails until both accept the current revision, and on disagreement', async () => await withStore(async store => {
  const b = await book(store);
  await store.transition('aanya', b.id, { action: 'accept' });
  const v = await view(store, b.id, 'aanya');
  await store.handover.propose('aanya', b.id, { baseRevision: 1, checklist: { ...v.current.terms.checklist, condition: 'Small scratch on the left softbox frame.' } });
  await assert.rejects(() => collect(store, b.id), e => e.code === 'AGREEMENT_NOT_ACCEPTED' && e.status === 409 && e.details.waiting[0] === 'renter' && /does not record agreement on condition/.test(e.message));
  assert.equal((await store.booking(b.id, 'teja')).status, 'confirmed', 'the correct code alone does not collect');
  // The renter disagrees: collection stays blocked, nobody is at fault, nothing is cancelled.
  await assert.rejects(() => store.handover.disagree('teja', b.id, { revision: 2, note: 'short' }), /10 characters/);
  await store.handover.disagree('teja', b.id, { revision: 2, note: 'The scratch is on the right frame, not the left.' });
  await assert.rejects(() => collect(store, b.id), e => e.code === 'AGREEMENT_DISAGREEMENT' && /Nobody is treated as at fault/.test(e.message));
  await store.handover.accept('aanya', b.id, { revision: 2 }); // host re-accepting does not clear the renter's flag
  await assert.rejects(() => collect(store, b.id), e => e.code === 'AGREEMENT_DISAGREEMENT');
  let state = await view(store, b.id);
  assert.equal(state.cancellation, null);
  assert.equal(state.can.accept, true);
  assert.equal(state.can.cancel, true);
  // Resolution: a corrected revision both accept.
  await store.handover.propose('aanya', b.id, { baseRevision: 2, checklist: { ...state.current.terms.checklist, condition: 'Small scratch on the right softbox frame.' } });
  await store.handover.accept('teja', b.id, { revision: 3 });
  await store.handover.accept('teja', b.id, { revision: 3 }); // repeat is a no-op
  const done = await collect(store, b.id);
  assert.equal(done.status, 'active');
  assert.match(done.trace.at(-1).detail, /accepted agreement revision 3/);
  await assert.rejects(() => store.handover.propose('aanya', b.id, { baseRevision: 3, checklist: state.current.terms.checklist }), e => e.code === 'AGREEMENT_LOCKED');
  state = await view(store, b.id);
  assert.equal(state.revisions.length, 3);
  assert.equal(state.revisions[1].disagreement.role, 'renter', 'the disagreement stays on its revision');
}));

test('legitimate return still possible during a recovery hold; manual verified return and operator closure leave a trace', async () => await withStore(async store => {
  const b = await book(store);
  await store.transition('aanya', b.id, { action: 'accept' });
  await collect(store, b.id);
  await store.recovery.open('teja', b.id, { type: 'unsafe', description: 'The power lead insulation looks frayed.' });
  assert.equal((await store.listing('light-kit')).recoveryHold, true);
  const returned = await store.transition('aanya', b.id, { action: 'return', code: await code(store, b.id, 'returnCode'), image: photo, note: 'Returned as it was.' });
  assert.equal(returned.status, 'completed');
  // Manual route: no return code, owner receipt then an independent operator.
  const d = await book(store, at(2), at(3), 'drill-kit');
  await store.transition('aanya', d.id, { action: 'accept' });
  await collect(store, d.id);
  let incident = await store.recovery.open('teja', d.id, { type: 'lost', description: 'I lost the return code message.' });
  incident = await store.recovery.action('aanya', incident.id, { action: 'record-owner-receipt', expectedVersion: incident.version, note: 'The drill kit is back with me now.', image: photo });
  await assert.rejects(() => store.recovery.action('mira', incident.id, { action: 'verify-return', expectedVersion: incident.version - 1, note: 'Stale decision attempt here.' }), e => e.code === 'STALE_INCIDENT');
  incident = await store.recovery.action('mira', incident.id, { action: 'verify-return', expectedVersion: incident.version, note: 'Owner receipt photo reviewed; return confirmed.' });
  incident = await store.recovery.action('mira', incident.id, { action: 'resolve', expectedVersion: incident.version, outcome: 'returned', note: 'Returned and verified; closing the case.' });
  const after = await store.booking(d.id, 'teja');
  assert.equal(after.status, 'completed');
  assert.ok(after.trace.some(t => t.title === 'Return recorded by independent operator'));
  assert.ok(after.trace.some(t => t.title === 'Recovery case resolved'));
  assert.equal(after.evidence.filter(e => e.stage === 'Return').length, 1);
  assert.equal((await store.metadata(d.id)).details.cancellation, undefined, 'no fee or cancellation was invented');
}));

test('cancellation outcomes per stage follow the snapshotted policy and are recorded once', async () => await withStore(async store => {
  const outcome = async id => (await store.metadata(id)).details.cancellation;
  // Requested: full refund.
  const r = await book(store);
  await store.transition('teja', r.id, { action: 'cancel' });
  assert.deepEqual({ ...(await outcome(r.id)), at: null }, { by: 'renter', stage: 'requested', at: null, reason: 'Cancelled or declined before the host confirmed', policyVersion: 'demo-v2', rentalRefund: 350, depositRefund: 1000, hostCompensation: 0 });
  // Confirmed, more than 24 h ahead: full refund.
  const early = await book(store, at(3), at(4));
  await store.transition('aanya', early.id, { action: 'accept' });
  assert.equal((await view(store, early.id)).cancellationPreview.stage, 'confirmed_early');
  await store.transition('teja', early.id, { action: 'cancel', reason: 'Plans changed.' });
  assert.equal((await outcome(early.id)).stage, 'confirmed_early');
  assert.equal((await outcome(early.id)).hostCompensation, 0);
  // Confirmed, within 24 h: the snapshot applies even if the live policy changes afterwards.
  const late = await book(store, at(0, 12), at(1, 12));
  await store.transition('aanya', late.id, { action: 'accept' });
  const stages = rentalPolicy.cancellation.stages, saved = stages.confirmed_late.rentalRefundPct;
  stages.confirmed_late.rentalRefundPct = 0;
  try {
    const preview = (await view(store, late.id)).cancellationPreview;
    assert.deepEqual([preview.stage, preview.rentalRefund, preview.hostCompensation], ['confirmed_late', 175, 175]);
    await store.transition('teja', late.id, { action: 'cancel' });
  } finally { stages.confirmed_late.rentalRefundPct = saved; }
  const first = await outcome(late.id);
  assert.deepEqual([first.stage, first.rentalRefund, first.depositRefund, first.hostCompensation], ['confirmed_late', 175, 1000, 175]);
  await assert.rejects(() => store.transition('teja', late.id, { action: 'cancel' }), e => e.status === 409);
  await assert.rejects(() => store.transition('aanya', late.id, { action: 'cancel' }), e => e.status === 409);
  assert.deepEqual(await outcome(late.id), first, 'recorded once, unchanged by repeats');
  // Host cancellation of a confirmed booking: renter refunded in full.
  const host = await book(store, at(0, 6), at(1));
  await store.transition('aanya', host.id, { action: 'accept' });
  assert.equal((await view(store, host.id, 'aanya')).cancellationPreview.stage, 'host_cancelled');
  await store.transition('aanya', host.id, { action: 'cancel' });
  assert.deepEqual([(await outcome(host.id)).by, (await outcome(host.id)).stage, (await outcome(host.id)).rentalRefund], ['host', 'host_cancelled', 350]);
  // Decline records a requested-stage outcome by the host.
  const declined = await book(store, at(8), at(9));
  await store.transition('aanya', declined.id, { action: 'decline', note: 'Away that week.' });
  assert.deepEqual([(await outcome(declined.id)).by, (await outcome(declined.id)).stage], ['host', 'requested']);
  // A demo-v1 booking keeps v1 terms: everything refunded.
  const old = await book(store, at(0, 10), at(1));
  await store.transition('aanya', old.id, { action: 'accept' });
  const meta = await store.metadata(old.id);
  meta.policy = { ...meta.policy, version: 'demo-v1' }; delete meta.policy.cancellation;
  await store.saveMetadata(old.id, meta);
  await store.transition('teja', old.id, { action: 'cancel' });
  assert.deepEqual([(await outcome(old.id)).policyVersion, (await outcome(old.id)).rentalRefund, (await outcome(old.id)).hostCompensation], ['demo-v1', 350, 0]);
  // Disclosed before confirmation: the listing policy and the agreement snapshot carry the rules.
  assert.ok((await store.listing('light-kit')).policy.rules.some(rule => /within 24 hours of collection/.test(rule)));
  assert.equal(r.agreement.cancellation.stages.confirmed_late.rentalRefundPct, 50);
}));

test('reschedule re-checks availability and capacity; price changes only on acceptance', async () => await withStore(async store => {
  const l = await sharedStorage(store);
  const a = await store.createBooking('teja', { listingId: l.id, start: at(2), end: at(4), agreed: true, intake: storageIntake(12) });
  await store.createBooking('aanya', { listingId: l.id, start: at(5), end: at(6), agreed: true, intake: storageIntake(10) });
  await store.transition('kabir', a.id, { action: 'accept' });
  await assert.rejects(() => store.handover.proposeReschedule('teja', a.id, { start: at(5), end: at(6) }), e => e.code === 'CAPACITY_FULL');
  await store.handover.proposeReschedule('teja', a.id, { start: at(7), end: at(10), note: 'Move delayed.' });
  let v = await view(store, a.id, 'kabir');
  assert.equal(v.reschedule.quote.areaSqft, 12, 'agreed area and rate basis kept');
  assert.equal((await store.booking(a.id, 'teja')).quote.rental, a.quote.rental, 'price unchanged until accepted');
  assert.equal(v.can.answerReschedule, true);
  await assert.rejects(() => store.handover.decideReschedule('teja', a.id, { proposalId: v.reschedule.id, decision: 'accept' }), e => e.status === 403, 'the proposer cannot accept their own proposal');
  await assert.rejects(() => store.handover.decideReschedule('kabir', a.id, { proposalId: 'old', decision: 'accept' }), e => e.code === 'STALE_RESCHEDULE');
  await store.handover.decideReschedule('kabir', a.id, { proposalId: v.reschedule.id, decision: 'accept' });
  const moved = await store.booking(a.id, 'teja');
  assert.equal(moved.start, v.reschedule.start);
  assert.ok(moved.quote.rental > a.quote.rental);
  v = await view(store, a.id);
  assert.equal(v.current.revision, 2);
  assert.equal(v.current.terms.quote.rental, moved.quote.rental);
  assert.equal(v.gate.ok, true, 'both had accepted the checklist, so acceptance carries');
  // Capacity is checked again at acceptance.
  await store.handover.proposeReschedule('kabir', a.id, { start: at(11), end: at(12) });
  const pending = (await view(store, a.id)).reschedule;
  await store.createBooking('aanya', { listingId: l.id, start: at(11), end: at(12), agreed: true, intake: storageIntake(10) });
  await assert.rejects(() => store.handover.decideReschedule('teja', a.id, { proposalId: pending.id, decision: 'accept' }), e => e.code === 'CAPACITY_FULL');
  assert.equal((await store.booking(a.id, 'teja')).start, moved.start, 'dates unchanged');
  await store.handover.decideReschedule('teja', a.id, { proposalId: pending.id, decision: 'decline' });
  assert.equal((await view(store, a.id)).reschedule, null);
  // Exclusive listings: a booked period is not available.
  const e = await book(store, at(2), at(3));
  await book(store, at(6), at(7), 'light-kit', 'kabir');
  await assert.rejects(() => store.handover.proposeReschedule('teja', e.id, { start: at(6, 12), end: at(7, 12) }), err => err.code === 'DATES_TAKEN');
}));

test('a reported no-show assigns no fault until the other party agrees or an operator decides', async () => await withStore(async store => {
  const b = await book(store, at(0, 1), at(1));
  await store.transition('aanya', b.id, { action: 'accept' });
  await assert.rejects(() => store.handover.reportNoShow('aanya', b.id, { kind: 'renter_no_show', note: 'Renter did not arrive.' }), e => e.status === 409, 'not before collection time + grace');
  await advance(store, b.id, 2 * 3600000);
  await assert.rejects(() => store.handover.reportNoShow('aanya', b.id, { kind: 'host_no_show', note: 'Wrong side reporting.' }), /Only the renter/);
  await store.handover.reportNoShow('aanya', b.id, { kind: 'renter_no_show', note: 'Waited at the gate for 40 minutes.' });
  let v = await view(store, b.id);
  assert.equal(v.noShow.status, 'reported');
  assert.equal(v.cancellation, null, 'a report alone has no consequence');
  assert.equal((await store.booking(b.id, 'teja')).status, 'confirmed');
  assert.equal(v.can.answerNoShow, true);
  await assert.rejects(() => store.handover.actOnNoShow('mira', b.id, { reportId: v.noShow.id, action: 'decide', outcome: 'uphold', note: 'Deciding too early here.' }), e => e.status === 409, 'operator waits for a response or the window');
  await assert.rejects(() => store.handover.actOnNoShow('aanya', b.id, { reportId: v.noShow.id, action: 'agree' }), e => e.status === 403, 'the reporter cannot agree with themselves');
  await store.handover.actOnNoShow('teja', b.id, { reportId: v.noShow.id, action: 'dispute', note: 'I was there; the gate was locked.' });
  v = await view(store, b.id, 'mira');
  assert.equal(v.noShow.status, 'disputed');
  assert.equal(v.can.decideNoShow, true);
  assert.equal(v.cancellation, null);
  assert.equal((await store.handover.openReports('mira')).reports.length, 1);
  await assert.rejects(() => store.handover.actOnNoShow('aanya', b.id, { reportId: v.noShow.id, action: 'decide', outcome: 'uphold', note: 'Host deciding own case.' }), e => e.status === 403);
  await store.handover.actOnNoShow('mira', b.id, { reportId: v.noShow.id, action: 'decide', outcome: 'uphold', note: 'Gate camera log shows nobody arrived.' });
  const c = (await store.metadata(b.id)).details.cancellation;
  assert.deepEqual([c.by, c.stage, c.rentalRefund, c.hostCompensation, c.depositRefund], ['system', 'renter_no_show', 175, 175, 1000]);
  assert.equal((await store.booking(b.id, 'teja')).status, 'cancelled');
  // The other party agreeing makes it final; inaccessible storage refunds in full.
  const l = await sharedStorage(store);
  const s = await store.createBooking('teja', { listingId: l.id, start: at(0, 2), end: at(1), agreed: true, intake: storageIntake(4) });
  await store.transition('kabir', s.id, { action: 'accept' });
  await store.handover.reportNoShow('teja', s.id, { kind: 'inaccessible_storage', note: 'The storage room was locked and nobody answered.' });
  const report = (await view(store, s.id, 'kabir')).noShow;
  await store.handover.actOnNoShow('kabir', s.id, { reportId: report.id, action: 'agree', note: 'Sorry, my key was with me.' });
  const sc = (await store.metadata(s.id)).details.cancellation;
  assert.deepEqual([sc.by, sc.stage, sc.rentalRefund, sc.hostCompensation], ['renter', 'inaccessible_storage', s.quote.rental, 0]);
  // A rejected report changes nothing.
  const k = await book(store, at(0, 1), at(1), 'drill-kit');
  await store.transition('aanya', k.id, { action: 'accept' });
  await advance(store, k.id, 26 * 3600000);
  await store.handover.reportNoShow('teja', k.id, { kind: 'host_no_show', note: 'Host never came to the door.' });
  const kr = (await view(store, k.id, 'mira')).noShow;
  assert.equal((await view(store, k.id, 'mira')).can.decideNoShow, false, 'within the response window');
  await advance(store, k.id, 25 * 3600000);
  await store.handover.actOnNoShow('mira', k.id, { reportId: kr.id, action: 'decide', outcome: 'reject', note: 'No evidence either way; no consequence.' });
  assert.equal((await store.booking(k.id, 'teja')).status, 'confirmed');
  assert.equal((await store.metadata(k.id)).details.cancellation, undefined);
}));

test('HTTP: commands need an idempotency key, replay by reference, and notices are deduplicated', async () => {
  const { server, store } = createApplication({ dbPath: ':memory:', watchdogInterval: 0 });
  await store.ready;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const as = async id => {
    let cookie = '';
    const call = async (path, { method = 'GET', body, key } = {}) => {
      const response = await fetch(origin + '/api' + path, { method, headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(method !== 'GET' ? { 'X-Sparely-Actor': id } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const next = response.headers.get('set-cookie')?.split(';')[0];
      if (next) cookie = next;
      return { status: response.status, data: await response.json().catch(() => ({})), idempotency: response.headers.get('idempotency-status') };
    };
    await call('/session', { method: 'POST', body: { userId: id } });
    return call;
  };
  try {
    const b = await book(store);
    await store.transition('aanya', b.id, { action: 'accept' });
    const teja = await as('teja'), aanya = await as('aanya'), kabir = await as('kabir');
    assert.equal((await kabir(`/bookings/${b.id}/agreement`)).status, 403);
    const got = await teja(`/bookings/${b.id}/agreement`);
    assert.equal(got.status, 200);
    assert.equal(got.data.agreement.gate.ok, true);
    const checklist = { ...got.data.agreement.current.terms.checklist, condition: 'One stand leg is stiff.' };
    assert.equal((await teja(`/bookings/${b.id}/agreement/revisions`, { method: 'POST', body: { baseRevision: 1, checklist } })).status, 428);
    const key = randomUUID();
    const proposed = await teja(`/bookings/${b.id}/agreement/revisions`, { method: 'POST', body: { baseRevision: 1, checklist }, key });
    assert.equal(proposed.status, 200);
    assert.equal(proposed.data.agreement.current.revision, 2);
    const replay = await teja(`/bookings/${b.id}/agreement/revisions`, { method: 'POST', body: { baseRevision: 1, checklist }, key });
    assert.equal(replay.idempotency, 'replayed');
    assert.equal(replay.data.agreement.revisions.length, 2, 'replay did not create revision 3');
    const receipt = await store.db.prepare('SELECT result FROM command_receipts WHERE key=?').get(key);
    assert.deepEqual(JSON.parse(receipt.result), { resource: 'agreement', id: b.id, status: 200 }, 'receipt references the record');
    const stale = await aanya(`/bookings/${b.id}/agreement/accept`, { method: 'POST', body: { revision: 1 }, key: randomUUID() });
    assert.equal(stale.status, 409); assert.equal(stale.data.code, 'STALE_AGREEMENT');
    const collectTry = await aanya(`/bookings/${b.id}`, { method: 'PATCH', body: { action: 'collect', code: await code(store, b.id), image: photo, note: 'x' }, key: randomUUID() });
    assert.equal(collectTry.status, 409); assert.equal(collectTry.data.code, 'AGREEMENT_NOT_ACCEPTED');
    for (let i = 0; i < 2; i++) assert.equal((await aanya(`/bookings/${b.id}/agreement/accept`, { method: 'POST', body: { revision: 2 }, key: randomUUID() })).status, 200);
    const notices = await store.db.prepare("SELECT kind FROM notices WHERE dedupe_key LIKE ?").all(`%agreement:${b.id}:%`);
    assert.deepEqual(notices.map(n => n.kind).sort(), ['agreement_accepted', 'agreement_changed'], 'one notice per event, repeats deduplicated');
    const resched = await teja(`/bookings/${b.id}/reschedule`, { method: 'POST', body: { start: at(4), end: at(5) }, key: randomUUID() });
    assert.equal(resched.status, 200);
    const decided = await aanya(`/bookings/${b.id}/reschedule`, { method: 'PATCH', body: { proposalId: resched.data.agreement.reschedule.id, decision: 'decline' }, key: randomUUID() });
    assert.equal(decided.data.agreement.reschedules[0].status, 'declined');
    assert.equal((await teja('/no-show-reports')).status, 403);
    assert.deepEqual((await (await as('mira'))('/no-show-reports')).data, { reports: [] });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await store.close(); }
});
