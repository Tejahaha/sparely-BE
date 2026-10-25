// M7 migrations (ids start 0009_). Additive and idempotent only.
import { migration } from '../migration-registry.mjs';

// Simulated settlement ledger (no real money). Append-only: rows are never updated or deleted;
// corrections are new reversing entries. entry_key is deterministic per booking event, so a
// replayed, duplicated or reordered sync can never post the same effect twice.
// settlement_decisions is the immutable operator decision history (decision_key UNIQUE).
migration('0009_settlement', async db => {
  await db.exec(`CREATE TABLE IF NOT EXISTS settlement_entries(
      id TEXT PRIMARY KEY,booking_id TEXT NOT NULL REFERENCES bookings(id),entry_key TEXT NOT NULL UNIQUE,seq INTEGER NOT NULL,
      kind TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','completed','failed','disputed')),amount INTEGER NOT NULL CHECK(amount>=0),
      from_party TEXT,to_party TEXT,reverses_key TEXT,label TEXT NOT NULL,detail TEXT NOT NULL,source TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS settlement_entries_booking ON settlement_entries(booking_id,seq);
    CREATE TABLE IF NOT EXISTS settlement_decisions(
      id TEXT PRIMARY KEY,booking_id TEXT NOT NULL REFERENCES bookings(id),decision_key TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,
      operator_id TEXT NOT NULL REFERENCES users(id),rental_refund INTEGER,deposit_refund INTEGER,host_compensation INTEGER,
      reason TEXT NOT NULL,version_seen INTEGER NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS settlement_decisions_booking ON settlement_decisions(booking_id,created_at);`);
});
