import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.mjs';
import { equipmentProfile, photo, storageFacts, storageIntake, storageProfile } from './fixtures.mjs';

const at = days => new Date(Date.now() + days * 86400000).toISOString();
const basics = { title: 'Spare room corner for boxes', description: 'A dry corner of a spare room for a few sealed boxes while you move.', category: 'storage', city: 'Hyderabad', area: 'Madhapur', rate: 40, unit: 'day', deposit: 300 };
async function withStore(fn) { const store = new Store(':memory:'); await store.ready; try { await fn(store); } finally { await store.close(); } }

test('storage starts as a draft, resumes after reload, and cannot publish while incomplete or contradictory', async () => await withStore(async store => {
  const draft = await store.createListing('kabir', basics);
  assert.equal(draft.active, false); assert.equal(draft.draft, true);
  assert.ok(!(await store.search()).some(l => l.id === draft.id), 'drafts are not discoverable');
  let view = await store.profiles.save('kabir', draft.id, { version: 0, facts: { public: { mode: 'shared', room: { length: 5, width: 4, height: 8, unit: 'ft' } }, private: {} } });
  assert.equal(view.status, 'draft');
  assert.ok(view.missing.length > 5);
  // "Reload": a fresh read returns the owner's saved draft.
  view = await store.profiles.ownerView('kabir', draft.id);
  assert.equal(view.facts.public.room.length, 5);
  await assert.rejects(() => store.profiles.ownerView('teja', draft.id), e => e.status === 403);
  await assert.rejects(() => store.profiles.publish('kabir', draft.id), e => e.code === 'PROFILE_INCOMPLETE' && e.details.missing.length > 0);
  await assert.rejects(() => store.toggleListing('kabir', draft.id, true), /publish/);
  // Contradictions are refused even when every field is filled in.
  view = await store.profiles.save('kabir', draft.id, { version: view.version, facts: { public: storageFacts({ usableArea: 30, mode: 'exclusive' }), private: { address: '4 Lake Road, Madhapur, Hyderabad' } }, addPhotos: [{ kind: 'room', image: photo }, { kind: 'entrance', image: photo }] });
  assert.ok(view.missing.some(m => m.includes('cannot exceed')), view.missing.join(' | '));
  assert.ok(view.missing.some(m => m.includes('exclusive space')));
  await assert.rejects(() => store.profiles.publish('kabir', draft.id), e => e.code === 'PROFILE_INCOMPLETE');
  await assert.rejects(() => store.profiles.save('kabir', draft.id, { version: 1, facts: {} }), e => e.code === 'STALE_PROFILE');
  view = await store.profiles.save('kabir', draft.id, { version: view.version, facts: { public: storageFacts({ petsPresent: 'unknown', damp: 'unknown' }), private: { address: '4 Lake Road, Madhapur, Hyderabad', accessInstructions: 'Key with the security guard.' } } });
  assert.deepEqual(view.missing, [], '"unknown" is an honest, valid answer');
  await assert.rejects(() => store.profiles.publish('kabir', draft.id), /price per sq ft/, 'storage also needs a price within the cap');
  await store.capacity.setRate('kabir', draft.id, { ratePaise: 200 });
  const published = await store.profiles.publish('kabir', draft.id);
  assert.equal(published.active, true);
  await assert.rejects(() => store.profiles.save('kabir', draft.id, { version: view.version, facts: { public: { mode: 'shared' }, private: {} } }), /must stay complete/);
}));

test('disclosures are public, the exact address is private until confirmation, and the agreement keeps them', async () => await withStore(async store => {
  const listing = await store.createListing('kabir', { ...basics, profile: storageProfile(), storageRatePaise: 200 });
  assert.equal(listing.active, true);
  const publicView = await store.listing(listing.id, 'teja');
  assert.equal(publicView.profile.facts.usableSqft, 20);
  assert.equal(publicView.profile.verifiedBySparely, false);
  assert.ok(!JSON.stringify(publicView).includes('Test Lane'), 'no exact address in the listing');
  assert.ok(!JSON.stringify(await store.search({ category: 'storage' }, 'teja')).includes('data:image'), 'search results carry no photos');
  const booking = await store.createBooking('teja', { listingId: listing.id, start: at(2), end: at(4), agreed: true, intake: storageIntake() });
  assert.equal(booking.access, null, 'no access details while only requested');
  assert.equal(booking.agreement.disclosures.facts.usableSqft, 20);
  await store.transition('kabir', booking.id, { action: 'accept' });
  assert.equal((await store.booking(booking.id, 'teja')).access.address, '12 Test Lane, Madhapur, Hyderabad 500081');
  await assert.rejects(() => store.booking(booking.id, 'aanya'), e => e.status === 403);
}));

test('legacy storage without facts takes no new bookings until its host completes them; obligations survive', async () => await withStore(async store => {
  const legacy = await store.createListing('kabir', basics, { internal: true }); // published before onboarding existed
  assert.equal(legacy.needsOnboarding, true);
  await assert.rejects(() => store.createBooking('teja', { listingId: legacy.id, start: at(2), end: at(3), agreed: true }), e => e.code === 'STORAGE_INCOMPLETE');
  await store.profiles.save('kabir', legacy.id, { version: 0, ...storageProfile() });
  await store.capacity.setRate('kabir', legacy.id, { ratePaise: 200 });
  assert.equal((await store.createBooking('teja', { listingId: legacy.id, start: at(2), end: at(3), agreed: true, intake: storageIntake() })).status, 'requested');
  // The demo's sample storage is complete and labelled as sample data.
  const sample = await store.listing('storage-nook', 'teja');
  assert.equal(sample.profile.sample, true);
  assert.equal(sample.profile.facts.mode, 'shared');
}));

test('equipment needs a dated function check before publishing', async () => await withStore(async store => {
  const input = { title: 'Pressure washer for patios', description: 'An electric pressure washer for patios, bikes and balcony floors.', category: 'tools', city: 'Hyderabad', area: 'Kondapur', rate: 400, unit: 'day', deposit: 1000 };
  await assert.rejects(() => store.createListing('aanya', { ...input, profile: equipmentProfile({ checkedOn: '' }) }), e => e.code === 'PROFILE_INCOMPLETE' && e.details.missing.some(m => m.includes('function check')));
  await assert.rejects(() => store.createListing('aanya', { ...input, profile: equipmentProfile({ functionCheck: 'working_with_notes', functionNote: '' }) }), e => e.code === 'PROFILE_INCOMPLETE');
  assert.equal((await store.createListing('aanya', { ...input, profile: equipmentProfile() })).active, true);
}));
