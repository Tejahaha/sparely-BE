import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.mjs';
import { storageIntake, storageProfile } from './fixtures.mjs';

const at = (days, hours = 0) => new Date(Date.now() + days * 86400000 + hours * 3600000).toISOString();
const basics = { title: 'Shared box room in Kondapur', description: 'A dry shared box room with shelving for sealed boxes and suitcases.', category: 'storage', city: 'Hyderabad', area: 'Kondapur', rate: 40, unit: 'day', deposit: 200 };
async function withStore(fn) { const store = new Store(':memory:'); await store.ready; try { await fn(store); } finally { await store.close(); } }
const request = (store, renter, listingId, sqft, days = [2, 4]) => store.createBooking(renter, { listingId, start: at(days[0]), end: at(days[1]), agreed: true, intake: storageIntake(sqft) });
async function sharedListing(store, owner = 'kabir', ratePaise = 200) {
  return await store.createListing(owner, { ...basics, profile: storageProfile({ usableArea: 20 }), storageRatePaise: ratePaise });
}

test('20 sq ft shared: 12 + 8 sq ft fit for the same period, 1 more sq ft does not', async () => await withStore(async store => {
  const l = await sharedListing(store);
  const a = await request(store, 'teja', l.id, 12);
  const b = await request(store, 'aanya', l.id, 8);
  assert.equal(a.status, 'requested'); assert.equal(b.status, 'requested');
  await assert.rejects(() => request(store, 'mira', l.id, 1), e => e.code === 'CAPACITY_FULL');
  // A later, non-overlapping period is free again (half-open intervals: back-to-back is fine).
  assert.equal((await request(store, 'mira', l.id, 20, [4, 5])).status, 'requested');
  // Quote: area × rate × started days, rounded up to whole rupees; exact inputs recorded.
  assert.equal(a.quote.pricingVersion, 'area-v1');
  assert.equal(a.quote.areaSqft, 12);
  assert.equal(a.quote.rental, Math.ceil(120 * 200 * 2 / 1000));
  assert.equal(a.agreement.storage.reservedSqft, 12);
  assert.match(a.agreement.storage.fitDisclaimer, /not a packing guarantee/);
  assert.equal(a.quote.cap.demoOnly, true);
}));

test('expiry, decline and cancellation release capacity exactly once; overlap is checked at every boundary', async () => await withStore(async store => {
  const l = await sharedListing(store);
  const a = await request(store, 'teja', l.id, 10, [2, 6]);
  const b = await request(store, 'aanya', l.id, 10, [3, 4]);
  // [2,6) 10 + [3,4) 10 = 20 at [3,4); a 1 sq ft request across [3.5d, 5d) must fail even
  // though it does not overlap b for its whole length.
  await assert.rejects(() => store.createBooking('mira', { listingId: l.id, start: at(3, 12), end: at(5), agreed: true, intake: storageIntake(1) }), e => e.code === 'CAPACITY_FULL');
  assert.equal((await store.createBooking('mira', { listingId: l.id, start: at(4), end: at(5), agreed: true, intake: storageIntake(10) })).status, 'requested', 'after b ends, 10 sq ft is free again');
  await store.transition('aanya', b.id, { action: 'cancel' }).catch(() => {});
  await store.transition('kabir', b.id, { action: 'decline' }).catch(() => {});
  assert.equal((await store.createBooking('mira', { listingId: l.id, start: at(3), end: at(3, 12), agreed: true, intake: storageIntake(10) })).status, 'requested');
  // Hold expiry: once the 30-minute hold lapses the space is free, with no extra release step.
  await store.db.prepare('UPDATE bookings SET hold_until=? WHERE id=?').run(Date.now() - 1000, a.id);
  await store.expire();
  assert.equal((await store.booking(a.id, 'teja')).status, 'expired');
  assert.equal(await store.capacity.availableSqft(await store.listing(l.id), at(5, 12), at(5, 18)), 20);
}));

test('legacy bookings without a footprint occupy the whole shared space; accept rechecks capacity', async () => await withStore(async store => {
  const l = await sharedListing(store);
  const legacy = await request(store, 'teja', l.id, 4);
  await store.db.prepare('DELETE FROM booking_storage WHERE booking_id=?').run(legacy.id); // as if booked before M4
  await assert.rejects(() => request(store, 'aanya', l.id, 1), e => e.code === 'CAPACITY_FULL', 'unknown footprint is treated as the whole space');
  await store.db.prepare("UPDATE bookings SET status='cancelled' WHERE id=?").run(legacy.id);
  const first = await request(store, 'aanya', l.id, 15);
  const second = await request(store, 'mira', l.id, 5);
  await store.transition('kabir', first.id, { action: 'accept' });
  await store.transition('kabir', second.id, { action: 'accept' });
  // Onboarding can never shrink usable area below accepted obligations.
  const view = await store.profiles.ownerView('kabir', l.id);
  await assert.rejects(() => store.profiles.save('kabir', l.id, { version: view.version, facts: storageProfile({ usableArea: 15 }).facts }), /already reserved/);
}));

test('prices are capped, rechecked at reservation and never rewritten afterwards', async () => await withStore(async store => {
  await assert.rejects(() => sharedListing(store, 'kabir', 301), e => e.code === 'RATE_OVER_CAP', 'over the demo-only cap');
  const l = await sharedListing(store, 'kabir', 250);
  const booked = await request(store, 'teja', l.id, 10);
  await store.capacity.setRate('kabir', l.id, { ratePaise: 150 });
  assert.equal((await store.booking(booked.id, 'teja')).quote.ratePaisePerSqftDay, 250, 'existing price frozen');
  assert.equal((await request(store, 'aanya', l.id, 5, [6, 7])).quote.ratePaisePerSqftDay, 150, 'new requests use the new rate');
  // Extensions keep the agreed area and rate basis and recheck capacity.
  await store.transition('kabir', booked.id, { action: 'accept' });
  await store.createBooking('mira', { listingId: l.id, start: at(4, 18), end: at(5), agreed: true, intake: storageIntake(15) });
  await assert.rejects(() => store.transition('teja', booked.id, { action: 'request-extension', end: at(5) }), e => e.status === 409, 'extension into a full period is refused');
  const ext = await store.transition('teja', booked.id, { action: 'request-extension', end: at(4, 12) });
  assert.equal(ext.extension.quote.ratePaisePerSqftDay, 250);
}));

test('real accounts cannot price storage until an operator approves a cap', async () => await withStore(async store => {
  const { Accounts } = await import('../lib/accounts.mjs'); void Accounts;
  const host = await store.accounts.signup({ name: 'Real Host', email: 'host@example.com', password: 'long password 1' }, 'test');
  const op = await store.accounts.signup({ name: 'Real Operator', email: 'op@example.com', password: 'long password 2' }, 'test');
  await assert.rejects(() => store.createListing(host, { ...basics, profile: storageProfile(), storageRatePaise: 200 }), e => e.code === 'PRICING_NOT_CONFIGURED');
  await assert.rejects(() => store.capacity.setCap(op, { scope: 'default', currency: 'INR', billingUnit: 'sqft_day', maxRatePaise: 250, label: 'Approved launch limit', approved: true }), e => e.status === 403, 'members cannot set caps');
  await store.accounts.setOperator('op@example.com', true);
  await assert.rejects(() => store.capacity.setCap(op, { scope: 'default', currency: 'INR', billingUnit: 'sqft_day', maxRatePaise: 250, label: 'Approved launch limit' }), /approved/);
  const cap = await store.capacity.setCap(op, { scope: 'default', currency: 'INR', billingUnit: 'sqft_day', maxRatePaise: 250, label: 'Approved launch limit', approved: true });
  assert.equal(cap.demoOnly, false); assert.equal(cap.world, 'account');
  const listing = await store.createListing(host, { ...basics, profile: storageProfile(), storageRatePaise: 200 });
  assert.equal(listing.storage.cap.maxRatePaise, 250);
  const v2 = await store.capacity.setCap(op, { scope: 'default', currency: 'INR', billingUnit: 'sqft_day', maxRatePaise: 180, label: 'Lowered after review', approved: true });
  assert.equal(v2.version, 2);
  const renter = await store.accounts.signup({ name: 'Real Renter', email: 'renter@example.com', password: 'long password 3' }, 'test');
  await assert.rejects(() => request(store, renter, listing.id, 5), e => e.code === 'RATE_OVER_CAP', 'authoritative price is rechecked at reservation');
}));
