import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.mjs';
import { applyMigrations } from '../lib/migrations.mjs';

const at = (days, hours = 0) => new Date(Date.now() + days * 86400000 + hours * 3600000).toISOString();
const listingInput = { title: 'Lawn mower for a day', description: 'A push lawn mower for small lawns, cleaned and sharpened between bookings.', city: 'Hyderabad', area: 'Kondapur', rate: 300, unit: 'day', deposit: 500 };
async function withStore(fn) { const store = new Store(':memory:'); await store.ready; try { await fn(store); } finally { await store.close(); } }

test('retired categories cannot be published, even with a forged request', async () => await withStore(async store => {
  for (const category of ['work', 'spaces', 'camera', '']) await assert.rejects(() => store.createListing('aanya', { ...listingInput, category }), /supported category/);
  assert.equal((await store.createListing('aanya', { ...listingInput, category: 'tools' })).category, 'tools');
}));

test('retired listings: one with a booking is kept and still works, ones without bookings are deleted', async () => await withStore(async store => {
  // Recreate the old sample listings as they existed on older databases, then re-run 0003 and 0010.
  const insert = (id, category, title) => store.db.prepare('INSERT INTO listings(id,owner_id,title,description,category,city,area,rate,unit,deposit,image,photo,details,active,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, 'aanya', title, 'An old sample listing used to test retirement and removal.', category, 'Hyderabad', 'Kondapur', 500, 'day', 1000, 'drill', null, JSON.stringify({ included: ['Item'], rules: [], specs: {} }), 1, new Date().toISOString());
  await insert('camera-kit', 'creator', 'Mirrorless camera & portrait lens');
  await insert('quiet-room', 'spaces', 'A quiet room for your next big call');
  await store.favorite('teja', 'quiet-room', true);
  const booking = await store.createBooking('teja', { listingId: 'camera-kit', start: at(2), end: at(3), agreed: true });
  await store.db.prepare("DELETE FROM schema_migrations WHERE id IN ('0003_catalogue_and_blocks','0010_remove_retired_listings')").run();
  await applyMigrations(store.db);
  const after = await store.booking(booking.id, 'teja');
  assert.equal(after.status, 'requested');
  assert.equal(after.agreement.listing.title, booking.agreement.listing.title);
  assert.deepEqual(after.quote, booking.quote);
  const camera = await store.listing('camera-kit');
  assert.equal(camera.active, false, 'kept because a booking uses it, but retired');
  assert.ok(camera.retired);
  await assert.rejects(() => store.listing('quiet-room'), e => e.status === 404, 'no bookings: deleted');
  assert.equal((await store.db.prepare("SELECT COUNT(*) AS n FROM favorites WHERE listing_id='quiet-room'").get()).n, 0);
  assert.ok(!(await store.search()).some(l => ['camera-kit', 'quiet-room'].includes(l.id)));
  await assert.rejects(() => store.createBooking('kabir', { listingId: 'camera-kit', start: at(5), end: at(6), agreed: true }), /no longer offered/);
  await store.transition('aanya', booking.id, { action: 'accept' });
  assert.equal((await store.booking(booking.id, 'teja')).status, 'confirmed', 'an existing obligation can still proceed');
  assert.equal((await store.search({ category: 'tools' })).filter(l => ['sewing-machine', 'garden-kit'].includes(l.id)).length, 2);
}));

test('editing a listing is versioned and never rewrites an earlier booking agreement', async () => await withStore(async store => {
  const booking = await store.createBooking('teja', { listingId: 'drill-kit', start: at(2), end: at(3), agreed: true });
  const before = await store.listing('drill-kit', 'aanya');
  const edited = await store.editListing('aanya', 'drill-kit', { version: before.version, title: 'Cordless drill, bits and level', description: before.description, area: before.area, rate: 400, deposit: 1500, included: 'Drill\nBits', rules: 'Return clean' });
  assert.equal(edited.version, before.version + 1);
  assert.equal(edited.rate, 400);
  const kept = await store.booking(booking.id, 'teja');
  assert.equal(kept.agreement.listing.title, before.title, 'the agreement keeps the original title');
  assert.equal(kept.quote.rate, before.rate, 'the agreed price is frozen');
  await assert.rejects(() => store.editListing('aanya', 'drill-kit', { ...edited, version: before.version, included: '', rules: '' }), error => error.code === 'STALE_LISTING' && error.details.currentVersion === edited.version);
  await assert.rejects(() => store.editListing('kabir', 'drill-kit', { ...edited, included: '', rules: '' }), error => error.status === 403);
  const next = await store.createBooking('kabir', { listingId: 'drill-kit', start: at(5), end: at(6), agreed: true });
  assert.equal(next.quote.rate, 400, 'new bookings use the edited price');
}));

test('host blocks cannot override pending or accepted bookings and do stop new ones', async () => await withStore(async store => {
  const booking = await store.createBooking('teja', { listingId: 'drill-kit', start: at(2), end: at(3), agreed: true });
  await assert.rejects(() => store.addBlock('aanya', 'drill-kit', { start: at(2, 12), end: at(4) }), error => error.code === 'BLOCK_CONFLICT' && error.details.bookings[0].id === booking.id);
  await assert.rejects(() => store.addBlock('teja', 'drill-kit', { start: at(5), end: at(6) }), error => error.status === 403);
  const blocked = await store.addBlock('aanya', 'drill-kit', { start: at(5), end: at(7), note: 'Away for a family visit' });
  assert.equal(blocked.hostBlocks.length, 1);
  assert.ok(blocked.blocked.some(b => b.kind === 'host'));
  assert.equal((await store.listing('drill-kit', 'teja')).hostBlocks, undefined, 'notes are owner-only');
  await assert.rejects(() => store.createBooking('kabir', { listingId: 'drill-kit', start: at(6), end: at(6, 6), agreed: true }), error => error.status === 409);
  assert.ok(!(await store.search({ category: 'tools', start: at(6), end: at(6, 6) })).some(l => l.id === 'drill-kit'));
  await store.removeBlock('aanya', 'drill-kit', blocked.hostBlocks[0].id);
  assert.equal((await store.createBooking('kabir', { listingId: 'drill-kit', start: at(6), end: at(6, 6), agreed: true })).status, 'requested');
  assert.equal((await store.booking(booking.id, 'teja')).status, 'requested', 'the original booking was never touched');
}));
