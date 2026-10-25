// M4 migrations: storage pricing caps, per-listing storage rates, booking storage intake.
import { migration } from '../migration-registry.mjs';

migration('0005_capacity', async db => {
  await db.exec(`CREATE TABLE IF NOT EXISTS pricing_caps(id TEXT PRIMARY KEY,world TEXT NOT NULL,scope TEXT NOT NULL,city TEXT NOT NULL DEFAULT '',currency TEXT NOT NULL,billing_unit TEXT NOT NULL,max_rate_paise INTEGER NOT NULL,label TEXT NOT NULL,demo_only INTEGER NOT NULL,approved INTEGER NOT NULL,version INTEGER NOT NULL,created_by TEXT NOT NULL,created_at TEXT NOT NULL,retired_at TEXT);
    CREATE TABLE IF NOT EXISTS storage_pricing(listing_id TEXT PRIMARY KEY REFERENCES listings(id),rate_paise INTEGER NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS booking_storage(booking_id TEXT PRIMARY KEY REFERENCES bookings(id),listing_id TEXT NOT NULL REFERENCES listings(id),footprint_tenths INTEGER NOT NULL,items TEXT NOT NULL,access_needs TEXT NOT NULL,environment TEXT NOT NULL,acknowledged INTEGER NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS booking_storage_listing ON booking_storage(listing_id);`);
  const at = new Date().toISOString();
  // Demo world only: a clearly labelled assumption so the demo can show capped pricing.
  // Real accounts get NO cap here; an operator must configure and approve one.
  await db.query('INSERT OR IGNORE INTO pricing_caps(id,world,scope,city,currency,billing_unit,max_rate_paise,label,demo_only,approved,version,created_by,created_at,retired_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)',
    ['demo-default-cap', 'demo', 'default', '', 'INR', 'sqft_day', 300, 'Demo-only assumption: ₹3.00 per sq ft per day. Not market or legal guidance.', 1, 1, 1, 'system', at], 'run');
  // The demo storage nook (20 sq ft at ₹45/day) priced consistently: 225 paise/sq ft/day.
  if (await db.query("SELECT 1 FROM listings WHERE id='storage-nook' AND category='storage'", [], 'get'))
    await db.query('INSERT OR IGNORE INTO storage_pricing(listing_id,rate_paise,updated_at) VALUES(?,?,?)', ['storage-nook', 225, at], 'run');
});
