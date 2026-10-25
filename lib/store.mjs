import { Database, asyncFilter, asyncSome } from './database.mjs';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { categories, demoUsers, listings as seedListings } from './seed.mjs';
import { attentionFor, rentalPolicy } from './rental-policy.mjs';
import { AppError, fail } from './errors.mjs';
import { Commands } from './commands.mjs';
import { Recovery } from './recovery.mjs';
import { applyMigrations, migrationStatus } from './migrations.mjs';
import { Accounts, SESSION_MS } from './accounts.mjs';
import { Profiles } from './profiles.mjs';
import { Capacity } from './capacity.mjs';
import { Messages } from './messages.mjs';
import { Ops } from './ops.mjs';
import { Handover } from './handover.mjs';
import { Settlement } from './settlement.mjs';
export { AppError, fail } from './errors.mjs';
const parse = (text, fallback = {}) => {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};
const trim = (value, max = 2000) => String(value ?? '').trim().slice(0, max);
const code = () => String(randomInt(100000, 1000000));
import { checkImage } from './images.mjs'; export const validImage = image => checkImage(image).ok;
export function timeRange(start, end, now = Date.now()) {
  const a = Date.parse(start),
    b = Date.parse(end);
  fail(!Number.isFinite(a) || !Number.isFinite(b), 'Choose valid collection and return dates.');
  fail(b <= a, 'The return time must be after collection.');
  fail(a < now - 60_000, 'Choose a collection time in the future.');
  fail(b - a > 92 * 86400_000, 'Bookings can be up to 92 days long.');
  fail(a - now > 366 * 86400_000, 'Choose dates within the next year.');
  return {
    start: new Date(a).toISOString(),
    end: new Date(b).toISOString()
  };
}
export function quote(listing, start, end) {
  const difference = Date.parse(end) - Date.parse(start);
  fail(!Number.isFinite(difference) || difference <= 0, 'Choose a valid booking period.');
  const units = Math.max(1, Math.ceil(difference / (listing.unit === 'hour' ? 3600_000 : 86400_000)));
  const rental = units * listing.rate;
  return {
    units,
    unit: listing.unit,
    rate: listing.rate,
    rental,
    deposit: listing.deposit,
    total: rental + listing.deposit,
    currency: 'INR'
  };
}
export class Store {
  constructor(path = ':memory:', {
    seed = true,
    autoMigrate
  } = {}) {
    if (!/^postgres(?:ql)?:\/\//.test(path) && path !== ':memory:') mkdirSync(dirname(path), {
      recursive: true
    });
    this.db = new Database(path);
    this.seedEnabled = seed;
    // PostgreSQL never migrates implicitly: take a recovery point and run `npm run db:migrate`.
    this.autoMigrate = autoMigrate ?? (!this.db.postgres || process.env.SPARELY_MIGRATE_ON_START === '1');
    this.ready = this.initialize();
  }
  async close() {
    this.closing ||= (async () => { try { await this.ready; } catch {} finally { await this.db.close(); } })();
    return await this.closing;
  }
  async transaction(fn) {
    return await this.db.transaction(fn);
  }
  // The shared demo profiles (users without a real account).
  async users() {
    return await this.db.prepare('SELECT u.* FROM users u LEFT JOIN accounts a ON a.user_id=u.id WHERE a.user_id IS NULL ORDER BY u.id').all();
  }
  async user(id) {
    const u = await this.db.prepare('SELECT * FROM users WHERE id=?').get(id);
    fail(!u, 'Profile not found.', 404);
    return u;
  }
  async session(token) {
    return await this.db.prepare('SELECT users.* FROM users JOIN sessions ON users.id=sessions.user_id WHERE token=? AND expires>?').get(token || '', Date.now());
  }
  async createSession(userId) {
    await this.user(userId);
    const token = randomBytes(32).toString('hex');
    await this.db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
    await this.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(token, userId, Date.now() + SESSION_MS);
    return token;
  }
  async endSession(token) {
    await this.db.prepare('DELETE FROM sessions WHERE token=?').run(token);
  }
  async sameWorld(a, b) {
    return (await this.accounts.world(a)) === (await this.accounts.world(b));
  }
  // A listing as seen by a viewer: listings in the other world (demo vs real accounts) do not exist for them.
  async visibleListing(id, userId) {
    const l = await this.listing(id, userId);
    fail(userId && l.ownerId !== userId && !(await this.sameWorld(l.ownerId, userId)), 'This listing could not be found.', 404);
    return l;
  }
  async metadata(id) {
    const row = await this.db.prepare('SELECT * FROM booking_meta WHERE booking_id=?').get(id);
    if (row) return {
      policy: parse(row.policy),
      details: parse(row.details)
    };
    const value = {
      policy: structuredClone(rentalPolicy),
      details: {}
    };
    await this.db.prepare('INSERT OR IGNORE INTO booking_meta VALUES(?,?,?)').run(id, JSON.stringify(value.policy), '{}');
    return value;
  }
  async saveMetadata(id, meta) {
    await this.db.prepare('UPDATE booking_meta SET policy=?,details=? WHERE booking_id=?').run(JSON.stringify(meta.policy), JSON.stringify(meta.details), id);
  }
  async now(id) {
    return Date.now() + ((await this.metadata(id)).details.offsetMs || 0);
  }
  async addTrace(id, title, detail) {
    const row = await this.db.prepare('SELECT trace FROM bookings WHERE id=?').get(id);
    const trace = parse(row.trace, []);
    trace.push({
      at: new Date(await this.now(id)).toISOString(),
      title,
      detail
    });
    await this.db.prepare('UPDATE bookings SET trace=? WHERE id=?').run(JSON.stringify(trace), id);
  }
  async expire() {
    for (const b of await this.db.prepare("SELECT * FROM bookings WHERE status='requested'").all()) {
      if (b.hold_until >= (await this.now(b.id))) continue;
      await this.db.prepare("UPDATE bookings SET status='expired' WHERE id=? AND status='requested'").run(b.id);
      await this.addTrace(b.id, 'Request expired', 'The 30-minute confirmation window ended. These dates are available again.');
      await this.settlement.sync(b.id);
    }
  }
  async evaluate() {
    return await this.transaction(async () => await this.evaluateRentals());
  }
  async evaluateRentals() {
    await this.expire();
    await this.recovery.evaluate();
    for (const b of await this.db.prepare("SELECT * FROM bookings WHERE status IN ('active','confirmed','under_review')").all()) {
      const meta = await this.metadata(b.id),
        now = await this.now(b.id);
      const listing = await this.listing(b.listing_id);
      const attention = b.status === 'confirmed' && (listing.conditionHold || listing.recoveryHold) ? {
        kind: 'unavailable',
        detail: 'An earlier rental reported a condition issue. Contact the host or cancel; collection is blocked until review and readiness are complete.'
      } : attentionFor(b, meta.details, now, meta.policy);
      if (attention && ['overdue', 'pickup_missed', 'unavailable'].includes(attention.kind) && !meta.details.alerts?.[attention.kind]) {
        meta.details.alerts = {
          ...meta.details.alerts,
          [attention.kind]: true
        };
        await this.saveMetadata(b.id, meta);
        await this.addTrace(b.id, attention.kind === 'overdue' ? 'Overdue alert raised' : attention.kind === 'unavailable' ? 'Upcoming collection at risk' : 'Collection needs attention', `${attention.detail} This is an in-app alert; no external message was sent.`);
      }
    }
  }
  async listing(id, userId, { summary = false } = {}) {
    const l = await this.db.prepare('SELECT l.*,u.name AS owner_name,u.initials AS owner_initials FROM listings l JOIN users u ON l.owner_id=u.id WHERE l.id=?').get(id);
    fail(!l, 'This listing could not be found.', 404);
    const favorite = userId ? !!(await this.db.prepare('SELECT 1 FROM favorites WHERE user_id=? AND listing_id=?').get(userId, id)) : false;
    const details = parse(l.details);
    const blocks = await this.db.prepare('SELECT id,starts_at AS start,ends_at AS end,note FROM listing_blocks WHERE listing_id=? AND removed_at IS NULL ORDER BY starts_at').all(id);
    const booked = await this.db.prepare("SELECT start,end FROM bookings WHERE listing_id=? AND status IN ('requested','confirmed','active') ORDER BY start").all(id);
    const profile = await this.profiles.publicView(id, { withPhotos: !summary });
    const storage = l.category === 'storage' ? await this.capacity.listingInfo({ id, category: l.category, ownerId: l.owner_id, city: l.city, profile }) : null;
    return {
      id: l.id,
      ownerId: l.owner_id,
      ownerName: l.owner_name,
      ownerInitials: l.owner_initials,
      title: l.title,
      description: l.description,
      category: l.category,
      city: l.city,
      area: l.area,
      rate: l.rate,
      unit: l.unit,
      deposit: l.deposit,
      image: l.photo || `/assets/${l.image}.svg`,
      active: !!l.active,
      favorite,
      createdAt: l.created_at,
      policy: rentalPolicy,
      ...details,
      version: details.version || 1,
      retired: details.retired || null,
      draft: !!details.draft,
      profile,
      needsOnboarding: l.category === 'storage' && profile?.status !== 'complete',
      storage,
      blocked: [...booked.map(b => ({ ...b, kind: 'booking' })), ...blocks.map(b => ({ start: b.start, end: b.end, kind: 'host' }))].sort((a, b) => a.start.localeCompare(b.start)),
      ...(userId && userId === l.owner_id ? { hostBlocks: blocks } : {})
    };
  }
  async available(id, start, end, exclude = '', footprintTenths = null) {
    const listing = await this.listing(id, undefined, { summary: true });
    if (listing.recoveryHold || (await this.recovery.hasOpen(id))) return false;
    if (await this.db.prepare('SELECT 1 FROM listing_blocks WHERE listing_id=? AND removed_at IS NULL AND starts_at<? AND ends_at>? LIMIT 1').get(id, end, start)) return false;
    if (this.capacity.shared(listing)) return await this.capacity.fits(listing, start, end, footprintTenths ?? (exclude ? await this.capacity.footprint(exclude) : null), exclude);
    if (await asyncSome(await this.db.prepare("SELECT * FROM bookings WHERE listing_id=? AND id<>? AND status='active'").all(id, exclude), async b => Date.parse(b.end) < (await this.now(b.id)))) return false;
    return !(await this.db.prepare("SELECT 1 FROM bookings WHERE listing_id=? AND id<>? AND status IN ('requested','confirmed','active') AND start<? AND end>? LIMIT 1").get(id, exclude, end, start));
  }
  async search(filters = {}, userId) {
    await this.expire();
    const world = userId ? await this.accounts.world(userId) : 'demo';
    let rows = await Promise.all((await this.db.prepare(`SELECT l.id FROM listings l LEFT JOIN accounts a ON a.user_id=l.owner_id WHERE l.active=1 AND a.user_id IS ${world === 'account' ? 'NOT ' : ''}NULL ORDER BY l.created_at,l.id`).all()).map(async r => await this.listing(r.id, userId, { summary: true })));
    rows = rows.filter(l => !l.demoScenario);
    if (filters.city) rows = rows.filter(l => l.city === filters.city);
    if (filters.category && filters.category !== 'all') rows = rows.filter(l => l.category === filters.category);
    if (filters.saved === 'true') rows = rows.filter(l => l.favorite);
    if (filters.owner) rows = rows.filter(l => l.ownerId === filters.owner);
    if (filters.q?.trim()) {
      const terms = filters.q.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
      rows = rows.map(l => ({
        ...l,
        relevance: terms.reduce((s, t) => s + (`${l.title} ${l.area} ${l.tags} ${l.category}`.toLowerCase().includes(t) ? 1 : 0), 0)
      })).filter(l => l.relevance > 0).sort((a, b) => b.relevance - a.relevance);
    }
    if (filters.maxRate) rows = rows.filter(l => l.rate <= Number(filters.maxRate));
    if (filters.noDeposit === 'true') rows = rows.filter(l => l.deposit === 0);
    if (filters.start || filters.end) {
      const {
        start,
        end
      } = timeRange(filters.start, filters.end);
      rows = (await asyncFilter(rows, async l => await this.available(l.id, start, end))).map(l => this.capacity.isAreaPriced(l) ? l : ({
        ...l,
        quote: quote(l, start, end)
      }));
    }
    if (filters.sort === 'price') rows.sort((a, b) => (a.quote?.rental ?? a.rate * (a.unit === 'hour' ? 24 : 1)) - (b.quote?.rental ?? b.rate * (b.unit === 'hour' ? 24 : 1)));else if (filters.sort === 'distance') rows.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));else if (filters.sort === 'newest') rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return rows;
  }
  async favorite(userId, listingId, saved) {
    await this.visibleListing(listingId, userId);
    if (saved) await this.db.prepare('INSERT OR IGNORE INTO favorites VALUES(?,?)').run(userId, listingId);else await this.db.prepare('DELETE FROM favorites WHERE user_id=? AND listing_id=?').run(userId, listingId);
  }
  // New listings are drafts until their onboarding facts are complete (profiles.publish).
  // `internal` is only for demo scenario clones, which copy a complete sample profile.
  async createListing(userId, input, { internal = false } = {}) {
    const title = trim(input.title, 90),
      description = trim(input.description),
      area = trim(input.area, 80);
    fail(title.length < 6 || description.length < 30 || area.length < 2, 'Add a title of at least 6 characters, a description of 30 characters, and your area.');
    fail(!categories.some(c => c.id === input.category), 'Choose a supported category.');
    fail(!['Hyderabad', 'Bengaluru'].includes(input.city), 'Choose Hyderabad or Bengaluru.');
    fail(!['hour', 'day'].includes(input.unit), 'Choose an hourly or daily rate.');
    const rate = Number(input.rate),
      deposit = Number(input.deposit || 0);
    fail(!Number.isInteger(rate) || rate < 1 || rate > 100000 || !Number.isInteger(deposit) || deposit < 0 || deposit > 500000, 'Enter whole-rupee prices within the allowed range.');
    fail(input.photo && !validImage(input.photo), 'Upload a JPG, PNG, or WebP image under 3 MB.');
    const defaults = {
      storage: 'storage',
      parking: 'parking',
      work: 'laptop',
      creator: 'camera',
      tools: 'drill',
      spaces: 'workspace'
    };
    const lines = value => String(value || '').split('\n').map(s => s.trim().slice(0, 200)).filter(Boolean).slice(0, 12);
    const id = `listing-${randomUUID()}`;
    const details = {
      included: lines(input.included),
      rules: lines(input.rules),
      specs: {
        'Collection': 'Arrange with host'
      },
      tags: trim(input.tags || title, 500),
      distance: null,
      ...(internal ? {} : { draft: true })
    };
    return await this.transaction(async () => {
      await this.db.prepare('INSERT INTO listings VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, userId, title, description, input.category, input.city, area, rate, input.unit, deposit, defaults[input.category], input.photo || null, JSON.stringify(details), internal ? 1 : 0, new Date().toISOString());
      if (!internal && input.profile) {
        await this.profiles.save(userId, id, { version: 0, facts: input.profile.facts, addPhotos: input.profile.addPhotos });
        if (input.category === 'storage' && input.storageRatePaise !== undefined) await this.capacity.setRate(userId, id, { ratePaise: input.storageRatePaise });
        if (input.publish !== false) return await this.profiles.publish(userId, id);
      }
      return await this.listing(id, userId);
    });
  }
  async toggleListing(userId, id, active) {
    const l = await this.listing(id);
    fail(l.ownerId !== userId, 'Only the owner can change this listing.', 403);
    fail(active && l.retired, 'This item or category is no longer offered on Sparely.', 409);
    fail(active && l.draft, 'Finish and publish the listing details first.', 409);
    fail(active && (await this.recovery.hasOpen(id)), 'Resolve the recovery case before making this item available again.', 409);
    fail(active && (await this.db.prepare("SELECT 1 FROM bookings WHERE listing_id=? AND status='under_review'").get(id)), 'Resolve the condition review before making this item available again.', 409);
    if (active && (l.conditionHold || l.recoveryHold)) {
      const raw = await this.db.prepare('SELECT details FROM listings WHERE id=?').get(id);
      await this.db.prepare('UPDATE listings SET details=? WHERE id=?').run(JSON.stringify({
        ...parse(raw.details),
        conditionHold: false,
        recoveryHold: false
      }), id);
    }
    await this.db.prepare('UPDATE listings SET active=? WHERE id=?').run(active ? 1 : 0, id);
    return await this.listing(id, userId);
  }
  async createBooking(userId, input) {
    await this.expire();
    return await this.transaction(async () => {
      const l = await this.visibleListing(input.listingId, userId);
      fail(l.retired, 'This item is no longer offered on Sparely.', 409);
      fail(!l.active, 'This listing is paused.');
      if (!(await this.profiles.bookable(l))) throw new AppError('The host still needs to complete the storage details before taking new bookings.', 409, 'STORAGE_INCOMPLETE');
      fail(l.ownerId === userId, 'You cannot book your own listing.');
      const {
        start,
        end
      } = timeRange(input.start, input.end);
      const intake = l.category === 'storage' ? this.capacity.normaliseIntake(input.intake, l) : null;
      if (!(await this.available(l.id, start, end, '', intake?.footprintTenths ?? null))) throw new AppError(this.capacity.shared(l) ? 'Not enough floor area is free for those dates. Try less space or other dates.' : 'These dates were just reserved. Choose another time.', 409, this.capacity.shared(l) ? 'CAPACITY_FULL' : 'DATES_TAKEN');
      fail(input.agreed !== true, 'Confirm that you have read the listing rules.');
      const cost = (intake && await this.capacity.storageQuote(l, start, end, intake)) || quote(l, start, end),
        id = randomUUID(),
        at = new Date().toISOString();
      const trace = [{
        at,
        title: 'Dates checked',
        detail: 'The inventory was checked inside the reservation transaction.'
      }, {
        at,
        title: 'Request sent',
        detail: `Dates held for 30 minutes while ${l.ownerName.split(' ')[0]} confirms. No payment was taken.`
      }];
      await this.db.prepare('INSERT INTO bookings VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, l.id, userId, start, end, 'requested', trim(input.note, 1000), JSON.stringify(cost), null, null, Date.now() + 30 * 60_000, JSON.stringify(trace), at);
      const meta = await this.metadata(id);
      meta.details.agreement = {
        version: 'agreement-v1',
        capturedAt: at,
        hostId: l.ownerId,
        renterId: userId,
        listing: {
          id: l.id,
          title: l.title,
          description: l.description,
          category: l.category,
          included: l.included,
          rules: l.rules,
          specs: l.specs
        },
        start,
        end,
        quote: cost,
        policyVersion: meta.policy.version,
        conditionVerification: 'host_code_and_photo_only',
        // Host-declared facts as shown at booking time (no photos; not verified by Sparely).
        disclosures: l.profile ? { version: l.profile.version, sample: l.profile.sample, facts: l.profile.facts } : null,
        storage: intake ? { mode: l.storage?.mode, usableSqft: l.storage?.usableSqft, reservedSqft: intake.footprintTenths / 10, items: intake.items, accessNeeds: intake.accessNeeds, environment: intake.environment, prohibitedAcknowledged: true, fitDisclaimer: 'Floor area is not a packing guarantee: height, shape and entrance size also matter.' } : null,
        // Cancellation / no-show consequences disclosed before booking (M6), frozen with the policy.
        cancellation: meta.policy.cancellation || null
      };
      if (intake) await this.capacity.record(id, l.id, intake);
      await this.saveMetadata(id, meta);
      // Versioned agreement revision 1; the renter's request accepts it (the host's confirmation will too).
      await this.handover.start(id, meta.details.agreement, userId, at);
      return await this.booking(id, userId);
    });
  }
  async booking(id, userId) {
    const b = await this.db.prepare('SELECT * FROM bookings WHERE id=?').get(id);
    fail(!b, 'Booking not found.', 404);
    const meta = await this.metadata(id),
      canReview = (await this.user(userId)).role === 'Operator' && (!!meta.details.claim || (meta.details.noShowReports || []).length > 0 || (await this.recovery.hasCase(id))) && (await this.sameWorld(userId, b.renter_id));
    const l = await this.listing(b.listing_id, userId);
    fail(userId !== b.renter_id && userId !== l.ownerId && !canReview, 'This booking belongs to another profile.', 403);
    const isHost = userId === l.ownerId;
    const isRenter = userId === b.renter_id,
      now = await this.now(id);
    const attention = ['requested', 'confirmed'].includes(b.status) && (l.conditionHold || l.recoveryHold) ? {
      kind: 'unavailable',
      title: 'This collection is at risk after an earlier return.',
      detail: 'The item has a condition issue. Contact the host or cancel; it cannot be collected until the review is resolved and the host marks it ready.'
    } : attentionFor(b, meta.details, now, meta.policy);
    const claim = meta.details.claim || null;
    // Exact address and access steps: renter once confirmed/active/under review, the owner, or a reviewing operator.
    const accessAllowed = isHost || canReview || (isRenter && ['confirmed', 'active', 'under_review'].includes(b.status));
    return {
      id: b.id,
      listing: l,
      access: accessAllowed ? await this.profiles.privateFacts(l.id) : null,
      renter: await this.user(b.renter_id),
      start: b.start,
      end: b.end,
      status: b.status,
      note: b.note,
      quote: parse(b.quote),
      pickupCode: isRenter && b.status === 'confirmed' ? b.pickup_code : null,
      returnCode: isRenter && b.status === 'active' ? b.return_code : null,
      holdUntil: b.hold_until,
      trace: parse(b.trace, []),
      isHost,
      isRenter,
      canReview,
      recovery: await this.recovery.summary(id),
      agreement: meta.details.agreement || null,
      policy: meta.policy,
      attention,
      claim,
      extension: meta.details.extension || null,
      demoScenario: meta.details.demo || null,
      effectiveNow: new Date(now).toISOString(),
      depositDeduction: claim?.decision?.amount || 0,
      createdAt: b.created_at,
      storage: l.category === 'storage' ? await this.capacity.bookingStorage(id) : null,
      evidence: await this.db.prepare('SELECT id,stage,note,image,created_at AS createdAt FROM evidence WHERE booking_id=? ORDER BY created_at').all(id)
    };
  }
  async bookings(userId, hosting = false) {
    await this.expire();
    const rows = hosting ? await this.db.prepare('SELECT b.id FROM bookings b JOIN listings l ON l.id=b.listing_id WHERE l.owner_id=? ORDER BY b.created_at DESC').all(userId) : await this.db.prepare('SELECT id FROM bookings WHERE renter_id=? ORDER BY created_at DESC').all(userId);
    return await Promise.all(rows.map(async r => await this.booking(r.id, userId)));
  }
  async transition(userId, id, input) {
    await this.expire();
    return await this.transaction(async () => {
      const b = await this.booking(id, userId),
        action = input.action;
      const meta = await this.metadata(id);
      if (['request-extension', 'approve-extension', 'decline-extension', 'respond-claim', 'resolve-claim', 'advance-demo'].includes(action)) return await this.edgeAction(userId, b, meta, input);
      const hostActions = ['accept', 'decline', 'collect', 'return'];
      fail(hostActions.includes(action) && !b.isHost, 'Only the host can do that.', 403);
      let status, title, detail;
      if (action === 'accept') {
        fail(b.status !== 'requested', 'This request is no longer awaiting confirmation.', 409);
        fail(b.listing.conditionHold || b.listing.recoveryHold, 'This item is paused for a condition or recovery review.', 409);
        fail(!(await this.available(b.listing.id, b.start, b.end, id)), 'The dates are no longer available.', 409);
        // Confirming accepts the current agreement revision (optionally pinned: a stale pin is a 409).
        const revision = await this.handover.confirmedByHost(id, userId, input.agreementRevision);
        status = 'confirmed';
        title = 'Host confirmed';
        detail = `Collection is ready to arrange. The renter can share their collection code at handover.${revision ? ` The host accepted agreement revision ${revision}.` : ''}`;
        await this.db.prepare('UPDATE bookings SET pickup_code=?,return_code=?,hold_until=NULL WHERE id=?').run(code(), code(), id);
      } else if (action === 'decline') {
        fail(b.status !== 'requested', 'Only pending requests can be declined.', 409);
        const outcome = await this.handover.recordCancellation({ id, status: b.status, start: b.start, quote: b.quote, hostId: b.listing.ownerId, renterId: b.renter.id }, meta, 'host', { reason: trim(input.note, 500) || 'Declined by the host.' });
        status = 'declined';
        title = 'Host declined';
        detail = `${trim(input.note, 500) || 'The host could not accommodate this request. The dates have been released.'} ${this.handover.describe(outcome)}`;
      } else if (action === 'cancel') {
        fail(!b.isHost && !b.isRenter, 'Only the renter or host can cancel.', 403);
        fail(!['requested', 'confirmed'].includes(b.status), 'This booking can no longer be cancelled here.', 409);
        // Outcome computed on the server from the stored quote and snapshotted policy; recorded once.
        const outcome = await this.handover.recordCancellation({ id, status: b.status, start: b.start, quote: b.quote, hostId: b.listing.ownerId, renterId: b.renter.id }, meta, b.isHost ? 'host' : 'renter', { reason: input.reason });
        status = 'cancelled';
        title = b.isHost ? 'Host cancelled' : 'Renter cancelled';
        detail = `The booking was cancelled and its dates released. ${this.handover.describe(outcome)}`;
      } else if (action === 'collect' || action === 'return') {
        fail(action === 'collect' && (b.listing.conditionHold || b.listing.recoveryHold), 'Resolve the condition review and mark the item ready before collection.', 409);
        const raw = await this.db.prepare('SELECT pickup_code,return_code FROM bookings WHERE id=?').get(id);
        fail(b.status !== (action === 'collect' ? 'confirmed' : 'active'), 'This booking is not ready for that step.', 409);
        // Collection gate: both parties accepted the current agreement revision and nobody flagged a mismatch.
        const gate = action === 'collect' ? await this.handover.assertCollectable(id) : null;
        fail(String(input.code) !== (action === 'collect' ? raw.pickup_code : raw.return_code), 'That code does not match. Ask the renter for the correct code.');
        fail(!validImage(input.image || ''), 'Add a JPG, PNG, or WebP condition photo under 3 MB.');
        const issue = input.issue || 'none';
        fail(!['none', 'damage', 'missing'].includes(issue), 'Choose normal wear, damage, or missing accessories.');
        status = action === 'collect' ? 'active' : 'completed';
        title = action === 'collect' ? 'Collected' : 'Returned and closed';
        detail = action === 'collect' ? `The host recorded a condition photo and confirmed the renter’s collection code. ${gate?.legacy ? 'This older booking has no versioned agreement.' : `Both parties had accepted agreement revision ${gate.revision}.`} Deposit hold is simulated.` : 'The host recorded the return condition and confirmed the renter’s return code. Ordinary wear is not damage. The simulated deposit is released.';
        await this.db.prepare('INSERT INTO evidence VALUES(?,?,?,?,?,?)').run(randomUUID(), id, action === 'collect' ? 'Collection' : 'Return', trim(input.note, 1000), input.image, new Date(await this.now(id)).toISOString());
        if (action === 'collect') await this.handover.afterCollect(id);
        if (action === 'return') {
          meta.details.returnedAt = new Date(await this.now(id)).toISOString();
          if (meta.details.extension?.status === 'pending') meta.details.extension.status = 'cancelled';
          if (issue !== 'none') {
            const amount = Number(input.amount);
            fail(!Number.isInteger(amount) || amount < 0 || amount > b.quote.deposit, `The proposed deduction must be between ₹0 and the ₹${b.quote.deposit} deposit.`);
            fail(trim(input.note).length < 10, 'Describe the condition issue and repair or replacement estimate in at least 10 characters.');
            meta.details.claim = {
              issue,
              amount,
              reason: trim(input.note, 1000),
              status: 'awaiting_response',
              openedAt: meta.details.returnedAt
            };
            status = 'under_review';
            title = 'Returned · condition review opened';
            detail = 'The host reported a condition issue. This is an allegation, not a decision: defects declared in the accepted agreement are pre-existing, and only an operator decision is final. The listing is paused and the simulated deposit remains on hold. The renter can accept or dispute the claim before operator review.';
            const raw = await this.db.prepare('SELECT details FROM listings WHERE id=?').get(b.listing.id);
            await this.db.prepare('UPDATE listings SET details=? WHERE id=?').run(JSON.stringify({
              ...parse(raw.details),
              conditionHold: true
            }), b.listing.id);
            await this.db.prepare('UPDATE listings SET active=0 WHERE id=?').run(b.listing.id);
          }
          await this.saveMetadata(id, meta);
        }
      } else throw new AppError('Unknown booking action.');
      const trace = [...b.trace, {
        at: new Date(await this.now(id)).toISOString(),
        title,
        detail
      }];
      await this.db.prepare('UPDATE bookings SET status=?,trace=? WHERE id=?').run(status, JSON.stringify(trace), id);
      await this.settlement.sync(id);
      return await this.booking(id, userId);
    });
  }
  async edgeAction(userId, b, meta, input) {
    const id = b.id,
      action = input.action,
      now = await this.now(id);
    if (action === 'request-extension') {
      fail(!b.isRenter, 'Only the renter can request an extension.', 403);
      fail(!['confirmed', 'active'].includes(b.status), 'This rental cannot be extended.', 409);
      fail(b.listing.conditionHold || b.listing.recoveryHold, 'The item needs a condition or recovery check before another extension can be agreed.', 409);
      fail(meta.details.extension?.status === 'pending', 'An extension is already awaiting the host’s reply.', 409);
      const endMs = Date.parse(input.end);
      fail(!Number.isFinite(endMs) || endMs <= Math.max(Date.parse(b.end), now), 'Choose a new return time after the current deadline and the scenario clock.');
      fail(endMs - Date.parse(b.start) > 92 * 86400_000, 'The full rental can be up to 92 days long.');
      const end = new Date(endMs).toISOString();
      fail(!(await this.available(b.listing.id, b.end, end, id)), 'The extension overlaps another reservation. Your current return time stays in place.', 409);
      const nextQuote = b.quote.pricingVersion === 'area-v1' ? this.capacity.extensionQuote(b.quote, b.start, end) : quote({
        ...b.listing,
        rate: b.quote.rate,
        deposit: b.quote.deposit,
        unit: b.quote.unit
      }, b.start, end);
      meta.details.extension = {
        status: 'pending',
        end,
        additionalRental: nextQuote.rental - b.quote.rental,
        quote: nextQuote,
        requestedAt: new Date(now).toISOString()
      };
      await this.saveMetadata(id, meta);
      await this.addTrace(id, 'Extension requested', `The renter proposed ${end}. Extra rental: ₹${nextQuote.rental - b.quote.rental}. The existing deadline remains until the host approves.`);
    } else if (action === 'approve-extension' || action === 'decline-extension') {
      fail(!b.isHost, 'Only the host can answer an extension request.', 403);
      fail(!['confirmed', 'active'].includes(b.status) || meta.details.extension?.status !== 'pending', 'No pending extension can be answered.', 409);
      const extension = meta.details.extension;
      if (action === 'approve-extension') {
        fail(Date.parse(extension.end) <= now, 'The proposed return time has passed. Decline this request and ask for a new time.', 409);
        fail(!(await this.available(b.listing.id, b.end, extension.end, id)), 'Another reservation now overlaps this extension. Decline this request; the original deadline stays in place.', 409);
        await this.db.prepare('UPDATE bookings SET end=?,quote=? WHERE id=?').run(extension.end, JSON.stringify(extension.quote), id);
        extension.status = 'approved';
        meta.details.alerts = {};
      } else extension.status = 'declined';
      await this.saveMetadata(id, meta);
      await this.addTrace(id, action === 'approve-extension' ? 'Extension approved' : 'Extension declined', action === 'approve-extension' ? `Both parties approved the updated return time and rental quote. New return: ${extension.end}.` : 'The original return deadline and price remain in place.');
    } else if (action === 'respond-claim') {
      fail(!b.isRenter, 'Only the renter can respond to this claim.', 403);
      const claim = meta.details.claim;
      fail(b.status !== 'under_review' || claim?.status !== 'awaiting_response', 'This claim is no longer waiting for a response.', 409);
      fail(typeof input.accepted !== 'boolean', 'Choose whether to accept or dispute the claim.');
      fail(!input.accepted && trim(input.note).length < 10, 'Explain the disagreement in at least 10 characters.');
      claim.status = input.accepted ? 'accepted' : 'disputed';
      claim.response = {
        accepted: input.accepted,
        note: trim(input.note, 1000) || 'The renter accepts the proposed claim.',
        at: new Date(now).toISOString()
      };
      await this.saveMetadata(id, meta);
      await this.addTrace(id, input.accepted ? 'Renter accepted the claim' : 'Renter disputed the claim', 'The response was recorded. The simulated deposit remains on hold until an operator decides.');
    } else if (action === 'resolve-claim') {
      fail(!b.canReview || b.isHost || b.isRenter, 'An independent operator must review this claim.', 403);
      const claim = meta.details.claim;
      fail(b.status !== 'under_review' || !claim || claim.decision, 'This claim is already closed.', 409);
      fail(!claim.response && now < Date.parse(claim.openedAt) + meta.policy.responseHours * 3600_000, `Wait for the renter’s response or the ${meta.policy.responseHours}-hour response window.`, 409);
      const amount = Number(input.amount),
        note = trim(input.note, 1000);
      fail(!Number.isInteger(amount) || amount < 0 || amount > Math.min(claim.amount, b.quote.deposit), 'The decision must be a whole-rupee amount between zero and the proposed deduction.');
      fail(note.length < 10, 'Record an evidence-based decision in at least 10 characters.');
      const evidence = await this.db.prepare('SELECT DISTINCT stage FROM evidence WHERE booking_id=?').all(id);
      fail(!evidence.some(e => e.stage === 'Collection') || !evidence.some(e => e.stage === 'Return'), 'Collection and return evidence are required for a decision.');
      claim.status = 'resolved';
      claim.decision = {
        amount,
        note,
        at: new Date(now).toISOString(),
        operator: (await this.user(userId)).name
      };
      await this.saveMetadata(id, meta);
      await this.db.prepare("UPDATE bookings SET status='completed' WHERE id=?").run(id);
      await this.addTrace(id, 'Condition review resolved', `Operator ${claim.decision.operator} approved a simulated deduction of ₹${amount}; simulated deposit release: ₹${b.quote.deposit - amount}. Reason: ${note} The item stays paused until the host marks it ready.`);
    } else if (action === 'advance-demo') {
      fail(!meta.details.demo, 'Scenario controls apply only to separately created demo rentals.', 403);
      const hours = Number(input.hours);
      fail(![1, 24, 48].includes(hours), 'Choose a one-hour, one-day, or two-day scenario advance.');
      fail((meta.details.offsetMs || 0) + hours * 3600_000 > 365 * 86400_000, 'The scenario clock is limited to one year.');
      meta.details.offsetMs = (meta.details.offsetMs || 0) + hours * 3600_000;
      await this.saveMetadata(id, meta);
      await this.addTrace(id, 'Demo clock advanced', `Only this scenario moved forward ${hours} hours. Other rentals and the real system clock are unchanged.`);
      await this.evaluate();
    }
    await this.settlement.sync(id);
    return await this.booking(id, userId);
  }
  async reviews(userId) {
    fail((await this.user(userId)).role !== 'Operator', 'Only the operator can open the review desk.', 403);
    await this.evaluate();
    const world = await this.accounts.world(userId);
    const rows = (await this.db.prepare('SELECT m.booking_id,m.details,b.renter_id FROM booking_meta m JOIN bookings b ON b.id=m.booking_id').all()).filter(row => parse(row.details).claim);
    const mine = await asyncFilter(rows, async row => (await this.accounts.world(row.renter_id)) === world);
    return (await Promise.all(mine.map(async row => await this.booking(row.booking_id, userId)))).sort((a, b) => Number(b.status === 'under_review') - Number(a.status === 'under_review'));
  }
  async createScenario(kind) {
    const labels = {
      overdue: 'Overdue return',
      damage: 'Damage disagreement',
      expired: 'Host did not reply',
      conflict: 'Extension clashes with another booking',
      // Review cases with both sides on record, for the operator case brief.
      dispute: 'Damage dispute (both sides)',
      missing: 'Item not returned · recovery case'
    };
    fail(!Object.hasOwn(labels, kind), 'Choose an available demo scenario.');
    const original = await this.listing(kind === 'overdue' ? 'storage-nook' : kind === 'conflict' ? 'covered-parking' : kind === 'missing' ? 'drill-kit' : 'light-kit');
    const l = await this.createListing(original.ownerId, {
      ...original,
      title: `Demo · ${original.title}`,
      included: original.included.join('\n'),
      rules: original.rules.join('\n'),
      photo: undefined
    }, { internal: true });
    await this.profiles.copy(original.id, l.id);
    const raw = await this.db.prepare('SELECT details FROM listings WHERE id=?').get(l.id);
    await this.db.prepare('UPDATE listings SET details=? WHERE id=?').run(JSON.stringify({
      ...parse(raw.details),
      demoScenario: true
    }), l.id);
    const startMs = Date.now() + 3600_000,
      endMs = startMs + (original.unit === 'hour' ? 3 * 3600_000 : 86400_000);
    let b = await this.createBooking('teja', {
      listingId: l.id,
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      agreed: true,
      note: `Separate hackathon scenario: ${labels[kind]}. Condition pictures are illustrative sample evidence.`,
      ...(original.category === 'storage' ? { intake: { items: [{ description: 'Sealed moving boxes (sample)', quantity: 4 }], footprintSqft: 6, prohibitedAcknowledged: true } } : {})
    });
    let meta = await this.metadata(b.id);
    meta.details.demo = {
      kind,
      label: labels[kind]
    };
    await this.saveMetadata(b.id, meta);
    const samplePhoto = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCWQAAAAASUVORK5CYII=';
    if (kind === 'expired') {
      meta.details.offsetMs = 31 * 60000;
      await this.saveMetadata(b.id, meta);
      await this.evaluate();
    } else {
      await this.transition(original.ownerId, b.id, {
        action: 'accept'
      });
      const pickupCode = (await this.booking(b.id, 'teja')).pickupCode;
      await this.transition(original.ownerId, b.id, {
        action: 'collect',
        code: pickupCode,
        image: samplePhoto,
        note: 'Illustrative sample: all accessories recorded at collection.'
      });
      if (kind === 'overdue' || kind === 'missing') {
        meta = await this.metadata(b.id);
        meta.details.offsetMs = endMs + 2 * 3600_000 - Date.now();
        await this.saveMetadata(b.id, meta);
        await this.evaluate();
      }
      if (kind === 'missing') {
        // Host opens a non-return case; both sides then add notes, as a reviewer would find it.
        let incident = await this.recovery.open(original.ownerId, b.id, {
          type: 'non_return',
          description: 'The drill kit is past its return time. The renter has not brought it back and two calls went unanswered.',
          lastKnown: 'Renter said on chat they were travelling out of the city.'
        });
        incident = await this.recovery.action('teja', incident.id, { action: 'add-evidence', expectedVersion: incident.version, note: 'I am away for a family function and can return the kit on Monday morning. The drill, both batteries and the case are safe with me.' });
        await this.recovery.action(original.ownerId, incident.id, { action: 'add-evidence', expectedVersion: incident.version, note: 'Monday is two days after the agreed return. I need the drill for a paid job on Saturday and was not told about the delay.' });
      } else if (kind === 'dispute') {
        await this.transition(original.ownerId, b.id, {
          action: 'return',
          code: (await this.booking(b.id, 'teja')).returnCode,
          image: samplePhoto,
          issue: 'damage',
          amount: 800,
          note: 'Illustrative claim: one softbox came back with a torn corner and a bent support rod. Host proposes ₹800 towards a replacement.'
        });
        await this.transition('teja', b.id, {
          action: 'respond-claim',
          accepted: false,
          note: 'The softbox corner was already frayed near the zip at collection, and I pointed it out at the door. The rod bent when it was packed back into the bag.'
        });
      } else if (kind === 'damage') {
        await this.transition(original.ownerId, b.id, {
          action: 'return',
          code: (await this.booking(b.id, 'teja')).returnCode,
          image: samplePhoto,
          issue: 'missing',
          amount: 500,
          note: 'Illustrative claim: the supplied charger is missing. Host proposes a ₹500 replacement deduction; renter can disagree.'
        });
      } else if (kind === 'conflict') {
        const nextRenter = original.ownerId === 'kabir' ? 'aanya' : 'kabir';
        const next = await this.createBooking(nextRenter, {
          listingId: l.id,
          start: new Date(endMs + 3600_000).toISOString(),
          end: new Date(endMs + 4 * 3600_000).toISOString(),
          agreed: true,
          note: 'Follow-up reservation for the extension-conflict scenario.'
        });
        const nextMeta = await this.metadata(next.id);
        nextMeta.details.demo = {
          kind: 'follow-up',
          label: 'Next reservation · scenario'
        };
        await this.saveMetadata(next.id, nextMeta);
        await this.transition(original.ownerId, next.id, {
          action: 'accept'
        });
      }
      await this.db.prepare('UPDATE evidence SET image=? WHERE booking_id=?').run(original.image, b.id);
    }
    return await this.booking(b.id, 'teja');
  }
  // Owner edits to listing details. Optimistic version check; booked agreements and quotes
  // are snapshots on each booking and are never rewritten by an edit.
  async editListing(userId, id, input) {
    return await this.transaction(async () => {
      const l = await this.listing(id);
      fail(l.ownerId !== userId, 'Only the owner can edit this listing.', 403);
      fail(l.retired, 'This item or category is no longer offered and cannot be edited.', 409);
      if (input.version !== l.version) throw new AppError('This listing changed since you opened it. Reload before saving.', 409, 'STALE_LISTING', { currentVersion: l.version });
      const title = trim(input.title, 90), description = trim(input.description), area = trim(input.area, 80);
      fail(title.length < 6 || description.length < 30 || area.length < 2, 'Add a title of at least 6 characters, a description of 30 characters, and your area.');
      const rate = Number(input.rate), deposit = Number(input.deposit || 0);
      fail(!Number.isInteger(rate) || rate < 1 || rate > 100000 || !Number.isInteger(deposit) || deposit < 0 || deposit > 500000, 'Enter whole-rupee prices within the allowed range.');
      fail(input.photo && input.photo !== 'keep' && !validImage(input.photo), 'Upload a JPG, PNG, or WebP image under 3 MB.');
      const lines = value => String(value || '').split('\n').map(s => s.trim().slice(0, 200)).filter(Boolean).slice(0, 12);
      const raw = await this.db.prepare('SELECT details,photo FROM listings WHERE id=?').get(id);
      const details = { ...parse(raw.details), included: lines(input.included), rules: lines(input.rules), version: l.version + 1, editedAt: new Date().toISOString() };
      const photo = input.photo === 'keep' || input.photo === undefined ? raw.photo : input.photo || null;
      await this.db.prepare('UPDATE listings SET title=?,description=?,area=?,rate=?,deposit=?,photo=?,details=? WHERE id=?').run(title, description, area, rate, deposit, photo, JSON.stringify(details), id);
      return await this.listing(id, userId);
    });
  }
  // Host availability blocks. A block may never overlap a pending or accepted booking:
  // the host is told which bookings conflict instead of silently invalidating them.
  async addBlock(userId, id, input) {
    return await this.transaction(async () => {
      const l = await this.listing(id);
      fail(l.ownerId !== userId, 'Only the owner can block dates.', 403);
      const { start, end } = timeRange(input.start, input.end);
      const conflicts = await this.db.prepare("SELECT id,start,end,status FROM bookings WHERE listing_id=? AND status IN ('requested','confirmed','active','under_review') AND start<? AND end>? ORDER BY start").all(id, end, start);
      if (conflicts.length) throw new AppError(`These dates overlap ${conflicts.length === 1 ? 'a booking' : `${conflicts.length} bookings`}. Cancel or reschedule ${conflicts.length === 1 ? 'it' : 'them'} with the renter first.`, 409, 'BLOCK_CONFLICT', { bookings: conflicts });
      fail((await this.db.prepare('SELECT COUNT(*) AS n FROM listing_blocks WHERE listing_id=? AND removed_at IS NULL').get(id)).n >= 50, 'A listing can have up to 50 blocked periods.');
      await this.db.prepare('INSERT INTO listing_blocks(id,listing_id,starts_at,ends_at,note,created_by,created_at,removed_at) VALUES(?,?,?,?,?,?,?,NULL)').run(randomUUID(), id, start, end, trim(input.note, 200), userId, new Date().toISOString());
      return await this.listing(id, userId);
    });
  }
  async removeBlock(userId, id, blockId) {
    return await this.transaction(async () => {
      const l = await this.listing(id);
      fail(l.ownerId !== userId, 'Only the owner can change blocked dates.', 403);
      const changed = await this.db.prepare('UPDATE listing_blocks SET removed_at=? WHERE id=? AND listing_id=? AND removed_at IS NULL').run(new Date().toISOString(), blockId, id);
      fail(!changed.changes, 'That blocked period was not found.', 404);
      return await this.listing(id, userId);
    });
  }
  async hosted(userId) {
    return await Promise.all((await this.db.prepare('SELECT id FROM listings WHERE owner_id=? ORDER BY created_at DESC').all(userId)).map(async r => await this.listing(r.id, userId)));
  }
  async initialize() {
    await this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL,initials TEXT NOT NULL,role TEXT NOT NULL,area TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS listings(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),title TEXT NOT NULL,description TEXT NOT NULL,category TEXT NOT NULL,city TEXT NOT NULL,area TEXT NOT NULL,rate INTEGER NOT NULL CHECK(rate>0),unit TEXT NOT NULL CHECK(unit IN ('hour','day')),deposit INTEGER NOT NULL CHECK(deposit>=0),image TEXT NOT NULL,photo TEXT,details TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS favorites(user_id TEXT REFERENCES users(id),listing_id TEXT REFERENCES listings(id),PRIMARY KEY(user_id,listing_id));
      CREATE TABLE IF NOT EXISTS bookings(id TEXT PRIMARY KEY,listing_id TEXT NOT NULL REFERENCES listings(id),renter_id TEXT NOT NULL REFERENCES users(id),start TEXT NOT NULL,end TEXT NOT NULL,status TEXT NOT NULL,note TEXT NOT NULL,quote TEXT NOT NULL,pickup_code TEXT,return_code TEXT,hold_until INTEGER,trace TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS booking_overlap ON bookings(listing_id,status,start,end);
      CREATE TABLE IF NOT EXISTS evidence(id TEXT PRIMARY KEY,booking_id TEXT NOT NULL REFERENCES bookings(id),stage TEXT NOT NULL,note TEXT NOT NULL,image TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS booking_meta(booking_id TEXT PRIMARY KEY REFERENCES bookings(id),policy TEXT NOT NULL,details TEXT NOT NULL);`);
    if (this.seedEnabled) {
      await this.transaction(async () => {
        for (const u of demoUsers) await this.db.prepare('INSERT OR IGNORE INTO users VALUES(?,?,?,?,?)').run(u.id, u.name, u.initials, u.role, u.area);
        const insert = this.db.prepare('INSERT OR IGNORE INTO listings VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
        for (const l of seedListings) await insert.run(l.id, l.ownerId, l.title, l.description, l.category, 'Hyderabad', l.area, l.rate, l.unit, l.deposit, l.image, null, JSON.stringify({
          included: l.included,
          specs: l.specs,
          rules: l.rules,
          tags: l.tags,
          distance: l.distance
        }), 1, new Date().toISOString());
      });
    }
    this.accounts = new Accounts(this);
    this.profiles = new Profiles(this);
    this.capacity = new Capacity(this);
    this.messages = new Messages(this);
    this.ops = new Ops(this);
    this.handover = new Handover(this);
    this.settlement = new Settlement(this);
    this.commands = new Commands(this);
    this.recovery = new Recovery(this);
    await this.commands.ready;
    await this.recovery.ready;
    const status = await migrationStatus(this.db);
    if (status.pending.length) {
      if (!this.autoMigrate) throw new AppError(`Database migrations are pending (${status.pending.join(', ')}). Take a recovery point and run npm run db:migrate.`, 503, 'MIGRATIONS_PENDING');
      await applyMigrations(this.db);
    }
  }
}
