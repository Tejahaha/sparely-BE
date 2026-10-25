import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { Store } from '../lib/store.mjs';
import { fingerprint } from '../lib/commands.mjs';
import { evidenceDigest } from '../lib/recovery.mjs';
import { createApplication } from '../server.mjs';
import { backupDatabase } from '../lib/backup.mjs';
const photo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCWQAAAAASUVORK5CYII=';
const dates = () => ({
  start: new Date(Date.now() + 86400000).toISOString(),
  end: new Date(Date.now() + 2 * 86400000).toISOString()
});
const withStore = async fn => {
  const store = new Store();
  await store.ready;
  try {
    return await fn(store);
  } finally {
    await store.close();
  }
};
const active = async store => {
  const b = await store.createBooking('teja', {
    listingId: 'light-kit',
    ...dates(),
    agreed: true
  });
  await store.transition('aanya', b.id, {
    action: 'accept'
  });
  return await store.transition('aanya', b.id, {
    action: 'collect',
    code: (await store.booking(b.id, 'teja')).pickupCode,
    image: photo
  });
};
const report = async (store, b) => await store.recovery.open('teja', b.id, {
  type: 'lost',
  description: 'The item cannot be located after the trip.',
  lastKnown: 'Last seen in its carry bag.',
  image: photo
});
const action = async (store, actor, incident, input) => await store.recovery.action(actor, incident.id, {
  expectedVersion: incident.version,
  note: 'Recorded a specific recovery action with a reason.',
  ...input
});
test('reported loss freezes the item and later handovers, preserves custody, and limits case access', async () => await withStore(async store => {
  const b = await active(store);
  const next = await store.createBooking('kabir', {
    listingId: b.listing.id,
    start: b.end,
    end: new Date(Date.parse(b.end) + 86400000).toISOString(),
    agreed: true
  });
  await store.transition('aanya', next.id, {
    action: 'accept'
  });
  const incident = await report(store, b);
  assert.equal((await store.booking(b.id, 'teja')).status, 'active', 'a report cannot fake a physical return');
  assert.equal((await store.listing(b.listing.id)).active, false);
  assert.equal((await store.listing(b.listing.id)).recoveryHold, true);
  assert.equal(await store.available(b.listing.id, b.end, new Date(Date.parse(b.end) + 5 * 86400000).toISOString()), false);
  await assert.rejects(async () => await store.toggleListing('aanya', b.listing.id, true), /Resolve the recovery/);
  await assert.rejects(async () => await store.transition('aanya', next.id, {
    action: 'collect',
    code: (await store.booking(next.id, 'kabir')).pickupCode,
    image: photo
  }), e => e.status === 409);
  assert.equal((await store.booking(next.id, 'kabir')).attention.kind, 'unavailable');
  await assert.rejects(async () => await store.recovery.get(incident.id, 'kabir'), e => e.status === 403);
  assert.equal((await store.recovery.get(incident.id, 'mira')).canReview, true);
  assert.ok((await store.recovery.notices('kabir')).notices.some(n => n.bookingId === next.id && n.kind === 'collection_at_risk'));
  assert.equal(incident.entries[0].digest, evidenceDigest(photo));
  assert.equal((await store.booking(b.id, 'mira')).pickupCode, null);
  assert.equal((await store.booking(b.id, 'mira')).returnCode, null);
}));
test('an unrecovered item cannot be closed; stale decisions and unilateral return plans are rejected', async () => await withStore(async store => {
  const b = await active(store),
    incident = await report(store, b);
  await assert.rejects(async () => await action(store, 'aanya', incident, {
    action: 'resolve',
    outcome: 'returned'
  }), e => e.status === 403);
  await assert.rejects(async () => await action(store, 'mira', incident, {
    action: 'resolve',
    outcome: 'returned'
  }), e => e.status === 409);
  const planned = await action(store, 'teja', incident, {
    action: 'propose-return',
    returnAt: new Date(Date.now() + 3600000).toISOString()
  });
  await assert.rejects(async () => await action(store, 'teja', planned, {
    action: 'confirm-return-plan'
  }), e => e.status === 409);
  await assert.rejects(async () => await action(store, 'mira', incident, {
    action: 'escalate'
  }), e => e.code === 'STALE_INCIDENT');
  const agreed = await action(store, 'aanya', planned, {
    action: 'confirm-return-plan'
  });
  assert.equal(agreed.plan.confirmedBy, 'aanya');
  assert.equal((await store.booking(b.id, 'teja')).end, b.end, 'a recovery plan cannot silently extend rental charges');
  assert.equal((await store.booking(b.id, 'teja')).quote.total, b.quote.total);
}));
test('normal return remains possible during recovery; resolution requires evidence and host readiness', async () => await withStore(async store => {
  const b = await active(store),
    incident = await report(store, b);
  await store.transition('aanya', b.id, {
    action: 'return',
    code: (await store.booking(b.id, 'teja')).returnCode,
    image: photo
  });
  assert.equal((await store.booking(b.id, 'teja')).status, 'completed');
  assert.equal((await store.recovery.get(incident.id, 'teja')).status, 'open');
  const closed = await action(store, 'mira', incident, {
    action: 'resolve',
    outcome: 'returned'
  });
  assert.equal(closed.status, 'resolved');
  assert.equal((await store.listing(b.listing.id)).active, false);
  assert.equal((await store.booking(b.id, 'teja')).depositDeduction, 0);
  await store.toggleListing('aanya', b.listing.id, true);
  assert.equal((await store.listing(b.listing.id)).recoveryHold, false);
}));
test('a missing return code has an audited fallback requiring owner receipt and independent review', async () => await withStore(async store => {
  const b = await active(store),
    incident = await report(store, b);
  await assert.rejects(async () => await action(store, 'mira', incident, {
    action: 'verify-return'
  }), /owner must first record receipt/);
  await assert.rejects(async () => await action(store, 'teja', incident, {
    action: 'record-owner-receipt',
    image: photo
  }), e => e.status === 403);
  const received = await action(store, 'aanya', incident, {
    action: 'record-owner-receipt',
    image: photo
  });
  await assert.rejects(async () => await action(store, 'aanya', received, {
    action: 'verify-return'
  }), e => e.status === 403);
  const verified = await action(store, 'mira', received, {
    action: 'verify-return'
  });
  const returned = await store.booking(b.id, 'teja');
  assert.equal(returned.status, 'completed');
  assert.equal(returned.evidence.filter(e => e.stage === 'Return').length, 1);
  assert.match(returned.evidence.at(-1).note, /Manual recovery verified/);
  assert.equal(returned.depositDeduction, 0);
  assert.equal((await store.listing(b.listing.id)).active, false);
  assert.equal((await action(store, 'mira', verified, {
    action: 'resolve',
    outcome: 'returned'
  })).status, 'resolved');
}));
test('watchdog escalates a missed recovery deadline once and keeps the hold without assigning blame', async () => await withStore(async store => {
  const b = await active(store),
    incident = await report(store, b);
  await store.db.prepare('UPDATE incidents SET review_due_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), incident.id);
  await store.evaluate();
  const count = (await store.db.prepare('SELECT COUNT(*) AS count FROM safety_notices').get()).count;
  await store.evaluate();
  await store.evaluate();
  assert.equal((await store.db.prepare('SELECT COUNT(*) AS count FROM safety_notices').get()).count, count);
  assert.equal((await store.recovery.get(incident.id, 'teja')).status, 'escalated');
  assert.equal((await store.listing(b.listing.id)).active, false);
  assert.equal((await store.booking(b.id, 'teja')).status, 'active');
  assert.equal((await store.booking(b.id, 'teja')).trace.filter(e => e.title === 'Recovery review overdue').length, 1);
  assert.equal((await store.recovery.notices('teja')).delivery, 'in_app_only');
  const escalated = await store.recovery.get(incident.id, 'teja');
  const proposed = await action(store, 'teja', escalated, {
    action: 'propose-return',
    returnAt: new Date(Date.now() + 3600000).toISOString()
  });
  assert.equal(proposed.status, 'escalated', 'participants cannot erase an overdue operator escalation');
  assert.equal((await action(store, 'aanya', proposed, {
    action: 'confirm-return-plan'
  })).status, 'escalated');
}));
test('non-return reports enforce grace, and recovery alternatives require consent even for past collection dates', async () => await withStore(async store => {
  const b = await active(store);
  await assert.rejects(async () => await store.recovery.open('aanya', b.id, {
    type: 'non_return',
    description: 'The rental has not come back to me.'
  }), /past its return grace/);
  await store.db.prepare('UPDATE bookings SET start=?,end=? WHERE id=?').run(new Date(Date.now() - 2 * 86400000).toISOString(), new Date(Date.now() - 3600000).toISOString(), b.id);
  const incident = await store.recovery.open('aanya', b.id, {
    type: 'non_return',
    description: 'The rental has not come back to me.'
  });
  assert.equal(incident.type, 'non_return');
  const plan = await store.recovery.plan(b.id, 'teja');
  assert.equal(plan.lastRecordedCustody, 'renter_after_recorded_collection');
  assert.equal(plan.automaticCharge, false);
  assert.equal(plan.automaticReplacement, false);
  assert.equal(plan.alternativesRequireNewConsent, true);
  assert.ok(Date.parse(plan.alternativeDates.start) > Date.now());
  assert.ok(plan.alternatives.every(l => l.id !== b.listing.id));
  assert.equal((await store.db.prepare('SELECT COUNT(*) AS count FROM bookings').get()).count, 1);
}));
test('invalid evidence rolls back incident, item hold, timeline and notices together', async () => await withStore(async store => {
  const b = await active(store),
    trace = b.trace.length;
  await assert.rejects(async () => await store.recovery.open('teja', b.id, {
    type: 'lost',
    description: 'An item is missing from the case.',
    image: 'invalid'
  }), /photo/);
  assert.equal((await store.recovery.list('teja')).length, 0);
  assert.equal((await store.recovery.notices('teja')).unreadCount, 0);
  assert.equal((await store.listing(b.listing.id)).active, true);
  assert.equal((await store.booking(b.id, 'teja')).trace.length, trace);
}));
test('safety notices enforce recipient ownership, pagination and idempotent read acknowledgements', async () => await withStore(async store => {
  const b = await active(store),
    incident = await report(store, b),
    at = new Date().toISOString();
  for (let i = 0; i < 105; i++) await store.recovery.notify({
    id: b.id,
    owner_id: 'aanya',
    renter_id: 'teja'
  }, incident.id, `test:${i}`, 'Test notice', at);
  const first = await store.recovery.notices('teja');
  assert.equal(first.notices.length, 100);
  assert.ok(first.nextCursor);
  const second = await store.recovery.notices('teja', first.nextCursor);
  assert.equal(second.notices.length, 6);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.notices, ...second.notices].map(n => n.id)).size, 106);
  const id = first.notices[0].id;
  await assert.rejects(async () => await store.recovery.readNotice('kabir', id), e => e.status === 404);
  await store.recovery.readNotice('teja', id);
  await store.recovery.readNotice('teja', id);
  assert.equal((await store.recovery.notices('teja')).unreadCount, 105);
}));
test('nested idempotent transaction rolls back a committed inner booking if the outer command fails', async () => await withStore(async store => {
  const key = randomUUID(),
    body = {
      listingId: 'light-kit',
      ...dates(),
      agreed: true
    },
    hash = fingerprint('POST', '/api/bookings', body);
  await assert.rejects(async () => await store.commands.execute('teja', key, hash, async () => {
    await store.createBooking('teja', body);
    throw new Error('Injected receipt failure before outer commit');
  }), /Injected receipt failure/);
  assert.equal((await store.db.prepare('SELECT COUNT(*) AS count FROM bookings').get()).count, 0);
  assert.equal((await store.db.prepare('SELECT COUNT(*) AS count FROM command_receipts').get()).count, 0);
  const receipt = await store.commands.execute('teja', key, hash, async () => ({
    resource: 'booking',
    id: (await store.createBooking('teja', body)).id,
    status: 201
  }));
  assert.equal(receipt.idempotency, 'created');
  assert.equal((await store.commands.execute('teja', key, hash, () => {
    throw new Error('must not run twice');
  })).idempotency, 'replayed');
}));
test('recovery evidence, holds, deduplication receipts and notices survive database reopening', async () => {
  mkdirSync('.testdata', {
    recursive: true
  });
  const path = resolve('.testdata', `${randomUUID()}.db`);
  let store = new Store(path);
  await store.ready;
  try {
    const b = await active(store),
      incident = await report(store, b),
      key = randomUUID(),
      hash = fingerprint('PATCH', '/example', {
        action: 'test'
      });
    await store.commands.execute('teja', key, hash, () => ({
      resource: 'incident',
      id: incident.id,
      status: 201
    }));
    await store.close();
    store = new Store(path);
    await store.ready;
    assert.equal((await store.commands.execute('teja', key, hash, () => {
      throw new Error('duplicate');
    })).id, incident.id);
    assert.equal((await store.recovery.get(incident.id, 'teja')).entries[0].digest, evidenceDigest(photo));
    assert.equal((await store.listing(b.listing.id)).recoveryHold, true);
    assert.ok((await store.recovery.notices('mira')).unreadCount > 0);
  } finally {
    await store.close();
    for (const suffix of ['', '-wal', '-shm']) try {
      unlinkSync(path + suffix);
    } catch {}
  }
});
async function httpTest(callback) {
  const {
    server,
    store
  } = createApplication({
    dbPath: ':memory:'
  });
  await store.ready;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const actors = new Map(); // session cookie -> the account each write must name
  const call = async (path, {
    method = 'GET',
    body,
    cookie,
    key,
    actor,
    requestOrigin = origin
  } = {}) => {
    const response = await fetch(origin + '/api' + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Origin: requestOrigin,
        ...(cookie ? {
          Cookie: cookie,
          'X-Sparely-Actor': actor ?? actors.get(cookie)
        } : {}),
        ...(key ? {
          'Idempotency-Key': key
        } : {})
      },
      ...(body ? {
        body: JSON.stringify(body)
      } : {})
    });
    const data = await response.json(), next = response.headers.get('set-cookie')?.split(';')[0];
    if (next) actors.set(next, data.user?.id || (path === '/scenarios' ? 'teja' : undefined));
    return {
      status: response.status,
      data,
      idempotency: response.headers.get('idempotency-status'),
      cookie: next
    };
  };
  try {
    await callback({
      call,
      store
    });
  } finally {
    server.closeAllConnections();
    await new Promise(async resolve => await server.close(resolve));
  }
}
test('parallel browser retries create one booking; changed payload/key scope and command-status access are explicit', async () => await httpTest(async ({
  call,
  store
}) => {
  const renter = await call('/session', {
    method: 'POST',
    body: {
      userId: 'teja'
    }
  });
  const key = randomUUID(),
    body = {
      listingId: 'light-kit',
      ...dates(),
      agreed: true
    };
  const replies = await Promise.all(Array.from({
    length: 8
  }, async () => await call('/bookings', {
    method: 'POST',
    body,
    cookie: renter.cookie,
    key
  })));
  assert.ok(replies.every(r => r.status === 201));
  assert.equal(new Set(replies.map(r => r.data.booking.id)).size, 1);
  assert.equal(replies.filter(r => r.idempotency === 'created').length, 1);
  assert.equal((await store.db.prepare('SELECT COUNT(*) AS count FROM bookings').get()).count, 1);
  const reordered = await call('/bookings', {
    method: 'POST',
    body: {
      agreed: true,
      end: body.end,
      start: body.start,
      listingId: body.listingId
    },
    cookie: renter.cookie,
    key
  });
  assert.equal(reordered.idempotency, 'replayed');
  const conflict = await call('/bookings', {
    method: 'POST',
    body: {
      ...body,
      note: 'This is a different request.'
    },
    cookie: renter.cookie,
    key
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await call(`/commands/${key}`, {
    cookie: renter.cookie
  })).data.committed, true);
  const other = await call('/session', {
    method: 'POST',
    body: {
      userId: 'kabir'
    }
  });
  assert.equal((await call(`/commands/${key}`, {
    cookie: other.cookie
  })).status, 404);
  const separate = await call('/bookings', {
    method: 'POST',
    body: {
      ...body,
      listingId: 'tripod'
    },
    cookie: other.cookie,
    key
  });
  assert.equal(separate.status, 201, 'keys are scoped to authenticated actors');
}));
test('handover retries never add duplicate photos and replay returns the current authorized resource', async () => await httpTest(async ({
  call,
  store
}) => {
  const b = await store.createBooking('teja', {
    listingId: 'light-kit',
    ...dates(),
    agreed: true
  });
  await store.transition('aanya', b.id, {
    action: 'accept'
  });
  const host = await call('/session', {
    method: 'POST',
    body: {
      userId: 'aanya'
    }
  });
  const key = randomUUID(),
    body = {
      action: 'collect',
      code: (await store.booking(b.id, 'teja')).pickupCode,
      image: photo
    };
  const first = await call(`/bookings/${b.id}`, {
    method: 'PATCH',
    body,
    cookie: host.cookie,
    key
  });
  assert.equal(first.status, 200);
  await store.transition('aanya', b.id, {
    action: 'return',
    code: (await store.booking(b.id, 'teja')).returnCode,
    image: photo
  });
  const replay = await call(`/bookings/${b.id}`, {
    method: 'PATCH',
    body,
    cookie: host.cookie,
    key
  });
  assert.equal(replay.idempotency, 'replayed');
  assert.equal(replay.data.booking.status, 'completed');
  assert.equal(replay.data.booking.evidence.length, 2);
  assert.equal(replay.data.booking.returnCode, null);
  assert.ok(!(await store.db.prepare('SELECT result FROM command_receipts').get()).result.includes('base64'));
}));
test('incident API requires idempotency and versions; invalid and foreign-origin requests cannot reserve keys', async () => await httpTest(async ({
  call,
  store
}) => {
  const b = await active(store),
    renter = await call('/session', {
      method: 'POST',
      body: {
        userId: 'teja'
      }
    });
  const body = {
      type: 'lost',
      description: 'The camera cannot be located after the trip.'
    },
    key = randomUUID();
  assert.equal((await call(`/bookings/${b.id}/incidents`, {
    method: 'POST',
    body,
    cookie: renter.cookie
  })).status, 428);
  assert.equal((await call(`/bookings/${b.id}/incidents`, {
    method: 'POST',
    body,
    cookie: renter.cookie,
    key,
    requestOrigin: 'https://untrusted.example'
  })).status, 403);
  assert.equal((await call(`/bookings/${b.id}/incidents`, {
    method: 'POST',
    body: {
      ...body,
      description: 'short'
    },
    cookie: renter.cookie,
    key
  })).status, 400);
  const opened = await call(`/bookings/${b.id}/incidents`, {
    method: 'POST',
    body,
    cookie: renter.cookie,
    key
  });
  assert.equal(opened.status, 201);
  const replay = await call(`/bookings/${b.id}/incidents`, {
    method: 'POST',
    body,
    cookie: renter.cookie,
    key
  });
  assert.equal(replay.data.incident.id, opened.data.incident.id);
  assert.equal(replay.idempotency, 'replayed');
  const incident = opened.data.incident,
    editKey = randomUUID();
  const edit = {
    action: 'add-evidence',
    expectedVersion: incident.version,
    note: 'The carry bag has been checked again.',
    image: photo
  };
  assert.equal((await call(`/incidents/${incident.id}`, {
    method: 'PATCH',
    body: edit,
    cookie: renter.cookie,
    key: editKey
  })).status, 200);
  assert.equal((await call(`/incidents/${incident.id}`, {
    method: 'PATCH',
    body: edit,
    cookie: renter.cookie,
    key: editKey
  })).idempotency, 'replayed');
  assert.equal((await call(`/incidents/${incident.id}`, {
    method: 'PATCH',
    body: edit,
    cookie: renter.cookie,
    key: randomUUID()
  })).data.code, 'STALE_INCIDENT');
  assert.equal((await store.recovery.get(incident.id, 'teja')).entries.length, 2);
  const invalidKey = await call('/bookings', {
    method: 'POST',
    body: {
      listingId: 'tripod',
      ...dates(),
      agreed: true
    },
    cookie: renter.cookie,
    key: 'short'
  });
  assert.equal(invalidKey.status, 400);
  assert.equal(invalidKey.data.code, 'INVALID_IDEMPOTENCY_KEY');
}));
test('SQLite backup captures WAL-backed incidents and receipts with verified integrity and refuses overwrite', async () => {
  mkdirSync('.testdata', {
    recursive: true
  });
  const source = resolve('.testdata', `${randomUUID()}.db`),
    target = resolve('.testdata', `${randomUUID()}.db`);
  const store = new Store(source);
  await store.ready;
  try {
    const b = await active(store),
      incident = await report(store, b),
      key = randomUUID();
    await store.commands.execute('teja', key, fingerprint('POST', '/backup-test', {}), () => ({
      resource: 'incident',
      id: incident.id,
      status: 201
    }));
    const result = await backupDatabase(source, target);
    assert.equal(result.integrity, 'ok');
    assert.equal(result.counts.incidents, 1);
    assert.equal(result.counts.command_receipts, 1);
    assert.equal(JSON.parse(readFileSync(`${target}.json`, 'utf8')).sha256, result.sha256);
    const restored = new Store(target);
    await restored.ready;
    try {
      assert.equal((await restored.recovery.get(incident.id, 'teja')).entries[0].digest, evidenceDigest(photo));
      assert.equal((await restored.listing(b.listing.id)).recoveryHold, true);
      assert.equal((await restored.commands.execute('teja', key, fingerprint('POST', '/backup-test', {}), () => {
        throw new Error('must not repeat');
      })).idempotency, 'replayed');
    } finally {
      await restored.close();
    }
    await assert.rejects(backupDatabase(source, target), /EEXIST/);
    await assert.rejects(backupDatabase(source, source), /must not replace/);
  } finally {
    await store.close();
    for (const path of [source, target]) for (const suffix of ['', '-wal', '-shm', '.json']) try {
      unlinkSync(path + suffix);
    } catch {}
  }
});
test('busy storage fails closed with Retry-After; the same key works once the database lock is released', async () => {
  mkdirSync('.testdata', {
    recursive: true
  });
  const path = resolve('.testdata', `${randomUUID()}.db`);
  const {
    server,
    store
  } = createApplication({
    dbPath: path,
    allowCreate: true
  });
  await store.ready;
  const cookie = `sparely_session=${await store.createSession('teja')}`;
  await store.db.exec('PRAGMA busy_timeout=10');
  const lock = new DatabaseSync(path);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`,
    key = randomUUID();
  const body = {
    listingId: 'light-kit',
    ...dates(),
    agreed: true
  };
  const send = () => fetch(origin + '/api/bookings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
      Origin: origin,
      'Idempotency-Key': key,
      'X-Sparely-Actor': 'teja'
    },
    body: JSON.stringify(body)
  });
  try {
    await lock.exec('BEGIN IMMEDIATE');
    const busy = await send();
    assert.equal(busy.status, 503);
    assert.equal(await busy.headers.get('retry-after'), '1');
    assert.equal((await busy.json()).code, 'STORAGE_BUSY');
    await lock.exec('ROLLBACK');
    const success = await send();
    assert.equal(success.status, 201);
    assert.equal(await success.headers.get('idempotency-status'), 'created');
    assert.equal((await store.db.prepare('SELECT COUNT(*) AS count FROM bookings').get()).count, 1);
    assert.equal((await store.db.prepare('SELECT COUNT(*) AS count FROM command_receipts').get()).count, 1);
  } finally {
    await lock.close();
    server.closeAllConnections();
    await new Promise(async resolve => await server.close(resolve));
    for (const suffix of ['', '-wal', '-shm']) try {
      unlinkSync(path + suffix);
    } catch {}
  }
});
test('a missing persistent database blocks startup instead of silently creating new inventory', () => {
  const path = resolve('.testdata', `${randomUUID()}.db`);
  assert.throws(() => createApplication({
    dbPath: path
  }), /Refusing to silently create/);
});
test('new bookings preserve agreed inventory and terms independently of later listing edits; legacy terms are not fabricated', async () => await withStore(async store => {
  const b = await active(store),
    originalTitle = b.listing.title;
  assert.equal(b.agreement.listing.title, originalTitle);
  assert.equal(b.agreement.conditionVerification, 'host_code_and_photo_only');
  await store.db.prepare('UPDATE listings SET title=? WHERE id=?').run('Updated public listing title', b.listing.id);
  const after = await store.booking(b.id, 'teja');
  assert.equal(after.listing.title, 'Updated public listing title');
  assert.equal(after.agreement.listing.title, originalTitle);
  assert.equal(after.agreement.quote.total, b.quote.total);
  const meta = await store.metadata(b.id);
  delete meta.details.agreement;
  await store.saveMetadata(b.id, meta);
  assert.equal((await store.booking(b.id, 'teja')).agreement, null, 'legacy agreement facts cannot be inferred from current listing');
}));
test('failed access before handover can close after cancellation without inventing a return', async () => await withStore(async store => {
  const b = await store.createBooking('teja', {
    listingId: 'covered-parking',
    ...dates(),
    agreed: true
  });
  await store.transition('kabir', b.id, {
    action: 'accept'
  });
  const incident = await store.recovery.open('teja', b.id, {
    type: 'access_problem',
    description: 'The agreed gate access cannot be arranged.'
  });
  await store.transition('teja', b.id, {
    action: 'cancel'
  });
  const closed = await action(store, 'mira', incident, {
    action: 'resolve',
    outcome: 'handover_cancelled'
  });
  assert.equal(closed.status, 'resolved');
  assert.equal((await store.booking(b.id, 'teja')).evidence.length, 0);
  assert.equal((await store.booking(b.id, 'teja')).status, 'cancelled');
  assert.equal((await store.listing(b.listing.id)).active, false, 'host must fix access before marking ready');
}));
