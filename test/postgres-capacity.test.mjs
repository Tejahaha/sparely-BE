import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Database } from '../lib/database.mjs';
import { Store } from '../lib/store.mjs';
import { dropSchema, scopedUrl } from '../lib/pg-backup.mjs';
import { storageIntake, storageProfile } from './fixtures.mjs';

const url = process.env.POSTGRES_TEST_URL;
const at = days => new Date(Date.now() + days * 86400000).toISOString();

test('real PostgreSQL: concurrent 12 + 8 + 1 sq ft requests from separate API instances never overbook 20 sq ft', { skip: !url }, async () => {
  const schema = `sparely_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Database(url); await admin.exec(`CREATE SCHEMA "${schema}"`); await admin.close();
  const target = scopedUrl(url, schema);
  const first = new Store(target, { autoMigrate: true });
  const instances = [first];
  try {
    await first.ready;
    // Separate pools = separate API instances sharing one database.
    for (let i = 0; i < 2; i++) { const s = new Store(target, { autoMigrate: true }); await s.ready; instances.push(s); }
    const listing = await first.createListing('kabir', { title: 'Shared box room for the race', description: 'A shared storage room used to prove capacity checks under concurrency.', category: 'storage', city: 'Hyderabad', area: 'Kondapur', rate: 40, unit: 'day', deposit: 0, profile: storageProfile({ usableArea: 20 }), storageRatePaise: 200 });
    for (let round = 0; round < 3; round++) {
      const days = [2 + round * 3, 4 + round * 3];
      const attempts = [['teja', 12, 0], ['aanya', 8, 1], ['mira', 1, 2]].map(([renter, sqft, i]) => instances[i].createBooking(renter, { listingId: listing.id, start: at(days[0]), end: at(days[1]), agreed: true, intake: storageIntake(sqft) }).then(b => ({ ok: true, sqft, id: b.id }), e => ({ ok: false, sqft, code: e.code })));
      const results = await Promise.all(attempts);
      const accepted = results.filter(r => r.ok).reduce((s, r) => s + r.sqft, 0);
      assert.ok(accepted <= 20, `round ${round}: accepted ${accepted} sq ft`);
      assert.equal(results.filter(r => !r.ok).length, 1, `exactly one request is refused: ${JSON.stringify(results)}`);
      assert.ok(results.filter(r => !r.ok).every(r => r.code === 'CAPACITY_FULL'));
    }
    // The deterministic case from the gate: 12 + 8 first, then 1 more fails.
    const days = [20, 22];
    await first.createBooking('teja', { listingId: listing.id, start: at(days[0]), end: at(days[1]), agreed: true, intake: storageIntake(12) });
    await instances[1].createBooking('aanya', { listingId: listing.id, start: at(days[0]), end: at(days[1]), agreed: true, intake: storageIntake(8) });
    await assert.rejects(() => instances[2].createBooking('mira', { listingId: listing.id, start: at(days[0]), end: at(days[1]), agreed: true, intake: storageIntake(1) }), e => e.code === 'CAPACITY_FULL');
    console.log(`Capacity concurrency verified in isolated schema ${schema}.`);
  } finally {
    for (const s of instances) await s.close();
    await dropSchema(url, schema);
  }
});
