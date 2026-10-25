import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../lib/store.mjs';
import {sendAppointmentReminders} from '../lib/appointment-reminders.mjs';

const minute = 60_000;
async function fixture(work) {
  const store = new Store(':memory:');
  try { await store.ready; await work(store); } finally { await store.close(); }
}
async function appointment(store, kind = 'call', start = Date.now() + 30 * minute) {
  const conversation = await store.messages.openEnquiry('drill-kit', 'teja');
  const proposed = await store.messages.propose(conversation.id, 'teja', {kind, startsAt: new Date(start).toISOString()});
  return {id: proposed.id, conversationId: conversation.id};
}

test('confirmed calls remind both participants at 15 minutes and at start, once across concurrent runs', async () => fixture(async store => {
  const now = Date.now(), a = await appointment(store, 'call', now + 30 * minute);
  assert.equal(await sendAppointmentReminders(store, now + 15 * minute), 0, 'unconfirmed times never remind');
  await store.messages.respond(a.id, 'aanya', {action: 'confirm', expectedVersion: 1});
  assert.equal(await sendAppointmentReminders(store, now + 14 * minute), 0);
  const runs = await Promise.all([sendAppointmentReminders(store, now + 15 * minute), sendAppointmentReminders(store, now + 15 * minute)]);
  assert.equal(runs.reduce((a,b) => a+b), 2);
  assert.equal(await sendAppointmentReminders(store, now + 30 * minute), 2);
  assert.equal(await sendAppointmentReminders(store, now + 31 * minute), 0);
  const rows = await store.db.query("SELECT * FROM notices WHERE kind='appointment_reminder'");
  assert.equal(rows.length, 4);
  assert.ok(rows.filter(r => r.dedupe_key.endsWith(':soon')).every(r => r.read_at), 'start reminder retires the earlier one');
  for (const who of ['teja','aanya']) {
    const inbox = await store.messages.inbox(who);
    const reminders = inbox.items.filter(n => n.kind === 'appointment_reminder' && !n.readAt);
    assert.equal(reminders.length, 1);
    assert.equal(reminders[0].link, `conversation/${a.conversationId}`);
    assert.match(reminders[0].body, /Sparely does not place the call/);
  }
  assert.equal((await store.messages.inbox('kabir')).items.length, 0);
}));

test('cancelled and replaced viewing reminders are retired and no late reminder is generated', async () => fixture(async store => {
  const now = Date.now(), a = await appointment(store, 'viewing', now + 30 * minute);
  await store.messages.respond(a.id, 'aanya', {action: 'confirm', expectedVersion: 1});
  assert.equal(await sendAppointmentReminders(store, now + 15 * minute), 2);
  const b = await store.messages.propose(a.conversationId, 'teja', {kind:'viewing', startsAt:new Date(now + 60 * minute).toISOString(), supersedes:a.id, expectedVersion:2});
  assert.ok((await store.db.query("SELECT read_at FROM notices WHERE kind='appointment_reminder'")).every(n => n.read_at));
  assert.equal(await sendAppointmentReminders(store, now + 30 * minute), 0);
  await store.messages.respond(b.id, 'aanya', {action:'confirm', expectedVersion:1});
  assert.equal(await sendAppointmentReminders(store, now + 45 * minute), 2);
  await store.messages.respond(b.id, 'teja', {action:'cancel', expectedVersion:2});
  assert.equal(await sendAppointmentReminders(store, now + 60 * minute), 0);
  assert.ok((await store.db.query("SELECT read_at FROM notices WHERE kind='appointment_reminder'")).every(n => n.read_at));
}));

test('worker catches up recent appointments but does not flood people with long-past reminders', async () => fixture(async store => {
  const now = Date.now(), a = await appointment(store, 'viewing', now + 30 * minute);
  await store.messages.respond(a.id, 'aanya', {action:'confirm', expectedVersion:1});
  assert.equal(await sendAppointmentReminders(store, now + 46 * minute), 0);
  assert.equal(await sendAppointmentReminders(store, now + 35 * minute), 2);
}));

test('failed appointment delivery is recorded as a failed worker run rather than success', async () => fixture(async store => {
  await store.db.exec('DROP TABLE appointments');
  await assert.rejects(() => store.ops.runWorker('local'));
  const run = await store.db.query('SELECT outcome FROM worker_runs ORDER BY started_at DESC LIMIT 1', [], 'get');
  assert.equal(run.outcome, 'error');
}));
