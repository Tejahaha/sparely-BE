import { createHash } from 'node:crypto';

// Ordered, additive schema/data migrations with a ledger.
// Rules: never edit an applied migration (add a new one); statements must be
// safe to re-run (IF NOT EXISTS, guarded inserts); never delete user records.
// Each migration and its ledger row commit in one transaction.
import { migration, migrations } from './migration-registry.mjs';
export { migration, migrations };
// Feature migrations live in their own files (applied in id order with the ones below).
import './migrations/0005-capacity.mjs';
import './migrations/0006-messages.mjs';
import './migrations/0007-operations.mjs';
import './migrations/0008-handover.mjs';
import './migrations/0009-settlement.mjs';
import './migrations/0010-remove-retired.mjs';
import './migrations/0011-ai.mjs';

const checksum = up => createHash('sha256').update(up.toString()).digest('hex').slice(0, 16);

export async function hasColumn(db, table, column) {
  if (db.postgres) return !!(await db.query('SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=? AND column_name=?', [table, column], 'get'));
  return (await db.query(`PRAGMA table_info(${table})`)).some(c => c.name === column);
}
export async function addColumn(db, table, column, definition) {
  if (!(await hasColumn(db, table, column))) await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

async function ledger(db) {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(id TEXT PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)');
  return new Map((await db.query('SELECT id,checksum FROM schema_migrations')).map(r => [r.id, r.checksum]));
}

export async function migrationStatus(db) {
  const applied = await ledger(db);
  return {
    applied: [...applied.keys()],
    pending: migrations.filter(m => !applied.has(m.id)).map(m => m.id),
    changed: migrations.filter(m => applied.has(m.id) && applied.get(m.id) !== checksum(m.up)).map(m => m.id),
  };
}

export async function applyMigrations(db, log = () => {}) {
  const applied = await ledger(db), done = [];
  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    await db.transaction(async () => {
      // Re-check inside the transaction: another instance may have applied it.
      if (await db.query('SELECT 1 FROM schema_migrations WHERE id=?', [m.id], 'get')) return;
      await m.up(db);
      await db.query('INSERT INTO schema_migrations(id,checksum,applied_at) VALUES(?,?,?)', [m.id, checksum(m.up), new Date().toISOString()], 'run');
      done.push(m.id); log(`applied ${m.id}`);
    });
  }
  return done;
}

// 0001 records the pre-ledger schema (users … safety_notices) as the baseline.
migration('0001_ledger_baseline', async () => {});

// 0002 (M1): real accounts, operator-issued password resets, shared rate limits.
// A user with an accounts row is a real account; users without one are demo profiles.
migration('0002_accounts', async db => {
  await db.exec(`CREATE TABLE IF NOT EXISTS accounts(user_id TEXT PRIMARY KEY REFERENCES users(id),email TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,email_verified INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS password_resets(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires INTEGER NOT NULL,used_at TEXT,issued_by TEXT NOT NULL REFERENCES users(id));
    CREATE TABLE IF NOT EXISTS rate_limits(bucket TEXT NOT NULL,window_start INTEGER NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(bucket,window_start));
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);`);
});

// 0003 (M2): catalogue revision and host availability blocks.
// Retires (never deletes) Work & study, Useful spaces and the camera kit: they leave
// discovery and new bookings; existing bookings, agreements and evidence are untouched.
// Adds demo-world sewing and gardening equipment under Tools.
const m2Listings = [
  { id: 'sewing-machine', ownerId: 'aanya', title: 'A sewing machine for hems and repairs', area: 'Kondapur', rate: 220, deposit: 1500, image: 'sewing', description: 'A straightforward electric sewing machine for hemming curtains, mending clothes and small craft projects. Comes threaded, with a foot pedal and spare needles.', included: ['Electric sewing machine and foot pedal', 'Spare needles and bobbins', 'Dust cover and power lead'], specs: { 'Stitches': 'Straight, zigzag, buttonhole', 'Fabrics': 'Light to medium', 'Power': 'Mains', 'Weight': '6 kg' }, rules: ['Bring your own thread and fabric.', 'Do not sew denim layers thicker than the presser foot allows.', 'Return with the needle and bobbin case in place.'], tags: 'sewing machine hem mend curtains clothes tailoring stitch craft repair', distance: null },
  { id: 'garden-kit', ownerId: 'kabir', title: 'Garden tool kit for a weekend tidy-up', area: 'Gachibowli', rate: 180, deposit: 800, image: 'garden', description: 'Everything for a balcony or small-garden tidy-up: pruning, digging, raking and clearing leaves. Cleaned and sharpened between bookings.', included: ['Pruning shears and hand trowel', 'Garden fork, rake and leaf grabber', 'Gloves and a collapsible garden bag'], specs: { 'Suits': 'Balconies and small gardens', 'Power': 'None (hand tools)', 'Bag': '120 litres', 'Pickup': '8 am–7 pm' }, rules: ['Clean soil off the tools before return.', 'Not for cutting branches thicker than 2 cm.', 'Return the gloves in the bag.'], tags: 'garden gardening prune pruning plants balcony rake dig weeds leaves hedge yard', distance: null },
];
migration('0003_catalogue_and_blocks', async db => {
  await db.exec(`CREATE TABLE IF NOT EXISTS listing_blocks(id TEXT PRIMARY KEY,listing_id TEXT NOT NULL REFERENCES listings(id),starts_at TEXT NOT NULL,ends_at TEXT NOT NULL,note TEXT NOT NULL,created_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,removed_at TEXT);
    CREATE INDEX IF NOT EXISTS listing_blocks_window ON listing_blocks(listing_id,starts_at,ends_at);`);
  const at = new Date().toISOString();
  for (const row of await db.query("SELECT id,details FROM listings WHERE id='camera-kit' OR category IN ('work','spaces')")) {
    const details = JSON.parse(row.details || '{}');
    if (details.demoScenario || details.retired) continue;
    details.retired = { at, reason: 'Category or item no longer offered (catalogue revision M2)' };
    await db.query('UPDATE listings SET active=0,details=? WHERE id=?', [JSON.stringify(details), row.id], 'run');
  }
  const owners = new Set((await db.query('SELECT id FROM users')).map(u => u.id));
  for (const l of m2Listings) {
    if (!owners.has(l.ownerId)) continue; // a database without the demo profiles gets no demo listings
    await db.query('INSERT OR IGNORE INTO listings(id,owner_id,title,description,category,city,area,rate,unit,deposit,image,photo,details,active,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [l.id, l.ownerId, l.title, l.description, 'tools', 'Hyderabad', l.area, l.rate, 'day', l.deposit, l.image, null, JSON.stringify({ included: l.included, specs: l.specs, rules: l.rules, tags: l.tags, distance: l.distance }), 1, at], 'run');
  }
});

// 0004 (M3): host onboarding facts and listing photos.
// Real users' existing listings get NO invented facts: legacy storage must be completed
// by its host before new bookings. Only the demo world's own sample listings receive
// sample profiles (flagged sample=1, illustrations instead of photos, placeholder address).
const sampleAddress = { address: 'Sample listing — demo address only (Hyderabad)', accessInstructions: 'Sample listing: the host shares real access steps after confirmation.' };
const equipment = (condition, functionCheck = 'working', functionNote = '') => ({ condition, defects: condition === 'worn' ? 'Visible scuffs from normal use.' : '', functionCheck, functionNote, checkedOn: '2026-10-20', restrictions: 'Use as described in the listing rules.', safety: '', declaration: true });
const sampleProfiles = {
  'storage-nook': ['storage', { mode: 'shared', room: { length: 5, width: 5, height: 8, unit: 'ft' }, usableArea: 20, usableUnit: 'sqft', usableSqft: 20, doorway: { width: 3, height: 7, unit: 'ft' }, floor: 'Ground', access: 'ground', accessRoute: 'Through the building reception, second door on the left.', condition: 'Painted, dry concrete floor, wall shelving removed.', damp: 'none_known', dampNote: '', ventilation: 'good', pests: 'none_known', petsPresent: 'no', petsCanEnter: null, sharedAccess: 'yes', whoCanAccess: 'The host and other storage renters, by appointment.', security: 'Lockable door; building has a staffed reception.', accessHours: '9 am–6 pm', notice: '24h', appointment: 'yes', allowedGoods: ['Sealed boxes', 'Suitcases and bags', 'Small furniture'], prohibitedGoods: ['Food or liquids', 'Valuables, cash or documents', 'Hazardous or flammable goods'], stacking: 'Up to 1.5 m high; heavy boxes at the bottom.', declaration: true }, [['room', '/assets/storage.svg'], ['entrance', '/assets/storage.svg']]],
  'covered-parking': ['parking', { vehicles: ['hatchback', 'sedan'], space: { length: 5, width: 2.5, unit: 'm' }, heightLimit: 2.1, heightKnown: 'limit', covered: 'yes', gate: 'staffed', accessHours: '7 am–10 pm', restrictions: 'One vehicle; leave before the booking ends.', declaration: true }, [['space', '/assets/parking.svg']]],
  'bike-parking': ['parking', { vehicles: ['two_wheeler'], space: { length: 2, width: 1, unit: 'm' }, heightLimit: null, heightKnown: 'none', covered: 'no', gate: 'key', accessHours: '7 am–10 pm', restrictions: 'Keep the driveway clear.', declaration: true }, [['space', '/assets/parking-bike.svg']]],
  'drill-kit': ['tools', equipment('good'), [['item', '/assets/drill.svg']]],
  'wet-vacuum': ['tools', equipment('good'), [['item', '/assets/vacuum.svg']]],
  'sewing-machine': ['tools', equipment('good', 'working_with_notes', 'The bobbin winder is stiff; wind bobbins by hand.'), [['item', '/assets/sewing.svg']]],
  'garden-kit': ['tools', equipment('worn'), [['item', '/assets/garden.svg']]],
  'light-kit': ['creator', equipment('like_new'), [['item', '/assets/lights.svg']]],
  'tripod': ['creator', equipment('good'), [['item', '/assets/tripod.svg']]],
  'podcast-mics': ['creator', equipment('good'), [['item', '/assets/microphone.svg']]],
};
migration('0004_listing_profiles', async db => {
  await db.exec(`CREATE TABLE IF NOT EXISTS listing_profiles(listing_id TEXT PRIMARY KEY REFERENCES listings(id),public_facts TEXT NOT NULL,private_facts TEXT NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL,sample INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS listing_photos(id TEXT PRIMARY KEY,listing_id TEXT NOT NULL REFERENCES listings(id),kind TEXT NOT NULL,image TEXT NOT NULL,created_at TEXT NOT NULL,removed_at TEXT);
    CREATE INDEX IF NOT EXISTS listing_photos_listing ON listing_photos(listing_id);`);
  const at = new Date().toISOString();
  for (const [id, [category, facts, photos]] of Object.entries(sampleProfiles)) {
    const listing = await db.query('SELECT category FROM listings WHERE id=?', [id], 'get');
    if (!listing || listing.category !== category || (await db.query('SELECT 1 FROM listing_profiles WHERE listing_id=?', [id], 'get'))) continue;
    await db.query('INSERT INTO listing_profiles(listing_id,public_facts,private_facts,status,version,sample,updated_at) VALUES(?,?,?,?,?,1,?)', [id, JSON.stringify(facts), JSON.stringify(sampleAddress), 'complete', 1, at], 'run');
    for (const [kind, image] of photos) await db.query('INSERT INTO listing_photos(id,listing_id,kind,image,created_at,removed_at) VALUES(?,?,?,?,?,NULL)', [`${id}-${kind}-sample`, id, kind, image, at], 'run');
  }
});
