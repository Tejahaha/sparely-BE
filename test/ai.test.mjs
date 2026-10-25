// AI helpers with a stubbed model: each feature uses checked model output, and falls back
// to its non-AI path when the model is off, fails, or returns something unsafe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.mjs';
import { assist, understand } from '../lib/assistant.mjs';
import { ask, numbersOf } from '../lib/llm.mjs';
import { reminderText, reminderTemplate, sendReminders } from '../lib/reminders.mjs';

// Stub the model: `reply(request)` returns the object the model "answers", or throws to fail.
async function withModel(reply, callback) {
  const saved = { url: process.env.LLM_URL, fetch: globalThis.fetch };
  const calls = [];
  process.env.LLM_URL = 'http://llm.test';
  globalThis.fetch = async (url, init) => {
    const request = JSON.parse(init.body);
    calls.push({ url: String(url), request });
    const answer = reply(request);
    return { ok: true, json: async () => ({ choices: [{ message: { content: typeof answer === 'string' ? answer : JSON.stringify(answer) } }] }) };
  };
  const store = new Store(':memory:');
  try {
    await store.ready;
    await callback(store, calls);
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.url === undefined) delete process.env.LLM_URL; else process.env.LLM_URL = saved.url;
    await store.close();
  }
}
const day = offset => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(Date.now() + offset * 86400_000);

test('numbersOf reads Indian digits and thousands separators', () => {
  assert.deepEqual(numbersOf('₹2,000 on १२ Dec, ౧౦:00'), [0, 10, 12, 2000]);
});

test('Vercel never calls a private HTTP model URL or unauthenticated HTTPS model', async () => {
  const saved = { vercel: process.env.VERCEL, url: process.env.LLM_URL, key: process.env.LLM_API_KEY, fetch: globalThis.fetch };
  let called = false;
  try {
    process.env.VERCEL = '1';
    globalThis.fetch = async () => { called = true; throw new Error('unexpected model call'); };
    process.env.LLM_URL = 'http://192.168.1.8:11434';
    process.env.LLM_API_KEY = 'test-token';
    assert.equal(await ask({ system: 'test', prompt: 'test', schema: { type: 'object' } }), null);
    process.env.LLM_URL = 'https://model.example';
    delete process.env.LLM_API_KEY;
    assert.equal(await ask({ system: 'test', prompt: 'test', schema: { type: 'object' } }), null);
    assert.equal(called, false);
  } finally {
    for (const [name, value] of Object.entries({ VERCEL: saved.vercel, LLM_URL: saved.url, LLM_API_KEY: saved.key })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    globalThis.fetch = saved.fetch;
  }
});

test('search uses the model reading of a mixed-language request, with checked dates', async () => await withModel(() => ({
  categories: ['storage', 'made-up'], keywords: [], items: [{ name: 'boxes', count: 6 }, { name: 'cycle', count: 0 }],
  area: 'Madhapur', startDate: day(3), endDate: '', durationDays: 60, budget: 0
}), async (store, calls) => {
  const result = await assist(store, 'teja', { query: '6 boxes aur ek cycle rakhna hai Madhapur mein 2 mahine ke liye' });
  assert.equal(result.mode, 'model');
  assert.equal(calls[0].url, 'http://llm.test/v1/chat/completions');
  assert.deepEqual(result.understood.categories, ['storage'], 'unknown categories are dropped');
  assert.deepEqual(result.understood.items, [{ name: 'boxes', count: 6 }, { name: 'cycle', count: 1 }]);
  assert.equal(result.understood.area, 'Madhapur');
  assert.ok(result.dates, 'start + duration gives real dates');
  assert.equal(Math.round((Date.parse(result.dates.end) - Date.parse(result.dates.start)) / 86400_000), 60);
  assert.ok(result.suggestions.every(s => s.listing.category === 'storage'));
}));

test('search ignores past dates and falls back to keyword rules when the model fails', async () => {
  await withModel(() => ({ categories: ['tools'], keywords: ['sewing'], items: [], area: '', startDate: day(-5), endDate: day(-2), durationDays: 0, budget: 1500 }), async store => {
    const result = await assist(store, 'teja', { query: 'need to hem curtains, budget 1500' });
    assert.equal(result.dates, null, 'dates in the past are not used');
    assert.deepEqual(result.suggestions.map(s => s.listing.id), ['sewing-machine']);
    assert.equal(result.budget, 1500);
  });
  await withModel(() => 'not json at all', async store => {
    const result = await assist(store, 'teja', { query: 'I want to hem my curtains this weekend' });
    assert.equal(result.mode, 'local');
    assert.match(result.warning, /offline/);
    assert.deepEqual(result.suggestions.map(s => s.listing.id), ['sewing-machine']);
  });
});

test('reminder wording from the model is used only when it is safe and keeps the due date', async () => {
  const facts = { name: 'Teja', item: 'Storage nook', due: '12 Dec, 10:00 am', dueDay: 12, stage: 1, storage: true };
  await withModel(() => ({ message: 'Hi Teja, your things were due to be collected on 12 Dec, 10:00 am. Please speak to the host or request more time on the booking.' }), async () => {
    assert.match(await reminderText(facts), /speak to the host/);
  });
  for (const bad of ['Hi Teja, pay ₹500 fine now for 12 Dec.', 'Hi Teja, please return it by 14 Dec.', 'Hi Teja, please return it soon or we call the police.']) {
    await withModel(() => ({ message: bad }), async () => {
      assert.equal(await reminderText(facts), reminderTemplate(facts), bad);
    });
  }
});

test('overdue rentals get one reminder per stage, also without a model', async () => {
  const store = new Store(':memory:');
  try {
    await store.ready;
    const b = await store.createScenario('overdue');
    assert.equal(await sendReminders(store), 1);
    assert.equal(await sendReminders(store), 0, 'the same stage is never sent twice');
    const inbox = await store.messages.inbox(b.renter.id);
    const reminder = inbox.items.find(n => n.kind === 'return_reminder');
    assert.ok(reminder, JSON.stringify(inbox.items.map(n => n.kind)));
    assert.match(reminder.body, /collect your things/);
  } finally {
    await store.close();
  }
});

test('explicit weekdays and their durations use calendar arithmetic even if the model is wrong', async () => {
  await withModel(() => ({ categories: ['storage'], keywords: [], items: [], area: '', startDate: '2026-10-30', endDate: '2026-12-25', durationDays: 60, budget: 0 }), async () => {
    const result = await understand('Store boxes for 2 months from next Monday', Date.parse('2026-10-25T08:00:00Z'));
    assert.equal(result.start, '2026-10-26T04:30:00.000Z');
    assert.equal(result.end, '2026-12-25T04:30:00.000Z');
    const monday = await understand('Store boxes from next Monday for 60 days', Date.parse('2026-10-26T08:00:00Z'));
    assert.equal(monday.start, '2026-11-02T04:30:00.000Z');
  });
});

test('impossible model calendar dates are ignored', async () => {
  await withModel(() => ({ categories: ['storage'], keywords: [], items: [], area: '', startDate: '2027-02-30', endDate: '2027-03-05', durationDays: 0, budget: 0 }), async () => {
    const result = await understand('Store boxes from February 30', Date.parse('2026-10-25T08:00:00Z'));
    assert.equal(result.start, null);
    assert.equal(result.end, null);
  });
});

test('a stated duration wins over an inconsistent model end date', async () => {
  await withModel(() => ({ categories: ['parking'], keywords: [], items: [], area: '', startDate: '2026-10-26', endDate: '2026-11-01', durationDays: 7, budget: 0 }), async () => {
    const result = await understand('kal se ek hafte ke liye bike parking', Date.parse('2026-10-25T08:00:00Z'));
    assert.equal(result.end, '2026-11-02T04:30:00.000Z');
  });
});

test('reminder date placeholders are inserted by code and altered dates or fees fall back', async () => {
  const facts = { name: 'Teja', item: 'Drill', due: '12 Dec, 10:00 am', dueDay: 12, stage: 1, storage: false };
  await withModel(() => ({ message: 'Hi Teja, the drill was due on {{due}}. Please contact the host or request an extension.' }), async () => {
    assert.match(await reminderText(facts), /12 Dec, 10:00 am IST/);
  });
  await withModel(() => ({ message: 'Please contact the host to arrange the return, or request an extension on the booking.' }), async () => {
    assert.equal(await reminderText(facts), 'Please contact the host to arrange the return, or request an extension on the booking.\nWas due: 12 Dec, 10:00 am IST.');
  });
  for (const message of [
    'Hi Teja, the drill was due on 12 Jan, 10:00 am. Please contact the host.',
    'Hi Teja, the drill was due on 12 Dec, 10:12 am. Please contact the host.',
    'Hi Teja, pay a fee for the drill due on {{due}}. Please contact the host.',
    'Hi Teja, the drill was due on {{due}} and {{due}}. Please contact the host.'
  ]) await withModel(() => ({ message }), async () => assert.equal(await reminderText(facts), reminderTemplate(facts)));
});

test('search uses what the model read: storage size, named area', async () => {
  const reading = over => ({ categories: ['storage'], keywords: [], items: [], area: '', startDate: '', endDate: '', durationDays: 0, budget: 0, ...over });
  await withModel(() => reading({ items: [{ name: 'boxes', count: 6 }] }), async store => {
    const r = await assist(store, 'teja', { query: 'keep 6 boxes somewhere' });
    assert.equal(r.storageNeedSqft, 9);
    assert.match(r.suggestions[0].reason, /Room for the ~9 sq ft/);
    assert.ok(!r.questions.some(q => /room for about/.test(q)));
  });
  await withModel(() => reading({ categories: ['storage', 'parking'], items: [{ name: 'boxes', count: 20 }, { name: 'cycle', count: 1 }] }), async store => {
    const r = await assist(store, 'teja', { query: 'keep 20 boxes and a cycle' });
    assert.deepEqual(r.understood.categories, ['storage'], 'a cycle to keep is storage, not parking');
    assert.match(r.suggestions[0].reason, /^A storage option/, 'reason text is intact');
    assert.equal(r.storageNeedSqft, 42);
    assert.match(r.suggestions[0].reason, /Smaller than the ~42 sq ft/);
    assert.ok(r.questions.some(q => /room for about 42 sq ft/.test(q)));
  });
  await withModel(() => reading({ categories: ['creator'], area: 'Kondapur' }), async store => {
    const r = await assist(store, 'teja', { query: 'creator gear near Kondapur' });
    assert.equal(r.suggestions[0].listing.id, 'podcast-mics');
    assert.match(r.suggestions[0].reason, /In Kondapur, the area you named/);
  });
});
