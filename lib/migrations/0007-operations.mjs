// M8 migrations. Additive and idempotent only (CREATE ... IF NOT EXISTS). Never delete user records.
import { migration } from '../migration-registry.mjs';

// Operational evidence with no personal data: background evaluation runs and server-error
// events (request id, route template, status, code, time). Retention is bounded in lib/ops.mjs.
migration('0007_operations', async db => {
  await db.exec(`CREATE TABLE IF NOT EXISTS worker_runs(id TEXT PRIMARY KEY,trigger_kind TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT,outcome TEXT NOT NULL,error_code TEXT,duration_ms INTEGER,counts TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS worker_runs_started ON worker_runs(started_at);
    CREATE TABLE IF NOT EXISTS error_events(id TEXT PRIMARY KEY,request_id TEXT NOT NULL,method TEXT NOT NULL,route TEXT NOT NULL,status INTEGER NOT NULL,code TEXT,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS error_events_created ON error_events(created_at);`);
});
