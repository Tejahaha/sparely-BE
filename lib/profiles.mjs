import { randomUUID } from 'node:crypto';
import { AppError, fail } from './errors.mjs';

// Host onboarding facts (M3). Everything here is SELF-DECLARED by the host; nothing is
// inspected or verified by Sparely, and "unknown" is a valid, honest answer that must be
// shown as "not stated", never as a verified absence.
// Public facts appear on the listing; private facts (exact address, access instructions)
// only reach the owner, a renter with a confirmed/active booking, or an operator on a case.

const text = (value, max = 500) => String(value ?? '').trim().slice(0, max);
const num = value => (value === '' || value === null || value === undefined ? null : Number(value));
const lines = value => (Array.isArray(value) ? value : String(value || '').split('\n')).map(v => text(v, 120)).filter(Boolean).slice(0, 20);
const oneOf = (value, options) => (options.includes(value) ? value : null);
const FT_PER_M = 3.28084;
const toFeet = (value, unit) => (value === null || !Number.isFinite(value) ? null : unit === 'm' ? value * FT_PER_M : value);
const round1 = n => Math.round(n * 10) / 10;
import { checkImage } from './images.mjs'; export const validPhoto = image => checkImage(image).ok;

export const ENUMS = {
  mode: ['shared', 'exclusive'],
  unit: ['ft', 'm'],
  access: ['ground', 'lift', 'stairs'],
  damp: ['none_known', 'past', 'current', 'unknown'],
  ventilation: ['good', 'limited', 'none', 'unknown'],
  pests: ['none_known', 'treated', 'present', 'unknown'],
  yesNoUnknown: ['yes', 'no', 'unknown'],
  yesNo: ['yes', 'no'],
  notice: ['none', '2h', '24h', '48h'],
  vehicle: ['two_wheeler', 'hatchback', 'sedan', 'suv'],
  gate: ['open', 'key', 'remote', 'staffed'],
  condition: ['like_new', 'good', 'worn', 'needs_care'],
  check: ['working', 'working_with_notes'],
};

// Normalise whatever the client sent into the stored shape (unknown keys dropped).
export function normalise(category, raw = {}) {
  const p = raw.public || {}, q = raw.private || {};
  const priv = { address: text(q.address, 300), accessInstructions: text(q.accessInstructions, 1000) };
  if (category === 'storage') {
    const unit = oneOf(p.room?.unit, ENUMS.unit) || 'ft';
    const room = { length: num(p.room?.length), width: num(p.room?.width), height: num(p.room?.height), unit };
    const usableUnit = oneOf(p.usableUnit, ['sqft', 'sqm']) || 'sqft';
    const usable = num(p.usableArea);
    return {
      public: {
        mode: oneOf(p.mode, ENUMS.mode), room,
        usableArea: usable, usableUnit,
        usableSqft: usable === null ? null : round1(usableUnit === 'sqm' ? usable * FT_PER_M * FT_PER_M : usable),
        doorway: { width: num(p.doorway?.width), height: num(p.doorway?.height), unit: oneOf(p.doorway?.unit, ENUMS.unit) || unit },
        floor: text(p.floor, 40), access: oneOf(p.access, ENUMS.access), accessRoute: text(p.accessRoute),
        condition: text(p.condition), damp: oneOf(p.damp, ENUMS.damp), dampNote: text(p.dampNote, 300),
        ventilation: oneOf(p.ventilation, ENUMS.ventilation), pests: oneOf(p.pests, ENUMS.pests),
        petsPresent: oneOf(p.petsPresent, ENUMS.yesNoUnknown), petsCanEnter: oneOf(p.petsCanEnter, ENUMS.yesNo),
        sharedAccess: oneOf(p.sharedAccess, ENUMS.yesNo), whoCanAccess: text(p.whoCanAccess, 300), security: text(p.security, 300),
        accessHours: text(p.accessHours, 120), notice: oneOf(p.notice, ENUMS.notice), appointment: oneOf(p.appointment, ENUMS.yesNo),
        allowedGoods: lines(p.allowedGoods), prohibitedGoods: lines(p.prohibitedGoods), stacking: text(p.stacking, 300),
        declaration: p.declaration === true,
      },
      private: priv,
    };
  }
  if (category === 'parking') {
    const unit = oneOf(p.space?.unit, ENUMS.unit) || 'm';
    return {
      public: {
        vehicles: (Array.isArray(p.vehicles) ? p.vehicles : []).filter(v => ENUMS.vehicle.includes(v)),
        space: { length: num(p.space?.length), width: num(p.space?.width), unit },
        heightLimit: num(p.heightLimit), heightKnown: oneOf(p.heightKnown, ['limit', 'none', 'unknown']),
        covered: oneOf(p.covered, ENUMS.yesNo), gate: oneOf(p.gate, ENUMS.gate), accessHours: text(p.accessHours, 120),
        restrictions: text(p.restrictions), declaration: p.declaration === true,
      },
      private: priv,
    };
  }
  return { // tools, creator
    public: {
      condition: oneOf(p.condition, ENUMS.condition), defects: text(p.defects),
      functionCheck: oneOf(p.functionCheck, ENUMS.check), functionNote: text(p.functionNote, 300), checkedOn: text(p.checkedOn, 10),
      restrictions: text(p.restrictions), safety: text(p.safety), declaration: p.declaration === true,
    },
    private: priv,
  };
}

// Returns human-readable problems: missing answers and contradictions. Empty = complete.
export function problems(category, facts, photos) {
  const p = facts.public, q = facts.private, out = [];
  const need = (ok, label) => { if (!ok) out.push(label); };
  const positive = v => Number.isFinite(v) && v > 0;
  need(q.address.length >= 10, 'Exact address (kept private until a booking is confirmed)');
  need(p.declaration, 'Declaration that you have permission to offer this');
  if (category === 'storage') {
    need(p.mode, 'Shared area or exclusive space');
    need(positive(p.room.length) && positive(p.room.width) && positive(p.room.height), 'Room length, width and height');
    need(positive(p.usableSqft), 'Usable floor area');
    need(positive(p.doorway.width) && positive(p.doorway.height), 'Doorway width and height');
    need(p.floor, 'Floor'); need(p.access, 'Ground floor, lift or stairs'); need(p.accessRoute.length >= 5, 'Access route');
    need(p.condition.length >= 5, 'Current condition'); need(p.damp, 'Damp or leak history'); need(p.ventilation, 'Ventilation');
    need(p.pests, 'Pests'); need(p.petsPresent, 'Pets on the property'); if (p.petsPresent === 'yes') need(p.petsCanEnter, 'Whether pets can enter the storage');
    need(p.sharedAccess, 'Whether anyone else can enter'); need(p.whoCanAccess.length >= 3, 'Who can access the room'); need(p.security.length >= 3, 'Locks and security');
    need(p.accessHours.length >= 3, 'Access hours'); need(p.notice, 'Notice needed before access'); need(p.appointment, 'Whether access is by appointment');
    need(p.allowedGoods.length, 'Allowed goods'); need(p.prohibitedGoods.length, 'Prohibited goods'); need(p.stacking.length >= 3, 'Stacking or load limits');
    need(photos.some(x => x.kind === 'room'), 'A photo of the room'); need(photos.some(x => x.kind === 'entrance'), 'A photo of the entrance');
    if (positive(p.room.length) && positive(p.room.width) && positive(p.usableSqft)) {
      const roomSqft = toFeet(p.room.length, p.room.unit) * toFeet(p.room.width, p.room.unit);
      if (p.usableSqft > roomSqft + 0.05) out.push(`Usable area (${p.usableSqft} sq ft) cannot exceed the room's floor area (${round1(roomSqft)} sq ft)`);
    }
    if (p.mode === 'exclusive' && p.sharedAccess === 'yes') out.push('An exclusive space cannot also have other people entering it; choose shared, or describe who enters');
  } else if (category === 'parking') {
    need(p.vehicles.length, 'Vehicle types that fit'); need(positive(p.space.length) && positive(p.space.width), 'Space length and width');
    need(p.heightKnown, 'Height limit (or none / unknown)'); if (p.heightKnown === 'limit') need(positive(p.heightLimit), 'Height limit in metres');
    need(p.covered, 'Covered or open'); need(p.gate, 'Gate access'); need(p.accessHours.length >= 3, 'Access hours');
  } else {
    need(p.condition, 'Condition'); need(p.functionCheck, 'Result of your function check'); need(/^\d{4}-\d{2}-\d{2}$/.test(p.checkedOn), 'Date of your last function check');
    if (p.functionCheck === 'working_with_notes') need(p.functionNote.length >= 5, 'What to know about how it works');
  }
  return out;
}

export class Profiles {
  constructor(store) { this.store = store; this.db = store.db; }

  async row(listingId) { return await this.db.prepare('SELECT * FROM listing_profiles WHERE listing_id=?').get(listingId); }
  async photos(listingId, withImages = true) {
    return await this.db.prepare(`SELECT id,kind${withImages ? ',image' : ''},created_at AS createdAt FROM listing_photos WHERE listing_id=? AND removed_at IS NULL ORDER BY created_at`).all(listingId);
  }
  // Public view for any viewer who can see the listing. Null for a legacy listing without facts.
  async publicView(listingId, { withPhotos = true } = {}) {
    const row = await this.row(listingId);
    if (!row) return null;
    const facts = JSON.parse(row.public_facts);
    return { status: row.status, version: row.version, sample: !!row.sample, declaredBy: 'host', verifiedBySparely: false, facts, ...(withPhotos ? { photos: await this.photos(listingId) } : {}) };
  }
  async privateFacts(listingId) {
    const row = await this.row(listingId);
    return row ? JSON.parse(row.private_facts) : null;
  }
  async ownerView(userId, listingId) {
    const l = await this.store.listing(listingId);
    fail(l.ownerId !== userId, 'Only the owner can see these details.', 403);
    const row = await this.row(listingId), photos = await this.photos(listingId);
    const facts = row ? { public: JSON.parse(row.public_facts), private: JSON.parse(row.private_facts) } : normalise(l.category, {});
    return { listingId, category: l.category, status: row?.status || 'draft', version: row?.version || 0, facts, photos, missing: problems(l.category, facts, photos), published: l.active, draft: !!l.draft };
  }

  async save(userId, listingId, input) {
    return await this.store.transaction(async () => {
      const l = await this.store.listing(listingId);
      fail(l.ownerId !== userId, 'Only the owner can edit these details.', 403);
      fail(l.retired, 'This item or category is no longer offered.', 409);
      const row = await this.row(listingId), current = row?.version || 0;
      if (input.version !== current) throw new AppError('These details changed since you opened them. Reload before saving.', 409, 'STALE_PROFILE', { currentVersion: current });
      const facts = normalise(l.category, input.facts || {});
      if (l.category === 'storage' && facts.public.usableSqft !== null) {
        const reserved = await this.store.capacity?.committedSqft?.(listingId) ?? 0;
        fail(facts.public.usableSqft < reserved, `Usable area cannot go below the ${reserved} sq ft already reserved by accepted bookings.`, 409);
      }
      const at = new Date().toISOString();
      for (const photo of input.addPhotos || []) {
        fail(!['room', 'entrance', 'item', 'space'].includes(photo.kind) || !validPhoto(photo.image), 'Add JPG, PNG or WebP photos under 3 MB.');
        await this.db.prepare('INSERT INTO listing_photos(id,listing_id,kind,image,created_at,removed_at) VALUES(?,?,?,?,?,NULL)').run(randomUUID(), listingId, photo.kind, photo.image, at);
      }
      for (const id of input.removePhotos || []) await this.db.prepare('UPDATE listing_photos SET removed_at=? WHERE id=? AND listing_id=?').run(at, String(id), listingId);
      fail((await this.photos(listingId, false)).length > 8, 'Keep it to 8 photos per listing.');
      const complete = problems(l.category, facts, await this.photos(listingId, false)).length === 0;
      // A published listing can never be saved into an incomplete state.
      fail(l.active && !complete, 'A published listing must stay complete. Fill in the missing details or pause the listing first.', 409);
      if (row) await this.db.prepare('UPDATE listing_profiles SET public_facts=?,private_facts=?,status=?,version=?,updated_at=? WHERE listing_id=?').run(JSON.stringify(facts.public), JSON.stringify(facts.private), complete ? 'complete' : 'draft', current + 1, at, listingId);
      else await this.db.prepare('INSERT INTO listing_profiles(listing_id,public_facts,private_facts,status,version,sample,updated_at) VALUES(?,?,?,?,?,0,?)').run(listingId, JSON.stringify(facts.public), JSON.stringify(facts.private), complete ? 'complete' : 'draft', 1, at);
      return await this.ownerView(userId, listingId);
    });
  }

  async publish(userId, listingId) {
    return await this.store.transaction(async () => {
      const view = await this.ownerView(userId, listingId);
      if (view.missing.length) throw new AppError('Some details are still missing or contradictory.', 400, 'PROFILE_INCOMPLETE', { missing: view.missing });
      await this.store.capacity.assertPublishable(await this.store.listing(listingId));
      const raw = await this.db.prepare('SELECT details FROM listings WHERE id=?').get(listingId);
      const details = JSON.parse(raw.details || '{}');
      delete details.draft;
      await this.db.prepare('UPDATE listings SET details=? WHERE id=?').run(JSON.stringify(details), listingId);
      return await this.store.toggleListing(userId, listingId, true);
    });
  }

  // New bookings need the facts: storage always; other categories only if they have any.
  async bookable(listing) {
    const row = await this.row(listing.id);
    if (listing.category === 'storage' && row?.status !== 'complete') return false;
    return true;
  }

  async copy(fromId, toId) {
    const row = await this.row(fromId);
    if (!row) return;
    await this.db.prepare('INSERT OR IGNORE INTO listing_profiles(listing_id,public_facts,private_facts,status,version,sample,updated_at) VALUES(?,?,?,?,?,?,?)').run(toId, row.public_facts, row.private_facts, row.status, 1, row.sample, new Date().toISOString());
    for (const photo of await this.photos(fromId)) await this.db.prepare('INSERT INTO listing_photos(id,listing_id,kind,image,created_at,removed_at) VALUES(?,?,?,?,?,NULL)').run(randomUUID(), toId, photo.kind, photo.image, new Date().toISOString());
  }
}
