import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApplication } from '../server.mjs';
import { assist } from '../lib/assistant.mjs';
import { equipmentProfile } from './fixtures.mjs';

const dates = (days = 1) => ({ start: new Date(Date.now() + days * 86400000).toISOString(), end: new Date(Date.now() + (days + 1) * 86400000).toISOString() });

async function app(callback) {
  const { server, store } = createApplication({ dbPath: ':memory:', watchdogInterval: 0 });
  await store.ready;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  // A tiny browser: one cookie jar per "device", sends the expected-account header like the UI.
  const device = () => {
    let cookie = '', actor = '';
    const call = async (path, { method = 'GET', body, key, as } = {}) => {
      const response = await fetch(origin + '/api' + path, { method, headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(method !== 'GET' && (as ?? actor) ? { 'X-Sparely-Actor': as ?? actor } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const data = await response.json().catch(() => ({}));
      const next = response.headers.get('set-cookie')?.split(';')[0];
      if (next) { cookie = next.endsWith('=') ? '' : next; actor = data.user?.id || ''; }
      return { status: response.status, data };
    };
    return { call, get actor() { return actor; } };
  };
  try { await callback({ device, store }); } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('accounts sign up, sign in and out; signup cannot choose a role; duplicates and bad passwords fail', async () => await app(async ({ device, store }) => {
  const a = device();
  const signup = await a.call('/auth/signup', { method: 'POST', body: { name: 'Asha Iyer', email: 'Asha@Example.com', password: 'correct horse battery', role: 'Operator', id: 'mira' } });
  assert.equal(signup.status, 201);
  assert.equal(signup.data.mode, 'account');
  assert.equal(signup.data.user.role, 'Member', 'a signup can never pick the operator role');
  assert.notEqual(signup.data.user.id, 'mira', 'a signup can never claim an existing user id');
  assert.equal(signup.data.account.email, 'asha@example.com');
  assert.deepEqual(signup.data.users.map(u => u.id), [signup.data.user.id], 'demo profiles are not listed to real accounts');
  assert.equal((await device().call('/auth/signup', { method: 'POST', body: { name: 'Again', email: 'asha@example.com', password: 'another long password' } })).status, 409);
  assert.equal((await device().call('/auth/signup', { method: 'POST', body: { name: 'Short', email: 'short@example.com', password: 'short' } })).status, 400);
  assert.equal((await a.call('/auth/logout', { method: 'POST' })).data.user, null);
  assert.equal((await a.call('/listings')).status, 401, 'signed out');
  assert.equal((await a.call('/auth/login', { method: 'POST', body: { email: 'asha@example.com', password: 'wrong password!!' } })).status, 401);
  assert.equal((await a.call('/auth/login', { method: 'POST', body: { email: 'nobody@example.com', password: 'whatever password' } })).status, 401);
  assert.equal((await a.call('/auth/login', { method: 'POST', body: { email: 'ASHA@example.com', password: 'correct horse battery' } })).status, 200);
  assert.equal((await store.db.prepare('SELECT role FROM users WHERE id=?').get(signup.data.user.id)).role, 'Member');
}));

test('real accounts and the demo are separate worlds; user A cannot read or change user B records', async () => await app(async ({ device, store }) => {
  const host = device(), renter = device(), other = device();
  await host.call('/auth/signup', { method: 'POST', body: { name: 'Host Person', email: 'host@example.com', password: 'host password 123' } });
  await renter.call('/auth/signup', { method: 'POST', body: { name: 'Renter Person', email: 'renter@example.com', password: 'renter password 1' } });
  await other.call('/auth/signup', { method: 'POST', body: { name: 'Other Person', email: 'other@example.com', password: 'other password 12' } });
  const listing = (await host.call('/listings', { method: 'POST', body: { title: 'Account world drill', description: 'A drill offered by a real account for testing world isolation.', category: 'tools', city: 'Hyderabad', area: 'Madhapur', rate: 200, unit: 'day', deposit: 0, profile: equipmentProfile() } })).data.listing;
  const browse = (await renter.call('/listings?city=Hyderabad')).data.listings;
  assert.deepEqual(browse.map(l => l.id), [listing.id], 'accounts see only account-world listings, not the demo catalogue');
  assert.equal((await renter.call('/listings/drill-kit')).status, 404, 'demo listings do not exist for accounts');
  assert.equal((await renter.call('/bookings', { method: 'POST', body: { listingId: 'drill-kit', ...dates(), agreed: true } })).status, 404);
  const booking = (await renter.call('/bookings', { method: 'POST', body: { listingId: listing.id, ...dates(), agreed: true } })).data.booking;
  assert.equal((await other.call(`/bookings/${booking.id}`)).status, 403, 'outsiders cannot read a booking');
  assert.equal((await other.call(`/bookings/${booking.id}`, { method: 'PATCH', body: { action: 'cancel' } })).status, 403);
  assert.equal((await other.call(`/listings/${listing.id}`, { method: 'PATCH', body: { active: false } })).status, 403);
  assert.equal((await other.call('/reviews')).status, 403, 'an ordinary account cannot open the review desk');
  assert.equal((await other.call('/scenarios', { method: 'POST', body: { kind: 'damage' } })).status, 403, 'scenarios are demo-only');
  assert.equal((await other.call('/session', { method: 'POST', body: { userId: 'teja' } })).status, 409, 'a signed-in account cannot jump into a demo profile');
  const demo = device();
  await demo.call('/session', { method: 'POST', body: { userId: 'teja' } });
  assert.equal((await demo.call('/session', { method: 'POST', body: { userId: renter.actor } })).status, 403, 'demo switching cannot reach real accounts');
  assert.equal((await demo.call(`/listings/${listing.id}`)).status, 404, 'account listings do not exist for the demo');
  assert.ok((await demo.call('/listings?city=Hyderabad')).data.listings.length >= 10, 'the demo catalogue is preserved');
  // Operators: provisioned only by the server-side admin path, and scoped to their world.
  await store.accounts.setOperator('other@example.com', true);
  assert.equal((await other.call('/reviews')).data.bookings.length, 0, 'the account operator does not see demo claims');
  const mira = device();
  await mira.call('/session', { method: 'POST', body: { userId: 'mira' } });
  assert.equal((await mira.call(`/bookings/${booking.id}`)).status, 403, 'the demo operator cannot open real bookings');
}));

test('a write started under one account is refused after switching; receipts never cross accounts', async () => await app(async ({ device, store }) => {
  const phone = device();
  await phone.call('/session', { method: 'POST', body: { userId: 'teja' } });
  const key = randomUUID(), body = { listingId: 'drill-kit', ...dates(), agreed: true };
  // The original request committed, but its response was lost.
  const first = await phone.call('/bookings', { method: 'POST', key, body });
  assert.equal(first.status, 201);
  // The user switches profile before the client retries.
  await phone.call('/session', { method: 'POST', body: { userId: 'kabir' } });
  const retry = await phone.call('/bookings', { method: 'POST', key, body, as: 'teja' });
  assert.equal(retry.status, 409);
  assert.equal(retry.data.code, 'ACTOR_CHANGED');
  assert.equal((await store.db.prepare('SELECT COUNT(*) AS n FROM bookings').get()).n, 1, 'no second booking under the next profile');
  assert.equal((await phone.call(`/commands/${key}`)).status, 404, "another profile cannot see teja's receipt");
  await phone.call('/session', { method: 'POST', body: { userId: 'teja' } });
  const status = await phone.call(`/commands/${key}`);
  assert.equal(status.data.committed, true, 'reconciled once the original profile is back');
  const replay = await phone.call('/bookings', { method: 'POST', key, body });
  assert.equal(replay.data.booking.id, first.data.booking.id);
}));

test('operator-issued reset codes work once; password change ends other sessions; login is rate limited', async () => await app(async ({ device, store }) => {
  const user = device(), laptop = device(), op = device();
  await user.call('/auth/signup', { method: 'POST', body: { name: 'Forgetful', email: 'forget@example.com', password: 'first password 1' } });
  await laptop.call('/auth/login', { method: 'POST', body: { email: 'forget@example.com', password: 'first password 1' } });
  await op.call('/auth/signup', { method: 'POST', body: { name: 'Support Op', email: 'op@example.com', password: 'operator password' } });
  assert.equal((await op.call('/admin/password-resets', { method: 'POST', body: { email: 'forget@example.com' } })).status, 403, 'members cannot issue resets');
  await store.accounts.setOperator('op@example.com', true);
  const issued = await op.call('/admin/password-resets', { method: 'POST', body: { email: 'forget@example.com' } });
  assert.equal(issued.status, 201);
  const anon = device();
  assert.equal((await anon.call('/auth/reset', { method: 'POST', body: { email: 'forget@example.com', code: '00000000', password: 'brand new password' } })).status, 400);
  assert.equal((await anon.call('/auth/reset', { method: 'POST', body: { email: 'forget@example.com', code: issued.data.code, password: 'brand new password' } })).status, 200);
  assert.equal((await anon.call('/auth/reset', { method: 'POST', body: { email: 'forget@example.com', code: issued.data.code, password: 'another new password' } })).status, 400, 'codes are single use');
  assert.equal((await laptop.call('/bookings')).status, 401, 'a reset ends existing sessions');
  assert.equal((await anon.call('/auth/login', { method: 'POST', body: { email: 'forget@example.com', password: 'brand new password' } })).status, 200);
  assert.equal((await anon.call('/auth/password', { method: 'POST', body: { current: 'brand new password', next: 'final password 123' } })).status, 200);
  const attacker = device();
  const statuses = [];
  for (let i = 0; i < 12; i++) statuses.push((await attacker.call('/auth/login', { method: 'POST', body: { email: 'forget@example.com', password: `guess number ${i}` } })).status);
  assert.ok(statuses.includes(429), `login attempts are rate limited (${statuses.join(',')})`);
}));

test('no model calls without LLM_URL, even when other provider settings exist', async () => {
  const saved = { key: process.env.LLM_API_KEY, model: process.env.LLM_MODEL, fetch: globalThis.fetch };
  process.env.LLM_API_KEY = 'sk-test-should-never-be-used'; process.env.LLM_MODEL = 'any-model';
  let called = 0;
  globalThis.fetch = async () => { called++; throw new Error('network must not be used'); };
  const { Store } = await import('../lib/store.mjs');
  const store = new Store(':memory:');
  try {
    await store.ready;
    const result = await assist(store, 'teja', { query: 'I need to clean my flat before moving out', city: 'Hyderabad' });
    assert.equal(result.mode, 'local');
    assert.equal(called, 0, 'no provider request was made');
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.key === undefined) delete process.env.LLM_API_KEY; else process.env.LLM_API_KEY = saved.key;
    if (saved.model === undefined) delete process.env.LLM_MODEL; else process.env.LLM_MODEL = saved.model;
    await store.close();
  }
});
