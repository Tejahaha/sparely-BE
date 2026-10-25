// M7: simulated settlement ledger derived from server-side agreements and decisions.
// Owned by the M7 work stream. sync(bookingId) is called after every booking/case change
// and must be idempotent (deterministic entry keys; one effect per event).
//
// SIMULATED ONLY: no payment provider, payout, deposit authorisation or insurance exists.
// Every entry is derived from stored state (booking status, stored quote, agreement snapshot,
// claim decision, details.cancellation from M6, operator settlement decisions); never from
// client input. Entries are append-only and keyed `${bookingId}:<event>` (UNIQUE), so replayed,
// duplicate or reordered syncs cannot post an effect twice. Parties: renter, host, held
// (the simulated platform-held pool for deposits and captured cancellation amounts).
import { randomUUID } from 'node:crypto';
import { AppError, fail } from './errors.mjs';

const parse = (text, fallback = {}) => { try { return JSON.parse(text) ?? fallback; } catch { return fallback; } };
const trim = (value, max = 1000) => String(value ?? '').trim().slice(0, max);
const whole = n => Number.isSafeInteger(n) && n >= 0;
const rupees = n => `₹${n}`;
const HOUR = 3600_000;
export const UNRESOLVED_REVIEW_HOURS = 72;
export const LIVE_MONEY = false;
export const SIMULATED_LABEL = 'Simulated — no real money';
const TERMINAL = ['cancelled', 'declined', 'expired'];
const COLLECTED = ['active', 'under_review', 'completed'];

export const ESCALATION = {
  owner: 'Sparely operator review desk (in-app). The independent operator who records a decision owns that decision and its reason.',
  responseTarget: `Unresolved settlements are due for operator review within ${UNRESOLVED_REVIEW_HOURS} hours of being flagged. This is a demo target, not a staffed service level.`,
  manualProcess: 'Renter and host arrange any contact or return themselves through the booking conversation. The operator reviews the agreement, evidence and timeline and records a written decision here.',
  limits: [
    'All amounts are simulated. No card, UPI, bank account, payout or deposit authorisation is connected and no real money moves.',
    'There is no staffed external support line, no payment-provider dispute process, no insurance and no recovery partner.',
    'If a party is unreachable the settlement stays unresolved and visible here; the software never invents an outcome.',
  ],
};

// Line = the logical item an entry belongs to; its latest entry is its current state.
const lineOf = key => key.replace(/:(pending:\d+|completed|void|closed|resolved)$/, '');

// Pure: summary, per-party balances and attention from stored entries.
export function summarise(entries, { now = Date.now(), claim = null, responseHours = 48 } = {}) {
  const balances = { renter: 0, host: 0, held: 0 };
  const sum = kind => entries.filter(e => e.kind === kind && e.state === 'completed').reduce((s, e) => s + e.amount, 0);
  for (const e of entries) if (e.state === 'completed' && e.fromParty && e.toParty) { balances[e.fromParty] -= e.amount; balances[e.toParty] += e.amount; }
  const latest = new Map();
  for (const e of entries) latest.set(lineOf(e.entryKey), e);
  const pending = [...latest.values()].filter(e => e.state === 'pending' && e.kind !== 'unresolved');
  const unresolved = [...latest.values()].find(e => e.kind === 'unresolved');
  const failed = entries.filter(e => e.state === 'failed');
  const disputed = [...latest.values()].find(e => e.state === 'disputed');
  const attention = unresolved ? { kind: 'unresolved', reason: unresolved.detail, since: unresolved.createdAt, deadline: new Date(Date.parse(unresolved.createdAt) + UNRESOLVED_REVIEW_HOURS * HOUR).toISOString() }
    : failed.length ? { kind: 'failed', reason: failed.at(-1).detail, since: failed.at(-1).createdAt, deadline: new Date(Date.parse(failed.at(-1).createdAt) + UNRESOLVED_REVIEW_HOURS * HOUR).toISOString() }
    : disputed ? { kind: 'disputed', reason: disputed.detail, since: disputed.createdAt, deadline: claim?.openedAt ? new Date(Date.parse(claim.openedAt) + responseHours * HOUR).toISOString() : null }
    : null;
  if (attention) attention.overdue = !!attention.deadline && Date.parse(attention.deadline) < now;
  return {
    balances,
    summary: {
      rentalCharged: sum('rental_charge') + sum('extension_charge'),
      extensionCharged: sum('extension_charge'),
      depositHeld: balances.held,
      depositReleased: sum('deposit_release'),
      deductions: sum('deduction'),
      refunds: sum('rental_refund'),
      hostCompensation: sum('host_compensation'),
      pending: pending.map(e => ({ kind: e.kind, amount: e.amount, label: e.label })),
    },
    attention,
  };
}

export class Settlement {
  constructor(store) { this.store = store; this.db = store.db; }

  async row(bookingId) {
    return await this.db.prepare('SELECT b.*,l.owner_id AS owner_id,l.title AS listing_title FROM bookings b JOIN listings l ON l.id=b.listing_id WHERE b.id=?').get(bookingId);
  }
  async entries(bookingId) {
    return await this.db.prepare('SELECT id,entry_key AS entryKey,seq,kind,state,amount,from_party AS fromParty,to_party AS toParty,reverses_key AS reversesKey,label,detail,source,created_at AS createdAt FROM settlement_entries WHERE booking_id=? ORDER BY seq').all(bookingId);
  }
  async decisions(bookingId) {
    return await this.db.prepare('SELECT d.id,d.kind,d.operator_id AS operatorId,u.name AS operatorName,d.rental_refund AS rentalRefund,d.deposit_refund AS depositRefund,d.host_compensation AS hostCompensation,d.reason,d.version_seen AS versionSeen,d.created_at AS createdAt FROM settlement_decisions d JOIN users u ON u.id=d.operator_id WHERE d.booking_id=? ORDER BY d.version_seen,d.created_at').all(bookingId);
  }

  // Desired entries for the booking's current state. Pure apart from its inputs.
  plan(b, details, existing, decisions) {
    const id = b.id, q = parse(b.quote), rental = q.rental, deposit = q.deposit ?? 0, out = [];
    const keys = new Set(existing.map(e => e.entryKey));
    const add = (suffix, kind, state, amount, from, to, label, detail, source = 'booking_state', reverses = null) => out.push({ key: `${id}:${suffix}`, kind, state, amount, from, to, label, detail, source, reverses });
    const unresolved = reason => add('unresolved', 'unresolved', 'pending', 0, null, null, 'Settlement unresolved: operator review needed', reason);
    const status = b.status, confirmedEver = !!b.pickup_code;
    const collected = COLLECTED.includes(status) || keys.has(`${id}:rental_charge:completed`);
    if (status === 'requested') return out; // nothing authorised while the host decides
    if (!whole(rental) || !whole(deposit)) {
      add('quote_failed', 'failure', 'failed', 0, null, null, 'Simulated charge could not be computed', 'The stored quote has no whole-rupee rental or deposit, so nothing was posted. An operator must review the booking.');
      return out;
    }
    const base = whole(details.agreement?.quote?.rental) && details.agreement.quote.rental <= rental ? details.agreement.quote.rental : rental;
    if (status === 'confirmed') {
      add(`rental_charge:pending:${rental}`, 'rental_charge', 'pending', rental, 'renter', 'host', 'Rental charge authorised', `Simulated: ${rupees(rental)} is charged when the host records collection.`);
      if (deposit) add(`deposit_hold:pending:${deposit}`, 'deposit_hold', 'pending', deposit, 'renter', 'held', 'Deposit hold authorised', `Simulated: ${rupees(deposit)} is held from collection until return.`);
      return out;
    }
    if (COLLECTED.includes(status)) {
      add('rental_charge:completed', 'rental_charge', 'completed', base, 'renter', 'host', 'Rental charged', `Simulated rental charge from the agreed quote (${rupees(base)}).`);
      const prior = existing.filter(e => e.kind === 'extension_charge' && e.state === 'completed').reduce((s, e) => s + e.amount, 0);
      if (rental - base - prior > 0) add(`extension_charge:${rental}`, 'extension_charge', 'completed', rental - base - prior, 'renter', 'host', 'Extension charged', `Approved extension: the rental quote is now ${rupees(rental)}.`, 'extension_approval');
      if (deposit) add('deposit_hold:completed', 'deposit_hold', 'completed', deposit, 'renter', 'held', 'Deposit held', `Simulated deposit of ${rupees(deposit)} held during the rental.`);
      const claim = details.claim;
      if (claim && (status === 'under_review' || claim.decision)) add('deposit_dispute', 'deposit_dispute', 'disputed', Math.min(whole(claim.amount) ? claim.amount : 0, deposit), null, null, 'Deposit held for condition review', `The host proposed a ${rupees(claim.amount)} deduction. Nothing moves until an independent operator decides.`, 'claim');
      if (status !== 'completed') return out;
      if (claim && !claim.decision) { unresolved('The rental closed with a condition claim but no recorded decision.'); return out; }
      const deduction = claim?.decision ? claim.decision.amount : 0;
      if (!whole(deduction) || deduction > deposit) {
        add('deduction_failed', 'failure', 'failed', 0, null, null, 'Deduction could not be applied', 'The recorded decision amount is not a whole-rupee amount within the deposit. Nothing was deducted or released.', 'claim_decision');
        return out;
      }
      if (claim) add('deposit_dispute:closed', 'deposit_dispute', 'completed', deduction, null, null, 'Condition review decided', `Operator ${claim.decision.operator}: ${trim(claim.decision.note, 300)}`, 'claim_decision');
      if (deduction) add('deduction', 'deduction', 'completed', deduction, 'held', 'host', 'Approved deduction', `Deducted from the deposit by operator decision: ${rupees(deduction)}.`, 'claim_decision');
      if (deposit - deduction) add('deposit_release', 'deposit_release', 'completed', deposit - deduction, 'held', 'renter', deduction ? 'Deposit remainder released' : 'Deposit released', `${rupees(deposit - deduction)} returned to the renter.`, claim ? 'claim_decision' : 'booking_state');
      return out;
    }
    if (!TERMINAL.includes(status)) { unresolved(`Unknown booking status "${status}".`); return out; }
    if (collected) { unresolved('The booking ended after collection without a settlement rule. Settle it manually; this demo will not guess.'); return out; }
    // Cancelled/declined/expired before collection: apply a recorded outcome or stay unresolved.
    const valid = o => o && whole(o.rentalRefund) && o.rentalRefund <= rental && whole(o.depositRefund) && o.depositRefund <= deposit && whole(o.hostCompensation)
      && o.hostCompensation === rental + deposit - o.rentalRefund - o.depositRefund && (confirmedEver || o.hostCompensation === 0);
    const cancellation = details.cancellation, decision = decisions.find(d => d.kind === 'settle');
    if (!confirmedEver && !(cancellation && cancellation.hostCompensation > 0) && !decision) return out; // nothing was ever authorised: full release, no charge
    const outcome = valid(cancellation) ? { ...cancellation, source: 'cancellation', why: `Cancellation outcome recorded by the ${cancellation.by || 'system'} (${cancellation.policyVersion || 'policy'}).` }
      : valid(decision) ? { ...decision, source: 'operator_decision', why: `Operator decision by ${decision.operatorName}: ${trim(decision.reason, 300)}` } : null;
    if (!outcome) {
      unresolved(cancellation ? 'The recorded cancellation outcome does not balance against the agreed rental and deposit (refunds + host compensation must equal the authorised total).' : `The booking was ${status} after the host confirmed, but no cancellation outcome was recorded.`);
      return out;
    }
    const latest = new Map();
    for (const e of existing) latest.set(lineOf(e.entryKey), e);
    for (const line of ['rental_charge', 'deposit_hold']) {
      const e = latest.get(`${id}:${line}`);
      if (e?.state === 'pending') add(`${line}:void`, 'reversal', 'completed', e.amount, null, null, 'Authorisation replaced by cancellation settlement', `Reverses "${e.label}"; the cancellation entries below settle it.`, outcome.source, e.entryKey);
    }
    if (rental + deposit) add('cancellation_capture', 'cancellation_capture', 'completed', rental + deposit, 'renter', 'held', 'Cancellation: authorised amounts captured', `${outcome.why} Rental ${rupees(rental)} and deposit ${rupees(deposit)} are captured, then refunded or paid out below.`, outcome.source);
    if (outcome.rentalRefund) add('rental_refund', 'rental_refund', 'completed', outcome.rentalRefund, 'held', 'renter', 'Rental refunded', `Cancellation refund of ${rupees(outcome.rentalRefund)}.`, outcome.source);
    if (outcome.depositRefund) add('deposit_release', 'deposit_release', 'completed', outcome.depositRefund, 'held', 'renter', 'Deposit released', `Deposit refund of ${rupees(outcome.depositRefund)}.`, outcome.source);
    if (outcome.hostCompensation) add('host_compensation', 'host_compensation', 'completed', outcome.hostCompensation, 'held', 'host', 'Host compensation', `Paid to the host under the cancellation outcome: ${rupees(outcome.hostCompensation)}.`, outcome.source);
    if (keys.has(`${id}:unresolved`)) add('unresolved:resolved', 'resolution', 'completed', 0, null, null, 'Unresolved settlement closed', outcome.why, outcome.source);
    return out;
  }

  async sync(bookingId) {
    return await this.store.transaction(async () => {
      const b = await this.row(bookingId);
      if (!b) return;
      const meta = await this.store.metadata(bookingId);
      const existing = await this.entries(bookingId);
      const plan = this.plan(b, meta.details, existing, await this.decisions(bookingId));
      const keys = new Set(existing.map(e => e.entryKey));
      let seq = existing.reduce((m, e) => Math.max(m, e.seq), 0);
      const at = new Date(await this.store.now(bookingId)).toISOString();
      for (const e of plan) {
        if (keys.has(e.key)) continue;
        const r = await this.db.prepare('INSERT OR IGNORE INTO settlement_entries(id,booking_id,entry_key,seq,kind,state,amount,from_party,to_party,reverses_key,label,detail,source,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(`entry-${randomUUID()}`, bookingId, e.key, seq + 1, e.kind, e.state, e.amount, e.from, e.to, e.reverses, e.label, e.detail, e.source, at);
        if (r.changes) { seq++; keys.add(e.key); }
      }
    });
  }

  async access(bookingId, userId) {
    const b = await this.row(bookingId);
    fail(!b, 'Booking not found.', 404);
    const isHost = b.owner_id === userId, isRenter = b.renter_id === userId;
    const operator = !isHost && !isRenter && (await this.store.user(userId)).role === 'Operator' && (await this.store.sameWorld(userId, b.renter_id));
    fail(!isHost && !isRenter && !operator, 'This booking belongs to another profile.', 403);
    return { b, role: isHost ? 'host' : isRenter ? 'renter' : 'operator' };
  }

  async view(bookingId, role) {
    const b = await this.row(bookingId), meta = await this.store.metadata(bookingId), q = parse(b.quote);
    const entries = await this.entries(bookingId), decisions = await this.decisions(bookingId);
    const { balances, summary, attention } = summarise(entries, { now: await this.store.now(bookingId), claim: meta.details.claim, responseHours: meta.policy.responseHours });
    const result = {
      bookingId, liveMoney: LIVE_MONEY, simulated: true, label: SIMULATED_LABEL, currency: 'INR',
      version: entries.length + decisions.length, status: b.status, viewerRole: role,
      quote: { rental: q.rental ?? null, deposit: q.deposit ?? 0 },
      collected: COLLECTED.includes(b.status) || entries.some(e => e.entryKey === `${bookingId}:rental_charge:completed`),
      entries, balances, summary, attention, decisions, escalation: ESCALATION,
    };
    if (role === 'operator') {
      const a = meta.details.agreement, names = await this.db.prepare('SELECT id,name FROM users WHERE id IN (?,?)').all(b.renter_id, b.owner_id);
      const name = id => names.find(u => u.id === id)?.name || id;
      result.review = {
        listingTitle: b.listing_title, renterName: name(b.renter_id), hostName: name(b.owner_id),
        agreement: a ? { version: a.version, capturedAt: a.capturedAt, listingTitle: a.listing?.title, start: a.start, end: a.end, quote: a.quote, policyVersion: a.policyVersion, conditionVerification: a.conditionVerification } : null,
        currentPeriod: { start: b.start, end: b.end },
        claim: meta.details.claim || null, cancellation: meta.details.cancellation || null,
        evidenceCount: (await this.db.prepare('SELECT COUNT(*) AS n FROM evidence WHERE booking_id=?').get(bookingId)).n,
        timeline: parse(b.trace, []),
        // ponytail: booking conversations stay private to the parties (M5 rule); operators see counts only.
      };
    }
    return result;
  }

  async ledger(bookingId, userId) {
    const { role } = await this.access(bookingId, userId);
    await this.sync(bookingId); // self-healing for bookings that predate the ledger
    return await this.view(bookingId, role);
  }

  async review(userId) {
    fail((await this.store.user(userId)).role !== 'Operator', 'Only operators can open settlement review.', 403);
    const world = await this.store.accounts.world(userId);
    // ponytail: scans candidate bookings on each request; add a settlement_attention table if volume grows.
    const rows = await this.db.prepare(`SELECT DISTINCT b.id,b.renter_id,l.owner_id FROM bookings b JOIN listings l ON l.id=b.listing_id
      WHERE b.status='under_review' OR (b.status IN ('cancelled','declined','expired') AND b.pickup_code IS NOT NULL)
        OR b.id IN (SELECT booking_id FROM settlement_entries WHERE kind='unresolved' OR state='failed')`).all();
    const items = [];
    for (const row of rows) {
      if (row.renter_id === userId || row.owner_id === userId || (await this.store.accounts.world(row.renter_id)) !== world) continue;
      await this.sync(row.id);
      const v = await this.view(row.id, 'operator');
      if (!v.attention) continue;
      items.push({ bookingId: row.id, status: v.status, attention: v.attention, version: v.version, quote: v.quote, listingTitle: v.review.listingTitle, renterName: v.review.renterName, hostName: v.review.hostName, evidenceCount: v.review.evidenceCount, period: v.review.currentPeriod });
    }
    items.sort((a, b) => String(a.attention.deadline || '9').localeCompare(String(b.attention.deadline || '9')));
    return { liveMoney: LIVE_MONEY, label: SIMULATED_LABEL, escalation: ESCALATION, items };
  }

  async decision(id) {
    const row = await this.db.prepare('SELECT booking_id FROM settlement_decisions WHERE id=?').get(id);
    fail(!row, 'Settlement decision not found.', 404);
    return (await this.decisions(row.booking_id)).find(d => d.id === id);
  }

  // Independent operator decision. kind 'settle' resolves an unresolved pre-collection
  // settlement with refunds (host compensation is derived so the total always balances);
  // kind 'note' records a written review note without moving any simulated money.
  async decide(userId, bookingId, input) {
    return await this.store.transaction(async () => {
      const { b, role } = await this.access(bookingId, userId);
      fail(role !== 'operator', 'An independent operator must record settlement decisions. Parties to the booking cannot.', 403);
      await this.sync(bookingId);
      const v = await this.view(bookingId, role);
      if (input.version !== v.version) throw new AppError('The settlement changed since you opened it. Reload before deciding.', 409, 'STALE_SETTLEMENT', { currentVersion: v.version });
      const kind = input.kind, reason = trim(input.reason);
      fail(!['settle', 'note'].includes(kind), 'Choose to settle the booking or record a review note.');
      fail(reason.length < 10, 'Write the reason for this decision in at least 10 characters.');
      let amounts = [null, null, null], key = `${bookingId}:note:${v.version}`;
      if (kind === 'settle') {
        if (v.attention?.kind !== 'unresolved') throw new AppError('Only an unresolved settlement can be settled by decision.', 409, 'NOT_UNRESOLVED');
        if (v.collected || !TERMINAL.includes(b.status)) throw new AppError('This rental was collected or is still running. This demo settles only bookings that ended before collection; record a note and handle it manually.', 409, 'UNSUPPORTED_SETTLEMENT');
        const rental = v.quote.rental, deposit = v.quote.deposit, rr = Number(input.rentalRefund), dr = Number(input.depositRefund);
        fail(!whole(rr) || rr > rental, `The rental refund must be a whole-rupee amount between ₹0 and ₹${rental}.`);
        fail(!whole(dr) || dr > deposit, `The deposit refund must be a whole-rupee amount between ₹0 and ₹${deposit}.`);
        fail(!b.pickup_code && rr + dr !== rental + deposit, 'Nothing was authorised for this booking, so it can only be settled with full refunds.');
        amounts = [rr, dr, rental + deposit - rr - dr];
        key = `${bookingId}:settle`;
      }
      const id = `settlement-decision-${randomUUID()}`, at = new Date(await this.store.now(bookingId)).toISOString();
      const r = await this.db.prepare('INSERT OR IGNORE INTO settlement_decisions(id,booking_id,decision_key,kind,operator_id,rental_refund,deposit_refund,host_compensation,reason,version_seen,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, bookingId, key, kind, userId, ...amounts, reason, v.version, at);
      if (!r.changes) throw new AppError('A decision was already recorded for this settlement. Reload to see it.', 409, 'ALREADY_DECIDED');
      const operator = (await this.store.user(userId)).name;
      await this.store.addTrace(bookingId, kind === 'settle' ? 'Settlement decided' : 'Settlement review note', kind === 'settle'
        ? `Operator ${operator} settled the simulated amounts: rental refund ₹${amounts[0]}, deposit refund ₹${amounts[1]}, host compensation ₹${amounts[2]}. Reason: ${reason}`
        : `Operator ${operator} recorded a review note. No simulated money moved. Note: ${reason}`);
      await this.sync(bookingId);
      if (kind === 'settle') for (const recipientId of [b.renter_id, b.owner_id]) await this.store.messages.notify({
        recipientId, kind: 'settlement_decided', dedupeKey: `settlement:${id}`, title: `Settlement decided for ${b.listing_title}`,
        body: `Simulated, no real money: rental refund ₹${amounts[0]}, deposit refund ₹${amounts[1]}, host compensation ₹${amounts[2]}. Reason: ${reason}`, link: `booking/${bookingId}`,
      });
      return { id, bookingId };
    });
  }
}
