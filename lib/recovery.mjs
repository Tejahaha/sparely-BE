import { createHash, randomUUID } from 'node:crypto';
import { AppError, fail } from './errors.mjs';
const text = (value, max = 1000) => String(value || '').trim().slice(0, max);
const types = ['lost', 'non_return', 'damage', 'access_problem', 'unsafe'];
import { checkImage } from './images.mjs'; const imageValid = image => checkImage(image).ok;
export const evidenceDigest = image => createHash('sha256').update(image).digest('hex');
export class Recovery {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.ready = this.initialize();
  }
  async context(bookingId, actor) {
    const b = await this.db.prepare('SELECT b.*,l.owner_id,l.category,l.city,l.title AS listing_title FROM bookings b JOIN listings l ON l.id=b.listing_id WHERE b.id=?').get(bookingId);
    fail(!b, 'Booking not found.', 404);
    const isHost = b.owner_id === actor,
      isRenter = b.renter_id === actor;
    // Operators review only their own world (demo operator: demo cases; account operators: real cases).
    const independent = (await this.store.user(actor)).role === 'Operator' && !isHost && !isRenter && (await this.store.sameWorld(actor, b.renter_id));
    fail(!isHost && !isRenter && !independent, 'This incident belongs to another profile.', 403);
    return {
      b,
      isHost,
      isRenter,
      independent
    };
  }
  async hasCase(bookingId) {
    return !!(await this.db.prepare('SELECT 1 FROM incidents WHERE booking_id=?').get(bookingId));
  }
  async hasOpen(listingId) {
    return !!(await this.db.prepare("SELECT 1 FROM incidents i JOIN bookings b ON b.id=i.booking_id WHERE b.listing_id=? AND i.status<>'resolved'").get(listingId));
  }
  async summary(bookingId) {
    const rows = await this.db.prepare('SELECT id,type,status FROM incidents WHERE booking_id=? ORDER BY created_at,id').all(bookingId);
    return {
      open: rows.filter(i => i.status !== 'resolved').length,
      incidents: rows
    };
  }
  async get(id, actor) {
    const row = await this.db.prepare('SELECT * FROM incidents WHERE id=?').get(id);
    fail(!row, 'Recovery case not found.', 404);
    const {
      b,
      isHost,
      isRenter,
      independent
    } = await this.context(row.booking_id, actor);
    const entries = await this.db.prepare('SELECT id,actor_id AS actorId,kind,note,image,digest,created_at AS createdAt FROM incident_entries WHERE incident_id=? ORDER BY created_at,rowid').all(id);
    return {
      id,
      bookingId: row.booking_id,
      listingTitle: b.listing_title,
      reporterId: row.reporter_id,
      type: row.type,
      status: row.status,
      description: row.description,
      lastKnown: row.last_known,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      reviewDueAt: row.review_due_at,
      plan: row.plan ? JSON.parse(row.plan) : null,
      resolution: row.resolution ? JSON.parse(row.resolution) : null,
      isHost,
      isRenter,
      canReview: independent,
      entries,
      delivery: 'in_app_only'
    };
  }
  async list(actor) {
    const operator = (await this.store.user(actor)).role === 'Operator';
    const rows = await this.db.prepare(`SELECT i.id,b.renter_id FROM incidents i JOIN bookings b ON b.id=i.booking_id JOIN listings l ON l.id=b.listing_id
      WHERE ?=1 OR b.renter_id=? OR l.owner_id=? ORDER BY (i.status='resolved'),i.created_at DESC,i.id`).all(operator ? 1 : 0, actor, actor);
    const visible = [];
    for (const row of rows) if (!operator || (await this.store.sameWorld(actor, row.renter_id))) visible.push(row);
    return await Promise.all(visible.map(async i => await this.get(i.id, actor)));
  }
  async entry(id, actor, kind, note, image, at) {
    if (image) fail(!imageValid(image), 'Add a JPG, PNG, or WebP evidence photo under 3 MB.');
    await this.db.prepare('INSERT INTO incident_entries VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), id, actor, kind, text(note), image || null, image ? evidenceDigest(image) : null, at);
  }
  async notify(b, incidentId, event, message, at) {
    const operators = (await this.db.prepare("SELECT id FROM users WHERE role='Operator'").all()).map(u => u.id);
    for (const recipient of new Set([b.owner_id, b.renter_id, ...operators])) {
      await this.db.prepare('INSERT OR IGNORE INTO safety_notices VALUES(?,?,?,?,?,?,?,?,NULL)').run(randomUUID(), recipient, `${event}:${recipient}`, b.id, incidentId, event.split(':')[0], message, at);
    }
  }
  async impact(b, incidentId, at) {
    for (const next of await this.db.prepare("SELECT * FROM bookings WHERE listing_id=? AND id<>? AND status IN ('requested','confirmed')").all(b.listing_id, b.id)) {
      const context = {
        ...next,
        owner_id: b.owner_id
      };
      await this.notify(context, incidentId, `collection_at_risk:${incidentId}:${next.id}`, 'This item is paused for a recovery case. Arrange alternatives or cancel; collection is blocked until the case closes and the host marks it ready.', at);
      await this.store.addTrace(next.id, 'Recovery case affects collection', 'An earlier rental has an open recovery case. Collection is blocked; no replacement or extra charge was automatically accepted.');
    }
  }
  async open(actor, bookingId, input) {
    return await this.store.transaction(async () => {
      const {
        b,
        isHost,
        isRenter
      } = await this.context(bookingId, actor);
      fail(!isHost && !isRenter, 'Only a rental participant can report an incident.', 403);
      fail(!['requested', 'confirmed', 'active', 'under_review', 'completed'].includes(b.status), 'This booking cannot open a recovery case.', 409);
      fail(!types.includes(input.type), `Choose one of: ${types.join(', ')}.`);
      const now = await this.store.now(bookingId),
        at = new Date(now).toISOString(),
        description = text(input.description);
      fail(description.length < 10, 'Describe what happened in at least 10 characters.');
      if (input.type === 'non_return') fail(b.status !== 'active' || now <= Date.parse(b.end) + (await this.store.metadata(bookingId)).policy.graceMinutes * 60000, 'A non-return report requires an active rental past its return grace period.', 409);
      const existing = await this.db.prepare("SELECT id FROM incidents WHERE booking_id=? AND status<>'resolved'").get(bookingId);
      if (existing) throw new AppError('This rental already has an open recovery case. Add evidence to it.', 409, 'INCIDENT_EXISTS', {
        incidentId: existing.id
      });
      const id = randomUUID();
      await this.db.prepare('INSERT INTO incidents VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, bookingId, actor, input.type, 'open', description, text(input.lastKnown, 300), 1, at, at, new Date(now + 2 * 3600000).toISOString(), null, null);
      await this.entry(id, actor, 'reported', description, input.image, at);
      const listing = await this.db.prepare('SELECT details FROM listings WHERE id=?').get(b.listing_id);
      await this.db.prepare('UPDATE listings SET active=0,details=? WHERE id=?').run(JSON.stringify({
        ...JSON.parse(listing.details),
        recoveryHold: true
      }), b.listing_id);
      await this.store.addTrace(bookingId, 'Recovery case opened', 'A participant reported an issue. The item is paused, evidence is retained, and an operator review is queued. No blame, fee, deduction, or return is assumed.');
      await this.notify(b, id, `incident_opened:${id}`, 'A recovery case was opened. Review the evidence and arrange a safe return. No money was automatically charged.', at);
      await this.impact(b, id, at);
      return await this.get(id, actor);
    });
  }
  async action(actor, id, input) {
    return await this.store.transaction(async () => {
      const incident = await this.get(id, actor),
        {
          b,
          isHost,
          isRenter,
          independent
        } = await this.context(incident.bookingId, actor);
      if (!Number.isInteger(input.expectedVersion) || input.expectedVersion !== incident.version) throw new AppError('This case changed. Reload it before deciding.', 409, 'STALE_INCIDENT', {
        currentVersion: incident.version
      });
      fail(incident.status === 'resolved', 'This recovery case is closed.', 409);
      const note = text(input.note),
        action = input.action,
        now = await this.store.now(b.id),
        at = new Date(now).toISOString();
      fail(note.length < 10, 'Record a reason in at least 10 characters.');
      let status = incident.status,
        plan = incident.plan,
        resolution = null,
        reviewDue = incident.reviewDueAt;
      if (['acknowledge', 'escalate', 'verify-return', 'resolve'].includes(action)) fail(!independent, 'An independent operator must perform this action.', 403);
      if (action === 'add-evidence') {
        await this.entry(id, actor, 'evidence', note, input.image, at);
      } else if (action === 'acknowledge') {
        status = 'investigating';
        reviewDue = new Date(now + 24 * 3600000).toISOString();
      } else if (action === 'escalate') {
        status = 'escalated';
      } else if (action === 'propose-return') {
        fail(!isHost && !isRenter, 'A rental participant must propose the return.', 403);
        const returnAt = Date.parse(input.returnAt);
        fail(!Number.isFinite(returnAt) || returnAt <= now || returnAt > now + 7 * 86400000, 'Choose a return time within the next seven days.');
        plan = {
          returnAt: new Date(returnAt).toISOString(),
          proposedBy: actor,
          confirmedBy: null,
          note
        };
        if (incident.status !== 'escalated') {
          status = 'awaiting_return';
          reviewDue = new Date(Math.min(returnAt, now + 24 * 3600000)).toISOString();
        }
      } else if (action === 'confirm-return-plan') {
        fail(!isHost && !isRenter, 'Only the other rental participant can confirm a return plan.', 403);
        fail(!plan || plan.proposedBy === actor || plan.confirmedBy, 'There is no return plan for you to confirm.', 409);
        fail(Date.parse(plan.returnAt) <= now, 'This proposed return time has passed. Propose another time.', 409);
        plan = {
          ...plan,
          confirmedBy: actor
        };
        if (incident.status !== 'escalated') status = 'awaiting_return';
      } else if (action === 'record-owner-receipt') {
        fail(!isHost, 'Only the owner can record receiving the item.', 403);
        fail(b.status !== 'active', 'This rental is not awaiting physical return.', 409);
        fail(!imageValid(input.image), 'Record a condition photo for the received item.');
        await this.entry(id, actor, 'owner_receipt', note, input.image, at);
      } else if (action === 'verify-return') {
        fail(b.status !== 'active', 'This rental is not awaiting a manual return.', 409);
        const receipt = await this.db.prepare("SELECT * FROM incident_entries WHERE incident_id=? AND actor_id=? AND kind='owner_receipt' ORDER BY rowid DESC LIMIT 1").get(id, b.owner_id);
        fail(!receipt, 'The owner must first record receipt with a condition photo.', 409);
        await this.db.prepare('INSERT INTO evidence VALUES(?,?,?,?,?,?)').run(randomUUID(), b.id, 'Return', `Manual recovery verified by ${(await this.store.user(actor)).name}: ${note}`, receipt.image, at);
        await this.db.prepare("UPDATE bookings SET status='completed' WHERE id=?").run(b.id);
        const meta = await this.store.metadata(b.id);
        meta.details.returnedAt = at;
        if (meta.details.extension?.status === 'pending') meta.details.extension.status = 'cancelled';
        await this.store.saveMetadata(b.id, meta);
        await this.store.addTrace(b.id, 'Return recorded by independent operator', 'The owner supplied a receipt photo and an operator recorded a reason. The ordinary return code was unavailable. No deduction was made; the recovery hold remains.');
      } else if (action === 'resolve') {
        const returned = input.outcome === 'returned' && ['completed', 'under_review'].includes(b.status) && !!(await this.db.prepare("SELECT 1 FROM evidence WHERE booking_id=? AND stage='Return'").get(b.id));
        const cancelled = input.outcome === 'handover_cancelled' && ['cancelled', 'declined', 'expired'].includes(b.status);
        fail(!returned && !cancelled, 'Close only after a recorded return or a cancelled handover. An unrecovered item must stay escalated.', 409);
        status = 'resolved';
        resolution = {
          outcome: input.outcome,
          note,
          operatorId: actor,
          at
        };
        await this.store.addTrace(b.id, 'Recovery case resolved', `${note} The listing stays paused until the owner checks readiness. No fee or deduction was applied by this case.`);
      } else throw new AppError('Unknown recovery action.');
      if (!['add-evidence', 'record-owner-receipt'].includes(action)) await this.entry(id, actor, action, note, null, at);
      await this.db.prepare('UPDATE incidents SET status=?,version=version+1,updated_at=?,review_due_at=?,plan=?,resolution=? WHERE id=?').run(status, at, reviewDue, plan ? JSON.stringify(plan) : null, resolution ? JSON.stringify(resolution) : null, id);
      await this.notify(b, id, `incident_updated:${id}:${incident.version + 1}`, 'A recovery case was updated. Review the case for the recorded action and next steps.', at);
      await this.store.settlement.sync(b.id);
      return await this.get(id, actor);
    });
  }
  async evaluate() {
    for (const row of await this.db.prepare("SELECT * FROM incidents WHERE status NOT IN ('resolved','escalated')").all()) {
      const now = await this.store.now(row.booking_id);
      if (now <= Date.parse(row.review_due_at)) continue;
      const at = new Date(now).toISOString(),
        b = await this.db.prepare('SELECT b.*,l.owner_id FROM bookings b JOIN listings l ON l.id=b.listing_id WHERE b.id=?').get(row.booking_id);
      await this.db.prepare("UPDATE incidents SET status='escalated',version=version+1,updated_at=? WHERE id=?").run(at, row.id);
      await this.store.addTrace(row.booking_id, 'Recovery review overdue', 'The review or return-plan deadline passed. The case remains open and the item remains paused. In-app escalation was queued; no external delivery is claimed.');
      await this.notify(b, row.id, `incident_escalated:${row.id}:${row.version + 1}`, 'Recovery needs operator attention: its review or return-plan deadline passed. The item remains blocked.', at);
    }
  }
  async notices(actor, before) {
    fail(before !== null && before !== undefined && !/^[1-9][0-9]*$/.test(String(before)), 'Use a valid notice cursor.');
    const cursor = before ? Number(before) : Number.MAX_SAFE_INTEGER;
    fail(!Number.isSafeInteger(cursor), 'Use a valid notice cursor.');
    const rows = await this.db.prepare('SELECT rowid AS cursor,id,booking_id AS bookingId,incident_id AS incidentId,kind,message,created_at AS createdAt,read_at AS readAt FROM safety_notices WHERE recipient_id=? AND rowid<? ORDER BY rowid DESC LIMIT 101').all(actor, cursor);
    const notices = rows.slice(0, 100);
    return {
      notices,
      nextCursor: rows.length > 100 ? String(notices.at(-1).cursor) : null,
      unreadCount: (await this.db.prepare('SELECT COUNT(*) AS count FROM safety_notices WHERE recipient_id=? AND read_at IS NULL').get(actor)).count,
      delivery: 'in_app_only'
    };
  }
  async readNotice(actor, id) {
    const notice = await this.db.prepare('SELECT * FROM safety_notices WHERE id=? AND recipient_id=?').get(id, actor);
    fail(!notice, 'Notice not found.', 404);
    await this.db.prepare('UPDATE safety_notices SET read_at=COALESCE(read_at,?) WHERE id=? AND recipient_id=?').run(new Date().toISOString(), id, actor);
    return {
      id,
      read: true
    };
  }
  async plan(bookingId, actor) {
    const {
      b,
      independent
    } = await this.context(bookingId, actor);
    fail(independent && !(await this.hasCase(bookingId)) && !(await this.store.metadata(bookingId)).details.claim, 'This booking has no case for operator review.', 403);
    const listing = await this.store.listing(b.listing_id, actor);
    const cases = await this.summary(bookingId);
    const held = !!(listing.conditionHold || listing.recoveryHold || (await this.hasOpen(listing.id)));
    const start = new Date(Math.max(Date.parse(b.start), Date.now() + 60000)).toISOString();
    const end = new Date(Math.max(Date.parse(b.end), Date.parse(start) + (listing.unit === 'hour' ? 3600000 : 86400000))).toISOString();
    const alternatives = (await this.store.search({
      city: listing.city,
      category: listing.category,
      start,
      end
    }, actor)).filter(l => l.id !== listing.id && l.ownerId !== actor).slice(0, 3).map(l => ({
      id: l.id,
      title: l.title,
      city: l.city,
      quote: l.quote
    }));
    const evidence = (await this.db.prepare('SELECT id,stage,created_at AS createdAt,image FROM evidence WHERE booking_id=? ORDER BY created_at,rowid').all(bookingId)).map(({
      image,
      ...e
    }) => ({
      ...e,
      digest: evidenceDigest(image)
    }));
    return {
      bookingId,
      held,
      cases,
      lastRecordedCustody: evidence.some(e => e.stage === 'Return') ? 'owner_after_recorded_return' : evidence.some(e => e.stage === 'Collection') ? 'renter_after_recorded_collection' : 'handover_not_recorded',
      evidence,
      nextSteps: ['Stop using an unsafe item and preserve its condition; do not attempt an unapproved repair.', 'Record what happened and the last known location in a recovery case.', 'Arrange a mutually confirmed safe return; a recovery plan does not extend the rental or add a fee.', 'If a return code is unavailable, the owner records receipt and an independent operator can verify the return.', 'Unrecovered items remain escalated. Closing a report does not prove recovery or provide insurance.'],
      alternatives,
      alternativeDates: {
        start,
        end
      },
      alternativesRequireNewConsent: true,
      alternativesAreEquivalent: false,
      automaticReplacement: false,
      automaticCharge: false,
      delivery: 'in_app_only',
      limitations: ['Demo identities are not verified.', 'Photos and hashes preserve records; they do not independently prove who caused damage.', 'No insurer, recovery service, repair partner, live support SLA, or external notice delivery is connected.']
    };
  }
  async initialize() {
    await this.db.exec(`CREATE TABLE IF NOT EXISTS incidents(
      id TEXT PRIMARY KEY,booking_id TEXT NOT NULL REFERENCES bookings(id),reporter_id TEXT NOT NULL REFERENCES users(id),
      type TEXT NOT NULL,status TEXT NOT NULL,description TEXT NOT NULL,last_known TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,review_due_at TEXT NOT NULL,
      plan TEXT,resolution TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS incident_one_open ON incidents(booking_id) WHERE status<>'resolved';
      CREATE TABLE IF NOT EXISTS incident_entries(
        id TEXT PRIMARY KEY,incident_id TEXT NOT NULL REFERENCES incidents(id),actor_id TEXT NOT NULL REFERENCES users(id),
        kind TEXT NOT NULL,note TEXT NOT NULL,image TEXT,digest TEXT,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS safety_notices(
        id TEXT PRIMARY KEY,recipient_id TEXT NOT NULL REFERENCES users(id),dedupe_key TEXT NOT NULL UNIQUE,
        booking_id TEXT NOT NULL REFERENCES bookings(id),incident_id TEXT REFERENCES incidents(id),
        kind TEXT NOT NULL,message TEXT NOT NULL,created_at TEXT NOT NULL,read_at TEXT);`);
  }
}
