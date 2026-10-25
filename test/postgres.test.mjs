import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Database } from '../lib/database.mjs';
import { Store } from '../lib/store.mjs';
import { fingerprint } from '../lib/commands.mjs';

const url = process.env.POSTGRES_TEST_URL;
const photo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCWQAAAAASUVORK5CYII=';
test('real PostgreSQL preserves concurrent idempotency, booking rules, recovery and atomic rollback', { skip: !url }, async () => {
  const admin = new Database(url), schema = `sparely_test_${randomUUID().replaceAll('-', '')}`;
  await admin.exec(`CREATE SCHEMA "${schema}"`);
  const scoped = new URL(url); scoped.searchParams.set('options', `-c search_path=${schema}`);
  const store = new Store(scoped.toString(), { autoMigrate: true });
  try {
    await store.ready;
    assert.equal((await store.search()).length, 10);
    const body = { listingId: 'light-kit', start: new Date(Date.now() + 86400000).toISOString(), end: new Date(Date.now() + 2 * 86400000).toISOString(), agreed: true };
    const key = randomUUID(), hash = fingerprint('POST', '/api/bookings', body);
    const replies = await Promise.all(Array.from({ length: 8 }, () => store.commands.execute('teja', key, hash, async () => ({ resource: 'booking', id: (await store.createBooking('teja', body)).id, status: 201 }))));
    assert.equal(new Set(replies.map(r => r.id)).size, 1);
    assert.equal(replies.filter(r => r.idempotency === 'created').length, 1);
    const id = replies[0].id;
    await assert.rejects(() => store.createBooking('kabir', body), error => error.status === 409);
    await store.transition('aanya', id, { action: 'accept' });
    await store.transition('aanya', id, { action: 'collect', code: (await store.booking(id, 'teja')).pickupCode, image: photo });
    let incident = await store.recovery.open('teja', id, { type: 'lost', description: 'The equipment cannot be located after collection.' });
    await assert.rejects(() => store.recovery.get(incident.id, 'kabir'), error => error.status === 403);
    await assert.rejects(() => store.toggleListing('aanya', 'light-kit', true), error => error.status === 409);
    incident = await store.recovery.action('aanya', incident.id, { action: 'record-owner-receipt', expectedVersion: incident.version, note: 'The camera has now been returned to its owner.', image: photo });
    incident = await store.recovery.action('mira', incident.id, { action: 'verify-return', expectedVersion: incident.version, note: 'Owner receipt was reviewed and manual return confirmed.' });
    incident = await store.recovery.action('mira', incident.id, { action: 'resolve', outcome: 'returned', expectedVersion: incident.version, note: 'Physical return is recorded; readiness remains a separate action.' });
    assert.equal(incident.status, 'resolved');
    assert.equal((await store.booking(id, 'teja')).status, 'completed');
    const notices = await store.recovery.notices('teja');
    assert.ok(notices.notices[0].createdAt); assert.equal(notices.notices[0].readAt, null);
    const before = (await store.hosted('teja')).length;
    await assert.rejects(() => store.transaction(async () => {
      await store.createListing('teja', { title: 'Rollback test listing', description: 'This listing exists only inside a rolled back database transaction.', city: 'Hyderabad', area: 'Madhapur', category: 'tools', rate: 100, deposit: 0, unit: 'day' });
      throw new Error('Inject rollback');
    }), /Inject rollback/);
    assert.equal((await store.hosted('teja')).length, before);
    console.log(`PostgreSQL verified in isolated schema ${schema}; public app data was not used for fixtures.`);
  } finally { await store.close(); await admin.close(); await (await import('../lib/pg-backup.mjs')).dropSchema(url, schema); }
});

test('real PostgreSQL migrations re-run safely and a recovery point restores into a separate schema', { skip: !url }, async () => {
  const { applyMigrations, migrationStatus } = await import('../lib/migrations.mjs');
  const { exportDatabase, restoreIntoNewSchema, verifyRecoveryPoint, writeRecoveryPoint, dropSchema, scopedUrl } = await import('../lib/pg-backup.mjs');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const admin = new Database(url), schema = `sparely_test_${randomUUID().replaceAll('-', '')}`;
  await admin.exec(`CREATE SCHEMA "${schema}"`); await admin.close();
  const target = scopedUrl(url, schema), dir = mkdtempSync(join(tmpdir(), 'sparely-rp-'));
  let restored;
  try {
    const store = new Store(target, { autoMigrate: true });
    await store.ready;
    const booking = await store.createBooking('teja', { listingId: 'drill-kit', start: new Date(Date.now() + 86400000).toISOString(), end: new Date(Date.now() + 2 * 86400000).toISOString(), agreed: true });
    assert.deepEqual(await applyMigrations(store.db), [], 'second application is a no-op');
    assert.equal((await migrationStatus(store.db)).pending.length, 0);
    const point = writeRecoveryPoint(dir, await exportDatabase(store.db));
    assert.equal(verifyRecoveryPoint(point).ok, true);
    await store.close();
    const result = await restoreIntoNewSchema(url, point, { createSchema: async t => { const s = new Store(t, { seed: false, autoMigrate: true }); await s.ready; await s.close(); } });
    restored = result.schema;
    assert.equal(result.ok, true, JSON.stringify(result.results));
    const check = new Store(scopedUrl(url, restored), { seed: false });
    await check.ready;
    assert.equal((await check.booking(booking.id, 'teja')).status, 'requested', 'restored booking is readable through the app');
    await check.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (restored) await dropSchema(url, restored);
    await dropSchema(url, schema);
  }
});
