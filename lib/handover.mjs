// M6: versioned both-party agreement acceptance, category checklists, collection gate,
// cancellation / no-show / rescheduling rules. Owned by the M6 work stream.
// Contract with M7: record outcomes in booking_meta details, e.g.
//   details.cancellation = { by: 'host'|'renter'|'system', stage, at, reason, policyVersion,
//                            rentalRefund: <rupees>, depositRefund: <rupees>, hostCompensation: <rupees> }
// Other booking_meta details written here: reschedules[] (proposals), noShowReports[] (reports).
// Agreement revisions live in agreement_revisions (one immutable row per revision).
import { randomUUID } from 'node:crypto';
import { AppError, fail } from './errors.mjs';
import { cancellationRulesFor } from './rental-policy.mjs';
import { quote as rateQuote, timeRange } from './store.mjs';

const HOUR = 3600_000;
const str = (value, max = 300) => String(value ?? '').trim().slice(0, max);
const parse = (value, fallback) => { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } };
const roles = ['host', 'renter'];
const other = role => (role === 'host' ? 'renter' : 'host');
const OPEN_STATUSES = ['requested', 'confirmed'];
const OPEN_REPORTS = ['reported', 'disputed'];
export const CUSTODY_NOTE = 'Parking only: the host provides a space and access. Neither the host nor Sparely takes custody of, guards or insures the vehicle or its contents.';
export const FUNCTION_CHECKS = ['working', 'partly', 'not_working', 'not_checked'];
export const NO_SHOW_KINDS = { renter_no_show: 'host', host_no_show: 'renter', inaccessible_storage: 'renter' };
export const kindOf = category => (category === 'storage' ? 'storage' : category === 'parking' ? 'parking' : 'equipment');

const declaredKeys = {
  storage: [['condition', 'Condition'], ['damp', 'Damp or leak history'], ['pests', 'Pests'], ['ventilation', 'Ventilation'], ['petsPresent', 'Pets on the property'], ['security', 'Security'], ['stacking', 'Stacking / load']],
  equipment: [['condition', 'Condition'], ['defects', 'Known defects'], ['functionCheck', 'Function check'], ['restrictions', 'Operating restrictions'], ['safety', 'Safety']],
  parking: [['covered', 'Covered'], ['gate', 'Gate / entry'], ['restrictions', 'Restrictions']],
};
// Readable words for onboarding codes; "unknown" is shown as "Not stated", never as an absence.
const WORDS = { none_known: 'None known to the host', past: 'In the past', current: 'Current', unknown: 'Not stated', good: 'Good', limited: 'Limited', none: 'None', treated: 'In the past, treated', present: 'Present', yes: 'Yes', no: 'No', like_new: 'Like new', worn: 'Worn but working', needs_care: 'Needs care', working: 'Working', working_with_notes: 'Working, with notes', open: 'Open access', key: 'Key or code from host', remote: 'Remote gate', staffed: 'Staffed gate' };
const show = value => (Array.isArray(value) ? value.join(', ') : value && typeof value === 'object' ? Object.values(value).join(' × ') : WORDS[String(value ?? '')] ?? String(value ?? ''));

function cleanChecklist(kind, raw) {
  fail(!raw || typeof raw !== 'object' || Array.isArray(raw), 'Send the checklist as an object.');
  if (kind === 'storage') {
    const items = (Array.isArray(raw.items) ? raw.items : []).slice(0, 50).map((i, n) => ({ id: str(i?.id, 20) || `S${n + 1}`, description: str(i?.description, 120), quantity: Number(i?.quantity), seal: str(i?.seal, 60) }));
    fail(!items.length, 'List at least one box or item.');
    for (const i of items) {
      fail(i.description.length < 2, 'Describe each box or item.');
      fail(!Number.isInteger(i.quantity) || i.quantity < 1 || i.quantity > 500, 'Use a whole-number quantity for each box or item.');
    }
    fail(new Set(items.map(i => i.id)).size !== items.length, 'Give each box or item its own identifier.');
    return { items, sealsUsed: raw.sealsUsed === true, existingDefects: str(raw.existingDefects, 1000), location: str(raw.location, 300), access: str(raw.access, 500) };
  }
  if (kind === 'parking') return { vehicleRegistration: str(raw.vehicleRegistration, 20).toUpperCase(), vehicleType: str(raw.vehicleType, 60), space: str(raw.space, 200), access: str(raw.access, 500), custodyNote: CUSTODY_NOTE };
  fail(!FUNCTION_CHECKS.includes(raw.functionCheck), 'Choose a function check result.');
  const accessories = (Array.isArray(raw.accessories) ? raw.accessories : []).slice(0, 30).map(a => ({ name: str(a?.name, 120), present: a?.present !== false })).filter(a => a.name);
  return { functionCheck: raw.functionCheck, accessories, condition: str(raw.condition, 500), existingDefects: str(raw.existingDefects, 1000) };
}

// Revision 1, derived from the booking-time snapshot (host declarations + renter intake).
export function initialTerms(agreement) {
  const kind = kindOf(agreement.listing.category), facts = agreement.disclosures?.facts || {};
  const declaredConditions = declaredKeys[kind].filter(([k]) => facts[k] !== undefined && facts[k] !== '').map(([k, label]) => `${label}: ${show(facts[k])}`);
  const access = [facts.accessHours && `Access hours: ${facts.accessHours}`, facts.notice && `Notice: ${facts.notice}`, facts.appointment && `Appointment needed: ${facts.appointment}`, facts.gate && `Entry: ${facts.gate}`].filter(Boolean).join('. ');
  const checklist = kind === 'storage'
    ? { items: (agreement.storage?.items || []).map((i, n) => ({ id: `S${n + 1}`, description: i.description, quantity: i.quantity, seal: '' })), sealsUsed: false, existingDefects: '', location: '', access }
    : kind === 'parking'
      ? { vehicleRegistration: '', vehicleType: show(facts.vehicles), space: show(facts.space), access, custodyNote: CUSTODY_NOTE }
      : { functionCheck: FUNCTION_CHECKS.includes(facts.functionCheck) ? facts.functionCheck : 'not_checked', accessories: (agreement.listing.included || []).map(name => ({ name, present: true })), condition: str(facts.condition, 500), existingDefects: str(facts.defects, 1000) };
  return {
    category: kind, start: agreement.start, end: agreement.end, quote: agreement.quote, policyVersion: agreement.policyVersion,
    reservedSqft: agreement.storage?.reservedSqft ?? null, declaredConditions,
    accessExpectations: [access, agreement.storage?.accessNeeds && `Renter access needs: ${agreement.storage.accessNeeds}`].filter(Boolean).join('. '),
    conversationReference: null, checklist,
  };
}

export class Handover {
  constructor(store) { this.store = store; this.db = store.db; }

  // ---- access ---------------------------------------------------------------------
  async context(bookingId, userId) {
    const b = await this.db.prepare('SELECT b.*,l.owner_id,l.category,l.title AS listing_title FROM bookings b JOIN listings l ON l.id=b.listing_id WHERE b.id=?').get(bookingId);
    fail(!b, 'Booking not found.', 404);
    const role = userId === b.owner_id ? 'host' : userId === b.renter_id ? 'renter' : null;
    const meta = await this.store.metadata(bookingId);
    // Operators (same world, not a party) may read when there is something to review: a no-show report, a claim or a recovery case.
    const operator = !role && (await this.store.user(userId)).role === 'Operator' && ((meta.details.noShowReports || []).length > 0 || !!meta.details.claim || (await this.store.recovery.hasCase(bookingId))) && (await this.store.sameWorld(userId, b.renter_id));
    fail(!role && !operator, 'This booking belongs to another profile.', 403);
    return { b, role, operator, meta, quote: parse(b.quote, {}), now: await this.store.now(bookingId), ids: { host: b.owner_id, renter: b.renter_id } };
  }
  participant(ctx) { fail(!ctx.role, 'Only the host or renter can do that.', 403); return ctx.role; }
  editable(ctx, what = 'The agreement') {
    if (!OPEN_STATUSES.includes(ctx.b.status)) throw new AppError(`${what} can only change before collection.`, 409, 'AGREEMENT_LOCKED');
  }

  // ---- revisions ------------------------------------------------------------------
  revisionView(r) {
    const acceptance = role => (r[`${role}_accepted_at`] ? { userId: r[`${role}_accepted_by`], at: r[`${role}_accepted_at`], via: r[`${role}_accepted_via`] } : null);
    return { revision: r.revision, terms: parse(r.terms, {}), proposedBy: r.proposed_by, proposedRole: r.proposed_role, note: r.note, createdAt: r.created_at, acceptances: { host: acceptance('host'), renter: acceptance('renter') }, disagreement: parse(r.disagreement, null) };
  }
  async revisions(bookingId) {
    return (await this.db.prepare('SELECT * FROM agreement_revisions WHERE booking_id=? ORDER BY revision').all(bookingId)).map(r => this.revisionView(r));
  }
  async current(bookingId) {
    const r = await this.db.prepare('SELECT * FROM agreement_revisions WHERE booking_id=? ORDER BY revision DESC LIMIT 1').get(bookingId);
    return r ? this.revisionView(r) : null;
  }
  async insert(bookingId, revision, terms, by, role, note, at, accepted = {}, disagreement = null) {
    const col = r => accepted[r] ? [accepted[r].userId, accepted[r].at, accepted[r].via] : [null, null, null];
    await this.db.prepare('INSERT INTO agreement_revisions(booking_id,revision,terms,proposed_by,proposed_role,note,created_at,host_accepted_by,host_accepted_at,host_accepted_via,renter_accepted_by,renter_accepted_at,renter_accepted_via,disagreement) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(bookingId, revision, JSON.stringify(terms), by, role, note, at, ...col('host'), ...col('renter'), disagreement ? JSON.stringify(disagreement) : null);
  }
  stale(current, revision) {
    if (!current) throw new AppError('This booking has no versioned agreement (it was made before agreements were versioned).', 409, 'AGREEMENT_LEGACY');
    if (revision !== current.revision) throw new AppError(`The agreement changed: revision ${current.revision} is now current. Review it before accepting.`, 409, 'STALE_AGREEMENT', { currentRevision: current.revision });
  }

  // Called by createBooking: the renter's request (agreed:true) accepts revision 1.
  async start(bookingId, agreement, renterId, at) {
    await this.insert(bookingId, 1, initialTerms(agreement), renterId, 'renter', 'Terms as requested: listing declarations and the renter’s details.', at, { renter: { userId: renterId, at, via: 'request' } });
  }
  // Called by transition('accept'): confirming the request accepts the current revision.
  async confirmedByHost(bookingId, hostId, revision) {
    const current = await this.current(bookingId);
    if (!current) return null;
    if (revision !== undefined && revision !== null) this.stale(current, Number(revision));
    if (!current.acceptances.host) await this.setAcceptance(bookingId, current, 'host', hostId, new Date(await this.store.now(bookingId)).toISOString(), 'confirm');
    return current.revision;
  }
  async setAcceptance(bookingId, current, role, userId, at, via) {
    const disagreement = current.disagreement?.role === role ? null : current.disagreement;
    await this.db.prepare(`UPDATE agreement_revisions SET ${role}_accepted_by=?,${role}_accepted_at=?,${role}_accepted_via=?,disagreement=? WHERE booking_id=? AND revision=?`)
      .run(userId, at, via, disagreement ? JSON.stringify(disagreement) : null, bookingId, current.revision);
  }

  // ---- collection gate ------------------------------------------------------------
  async gate(bookingId) {
    const current = await this.current(bookingId);
    if (!current) return { ok: true, legacy: true, code: null, message: 'This booking was made before agreements were versioned. Check the listing terms together at handover.' };
    if (current.disagreement) return { ok: false, code: 'AGREEMENT_DISAGREEMENT', revision: current.revision, message: `The ${current.disagreement.role} flagged a mismatch on agreement revision ${current.revision}, so collection is paused. Clarify in messages, propose a corrected revision, or cancel under the rules. Nobody is treated as at fault.` };
    const waiting = roles.filter(r => !current.acceptances[r]);
    if (waiting.length) return { ok: false, code: 'AGREEMENT_NOT_ACCEPTED', revision: current.revision, waiting, message: `Collection needs both of you to accept agreement revision ${current.revision}. Waiting for the ${waiting.join(' and the ')}. The handover code confirms who is present; it does not record agreement on condition.` };
    return { ok: true, code: null, revision: current.revision, message: `Both of you accepted agreement revision ${current.revision}.` };
  }
  async assertCollectable(bookingId) {
    const g = await this.gate(bookingId);
    if (!g.ok) throw new AppError(g.message, 409, g.code, { currentRevision: g.revision, waiting: g.waiting || [] });
    return g;
  }
  // After collection, open proposals and reports no longer apply.
  async afterCollect(bookingId) {
    const meta = await this.store.metadata(bookingId);
    if (this.supersede(meta.details, new Date(await this.store.now(bookingId)).toISOString())) await this.store.saveMetadata(bookingId, meta);
  }
  supersede(details, at) {
    let changed = false;
    for (const r of details.reschedules || []) if (r.status === 'pending') { r.status = 'superseded'; r.decidedAt = at; changed = true; }
    for (const r of details.noShowReports || []) if (OPEN_REPORTS.includes(r.status)) { r.status = 'superseded'; r.closedAt = at; changed = true; }
    return changed;
  }

  // ---- agreement commands ---------------------------------------------------------
  async accept(userId, bookingId, input) {
    return await this.store.transaction(async () => {
      const ctx = await this.context(bookingId, userId), role = this.participant(ctx);
      this.editable(ctx);
      const current = await this.current(bookingId);
      this.stale(current, input.revision);
      if (current.acceptances[role] && current.disagreement?.role !== role) return { id: bookingId };
      const at = new Date(ctx.now).toISOString();
      await this.setAcceptance(bookingId, current, role, userId, at, 'accepted');
      await this.store.addTrace(bookingId, `Agreement revision ${current.revision} accepted by the ${role}`, `${(await this.store.user(userId)).name} accepted this exact revision.`);
      await this.notice(ctx.ids[other(role)], 'agreement_accepted', `agreement:${bookingId}:r${current.revision}:accepted:${role}`, `The ${role} accepted agreement revision ${current.revision}`, (await this.gate(bookingId)).message, bookingId);
      return { id: bookingId };
    });
  }
  async disagree(userId, bookingId, input) {
    return await this.store.transaction(async () => {
      const ctx = await this.context(bookingId, userId), role = this.participant(ctx);
      this.editable(ctx);
      const current = await this.current(bookingId);
      this.stale(current, input.revision);
      const note = str(input.note, 1000);
      fail(note.length < 10, 'Say what does not match in at least 10 characters.');
      const at = new Date(ctx.now).toISOString();
      await this.db.prepare(`UPDATE agreement_revisions SET ${role}_accepted_by=NULL,${role}_accepted_at=NULL,${role}_accepted_via=NULL,disagreement=? WHERE booking_id=? AND revision=?`)
        .run(JSON.stringify({ by: userId, role, note, at }), bookingId, current.revision);
      await this.store.addTrace(bookingId, `Mismatch flagged on agreement revision ${current.revision}`, `The ${role} said: ${note} Collection is paused until both accept a revision. This is not a finding of fault.`);
      await this.notice(ctx.ids[other(role)], 'agreement_disagreement', `agreement:${bookingId}:r${current.revision}:disagree:${role}:${at}`, `The ${role} flagged a mismatch in the agreement`, `${note} You can reply in messages, propose a corrected revision, or cancel under the rules.`, bookingId);
      return { id: bookingId };
    });
  }
  async propose(userId, bookingId, input) {
    return await this.store.transaction(async () => {
      const ctx = await this.context(bookingId, userId), role = this.participant(ctx);
      this.editable(ctx);
      const current = await this.current(bookingId);
      this.stale(current, input.baseRevision);
      const terms = { ...current.terms, checklist: cleanChecklist(current.terms.category, input.checklist ?? current.terms.checklist) };
      if (input.declaredConditions !== undefined) {
        fail(!Array.isArray(input.declaredConditions), 'Send declared conditions as a list.');
        terms.declaredConditions = input.declaredConditions.slice(0, 20).map(c => str(c, 300)).filter(Boolean);
      }
      if (input.accessExpectations !== undefined) terms.accessExpectations = str(input.accessExpectations, 1000);
      if (input.conversationReference !== undefined) terms.conversationReference = await this.reference(ctx.b, input.conversationReference);
      fail(JSON.stringify(terms) === JSON.stringify(current.terms), 'Nothing changed from the current revision.', 409);
      const at = new Date(ctx.now).toISOString(), revision = current.revision + 1, note = str(input.note, 500);
      // Proposing a revision is the proposer's acceptance of it; the other party must accept anew.
      await this.insert(bookingId, revision, terms, userId, role, note, at, { [role]: { userId, at, via: 'proposed' } });
      await this.store.addTrace(bookingId, `Agreement revision ${revision} proposed by the ${role}`, `Earlier acceptances no longer count for collection. ${note || 'No note.'}`);
      await this.notice(ctx.ids[other(role)], 'agreement_changed', `agreement:${bookingId}:r${revision}:proposed`, `The ${role} proposed agreement revision ${revision}`, `Review the checklist and accept it, or flag what does not match. ${note}`.trim(), bookingId);
      return { id: bookingId };
    });
  }
  // A conversation reference is "<conversationId>@<revision>" of this booking's (or its enquiry's) conversation.
  async reference(b, value) {
    if (value === null || value === '') return null;
    const match = String(value).match(/^([A-Za-z0-9_-]{1,80})@(\d{1,9})$/);
    fail(!match, 'Use a conversation reference like "<id>@<revision>".');
    const c = await this.db.prepare('SELECT id,booking_id,listing_id,renter_id,revision FROM conversations WHERE id=?').get(match[1]);
    fail(!c || !(c.booking_id === b.id || (!c.booking_id && c.listing_id === b.listing_id && c.renter_id === b.renter_id)), 'That conversation is not about this booking.');
    fail(Number(match[2]) > c.revision, 'That conversation revision does not exist yet.');
    return `${c.id}@${Number(match[2])}`;
  }

  // ---- cancellation ---------------------------------------------------------------
  // b: { id, status, start, quote, hostId, renterId }. Money comes only from the stored quote and the snapshotted policy.
  outcome(b, policy, byRole, now, stage) {
    const rules = cancellationRulesFor(policy);
    stage ||= b.status === 'requested' ? 'requested' : byRole === 'host' ? 'host_cancelled' : Date.parse(b.start) - now > (policy?.cancellation?.lateWindowHours ?? 24) * HOUR ? 'confirmed_early' : 'confirmed_late';
    const rule = rules[stage], rental = Number(b.quote?.rental) || 0, deposit = Number(b.quote?.deposit) || 0;
    const rentalRefund = Math.ceil(rental * rule.rentalRefundPct / 100);
    return { stage, label: rule.label, rentalRefund, depositRefund: Math.ceil(deposit * rule.depositRefundPct / 100), hostCompensation: rental - rentalRefund, policyVersion: policy?.version || 'demo-v1' };
  }
  describe(c) { return `Rental refund ₹${c.rentalRefund}, deposit refund ₹${c.depositRefund}, host compensation ₹${c.hostCompensation} (${c.stage}, policy ${c.policyVersion}). Simulated; no money moved.`; }
  // Records the outcome once on meta (and saves it). The caller changes the booking status.
  async recordCancellation(b, meta, by, { stage, reason } = {}) {
    if (meta.details.cancellation) throw new AppError('A cancellation outcome is already recorded for this booking.', 409, 'CANCELLATION_RECORDED');
    const now = await this.store.now(b.id), at = new Date(now).toISOString();
    const o = this.outcome(b, meta.policy, by === 'system' ? 'renter' : by, now, stage);
    const record = { by, stage: o.stage, at, reason: str(reason, 500) || o.label, policyVersion: o.policyVersion, rentalRefund: o.rentalRefund, depositRefund: o.depositRefund, hostCompensation: o.hostCompensation };
    meta.details.cancellation = record;
    this.supersede(meta.details, at);
    await this.store.saveMetadata(b.id, meta);
    for (const role of roles) if (role !== by) await this.notice(role === 'host' ? b.hostId : b.renterId, 'booking_cancelled', `cancel:${b.id}:${role}`, o.stage === 'requested' ? 'Booking request closed' : 'Booking cancelled', `${o.label}. ${this.describe(record)}`, b.id);
    return record;
  }

  // ---- rescheduling ---------------------------------------------------------------
  async newQuote(ctx, start, end) {
    const q = ctx.quote;
    if (q.pricingVersion === 'area-v1') return this.store.capacity.extensionQuote(q, start, end);
    return rateQuote({ rate: q.rate, deposit: q.deposit, unit: q.unit }, start, end);
  }
  async availability(ctx, start, end) {
    if (await this.store.available(ctx.b.listing_id, start, end, ctx.b.id)) return;
    const shared = this.store.capacity.shared(await this.store.listing(ctx.b.listing_id));
    throw new AppError(shared ? 'Not enough floor area is free for those dates.' : 'Those dates are not available.', 409, shared ? 'CAPACITY_FULL' : 'DATES_TAKEN');
  }
  async proposeReschedule(userId, bookingId, input) {
    return await this.store.transaction(async () => {
      const ctx = await this.context(bookingId, userId), role = this.participant(ctx);
      this.editable(ctx, 'Dates');
      const list = ctx.meta.details.reschedules ||= [];
      fail(list.some(r => r.status === 'pending'), 'A reschedule is already waiting for a reply.', 409);
      const { start, end } = timeRange(input.start, input.end, ctx.now);
      fail(start === ctx.b.start && end === ctx.b.end, 'Those are the current dates.');
      await this.availability(ctx, start, end);
      const at = new Date(ctx.now).toISOString(), q = await this.newQuote(ctx, start, end);
      const proposal = { id: randomUUID(), status: 'pending', proposedBy: userId, proposerRole: role, start, end, quote: q, previous: { start: ctx.b.start, end: ctx.b.end, rental: ctx.quote.rental }, note: str(input.note, 500), at, decidedBy: null, decidedAt: null };
      list.push(proposal);
      await this.store.saveMetadata(bookingId, ctx.meta);
      await this.store.addTrace(bookingId, `Reschedule proposed by the ${role}`, `New dates ${start} – ${end}, rental ₹${q.rental} (was ₹${ctx.quote.rental}). The current dates and price stay until the other party accepts.`);
      await this.notice(ctx.ids[other(role)], 'reschedule_proposed', `reschedule:${proposal.id}:proposed`, `The ${role} proposed new dates`, `Rental would be ₹${q.rental} (was ₹${ctx.quote.rental}). Accept or decline on the booking.`, bookingId);
      return { id: bookingId };
    });
  }
  async decideReschedule(userId, bookingId, input) {
    return await this.store.transaction(async () => {
      const ctx = await this.context(bookingId, userId), role = this.participant(ctx);
      const p = (ctx.meta.details.reschedules || []).find(r => r.status === 'pending');
      if (!p || p.id !== input.proposalId) throw new AppError('This reschedule proposal is no longer pending. Reload the booking.', 409, 'STALE_RESCHEDULE', { pendingId: p?.id || null });
      this.editable(ctx, 'Dates');
      const decision = input.decision, at = new Date(ctx.now).toISOString();
      fail(!['accept', 'decline', 'withdraw'].includes(decision), 'Choose accept, decline or withdraw.');
      fail(decision === 'withdraw' ? role !== p.proposerRole : role === p.proposerRole, decision === 'withdraw' ? 'Only the proposer can withdraw it.' : 'The other party must answer this proposal.', 403);
      if (decision === 'accept') {
        fail(Date.parse(p.start) <= ctx.now, 'The proposed collection time has passed. Decline it and propose new dates.', 409);
        await this.availability(ctx, p.start, p.end);
        await this.db.prepare('UPDATE bookings SET start=?,end=?,quote=? WHERE id=?').run(p.start, p.end, JSON.stringify(p.quote), bookingId);
        const current = await this.current(bookingId);
        if (current) {
          // Both explicitly accepted the new dates and price; checklist acceptance carries only for a party who had accepted it.
          const carried = {};
          for (const r of roles) if (current.acceptances[r]) carried[r] = { userId: ctx.ids[r], at, via: 'reschedule' };
          await this.insert(bookingId, current.revision + 1, { ...current.terms, start: p.start, end: p.end, quote: p.quote }, p.proposedBy, p.proposerRole, `Rescheduled: both accepted new dates and a rental of ₹${p.quote.rental}. Checklist unchanged from revision ${current.revision}.`, at, carried, current.disagreement);
        }
        ctx.meta.details.alerts = {};
      }
      p.status = decision === 'accept' ? 'accepted' : decision === 'decline' ? 'declined' : 'withdrawn';
      p.decidedBy = userId; p.decidedAt = at;
      await this.store.saveMetadata(bookingId, ctx.meta);
      await this.store.addTrace(bookingId, `Reschedule ${p.status}`, decision === 'accept' ? `New dates ${p.start} – ${p.end}; rental ₹${p.quote.rental}. A new agreement revision records it.` : 'The current dates and price stay in place.');
      await this.notice(ctx.ids[other(role)], `reschedule_${p.status}`, `reschedule:${p.id}:${p.status}`, `Reschedule ${p.status} by the ${role}`, decision === 'accept' ? `New dates are in effect. Rental ₹${p.quote.rental}.` : 'The current dates stay in place.', bookingId);
      await this.store.settlement.sync(bookingId);
      return { id: bookingId };
    });
  }

  // ---- no-show and inaccessible storage --------------------------------------------
  reportable(ctx) {
    if (!ctx.role || ctx.b.status !== 'confirmed' || (ctx.meta.details.noShowReports || []).some(r => OPEN_REPORTS.includes(r.status))) return [];
    const started = ctx.now > Date.parse(ctx.b.start) + (ctx.meta.policy.graceMinutes ?? 30) * 60_000;
    return Object.entries(NO_SHOW_KINDS).filter(([kind, by]) => by === ctx.role && (kind === 'inaccessible_storage' ? ctx.b.category === 'storage' : started)).map(([kind]) => kind);
  }
  async reportNoShow(userId, bookingId, input) {
    return await this.store.transaction(async () => {
      const ctx = await this.context(bookingId, userId), role = this.participant(ctx);
      fail(!Object.hasOwn(NO_SHOW_KINDS, input.kind), 'Choose what happened.');
      const allowed = this.reportable(ctx);
      fail(!allowed.includes(input.kind), NO_SHOW_KINDS[input.kind] !== role ? `Only the ${NO_SHOW_KINDS[input.kind]} can report that.` : 'This cannot be reported now: the booking must be confirmed, the collection time and grace period must have passed, and no other report may be open.', 409);
      const note = str(input.note, 1000);
      fail(note.length < 10, 'Describe what happened in at least 10 characters.');
      const at = new Date(ctx.now).toISOString(), hours = ctx.meta.policy.cancellation?.noShowResponseHours ?? 24;
      const report = { id: randomUUID(), kind: input.kind, status: 'reported', reportedBy: userId, reporterRole: role, note, at, respondBy: new Date(ctx.now + hours * HOUR).toISOString(), response: null, decision: null, closedAt: null };
      (ctx.meta.details.noShowReports ||= []).push(report);
      await this.store.saveMetadata(bookingId, ctx.meta);
      await this.store.addTrace(bookingId, `Reported by the ${role}: ${input.kind.replaceAll('_', ' ')}`, `This is a report, not a finding. The ${other(role)} can agree or dispute it by ${report.respondBy}; an operator decides disputed or unanswered reports. No consequence applies yet.`);
      await this.notice(ctx.ids[other(role)], 'no_show_reported', `noshow:${report.id}:reported`, `The ${role} reported a missed handover`, `${note} Agree or dispute it on the booking within ${hours} hours. Nothing is final yet.`, bookingId);
      return { id: bookingId };
    });
  }
  async actOnNoShow(userId, bookingId, input) {
    return await this.store.transaction(async () => {
      const ctx = await this.context(bookingId, userId), at = new Date(ctx.now).toISOString();
      const report = (ctx.meta.details.noShowReports || []).find(r => OPEN_REPORTS.includes(r.status));
      if (!report || report.id !== input.reportId) throw new AppError('This report is no longer open. Reload the booking.', 409, 'STALE_REPORT', { openReportId: report?.id || null });
      const note = str(input.note, 1000), action = input.action;
      let apply = null;
      if (action === 'agree' || action === 'dispute') {
        fail(!ctx.role || ctx.role === report.reporterRole, 'Only the other party can respond to this report.', 403);
        fail(report.status !== 'reported', 'This report already has a response.', 409);
        fail(action === 'dispute' && note.length < 10, 'Explain the disagreement in at least 10 characters.');
        report.response = { by: userId, agreed: action === 'agree', note, at };
        report.status = action === 'agree' ? 'agreed' : 'disputed';
        if (action === 'agree') apply = report.reporterRole;
      } else if (action === 'withdraw') {
        fail(ctx.role !== report.reporterRole, 'Only the reporter can withdraw it.', 403);
        report.status = 'withdrawn';
      } else if (action === 'decide') {
        fail(!ctx.operator, 'An independent operator must decide this report.', 403);
        fail(report.status === 'reported' && ctx.now <= Date.parse(report.respondBy), `Wait for the other party’s response or until ${report.respondBy}.`, 409);
        fail(!['uphold', 'reject'].includes(input.outcome), 'Choose uphold or reject.');
        fail(note.length < 10, 'Record the reason for the decision in at least 10 characters.');
        report.decision = { operatorId: userId, outcome: input.outcome, note, at };
        report.status = input.outcome === 'uphold' ? 'upheld' : 'rejected';
        if (input.outcome === 'uphold') apply = 'system';
      } else throw new AppError('Choose agree, dispute, withdraw or decide.');
      if (report.status !== 'disputed') report.closedAt = at;
      await this.store.saveMetadata(bookingId, ctx.meta);
      const label = report.kind.replaceAll('_', ' ');
      if (apply) {
        fail(ctx.b.status !== 'confirmed', 'The booking is no longer awaiting collection.', 409);
        const record = await this.recordCancellation({ id: bookingId, status: ctx.b.status, start: ctx.b.start, quote: ctx.quote, hostId: ctx.ids.host, renterId: ctx.ids.renter }, ctx.meta, apply === 'system' ? 'system' : apply, { stage: report.kind, reason: `${label}: ${report.note}` });
        await this.db.prepare("UPDATE bookings SET status='cancelled' WHERE id=? AND status='confirmed'").run(bookingId);
        await this.store.addTrace(bookingId, apply === 'system' ? `Operator upheld the ${label} report` : `Both agreed: ${label}`, `${note ? `${note} ` : ''}The booking is cancelled and its dates released. ${this.describe(record)}`);
      } else {
        await this.store.addTrace(bookingId, `Report ${report.status}: ${label}`, report.status === 'disputed' ? `${note} An operator will review it. No consequence applies until then.` : report.status === 'rejected' ? `Operator decision: ${note} No consequence applies; the booking stays as it was.` : 'The report was withdrawn. No consequence applies.');
      }
      for (const r of roles) if (r !== ctx.role) await this.notice(ctx.ids[r], `no_show_${report.status}`, `noshow:${report.id}:${report.status}:${r}`, `Missed-handover report ${report.status}`, apply ? 'The booking is cancelled under the snapshotted rules.' : 'No consequence has been applied.', bookingId);
      if (report.status === 'disputed') for (const op of await this.operators(ctx.b.renter_id)) await this.notice(op, 'no_show_review', `noshow:${report.id}:review:${op}`, 'A missed-handover report needs a decision', `${label} on "${ctx.b.listing_title}" is disputed.`, bookingId);
      await this.store.settlement.sync(bookingId);
      return { id: bookingId };
    });
  }
  async operators(renterId) {
    const ids = [];
    for (const u of await this.db.prepare("SELECT id FROM users WHERE role='Operator'").all()) if (await this.store.sameWorld(u.id, renterId)) ids.push(u.id);
    return ids;
  }
  // Operator queue: open reports (disputed, or unanswered past the response window) in the operator's world.
  async openReports(userId) {
    fail((await this.store.user(userId)).role !== 'Operator', 'Only an operator can open this queue.', 403);
    const out = [];
    for (const row of await this.db.prepare("SELECT m.booking_id,m.details,b.renter_id FROM booking_meta m JOIN bookings b ON b.id=m.booking_id WHERE m.details LIKE '%noShowReports%'").all()) {
      const open = (parse(row.details, {}).noShowReports || []).find(r => OPEN_REPORTS.includes(r.status));
      if (open && (await this.store.sameWorld(userId, row.renter_id))) out.push({ bookingId: row.booking_id, report: open, decidable: open.status === 'disputed' || (await this.store.now(row.booking_id)) > Date.parse(open.respondBy) });
    }
    return { reports: out };
  }

  // ---- read model -----------------------------------------------------------------
  async view(bookingId, userId) {
    const ctx = await this.context(bookingId, userId), { b, role, meta, now } = ctx;
    const revisions = await this.revisions(bookingId), current = revisions.at(-1) || null;
    const open = !!role && OPEN_STATUSES.includes(b.status);
    const reschedules = meta.details.reschedules || [], pending = reschedules.find(r => r.status === 'pending') || null;
    const reports = meta.details.noShowReports || [], report = reports.find(r => OPEN_REPORTS.includes(r.status)) || null;
    const cancellation = meta.details.cancellation || null, rules = cancellationRulesFor(meta.policy);
    const plain = { id: b.id, status: b.status, start: b.start, quote: ctx.quote };
    return {
      bookingId, status: b.status, category: kindOf(b.category), role: role || 'operator', legacy: !current,
      current, revisions: revisions.map(({ terms, ...r }) => r), gate: await this.gate(bookingId),
      policyVersion: meta.policy.version || 'demo-v1', lateWindowHours: meta.policy.cancellation?.lateWindowHours ?? 24,
      rules: Object.entries(rules).map(([stage, r]) => ({ stage, ...r })),
      cancellation, cancellationPreview: open && !cancellation ? this.outcome(plain, meta.policy, role, now) : null,
      reschedule: pending, reschedules, noShow: report, noShowReports: reports, custodyNote: kindOf(b.category) === 'parking' ? CUSTODY_NOTE : null,
      effectiveNow: new Date(now).toISOString(),
      can: {
        accept: open && !!current && (!current.acceptances[role] || current.disagreement?.role === role),
        propose: open && !!current, disagree: open && !!current && current.disagreement?.role !== role,
        cancel: open && !cancellation, reschedule: open && !pending,
        answerReschedule: open && !!pending && pending.proposerRole !== role, withdrawReschedule: open && !!pending && pending.proposerRole === role,
        reportNoShow: this.reportable(ctx),
        answerNoShow: !!report && !!role && report.status === 'reported' && report.reporterRole !== role,
        withdrawNoShow: !!report && report.reporterRole === role,
        decideNoShow: !!report && ctx.operator && (report.status === 'disputed' || now > Date.parse(report.respondBy)),
      },
    };
  }

  async notice(recipientId, kind, dedupeKey, title, body, bookingId) {
    await this.store.messages.notify({ recipientId, kind, dedupeKey, title, body, link: `booking/${bookingId}` });
  }
}
