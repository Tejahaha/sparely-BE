import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.mjs';
import { createApplication } from '../main.mjs';
const photo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCWQAAAAASUVORK5CYII=';
const withStore = async callback => {
  const store = new Store();
  await store.ready;
  try {
    await callback(store);
  } finally {
    await store.close();
  }
};
const activeRental = async store => {
  const start = new Date(Date.now() + 86400_000).toISOString();
  const end = new Date(Date.parse(start) + 86400_000).toISOString();
  const b = await store.createBooking('teja', {
    listingId: 'light-kit',
    start,
    end,
    agreed: true
  });
  await store.transition('aanya', b.id, {
    action: 'accept'
  });
  await store.transition('aanya', b.id, {
    action: 'collect',
    code: (await store.booking(b.id, 'teja')).pickupCode,
    image: photo
  });
  return await store.booking(b.id, 'teja');
};
test('scenario fixtures are separate rentals and do not change the public catalogue', async () => await withStore(async store => {
  const originalCount = (await store.search()).length;
  for (const kind of ['overdue', 'damage', 'expired', 'conflict']) {
    const b = await store.createScenario(kind);
    assert.equal(b.demoScenario.kind, kind);
    assert.equal(b.listing.demoScenario, true);
    assert.equal((await store.search()).length, originalCount);
    assert.notEqual(b.listing.id, 'light-kit');
  }
  assert.equal((await store.listing('light-kit')).active, true);
  assert.equal((await store.listing('storage-nook')).active, true);
  await assert.rejects(async () => await store.createScenario('unsupported'), /available demo scenario/);
}));
test('overdue is visible to both sides, blocks further rental and records a single watchdog alert', async () => await withStore(async store => {
  const b = await store.createScenario('overdue');
  assert.equal(b.status, 'active');
  assert.equal(b.attention.kind, 'overdue');
  assert.ok(b.attention.lateMinutes >= 120);
  assert.equal((await store.booking(b.id, b.listing.ownerId)).attention.kind, 'overdue');
  await store.evaluate();
  await store.evaluate();
  assert.equal((await store.booking(b.id, 'teja')).trace.filter(t => t.title === 'Overdue alert raised').length, 1);
  const start = new Date(Date.now() + 7 * 86400_000).toISOString(),
    end = new Date(Date.parse(start) + 86400_000).toISOString();
  // Shared storage (M4): overdue goods keep their own 6 sq ft; the rest stays bookable.
  assert.equal(await store.available(b.listing.id, start, end, '', 150), false, '15 sq ft no longer fits beside the overdue goods');
  assert.equal(await store.available(b.listing.id, start, end, '', 140), true, 'the remaining 14 sq ft is still bookable');
  assert.equal(await store.available('storage-nook', start, end), true);
}));
test('grace and collection-missed warnings distinguish uncertainty from an overdue return', async () => await withStore(async store => {
  const b = await store.createScenario('overdue');
  let meta = await store.metadata(b.id);
  meta.details.offsetMs = Date.parse(b.end) + 10 * 60000 - Date.now();
  await store.saveMetadata(b.id, meta);
  assert.equal((await store.booking(b.id, 'teja')).attention.kind, 'grace');
  const start = new Date(Date.now() + 3600_000).toISOString(),
    end = new Date(Date.parse(start) + 86400_000).toISOString();
  const next = await store.createBooking('teja', {
    listingId: 'light-kit',
    start,
    end,
    agreed: true
  });
  await store.transition('aanya', next.id, {
    action: 'accept'
  });
  meta = await store.metadata(next.id);
  meta.details.offsetMs = Date.parse(start) + 31 * 60000 - Date.now();
  await store.saveMetadata(next.id, meta);
  await store.evaluate();
  assert.equal((await store.booking(next.id, 'teja')).attention.kind, 'pickup_missed');
  assert.equal((await store.booking(next.id, 'teja')).status, 'confirmed');
  assert.equal((await store.booking(next.id, 'teja')).claim, null);
}));
test('expired demo holds release dates and cannot later be accepted', async () => await withStore(async store => {
  const b = await store.createScenario('expired');
  assert.equal(b.status, 'expired');
  assert.equal(await store.available(b.listing.id, b.start, b.end), true);
  await assert.rejects(async () => await store.transition(b.listing.ownerId, b.id, {
    action: 'accept'
  }), e => e.status === 409);
}));
test('ordinary wear closes normally and does not open a damage claim', async () => await withStore(async store => {
  const b = await activeRental(store);
  const returned = await store.transition('aanya', b.id, {
    action: 'return',
    code: b.returnCode,
    image: photo,
    issue: 'none',
    note: 'Light ordinary wear, all accessories present.'
  });
  assert.equal(returned.status, 'completed');
  assert.equal(returned.claim, null);
  assert.equal(returned.depositDeduction, 0);
  assert.equal(returned.listing.active, true);
}));
test('invalid damage proposals roll back the return, evidence and listing pause', async () => await withStore(async store => {
  const b = await activeRental(store);
  await assert.rejects(async () => await store.transition('aanya', b.id, {
    action: 'return',
    code: b.returnCode,
    image: photo,
    issue: 'damage',
    amount: b.quote.deposit + 1,
    note: 'A repair estimate beyond the deposit.'
  }), /deposit/);
  const unchanged = await store.booking(b.id, 'teja');
  assert.equal(unchanged.status, 'active');
  assert.equal(unchanged.evidence.length, 1);
  assert.equal(unchanged.claim, null);
  assert.equal(unchanged.listing.active, true);
}));
test('a disputed claim needs independent review; final deduction is capped and readiness remains manual', async () => await withStore(async store => {
  const b = await store.createScenario('damage');
  assert.equal(b.status, 'under_review');
  assert.equal(b.claim.amount, 500);
  assert.equal(b.listing.active, false);
  await assert.rejects(async () => await store.toggleListing(b.listing.ownerId, b.listing.id, true), e => e.status === 409);
  await assert.rejects(async () => await store.transition(b.listing.ownerId, b.id, {
    action: 'resolve-claim',
    amount: 500,
    note: 'Host tries to settle their own claim.'
  }), e => e.status === 403);
  await store.transition('teja', b.id, {
    action: 'respond-claim',
    accepted: false,
    note: 'The charger was not included at the initial handover.'
  });
  assert.equal((await store.booking(b.id, 'teja')).attention.kind, 'disputed');
  assert.equal((await store.reviews('mira')).length, 1);
  await assert.rejects(async () => await store.reviews('aanya'), e => e.status === 403);
  await assert.rejects(async () => await store.transition('mira', b.id, {
    action: 'resolve-claim',
    amount: 501,
    note: 'An amount above the host proposal.'
  }), /proposed deduction/);
  const resolved = await store.transition('mira', b.id, {
    action: 'resolve-claim',
    amount: 250,
    note: 'Partial responsibility agreed after reviewing both condition records and the response.'
  });
  assert.equal(resolved.status, 'completed');
  assert.equal(resolved.depositDeduction, 250);
  assert.equal(resolved.claim.decision.operator, 'Mira Patel');
  assert.equal(resolved.pickupCode, null);
  assert.equal(resolved.returnCode, null);
  assert.equal(resolved.listing.active, false);
  assert.equal((await store.toggleListing(b.listing.ownerId, b.listing.id, true)).active, true);
  await assert.rejects(async () => await store.transition('mira', b.id, {
    action: 'resolve-claim',
    amount: 0,
    note: 'Attempt to settle the same claim twice.'
  }), e => e.status === 409);
}));
test('an unanswered claim has a response window, and only sample rentals allow clock controls', async () => await withStore(async store => {
  const b = await store.createScenario('damage');
  await assert.rejects(async () => await store.transition('mira', b.id, {
    action: 'resolve-claim',
    amount: 0,
    note: 'Insufficient proof to approve a deduction.'
  }), e => e.status === 409);
  await store.transition('mira', b.id, {
    action: 'advance-demo',
    hours: 48
  });
  const resolved = await store.transition('mira', b.id, {
    action: 'resolve-claim',
    amount: 0,
    note: 'The response window ended; collection evidence does not establish that the accessory was supplied.'
  });
  assert.equal(resolved.depositDeduction, 0);
  const real = await activeRental(store);
  await assert.rejects(async () => await store.transition('teja', real.id, {
    action: 'advance-demo',
    hours: 48
  }), e => e.status === 403);
  await assert.rejects(async () => await store.booking(real.id, 'mira'), e => e.status === 403);
}));
test('damage puts later confirmed collections at risk until review and host readiness are complete', async () => await withStore(async store => {
  const first = await activeRental(store);
  const start = new Date(Date.parse(first.end) + 3600_000).toISOString();
  const end = new Date(Date.parse(start) + 86400_000).toISOString();
  const next = await store.createBooking('kabir', {
    listingId: first.listing.id,
    start,
    end,
    agreed: true
  });
  await store.transition('aanya', next.id, {
    action: 'accept'
  });
  await store.transition('aanya', first.id, {
    action: 'return',
    code: first.returnCode,
    image: photo,
    issue: 'damage',
    amount: 100,
    note: 'The tripod mount needs checking before another rental.'
  });
  await store.evaluate();
  assert.equal((await store.booking(next.id, 'kabir')).attention.kind, 'unavailable');
  const collect = async () => await store.transition('aanya', next.id, {
    action: 'collect',
    code: (await store.booking(next.id, 'kabir')).pickupCode,
    image: photo
  });
  await assert.rejects(collect, e => e.status === 409);
  await store.transition('teja', first.id, {
    action: 'respond-claim',
    accepted: true
  });
  await store.transition('mira', first.id, {
    action: 'resolve-claim',
    amount: 0,
    note: 'Waive the deduction; equipment still requires a readiness check.'
  });
  await assert.rejects(collect, e => e.status === 409);
  await store.toggleListing('aanya', first.listing.id, true);
  assert.equal((await collect()).status, 'active');
}));
test('extension updates deadline and quote only after host approval', async () => await withStore(async store => {
  const b = await activeRental(store),
    end = new Date(Date.parse(b.end) + 86400_000).toISOString();
  await assert.rejects(async () => await store.transition('aanya', b.id, {
    action: 'request-extension',
    end
  }), e => e.status === 403);
  const pending = await store.transition('teja', b.id, {
    action: 'request-extension',
    end
  });
  assert.equal(pending.end, b.end);
  assert.equal(pending.quote.rental, b.quote.rental);
  assert.equal(pending.extension.additionalRental, 350);
  await assert.rejects(async () => await store.transition('teja', b.id, {
    action: 'approve-extension'
  }), e => e.status === 403);
  const approved = await store.transition('aanya', b.id, {
    action: 'approve-extension'
  });
  assert.equal(approved.end, end);
  assert.equal(approved.quote.rental, 700);
  assert.equal(approved.extension.status, 'approved');
  assert.equal(approved.quote.deposit, b.quote.deposit);
}));
test('extension conflict is rejected and acceptance checks availability again after a competing reservation', async () => await withStore(async store => {
  const conflict = await store.createScenario('conflict');
  await assert.rejects(async () => await store.transition('teja', conflict.id, {
    action: 'request-extension',
    end: new Date(Date.parse(conflict.end) + 3 * 3600_000).toISOString()
  }), e => e.status === 409);
  assert.equal((await store.booking(conflict.id, 'teja')).extension, null);
  const b = await activeRental(store),
    end = new Date(Date.parse(b.end) + 86400_000).toISOString();
  await store.transition('teja', b.id, {
    action: 'request-extension',
    end
  });
  const next = await store.createBooking('kabir', {
    listingId: b.listing.id,
    start: new Date(Date.parse(b.end) + 3600_000).toISOString(),
    end,
    agreed: true
  });
  await store.transition('aanya', next.id, {
    action: 'accept'
  });
  await assert.rejects(async () => await store.transition('aanya', b.id, {
    action: 'approve-extension'
  }), e => e.status === 409);
  assert.equal((await store.booking(b.id, 'teja')).end, b.end);
  const declined = await store.transition('aanya', b.id, {
    action: 'decline-extension'
  });
  assert.equal(declined.extension.status, 'declined');
  assert.equal(declined.quote.rental, b.quote.rental);
}));
test('the policy is snapshotted with the booking and is not changed by client edits', async () => await withStore(async store => {
  const b = await activeRental(store);
  assert.equal(b.policy.version, 'demo-v2'); // M6: cancellation/no-show rules added to the policy
  b.policy.graceMinutes = 999;
  assert.equal((await store.booking(b.id, 'teja')).policy.graceMinutes, 30);
}));
test('scenario and operator endpoints enforce cookies and roles across a condition review', async () => {
  const {
    server
  } = createApplication({
    dbPath: ':memory:'
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const actors = new Map(); // session cookie -> the account each write must name
  const call = async (path, method = 'GET', body, cookie) => {
    const response = await fetch(base + '/api' + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Origin: base,
        ...(cookie ? {
          Cookie: cookie,
          'X-Sparely-Actor': actors.get(cookie)
        } : {})
      },
      ...(body ? {
        body: JSON.stringify(body)
      } : {})
    });
    const data = await response.json(), next = response.headers.get('set-cookie')?.split(';')[0];
    if (next) actors.set(next, data.user?.id || (path === '/scenarios' ? 'teja' : undefined));
    return { status: response.status, data, cookie: next };
  };
  try {
    const initial = await call('/session', 'POST', { userId: 'teja' });
    const scenario = await call('/scenarios', 'POST', {
      kind: 'damage'
    }, initial.cookie);
    assert.equal(scenario.status, 201);
    assert.equal((await call('/reviews', 'GET', undefined, scenario.cookie)).status, 403);
    const id = scenario.data.booking.id;
    assert.equal((await call(`/bookings/${id}`, 'PATCH', {
      action: 'respond-claim',
      accepted: false,
      note: 'The accessory was missing when I collected it.'
    }, scenario.cookie)).status, 200);
    const operator = await call('/session', 'POST', {
      userId: 'mira'
    });
    const reviews = await call('/reviews', 'GET', undefined, operator.cookie);
    assert.equal(reviews.status, 200);
    assert.equal(reviews.data.bookings.length, 1);
    const resolved = await call(`/bookings/${id}`, 'PATCH', {
      action: 'resolve-claim',
      amount: 0,
      note: 'Collection and return records do not substantiate a deduction.'
    }, operator.cookie);
    assert.equal(resolved.status, 200);
    assert.equal(resolved.data.booking.status, 'completed');
  } finally {
    server.closeAllConnections();
    await new Promise(async resolve => await server.close(resolve));
  }
});
