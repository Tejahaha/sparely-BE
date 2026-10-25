// M6 migrations (ids start 0008_). Additive and idempotent only.
import { migration } from '../migration-registry.mjs';

// One row per agreement revision. A revision's terms never change; an edit inserts the next
// revision. Acceptance is per role and names the exact revision. `disagreement` is JSON or NULL.
migration('0008_agreement_revisions', async db => {
  await db.exec(`CREATE TABLE IF NOT EXISTS agreement_revisions(
      booking_id TEXT NOT NULL REFERENCES bookings(id),revision INTEGER NOT NULL,terms TEXT NOT NULL,
      proposed_by TEXT NOT NULL REFERENCES users(id),proposed_role TEXT NOT NULL,note TEXT NOT NULL,created_at TEXT NOT NULL,
      host_accepted_by TEXT,host_accepted_at TEXT,host_accepted_via TEXT,
      renter_accepted_by TEXT,renter_accepted_at TEXT,renter_accepted_via TEXT,
      disagreement TEXT,PRIMARY KEY(booking_id,revision));`);
});
