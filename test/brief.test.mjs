// Operator case brief: facts from code, checked model condensation, code fallback, reviewer only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.mjs';
import { caseBrief } from '../lib/brief.mjs';

async function withCase(reply, callback) {
  const saved = { url: process.env.LLM_URL, fetch: globalThis.fetch };
  const calls = [];
  if (reply) {
    process.env.LLM_URL = 'http://llm.test';
    globalThis.fetch = async (url, init) => {
      calls.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(reply(calls.at(-1))) } }] }) };
    };
  } else delete process.env.LLM_URL;
  const store = new Store(':memory:');
  try {
    await store.ready;
    const b = await store.createScenario('damage');
    await callback(store, b, calls);
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.url === undefined) delete process.env.LLM_URL; else process.env.LLM_URL = saved.url;
    await store.close();
  }
}
const line = (text, refs = ['F1']) => ({ text, refs });

test('without a model the brief is built from the recorded facts, for the reviewer only', async () => withCase(null, async (store, b) => {
  const r = await caseBrief(store, b.id, 'mira');
  assert.equal(r.source, 'facts');
  assert.ok(r.facts.some(f => f.kind === 'claim'), 'the claim is in the facts');
  assert.ok(r.facts.some(f => f.kind === 'condition'), 'condition records are in the facts');
  assert.match(r.brief.decision.text, /Proposed deduction of ₹\d+ from a ₹\d+ deposit awaits review/);
  for (const line of [...r.brief.happened, ...r.brief.evidence]) assert.ok(line.refs.every(id => r.facts.some(f => f.id === id)));
  await assert.rejects(() => caseBrief(store, b.id, b.renter.id), /independent reviewer/);
  await assert.rejects(() => caseBrief(store, b.id, b.listing.ownerId), /independent reviewer/);
}));

test('a safe model brief is used; verdicts, invented numbers or unknown refs fall back to facts', async () => {
  const good = () => ({ happened: [line('The item was rented and returned.')], hostSays: line('Host reports damage.'), renterSays: line('Nothing recorded.', []), evidence: [line('Condition notes at both handovers.')], missing: [], decision: line('A proposed deduction awaits review.') });
  await withCase(good, async (store, b, calls) => {
    const r = await caseBrief(store, b.id, 'mira', { ai: true });
    assert.equal(r.source, 'model');
    assert.equal(r.brief.hostSays.text, 'Host reports damage.');
    await caseBrief(store, b.id, 'mira', { ai: true });
    assert.equal(calls.length, 1, 'an unchanged case is not sent to the model again');
  });
  // Real gemma3:4b output echoed "refs [..]" into the text and returned an empty id: tidied, not rejected.
  await withCase(() => ({ ...good(), hostSays: line('Host reports a missing charger. refs [F1]'), renterSays: line('Nothing recorded. refs [ ]', ['']) }), async (store, b) => {
    const r = await caseBrief(store, b.id, 'mira', { ai: true });
    assert.equal(r.source, 'model');
    assert.equal(r.brief.hostSays.text, 'Host reports a missing charger.');
    assert.deepEqual(r.brief.renterSays, { text: 'Nothing recorded.', refs: [] });
  });
  for (const bad of [
    { ...good(), decision: line('The renter should pay the full amount.') },
    { ...good(), hostSays: line('Host wants ₹987654 for repairs.') },
    { ...good(), happened: [line('The item was rented.', ['F999'])] }
  ]) await withCase(() => bad, async (store, b) => assert.equal((await caseBrief(store, b.id, 'mira', { ai: true })).source, 'facts'));
});

test('demo scenarios for the brief put both sides on record', async () => {
  const store = new Store(':memory:');
  try {
    await store.ready;
    const dispute = await caseBrief(store, (await store.createScenario('dispute')).id, 'mira');
    assert.match(dispute.brief.hostSays.text, /₹800/);
    assert.match(dispute.brief.renterSays.text, /disputed/);
    const missing = await store.createScenario('missing');
    assert.equal(missing.recovery.open, 1, 'a recovery case is open');
    const brief = await caseBrief(store, missing.id, 'mira');
    assert.match(brief.brief.hostSays.text, /by the host/);
    assert.match(brief.brief.renterSays.text, /by the renter/);
  } finally {
    await store.close();
  }
});
