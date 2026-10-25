// Operator case brief. Code gathers every recorded fact of a booking's case into numbered lines
// (F1, F2, ...). A model, if LLM_URL is set, only condenses them: each brief line must cite fact
// ids, every number must already appear in the facts, and verdict words are refused, so the brief
// helps the operator read faster without deciding anything. Model off or unsafe: a brief built by
// code from the same facts. The operator still records the decision and its written reason.
import { createHash } from 'node:crypto';
import { ask, numbersOf } from './llm.mjs';
import { fail } from './errors.mjs';

const ist = iso => (iso ? new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date(iso)) : '');
const clip = (value, max = 400) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const plain = value => (Array.isArray(value) ? value.join(', ') : typeof value === 'object' && value ? JSON.stringify(value) : String(value ?? ''));
// Words that judge or decide. A brief describes; the operator decides.
export const VERDICT = /\b(?:should|must|ought|deserves?|fair(?:ly)?|unfair|recommend\w*|liable|liability|at fault|fault|guilty|blame\w*|innocent|lying|lied|obviously|clearly)\b/i;

export async function caseFacts(store, b, viewerId) {
  const host = b.listing.ownerName, renter = b.renter.name;
  const who = id => (id === b.listing.ownerId ? `the host (${host})` : id === b.renter.id ? `the renter (${renter})` : 'an operator');
  const facts = [];
  const add = (kind, text) => facts.push({ id: `F${facts.length + 1}`, kind, text: clip(text) });
  add('booking', `${b.listing.title}, rented by ${renter} from ${host}, ${ist(b.start)} to ${ist(b.end)} IST. Status: ${b.status.replace(/_/g, ' ')}. Deposit ₹${b.quote?.deposit ?? 0}.`);
  if (b.note) add('booking', `Renter's request note: ${b.note}`);
  for (const t of b.trace.slice(-12)) add('timeline', `${ist(t.at)}: ${t.title}. ${t.detail}`);
  for (const e of b.evidence) add('condition', `${e.stage} condition record, ${ist(e.createdAt)}, ${e.image ? 'with photo' : 'no photo'}: ${e.note || 'no note written'}`);
  for (const r of await store.handover.revisions(b.id)) {
    const c = r.terms?.checklist || {};
    const details = [
      r.terms?.declaredConditions?.length && `host declared: ${r.terms.declaredConditions.join('; ')}`,
      c.condition && `condition "${c.condition}"`,
      c.existingDefects && `existing defects "${c.existingDefects}"`,
      Array.isArray(c.accessories) && c.accessories.length && `accessories: ${c.accessories.map(a => `${a.name}${a.present === false ? ' (missing)' : ''}`).join(', ')}`,
      c.functionCheck && c.functionCheck !== 'not_checked' && `function check: ${plain(c.functionCheck)}`,
      Array.isArray(c.items) && c.items.length && `stored items: ${c.items.map(i => `${i.quantity} × ${i.description}`).join(', ')}`,
      c.vehicleRegistration && `vehicle ${c.vehicleRegistration}`
    ].filter(Boolean).join('; ');
    const d = r.disagreement;
    add('agreement', `Agreement revision ${r.revision}, proposed by the ${r.proposedRole}${r.note ? ` ("${r.note}")` : ''}. ${details || 'No checklist details.'}. Host ${r.acceptances.host ? 'accepted' : 'has not accepted'}; renter ${r.acceptances.renter ? 'accepted' : 'has not accepted'}.${d ? ` The ${d.role} flagged a mismatch: ${d.note}` : ''}`);
  }
  const claim = b.claim;
  if (claim) {
    add('claim', `Host reported ${String(claim.issue).replace(/_/g, ' ')} on ${ist(claim.openedAt)} and proposes deducting ₹${claim.amount} of the ₹${b.quote?.deposit ?? 0} deposit. Host's note: ${claim.reason}`);
    if (claim.response) add('claim', `Renter ${claim.response.accepted ? 'accepted' : 'disputed'} the claim on ${ist(claim.response.at)}: ${claim.response.note}`);
    else add('claim', 'The renter has not responded to the claim yet.');
    if (claim.decision) add('claim', `Operator ${claim.decision.operator} decided a deduction of ₹${claim.decision.amount} on ${ist(claim.decision.at)}: ${claim.decision.note}`);
  }
  if (b.extension) add('extension', `Extension ${b.extension.status}${b.extension.end ? `, requested until ${ist(b.extension.end)} IST` : ''}${b.extension.additionalRental ? `, extra rental ₹${b.extension.additionalRental}` : ''}.`);
  for (const r of (await store.metadata(b.id)).details.noShowReports || []) add('no-show', `No-show (${String(r.kind || '').replace(/_/g, ' ')}) reported by ${who(r.reportedBy)} on ${ist(r.at)}, status ${String(r.status || '').replace(/_/g, ' ')}${r.note ? `: ${r.note}` : ''}.`);
  for (const ref of b.recovery?.incidents || []) {
    const i = await store.recovery.get(ref.id, viewerId);
    add('incident', `Recovery case: ${i.type.replace(/_/g, ' ')} reported by ${who(i.reporterId)} on ${ist(i.createdAt)}, status ${i.status}. ${i.description}${i.lastKnown ? ` Last known: ${i.lastKnown}` : ''}`);
    for (const e of i.entries.slice(-8)) add('incident', `Case note by ${who(e.actorId)}, ${ist(e.createdAt)} (${e.kind.replace(/_/g, ' ')})${e.image ? ', with photo' : ''}: ${e.note}`);
  }
  return facts;
}

const LINE = { type: 'object', additionalProperties: false, required: ['text', 'refs'], properties: { text: { type: 'string' }, refs: { type: 'array', maxItems: 4, items: { type: 'string' } } } };
const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['happened', 'hostSays', 'renterSays', 'evidence', 'missing', 'decision'],
  properties: {
    happened: { type: 'array', maxItems: 3, items: LINE }, hostSays: LINE, renterSays: LINE,
    evidence: { type: 'array', maxItems: 3, items: LINE }, missing: { type: 'array', maxItems: 2, items: LINE }, decision: LINE
  }
};
const SYSTEM = `You summarise a rental dispute case for an independent reviewer on a neighbourhood rental app in India. You get numbered facts (F1, F2, ...). Use only those facts.
Write very short, plain, neutral sentences (under 20 words each). Put fact ids only in "refs", never in "text".
- happened: up to 3 lines, in time order, about the item, the handover, the return and the reported problem. Skip routine steps such as dates checked, request sent or host confirmed.
- hostSays: the host's claim or position about the problem (claim, condition notes or case notes), in one line.
- renterSays: the renter's response or position about the problem, in one line. If there is none, text is "Nothing recorded." and refs is [].
- evidence: up to 3 lines on recorded condition notes, photos, accepted checklists or case notes.
- missing: up to 2 lines on evidence or responses that the facts show are absent.
- decision: one line on what is waiting for the reviewer.
Never judge who is right, never suggest an outcome or amount, never use words like should, fair, fault, liable or recommend. Copy amounts and dates exactly as written in the facts.`;

// Model output, checked line by line. null if anything is unsafe; the caller then uses the code brief.
function checked(r, facts) {
  if (!r) return null;
  const ids = new Set(facts.map(f => f.id)), allowed = new Set(numbersOf(facts.map(f => f.text).join(' ')));
  const line = l => {
    // Small models sometimes echo "refs [F1]" into the text or return an empty id; tidy both.
    const text = clip(String(l?.text ?? '').replace(/\s*\(?\brefs?\b\s*:?\s*\[[^\]]*\]\)?\s*\.?\s*$/i, ''), 240);
    const refs = [...new Set((Array.isArray(l?.refs) ? l.refs : []).map(id => String(id).trim()).filter(Boolean))];
    if (text.length < 3 || VERDICT.test(text) || refs.some(id => !ids.has(id)) || !numbersOf(text).every(n => allowed.has(n))) throw new Error('unsafe line');
    return { text, refs };
  };
  try {
    const list = v => (Array.isArray(v) ? v : []).map(line);
    const brief = { happened: list(r.happened), hostSays: line(r.hostSays), renterSays: line(r.renterSays), evidence: list(r.evidence), missing: list(r.missing), decision: line(r.decision) };
    return brief.decision.text ? brief : null;
  } catch {
    return null;
  }
}

// Brief built by code from the same facts: latest timeline, both positions, recorded evidence.
export function factsBrief(facts, b) {
  const of = kind => facts.filter(f => f.kind === kind);
  // First sentence (after any "date: " lead-in), so the plain brief stays short.
  const short = text => { const m = text.match(/^(.{20,}?[.!?])(?:\s|$)/); return clip(m ? m[1] : text, 160) };
  const ref = f => ({ text: short(f.text), refs: [f.id] });
  const claims = of('claim'), condition = of('condition');
  const stages = new Set((b.evidence || []).map(e => e.stage));
  // Each side's position: their claim or claim response, else their latest recovery-case note.
  const noteBy = role => of('incident').filter(f => f.text.includes(`by the ${role} (`)).at(-1);
  const say = f => (f ? { text: clip(f.text, 220), refs: [f.id] } : { text: 'Nothing recorded.', refs: [] });
  return {
    happened: [of('booking')[0], ...of('timeline').filter(f => !/Dates checked|Request sent|Host confirmed/.test(f.text)).slice(-3)].filter(Boolean).map(ref),
    hostSays: say(claims[0] || noteBy('host')),
    renterSays: say(claims[1] && !/has not responded/.test(claims[1].text) ? claims[1] : noteBy('renter')),
    evidence: [...condition, ...of('incident').slice(-1)].slice(0, 3).map(ref),
    missing: [
      !stages.has('Collection') && { text: 'No collection condition record.', refs: [] },
      !stages.has('Return') && { text: 'No return condition record.', refs: [] },
      claims[1] && /has not responded/.test(claims[1].text) && ref(claims[1])
    ].filter(Boolean),
    decision: b.claim && !b.claim.decision
      ? { text: `Proposed deduction of ₹${b.claim.amount} from a ₹${b.quote?.deposit ?? 0} deposit awaits review.`, refs: [claims[0].id] }
      : of('incident')[0] ? { text: 'Open recovery case awaits the next step.', refs: [of('incident')[0].id] } : { text: 'Nothing is waiting for a decision.', refs: [] }
  };
}

// ponytail: in-memory cache keyed by a hash of the facts; rebuilt when anything new is recorded or after a restart.
const cache = new Map();
export async function caseBrief(store, bookingId, userId, { ai = false } = {}) {
  const b = await store.booking(bookingId, userId);
  fail(!b.canReview || b.isHost || b.isRenter, 'Case briefs are for the independent reviewer.', 403);
  const facts = await caseFacts(store, b, userId);
  const plain = { bookingId, source: 'facts', brief: factsBrief(facts, b), facts, generatedAt: new Date().toISOString() };
  if (!ai) return plain;
  const key = createHash('sha256').update(JSON.stringify(facts)).digest('hex');
  const hit = cache.get(bookingId);
  if (hit?.key === key) return hit.value;
  const prompt = facts.map(f => `${f.id} [${f.kind}] ${clip(f.text, 260)}`).join('\n');
  const model = checked(await ask({ system: SYSTEM, prompt, schema: SCHEMA, maxTokens: 600, timeoutMs: Number(process.env.BRIEF_TIMEOUT_MS) || 90_000 }), facts);
  // A section the model left empty is filled from the code brief rather than dropping the whole summary.
  const merged = model && Object.fromEntries(Object.entries(model).map(([k, v]) => [k, Array.isArray(v) && !v.length && k !== 'missing' ? plain.brief[k] : v]));
  const value = model ? { ...plain, source: 'model', brief: merged } : plain;
  if (model) { if (cache.size > 500) cache.clear(); cache.set(bookingId, { key, value }) }
  return value;
}
