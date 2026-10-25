import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store, quote, timeRange } from '../lib/store.mjs';
import { assist } from '../lib/assistant.mjs';
import { createApplication } from '../main.mjs';
const photo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCWQAAAAASUVORK5CYII=';
const dates = (offset = 2, days = 1) => ({
  start: new Date(Date.now() + offset * 86400_000).toISOString(),
  end: new Date(Date.now() + (offset + days) * 86400_000).toISOString()
});
const request = async (store, listingId = 'light-kit', range = dates()) => await store.createBooking('teja', {
  listingId,
  ...range,
  agreed: true,
  note: 'A small product shoot.'
});
const usingStore = async fn => {
  const store = new Store();
  await store.ready;
  try {
    return await fn(store);
  } finally {
    await store.close();
  }
};
test('renter and host can complete a rental; codes and evidence stay attached', async () => await usingStore(async store => {
  const r = await request(store);
  assert.equal(r.status, 'requested');
  assert.equal(r.quote.total, 1350);
  const confirmed = await store.transition('aanya', r.id, {
    action: 'accept'
  });
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.pickupCode, null, 'host must not see the renter handover code');
  const renter = await store.booking(r.id, 'teja');
  assert.match(renter.pickupCode, /^\d{6}$/);
  await assert.rejects(async () => await store.transition('aanya', r.id, {
    action: 'collect',
    code: 'wrong',
    image: photo
  }), /does not match/);
  await assert.rejects(async () => await store.transition('aanya', r.id, {
    action: 'collect',
    code: renter.pickupCode
  }), /condition photo/);
  const active = await store.transition('aanya', r.id, {
    action: 'collect',
    code: renter.pickupCode,
    image: photo,
    note: 'All accessories counted.'
  });
  assert.equal(active.status, 'active');
  const complete = await store.transition('aanya', r.id, {
    action: 'return',
    code: (await store.booking(r.id, 'teja')).returnCode,
    image: photo,
    note: 'Returned complete.'
  });
  assert.equal(complete.status, 'completed');
  assert.equal(complete.evidence.length, 2);
  assert.equal(complete.trace.at(-1).title, 'Returned and closed');
  assert.equal(await store.available(r.listing.id, r.start, r.end), true);
}));
test('overlapping requests are rejected while back-to-back bookings are allowed', async () => await usingStore(async store => {
  const range = dates();
  const b = await request(store, 'light-kit', range);
  await assert.rejects(async () => await request(store, 'light-kit', range), e => e.status === 409);
  const adjacent = {
    start: b.end,
    end: new Date(Date.parse(b.end) + 86400_000).toISOString()
  };
  assert.equal((await request(store, 'light-kit', adjacent)).status, 'requested');
}));
test('declines and cancellations release held inventory; expired holds cannot be accepted', async () => await usingStore(async store => {
  let b = await request(store);
  await store.transition('aanya', b.id, {
    action: 'decline'
  });
  b = await request(store);
  await store.transition('teja', b.id, {
    action: 'cancel'
  });
  b = await request(store);
  await store.db.prepare('UPDATE bookings SET hold_until=? WHERE id=?').run(Date.now() - 1, b.id);
  await assert.rejects(async () => await store.transition('aanya', b.id, {
    action: 'accept'
  }), e => e.status === 409);
  assert.equal((await store.booking(b.id, 'teja')).status, 'expired');
  assert.equal((await request(store)).status, 'requested');
}));
test('only the correct host can accept and unrelated profiles cannot read a booking', async () => await usingStore(async store => {
  const b = await request(store);
  await assert.rejects(async () => await store.transition('teja', b.id, {
    action: 'accept'
  }), e => e.status === 403);
  await assert.rejects(async () => await store.booking(b.id, 'kabir'), e => e.status === 403);
  await assert.rejects(async () => await store.toggleListing('teja', b.listing.id, false), e => e.status === 403);
  await assert.rejects(async () => await store.createBooking('aanya', {
    listingId: 'light-kit',
    ...dates(),
    agreed: true
  }), /own listing/);
  await assert.rejects(async () => await store.transition('aanya', b.id, {
    action: 'return',
    image: photo,
    code: '123456'
  }), e => e.status === 409);
}));
test('quote rounds started units upward, preserves deposits, and validates dates', async () => await usingStore(async store => {
  const parking = await store.listing('covered-parking');
  const start = new Date(Date.now() + 86400_000).toISOString(),
    end = new Date(Date.parse(start) + 90 * 60_000).toISOString();
  assert.equal(quote(parking, start, end).rental, 70);
  assert.equal(quote(parking, start, end).deposit, 0);
  assert.throws(() => timeRange(end, start), /after collection/);
  assert.throws(() => timeRange('bad date', end), /valid/);
  assert.throws(() => timeRange(new Date(0).toISOString(), end), /future/);
  await assert.rejects(async () => await store.createBooking('teja', {
    listingId: 'light-kit',
    ...dates(),
    agreed: false
  }), /listing rules/);
}));
test('search combines saved items, category, no-deposit and date availability correctly', async () => await usingStore(async store => {
  assert.equal((await store.search()).length, 10, '12 original samples minus 4 retired plus sewing and garden');
  assert.equal((await store.search({
    city: 'Bengaluru'
  })).length, 0);
  await store.favorite('teja', 'covered-parking', true);
  assert.equal((await store.search({
    saved: 'true'
  }, 'teja')).length, 1);
  assert.equal((await store.search({
    saved: 'true'
  }, 'aanya')).length, 0);
  assert.equal((await store.search({
    category: 'parking',
    noDeposit: 'true'
  })).length, 2);
  const b = await request(store, 'covered-parking');
  const available = await store.search({
    category: 'parking',
    start: b.start,
    end: b.end
  });
  assert.equal(available.length, 1);
  assert.equal(available[0].id, 'bike-parking');
  assert.ok(available[0].quote.rental > 0);
}));
test('an overdue active item is not offered again before its actual return', async () => await usingStore(async store => {
  const b = await request(store);
  await store.transition('aanya', b.id, {
    action: 'accept'
  });
  await store.transition('aanya', b.id, {
    action: 'collect',
    code: (await store.booking(b.id, 'teja')).pickupCode,
    image: photo
  });
  await store.db.prepare('UPDATE bookings SET end=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), b.id);
  await assert.rejects(async () => await request(store, 'light-kit', dates(6)), e => e.status === 409);
}));
test('listing publication, validation, pausing and saves persist across a database restart', async () => {
  const folder = resolve('.testdata');
  mkdirSync(folder, {
    recursive: true
  });
  const path = resolve(folder, `${randomUUID()}.db`);
  let store = new Store(path);
  await store.ready;
  try {
    const input = {
      title: 'A folding table for your stall',
      description: 'A sturdy folding table for a weekend stall or a small gathering.',
      category: 'tools',
      city: 'Hyderabad',
      area: 'Madhapur',
      rate: 120,
      unit: 'day',
      deposit: 300,
      included: 'Folding table\nCarry strap',
      rules: 'Return clean',
      photo
    };
    await assert.rejects(async () => await store.createListing('teja', {
      ...input,
      rate: -1
    }), /whole-rupee/);
    await assert.rejects(async () => await store.createListing('teja', {
      ...input,
      photo: 'data:image/svg+xml;base64,PHN2Zz4='
    }), /JPG/);
    const l = await store.createListing('teja', input);
    await store.favorite('aanya', l.id, true);
    await store.toggleListing('teja', l.id, false);
    await store.close();
    store = new Store(path);
    await store.ready;
    assert.equal((await store.listing(l.id, 'aanya')).favorite, true);
    assert.equal((await store.listing(l.id)).active, false);
    assert.equal((await store.listing(l.id)).image, photo);
    assert.equal((await store.hosted('teja')).length, 1);
    await assert.rejects(async () => await store.createBooking('aanya', {
      listingId: l.id,
      ...dates(),
      agreed: true
    }), /paused/);
  } finally {
    await store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(path + suffix);
      } catch {}
    }
  }
});
test('task matcher returns catalogue-backed equipment and makes no undated total', async () => {
  const store = new Store();
  await store.ready;
  const oldKey = process.env.LLM_API_KEY;
  delete process.env.LLM_API_KEY;
  try {
    const result = await assist(store, 'teja', {
      query: 'I need to photograph products at home under ₹2000'
    });
    assert.equal(result.mode, 'local');
    assert.equal(result.budget, 2000);
    assert.equal(result.total, null);
    assert.deepEqual(result.suggestions.map(s => s.listing.id).sort(), ['light-kit', 'tripod']);
    assert.ok(result.questions.some(q => q.includes('dates')));
    const sewing = await assist(store, 'teja', { query: 'I want to hem my curtains this weekend' });
    assert.deepEqual(sewing.suggestions.map(s => s.listing.id), ['sewing-machine']);
    const garden = await assist(store, 'teja', { query: 'Tidy up my balcony plants and prune them' });
    assert.deepEqual(garden.suggestions.map(s => s.listing.id), ['garden-kit']);
    const retired = await assist(store, 'teja', { query: 'I need a laptop for a deadline' });
    assert.equal(retired.suggestions.length, 0, 'retired work equipment is never suggested');
    const dated = await assist(store, 'teja', {
      query: 'I need to mend a few clothes',
      ...dates()
    });
    assert.ok(dated.suggestions.length);
    assert.equal(dated.total, dated.suggestions.reduce((sum, s) => sum + s.listing.quote.rental, 0));
    const unknown = await assist(store, 'teja', {
      query: 'Tell me a story about the sea'
    });
    assert.equal(unknown.suggestions.length, 0);
    assert.ok(unknown.questions.length);
  } finally {
    if (oldKey !== undefined) process.env.LLM_API_KEY = oldKey;
    await store.close();
  }
});
test('HTTP API keeps profile cookies, enforces permissions and rejects foreign mutation origins', async () => {
  const {
    server
  } = createApplication({
    dbPath: ':memory:'
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const boot = await fetch(base + '/api/bootstrap');
    assert.equal(boot.status, 200);
    assert.equal((await boot.json()).user, null, 'no session is created implicitly');
    assert.equal(boot.headers.get('set-cookie'), null);
    const demo = await fetch(base + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: 'teja' }) });
    const cookie = demo.headers.get('set-cookie').split(';')[0];
    assert.match(cookie, /^sparely_session=/);
    const publicListings = await fetch(base + '/api/listings');
    assert.equal(publicListings.status, 401);
    const noActor = await fetch(base + '/api/bookings', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ listingId: 'light-kit', ...dates(), agreed: true }) });
    assert.equal(noActor.status, 428, 'writes must name the expected account');
    const wrongActor = await fetch(base + '/api/bookings', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-Sparely-Actor': 'aanya' }, body: JSON.stringify({ listingId: 'light-kit', ...dates(), agreed: true }) });
    assert.equal(wrongActor.status, 409);
    assert.equal((await wrongActor.json()).code, 'ACTOR_CHANGED');
    const create = await fetch(base + '/api/bookings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        'X-Sparely-Actor': 'teja'
      },
      body: JSON.stringify({
        listingId: 'light-kit',
        ...dates(),
        agreed: true
      })
    });
    assert.equal(create.status, 201);
    const {
      booking
    } = await create.json();
    const forbidden = await fetch(base + `/api/bookings/${booking.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        'X-Sparely-Actor': 'teja'
      },
      body: JSON.stringify({
        action: 'accept'
      })
    });
    assert.equal(forbidden.status, 403);
    const csrf = await fetch(base + '/api/session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        Origin: 'https://untrusted.example'
      },
      body: JSON.stringify({
        userId: 'aanya'
      })
    });
    assert.equal(csrf.status, 403);
    const session = await fetch(base + '/api/session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        userId: 'aanya'
      })
    });
    const hostCookie = (await session.headers.get('set-cookie')).split(';')[0];
    const accept = await fetch(base + `/api/bookings/${booking.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: hostCookie,
        'X-Sparely-Actor': 'aanya'
      },
      body: JSON.stringify({
        action: 'accept'
      })
    });
    assert.equal(accept.status, 200);
    assert.equal((await accept.json()).booking.pickupCode, null);
    const bookings = await fetch(base + '/api/bookings', {
      headers: {
        Cookie: cookie
      }
    });
    assert.equal((await bookings.json()).bookings[0].status, 'confirmed');
    const badJSON = await fetch(base + '/api/listings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie
      },
      body: '{bad'
    });
    assert.equal(badJSON.status, 400);
    const health = await fetch(base + '/api/health');
    assert.equal(health.status, 200);
    assert.equal(await health.headers.get('x-content-type-options'), 'nosniff');
  } finally {
    server.closeAllConnections();
    await new Promise(async resolve => await server.close(resolve));
  }
});
