import { randomUUID } from 'node:crypto';
import { AppError, fail } from './errors.mjs';

// M4: renter storage intake, area-based pricing with operator-configured caps, and
// transactional shared capacity.
//
// Units (exact, no floats in money): area is stored in integer TENTHS of a sq ft; rates in
// integer PAISE per sq ft per day. Storage rental (whole rupees, like every API amount) =
//   ceil(areaTenths × ratePaise × billableDays / 1000)
// where billable days are started 24-hour periods. Historical quotes are never recomputed.
//
// Occupancy is derived from booking status, so a release happens exactly once:
//   occupying = requested with an unexpired hold, confirmed, active (including overdue)
//   released  = declined, cancelled, expired, completed, under_review (goods returned)
// A booking on a shared listing without a recorded footprint counts as the whole space.

export const PRICING_VERSION = 'area-v1';
const DAY = 86400_000;
const toTenths = sqft => Math.round(Number(sqft) * 10);
const text = (v, max = 300) => String(v ?? '').trim().slice(0, max);
const FT_PER_M = 3.28084;

export class Capacity {
  constructor(store) { this.store = store; this.db = store.db; }

  // ---- caps -------------------------------------------------------------------------
  async world(userId) { return userId ? await this.store.accounts.world(userId) : 'demo'; }
  // Approved, active cap for a world: city scope first, then default.
  async capFor(world, city) {
    const rows = await this.db.prepare("SELECT * FROM pricing_caps WHERE world=? AND retired_at IS NULL AND approved=1 AND (scope='default' OR (scope='city' AND city=?)) ORDER BY CASE WHEN scope='city' THEN 0 ELSE 1 END, version DESC").all(world, city || '');
    return rows[0] ? this.capView(rows[0]) : null;
  }
  capView(r) { return { id: r.id, world: r.world, scope: r.scope, city: r.city || null, currency: r.currency, billingUnit: r.billing_unit, maxRatePaise: r.max_rate_paise, label: r.label, demoOnly: !!r.demo_only, approved: !!r.approved, version: r.version, createdBy: r.created_by, createdAt: r.created_at }; }
  async listCaps(userId) {
    const world = await this.world(userId);
    return { world, caps: (await this.db.prepare('SELECT * FROM pricing_caps WHERE world=? AND retired_at IS NULL ORDER BY scope, city, version DESC').all(world)).map(r => this.capView(r)) };
  }
  // Operators set caps for their own world. A new version replaces the previous one for the
  // same scope/city; nothing is deleted (retired_at keeps the audit trail).
  async setCap(userId, input) {
    const user = await this.store.user(userId);
    fail(user.role !== 'Operator', 'Only operators can change pricing limits.', 403);
    const world = await this.world(userId), scope = input.scope === 'city' ? 'city' : 'default';
    const city = scope === 'city' ? text(input.city, 60) : '';
    fail(scope === 'city' && !['Hyderabad', 'Bengaluru'].includes(city), 'Choose Hyderabad or Bengaluru for a city limit.');
    fail(input.currency !== 'INR' || input.billingUnit !== 'sqft_day', 'Limits are set in INR per sq ft per day.');
    const max = Number(input.maxRatePaise);
    fail(!Number.isInteger(max) || max < 1 || max > 100000, 'Enter a limit between ₹0.01 and ₹1,000 per sq ft per day.');
    const label = text(input.label, 200);
    fail(label.length < 5, 'Add a short note explaining where this limit comes from.');
    fail(input.approved !== true, 'Confirm that this limit is approved for use.');
    return await this.store.transaction(async () => {
      const previous = await this.db.prepare('SELECT * FROM pricing_caps WHERE world=? AND scope=? AND city=? AND retired_at IS NULL ORDER BY version DESC').get(world, scope, city);
      const at = new Date().toISOString(), id = `cap-${randomUUID()}`;
      if (previous) await this.db.prepare('UPDATE pricing_caps SET retired_at=? WHERE id=?').run(at, previous.id);
      await this.db.prepare('INSERT INTO pricing_caps(id,world,scope,city,currency,billing_unit,max_rate_paise,label,demo_only,approved,version,created_by,created_at,retired_at) VALUES(?,?,?,?,?,?,?,?,?,1,?,?,?,NULL)')
        .run(id, world, scope, city, 'INR', 'sqft_day', max, label, world === 'demo' ? 1 : 0, (previous?.version || 0) + 1, userId, at);
      return this.capView(await this.db.prepare('SELECT * FROM pricing_caps WHERE id=?').get(id));
    });
  }

  // ---- listing rates ----------------------------------------------------------------
  async rate(listingId) { return (await this.db.prepare('SELECT rate_paise FROM storage_pricing WHERE listing_id=?').get(listingId))?.rate_paise ?? null; }
  async setRate(userId, listingId, input) {
    return await this.store.transaction(async () => {
      const l = await this.store.listing(listingId);
      fail(l.ownerId !== userId, 'Only the owner can set this price.', 403);
      fail(l.category !== 'storage', 'Area pricing applies to storage listings only.');
      const ratePaise = Number(input.ratePaise);
      fail(!Number.isInteger(ratePaise) || ratePaise < 1, 'Enter a price of at least ₹0.01 per sq ft per day.');
      const cap = await this.capFor(await this.world(l.ownerId), l.city);
      if (!cap) throw new AppError('No approved storage price limit is configured for this city yet, so storage cannot be priced.', 409, 'PRICING_NOT_CONFIGURED');
      if (ratePaise > cap.maxRatePaise) throw new AppError(`That is above the ${rupees(cap.maxRatePaise)} per sq ft per day limit.`, 409, 'RATE_OVER_CAP', { maxRatePaise: cap.maxRatePaise });
      await this.db.prepare('INSERT INTO storage_pricing(listing_id,rate_paise,updated_at) VALUES(?,?,?) ON CONFLICT(listing_id) DO UPDATE SET rate_paise=excluded.rate_paise,updated_at=excluded.updated_at').run(listingId, ratePaise, new Date().toISOString());
      return await this.store.listing(listingId, userId);
    });
  }
  // Public storage pricing/capacity facts attached to storage listings.
  async listingInfo(l) {
    if (l.category !== 'storage') return null;
    const facts = l.profile?.facts || {}, ratePaise = await this.rate(l.id);
    const cap = await this.capFor(await this.world(l.ownerId), l.city);
    return { mode: facts.mode || null, usableSqft: facts.usableSqft ?? null, ratePaisePerSqftDay: ratePaise, pricingVersion: ratePaise ? PRICING_VERSION : 'flat-legacy', cap: cap && { maxRatePaise: cap.maxRatePaise, label: cap.label, demoOnly: cap.demoOnly, version: cap.version } };
  }
  // Publication rule for storage: needs a rate within an approved cap.
  async assertPublishable(l) {
    if (l.category !== 'storage') return;
    const ratePaise = await this.rate(l.id);
    if (!ratePaise) throw new AppError('Set a price per sq ft per day before publishing.', 400, 'PROFILE_INCOMPLETE', { missing: ['Price per sq ft per day'] });
    const cap = await this.capFor(await this.world(l.ownerId), l.city);
    if (!cap) throw new AppError('No approved storage price limit is configured for this city yet.', 409, 'PRICING_NOT_CONFIGURED');
    if (ratePaise > cap.maxRatePaise) throw new AppError(`Your price is above the ${rupees(cap.maxRatePaise)} per sq ft per day limit. Lower it first.`, 409, 'RATE_OVER_CAP', { maxRatePaise: cap.maxRatePaise });
  }

  // ---- renter intake ----------------------------------------------------------------
  normaliseIntake(raw, l) {
    fail(!raw || typeof raw !== 'object', 'Tell the host what you want to store and how much floor area you need.');
    const items = (Array.isArray(raw.items) ? raw.items : []).slice(0, 50).map(i => ({
      description: text(i.description, 120), quantity: Number(i.quantity),
      length: i.length === '' || i.length == null ? null : Number(i.length), width: i.width === '' || i.width == null ? null : Number(i.width), height: i.height === '' || i.height == null ? null : Number(i.height),
      unit: i.unit === 'm' ? 'm' : i.unit === 'cm' ? 'cm' : 'ft',
    }));
    fail(!items.length, 'List at least one item or box.');
    for (const i of items) {
      fail(i.description.length < 2, 'Describe each item or box.');
      fail(!Number.isInteger(i.quantity) || i.quantity < 1 || i.quantity > 500, 'Use a whole-number quantity for each item.');
      for (const d of [i.length, i.width, i.height]) fail(d !== null && (!Number.isFinite(d) || d <= 0 || d > 1000), 'Dimensions must be positive numbers.');
    }
    const footprintTenths = toTenths(raw.footprintSqft);
    fail(!Number.isInteger(footprintTenths) || footprintTenths < 1, 'Enter the floor area you need, in sq ft.');
    const usable = toTenths(l.profile?.facts?.usableSqft || 0);
    fail(usable && footprintTenths > usable, `That is more than the ${usable / 10} sq ft of usable floor area.`, 409);
    fail(raw.prohibitedAcknowledged !== true, 'Confirm that you will not store anything on the not-allowed list.');
    return { items, footprintTenths, accessNeeds: text(raw.accessNeeds, 500), environment: text(raw.environment, 300), prohibitedAcknowledged: true };
  }
  // Suggested floor area from item dimensions (a hint only; never a packing guarantee).
  static suggestedSqft(items) {
    const toFt = (v, u) => (u === 'm' ? v * FT_PER_M : u === 'cm' ? v * FT_PER_M / 100 : v);
    return Math.round(items.reduce((s, i) => s + (i.length && i.width ? toFt(i.length, i.unit) * toFt(i.width, i.unit) * i.quantity : 0), 0) * 10) / 10;
  }

  // ---- quotes -----------------------------------------------------------------------
  isAreaPriced(l) { return l.category === 'storage' && !!l.storage?.ratePaisePerSqftDay; }
  areaQuote({ footprintTenths, ratePaise, start, end, deposit, cap }) {
    const ms = Date.parse(end) - Date.parse(start);
    fail(!Number.isFinite(ms) || ms <= 0, 'Choose a valid booking period.');
    const days = Math.max(1, Math.ceil(ms / DAY));
    const rental = Math.ceil(footprintTenths * ratePaise * days / 1000);
    return { units: days, unit: 'day', rate: Math.round(footprintTenths * ratePaise / 10) / 100, rental, deposit, total: rental + deposit, currency: 'INR', pricingVersion: PRICING_VERSION, areaSqft: footprintTenths / 10, ratePaisePerSqftDay: ratePaise, roundingRule: 'ceil(areaTenths × ratePaise × days / 1000) rupees', cap: cap ? { id: cap.id, version: cap.version, maxRatePaise: cap.maxRatePaise, label: cap.label, demoOnly: cap.demoOnly } : null };
  }
  // Authoritative storage quote for a new request. Rechecks the rate against the cap now.
  async storageQuote(l, start, end, intake) {
    const ratePaise = await this.rate(l.id), world = await this.world(l.ownerId);
    if (!ratePaise) {
      if (world === 'account') throw new AppError('This storage listing has no price per sq ft yet.', 409, 'PRICING_NOT_CONFIGURED');
      return null; // demo legacy flat price
    }
    const cap = await this.capFor(world, l.city);
    if (!cap) throw new AppError('No approved storage price limit is configured, so this storage cannot be booked right now.', 409, 'PRICING_NOT_CONFIGURED');
    if (ratePaise > cap.maxRatePaise) throw new AppError('This listing’s price is above the current limit. The host needs to update it.', 409, 'RATE_OVER_CAP');
    return this.areaQuote({ footprintTenths: intake.footprintTenths, ratePaise, start, end, deposit: l.deposit, cap });
  }
  // Extension of an area-priced booking: same agreed rate and area (snapshot), new end.
  extensionQuote(agreed, start, end) {
    return this.areaQuote({ footprintTenths: Math.round(agreed.areaSqft * 10), ratePaise: agreed.ratePaisePerSqftDay, start, end, deposit: agreed.deposit, cap: agreed.cap });
  }

  // ---- shared capacity --------------------------------------------------------------
  shared(l) { return l.category === 'storage' && l.profile?.facts?.mode === 'shared' && Number(l.profile?.facts?.usableSqft) > 0; }
  async footprint(bookingId) { return (await this.db.prepare('SELECT footprint_tenths FROM booking_storage WHERE booking_id=?').get(bookingId))?.footprint_tenths ?? null; }
  // Highest concurrent occupied area (tenths) inside [start, end), excluding one booking.
  async peakUsage(l, start, end, exclude = '', committedOnly = false) {
    const capacity = toTenths(l.profile.facts.usableSqft);
    const rows = await this.db.prepare(`SELECT b.id,b.start,b.end,b.status,b.hold_until,s.footprint_tenths FROM bookings b LEFT JOIN booking_storage s ON s.booking_id=b.id WHERE b.listing_id=? AND b.id<>? AND b.status IN (${committedOnly ? "'confirmed','active'" : "'requested','confirmed','active'"}) AND b.start<? AND (b.end>? OR b.status='active')`).all(l.id, exclude, end, start);
    const events = [];
    for (const r of rows) {
      if (r.status === 'requested' && r.hold_until < await this.store.now(r.id)) continue; // hold expired: already released
      // Overdue active bookings keep occupying until an actual return is recorded.
      const until = r.status === 'active' ? new Date(Math.max(Date.parse(r.end), Date.parse(end))).toISOString() : r.end;
      const size = r.footprint_tenths ?? capacity; // unknown legacy footprint = the whole space
      events.push([r.start < start ? start : r.start, size], [until > end ? end : until, -size]);
    }
    // Ends before starts at the same instant: [a,b) and [b,c) do not overlap.
    events.sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1]);
    let current = 0, peak = 0;
    for (const [, delta] of events) { current += delta; peak = Math.max(peak, current); }
    return { capacity, peak };
  }
  // True if `footprintTenths` more can be reserved for the whole window.
  async fits(l, start, end, footprintTenths, exclude = '') {
    const { capacity, peak } = await this.peakUsage(l, start, end, exclude);
    return peak + (footprintTenths ?? 1) <= capacity;
  }
  async availableSqft(l, start, end) {
    if (!this.shared(l)) return null;
    const { capacity, peak } = await this.peakUsage(l, start, end);
    return Math.max(0, capacity - peak) / 10;
  }
  // Max committed (confirmed/active, unknown legacy = whole space) from now on, in sq ft.
  async committedSqft(listingId) {
    const l = await this.store.listing(listingId);
    if (!this.shared(l)) return 0;
    const now = new Date().toISOString(), far = new Date(Date.now() + 400 * DAY).toISOString();
    return (await this.peakUsage(l, now, far, '', true)).peak / 10;
  }
  async record(bookingId, listingId, intake) {
    await this.db.prepare('INSERT INTO booking_storage(booking_id,listing_id,footprint_tenths,items,access_needs,environment,acknowledged,created_at) VALUES(?,?,?,?,?,?,1,?)')
      .run(bookingId, listingId, intake.footprintTenths, JSON.stringify(intake.items), intake.accessNeeds, intake.environment, new Date().toISOString());
  }
  async bookingStorage(bookingId) {
    const r = await this.db.prepare('SELECT * FROM booking_storage WHERE booking_id=?').get(bookingId);
    return r ? { footprintSqft: r.footprint_tenths / 10, items: JSON.parse(r.items), accessNeeds: r.access_needs, environment: r.environment, suggestedSqft: Capacity.suggestedSqft(JSON.parse(r.items)) } : null;
  }
}
const rupees = paise => `₹${(paise / 100).toFixed(2)}`;
