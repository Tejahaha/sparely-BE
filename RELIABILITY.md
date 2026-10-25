# Item protection, recovery, and reliability

Updated 2026-10-24, backend iteration I04. Frontend integration instructions are maintained only in `frontend/HANDOFF.md` at the project root. This document explains backend decisions and operations; it is not a second frontend handoff. Earlier iteration sections below are historical; I04 supersedes their local API hosting assumptions and I02 supersedes I01 SQLite storage assumptions.

## M8 — Operations, uploads and deployment readiness (2026-10-24, not deployed)

Nothing below has been deployed from this environment; deployment steps are in `deploy/DEPLOY.md`. Neon Function deployment 1 predates this work.

- **Health.** `GET /api/health` (public, no database): `{ ok, build: { version, runtime, startedAt } }`; `version` comes from `SPARELY_BUILD_ID`. `GET /api/ready` (public): database ping with a 2 s timeout, startup state and pending migrations → 200 when all pass, else 503 with per-check codes (no connection details). The last successful worker run is reported but does not fail readiness: a stalled scheduler should alert operators, not remove the API from service. Through the Function, both routes still need the server secret (via the frontend host) and the Function starts the app first, so a pending migration there surfaces as the handler's generic 503.
- **Correlation and logs.** Every response carries `X-Request-Id`: a caller's id is kept only if it matches `[A-Za-z0-9._:-]{8,128}`, otherwise a UUID is generated. The frontend host/proxy creates or forwards it to the Function and the app. One JSON log line per request: method, route template (unknown segments become `:id`), status, ms, request id and `session` (a session cookie was presented). Error lines add an error code and stack frames only — never the message, bodies, cookies, tokens, emails, addresses or images. `SPARELY_LOG=off` silences request logs; tests are quiet by default.
- **Error events.** 5xx and storage-busy responses insert a row in `error_events` (request id, method, route template, status, code, time). Newest 1000 rows retained.
- **Worker evidence.** `store.ops.runWorker(trigger)` writes a `worker_runs` row (`running` → `ok|error`, error code, duration, `{attempts, openBookings}`) around `store.evaluate()`. Used by the Function's `/internal/watchdog` (trigger `schedule`, up to 2 attempts) and the local interval (`local`). Only storage-busy errors are retried, at most 3 attempts; evaluation is idempotent under its transactional guards. Request-time catch-up evaluation is not recorded (it would flood the table). Newest 500 rows retained. If the database is unreachable the run cannot be recorded; the handler logs it and returns 503.
- **Diagnostics.** `GET /api/operations/diagnostics`, operators only (demo or account operator; members 403). The payload has no personal data, so the shared demo operator sees the same view: build, database reachability, pending migrations, last 10 worker runs, last-success age with a "Delayed processing" warning after 15 minutes, 24 h error counts by route/status/code, and the latest local recovery point labelled `this-machine-only`. Shown on Operations → System health.
- **Uploads.** `lib/images.mjs checkImage` decodes the data URL and requires PNG/JPEG/WebP magic bytes matching the declared type, ≤ 3 MB decoded. SVG, HTML and relabelled files are rejected. `validImage` (store), `validPhoto` (profiles) and `imageValid` (recovery) all call it. The request body limit stays 5 MB. Evidence photos are returned only inside booking/incident responses, which already require participant or reviewing-operator access; search results carry no photos.
- **Backups.** `npm run db:prune` lists local recovery points and the last verified one; `-- --keep N [--dry-run]` deletes older points, always keeping the newest verified point and refusing when none verifies. Local points are files on one machine, not off-site backups. Scheduling notes are in `deploy/DEPLOY.md`. No backup, prune, or migration was run against the live database during this work.
- **Frontend host.** `deploy/frontend-host/server.mjs` (`npm run host:frontend`): serves `frontend/dist` with SPA fallback and security headers (CSP `script-src 'self'`, HSTS when `APP_ORIGIN` is HTTPS), and proxies `/api/*` through `createRemoteHandler`, which adds `ORIGIN_SECRET` server-side. It refuses to start without `NEON_FUNCTION_URL`, `ORIGIN_SECRET` and an exact `APP_ORIGIN`. Optional `DEMO_ACCESS_TOKEN` puts the whole site behind a shared Basic-auth gate; that credential is not forwarded upstream.
- **Still blocked (external):** uploading the new Function build, applying `0007_operations` (and M4/M5 migrations) to the live database, hosting the frontend over HTTPS, seeing a recorded scheduled run, and an off-site backup copy. All of these need Neon management access and a host.

## I04 — Hosted API status

Neon Function `sparelyapi` deployment 1 is completed on Node.js 24. Its observed invocation URL is recorded in `neon-project.json`; authenticated bootstrap returned 200 and requests without the server-only secret returned 401. Database remains `sparely_app`. The native URL does not expose the freely switchable demo API without that secret.

The existing port 4174 process now runs only a server proxy selected by `NEON_FUNCTION_URL` and `ORIGIN_SECRET` in backend environment. It forwards the existing Vite `/api` contract. No local database pool or watchdog starts in proxy mode. Hosted upstream failures return 503 with Retry-After and reconciliation guidance; never fall back to another writable database. Origins, bounded body size, cookies, original operation keys and response statuses are preserved. Opt-in local HTTPS DNS fallback preserves the original hostname's TLS validation.

The trusted frontend host must keep `NEON_FUNCTION_URL` and `ORIGIN_SECRET` server-side, set exact `APP_ORIGIN`, and protect demo access at the host or replace demo identity with real authentication. `proxy-entry.mjs` exports a Node request/response handler for host integration. Frontend hosting and that host-specific route are not deployed. A Vite URL rewrite alone does not add the secret or provide authentication. Native Function session cookies are Secure; the proxy removes that flag only for HTTP loopback development.

Created/enabled `sparely-watchdog` every five minutes, path `/internal/watchdog`. That route authenticates Neon trigger provenance and matching delivery payload, independently of the origin secret; only the expected schedule name is accepted. Function timers are disabled. Creation is verified; a successful scheduled delivery is not yet claimed. Request-time evaluation remains a catch-up fallback. The cron's repeated state evaluation uses the existing transactional guards and deduplication.

Verification: 44 root tests passed (43 backend + 1 existing Vite proxy), with 1 conditional PostgreSQL test skipped. New tests verify rejection before database startup, cookie forwarding, upload limit, simulated trusted schedule, origin checks, key forwarding and upstream failure. Live checks through 5173 reached the hosted API for bootstrap, Kabir profile switching, Bengaluru browse and a save with created/replayed headers; foreign origin returned 403. Saved value was preserved, no fixture rental/incident was added. This iteration made no frontend source/configuration changes; separate I03 work is preserved.

Deployment 1's original uploaded archive is retained under ignored `.deploy/function.zip`. Local source subsequently adds startup retry cleanup and oversized-error classification tested locally but not redeployed while management tools are unavailable. Do not claim that the current build and deployed archive are identical. No public-production identity, frontline support, private PostgreSQL export schedule, restore drill or frontend deployment is implied.

## I02 — Neon storage and operational status

The active database is Neon PostgreSQL in Singapore, project **Sparely**, branch `sparely-app`, database `sparely_app`. Nonsecret resource IDs are in `neon-project.json`. Credentials are only in ignored `backend/.env`; never copy them into browser code or `VITE_*` variables. The API still runs locally. No hosted API or frontend deployment is claimed; deployment management access needs the Neon plugin reconnected.

### Migration and concurrency

- A verified SQLite snapshot was imported in one PostgreSQL transaction. All 11 tables matched their source counts and canonical row hashes before commit: 4 users, 41 sessions, 15 listings, 1 favorite, 3 bookings, 6 evidence records, 3 booking metadata records, and zero records in the four new recovery/receipt tables at cutover. Runtime activity may change these counts afterward. Private report: `data/neon-migration-report.json`.
- The original SQLite database and verified backup remain private rollback artifacts. They are **not synchronized** with subsequent Neon writes. Do not point the API back to them without maintenance and reconciliation of every later commit.
- `DATABASE_URL` selects PostgreSQL; `SPARELY_DATABASE_URL` takes precedence when supplied by a future function deployment. Absence selects explicitly initialized SQLite for local installations/tests. PostgreSQL failure never silently switches storage or acknowledges a local substitute write.
- The adapter is asynchronous. A transaction pins one PostgreSQL client using AsyncLocalStorage; nested operations use savepoints. Business changes and command receipts still commit atomically. External model calls remain outside transactions.
- Mutating transactions acquire a fixed PostgreSQL advisory transaction lock. This preserves overlap checks and keyed retries across API instances; it serializes writes across the database and is a conservative hackathon throughput limit. It is not an assertion of high-scale performance. Session writes and notice read acknowledgements are simple statements outside this lock.
- Pool maximum is 5 per API instance. Current verified endpoint is direct with certificate hostname verification (`sslmode=verify-full`); connection pooling at the Neon endpoint was not confirmed enabled. Provision a verified pooled endpoint before increasing instance counts.
- PostgreSQL lock/serialization/deadlock/capacity/startup conditions mapped by SQLSTATE produce the existing 503 `STORAGE_BUSY` response and Retry-After. Other connection failures surface as failed requests; clients must reconcile uncertain outcomes using the original operation key. Existing frontend calls without keys remain unprotected against repeated effects.
- `NEON_DNS_FALLBACK=1` is enabled only for this machine's refusing DNS resolver. It resolves Neon hosts through HTTPS DNS and connects to the returned address while preserving original TLS SNI and certificate verification. No hardcoded address, global DNS change, or disabled certificate verification is used. Cloud deployment should leave it off unless required by an observed DNS failure.

### Backups and restore after cutover

`npm run backup --workspace @sparely/backend` now refuses when PostgreSQL is active, so it cannot misleadingly snapshot the obsolete SQLite file. Use an appropriate private `pg_dump` or a Neon restore/branch operation. No scheduled dump, off-device export, restore window verification, or production PostgreSQL restore drill has been configured by this migration.

Before a restore: stop API and worker writes, preserve the current branch/recovery point, restore to a separate branch/database, verify counts, permissions, holds and receipts, reconcile all operations after the recovery timestamp, then change the server connection and reopen. Restoring a snapshot cannot promise zero loss or deduplicate receipts committed after that snapshot. Never reset the only copy.

`npm run migrate:postgres --workspace @sparely/backend -- <verified-snapshot> <private-report>` validates the snapshot manifest/hash, imports without overwriting conflicting rows, and verifies every target table before commit. Re-running against an app database that has changed correctly refuses; this is a migration tool, not ongoing replication.

### Verification and hosting limits

Root `npm test`: 42 passed (41 backend, 1 existing Vite proxy integration), with the additional real-PostgreSQL test skipped unless `POSTGRES_TEST_URL` is provided. The real PostgreSQL test was separately run successfully against an isolated schema: concurrent replay, overlap rejection, access controls, recovery/manual return, aliases and rollback. The isolated test schema is retained separately from public app data. Backend syntax checks passed. Frontend source/configuration are unchanged.

A future hosted API must protect the freely switchable demo identities before exposing private records on a public URL. A server-only origin secret through a trusted frontend-host proxy is one demo deployment option; it must never be shipped to the browser. Neither this proxy nor a hosted API has been deployed. A persistent local timer is also not a durable hosted scheduler: configure and verify a worker/cron for idle-time evaluation, and keep request-time evaluation as catch-up. Frontend hosting remains a separate step.

## What the product can honestly promise

Sparely can preserve a custody record, stop an affected item being promised again, expose an accountable recovery process, and avoid repeating a database action when a client retries. It cannot make an item physically indestructible, prove fault from a photograph, guarantee return, or provide insurance through software alone.

A deposit is not the recovery plan. A missing laptop, inaccessible stored belongings, or a broken tool needs a return or restoration process even when no extra money is collected.

## Protection before the rental — next required work

The following complete safeguards are designed but **not yet enforced end to end**. Partial backend foundations are noted explicitly. These are the primary gaps before real customer rentals:

1. **Verified counterparties and reachable support.** Replace freely switchable demo identities with authenticated accounts, verified contact channels, and protected operator access. A repeated allegation must not automatically establish guilt; restrictions need independent review.
2. **Explicit eligibility.** Start with items/uses the host and operator can reasonably support. Do not claim protection for irreplaceable belongings, sensitive data, unsupported dangerous uses, or risks without an operational response. Category eligibility and ownership checks need actual enforcement, not only policy copy.
3. **Agreed inventory snapshot.** I01 now saves listing title/description/included items/rules/specs, original dates/quote, participants, and policy version with each new booking. Legacy bookings return `agreement:null` rather than inventing past terms. Structured item/box identifiers, serial numbers, defect checks, and both-party acceptance still need implementation. Future listing edits must not rewrite the captured agreement.
4. **Both-party condition acknowledgement.** Host and renter independently confirm the same checklist and condition at handover. A six-digit code alone does not prove agreement about condition. A mismatch should stop collection and enable cancellation without pressure to take the item.
5. **Category-specific checks.** Equipment: function, charger, serial/accessories, safe usage. Storage: numbered sealed boxes, inventory, access expectations, prohibited contents. Parking: vehicle size and entry/exit access; renting a spot is not taking custody of the vehicle. Spaces: access, permitted use, ready condition. The current code/photo form is generic.
6. **Real repair/recovery operation.** Agree who contacts the parties, where safe returns occur, who can inspect/repair, and who follows up outside the app. No repair partner, insurer, recovery provider, or staffed support response is integrated today.

Do not label these as implemented or expose a "protected/insured/verified" badge based on the present demo.

## Recovery implemented in I01

### Case lifecycle

```text
participant report
    -> open (item paused and recoveryHold set)
    -> investigating (independent operator acknowledges)
    -> awaiting_return (participant proposes; other participant confirms)
    -> escalated (operator action or missed review/return-plan deadline)
    -> resolved (independent operator, recorded return or cancelled handover only)
    -> owner separately marks listing ready
```

- Types: `lost`, `non_return`, `damage`, `access_problem`, `unsafe`. A report records an allegation, not a liability decision. There is one unresolved case per booking; further evidence goes into that case.
- A non-return report requires an active rental beyond its snapshotted return grace period. The watchdog does not automatically label lateness as theft or automatically open a case in someone's name.
- Opening a case atomically stores the report/evidence, pauses the listing, sets its hold, adds a booking trace, and queues durable in-app notices. Later requested/confirmed bookings get an at-risk notice and trace. New bookings and collections are blocked; ordinary physical return remains possible.
- An active rental stays active when reported lost. Reporting, escalating, or proposing a return does not pretend that custody changed, release the simulated deposit, add a fee, or extend the rental deadline.
- A return proposal requires confirmation by the other participant. It never changes the booked price/time, and a participant proposal/confirmation cannot clear an escalated operator case. A mutually agreed rental extension remains a separate existing workflow.
- Initial review is due in two hours. Operator acknowledgement sets a 24-hour review deadline; a return proposal uses the earlier of its proposed return time or 24 hours. These are internal queue deadlines, **not a promise that staffed support exists**. The 30-second watchdog escalates a missed deadline once, including after a restart when evaluation next runs.
- Closing a case needs a recorded return or an already cancelled/declined/expired handover. An unrecovered item cannot be marked resolved just because a report timed out; it stays escalated. There is no automatic deduction or "pay to close" action.
- Closing a recovery case does not close a separate damage claim. Both must permit readiness before the host can make the listing available again.

### Missing return-code fallback

If the item is physically returned but the renter is unavailable or the code cannot be obtained:

1. Owner records receipt with a condition photo and explanatory note in the recovery case.
2. An independent operator records a separate review reason and verifies the manual return.
3. Backend appends a Return evidence record and audit trace, marks the rental completed, and leaves the recovery hold in place.
4. Operator resolves the recovery case; owner then checks readiness and reactivates the listing. If there is a condition dispute, record it for review before readiness; no financial deduction is inferred by manual return.

This is an audited human fallback. It does not independently prove the truth of an owner's photograph. Operators who are themselves a host or renter in the case cannot perform the independent decision.

If the owner is also unreachable, there is no integrated staffed drop-off or custody partner today. The case stays escalated; the software must not instruct a renter to abandon the item or invent a completed return. An agreed, attended custody-transfer fallback is operational work still required.

### Evidence and future renters

Incident entries are append-only through the API. Photos get a SHA-256 digest of their stored data-URL string. Existing handover evidence is also represented with digests in the recovery plan. Digests help detect changed bytes when comparing records; they are not signatures, independent witnesses, or protection against a database administrator changing both the record and hash.

Evidence/location details are accessible to the parties and independent operators. A renter of the next reservation receives a generic risk notice for their own booking; that does not grant access to the prior customer's case.

Recovery alternatives are up to three currently available listings in the same city/category, excluding the affected item and the requesting user's own listings. They are **candidates, not verified equivalent replacements**. API returns the actual dates and quotes used; past collection dates move the suggestion window forward. A new booking, consent, quote, and host approval are required. Nothing is automatically booked or charged.

## Failure behavior

| Failure | Implemented fallback / limit |
| --- | --- |
| Duplicate click or client timeout after commit | Same actor + same Idempotency-Key + same request returns the committed resource without running the mutation again. |
| Key reused for changed payload/route | 409 `IDEMPOTENCY_CONFLICT`; do not overwrite the original receipt. |
| Mutation fails before commit, including after an inner booking transaction | Outer transaction rolls back business writes and receipt together; retry the same operation/key after resolving the error. |
| Other operator acts while a case is open | Required `expectedVersion` yields 409 `STALE_INCIDENT`; reload before a new human decision. A replay of an already committed keyed command bypasses re-execution. |
| SQLite writer is busy | Fail closed with 503 `STORAGE_BUSY`, `retryable:true`, `Retry-After:1`; no in-memory success or alternative booking. |
| API crashes after commit / response is lost | Receipt persists in the same SQLite commit. Client can query its own command status and retry using the original key. |
| Model unavailable/invalid | Existing deterministic catalogue matching, explicitly labelled fallback. Models never decide custody, fault, or deductions. |
| Operator does not respond | Deadline escalation, retained hold, persistent operator/participant inbox notices. No automatic blame or resolution. External contact delivery is not yet connected. |
| Participant cannot provide a return code | Owner receipt photo + independent operator's recorded manual verification. No one-person code bypass. |
| A replacement candidate disappears | New booking rechecks availability atomically; keep the original case, offer another candidate, never silently substitute. |
| Database loss/corruption | Verified SQLite snapshot backup tool exists; human restore and reconciliation procedure below. No automatic fresh/empty database fallback. |

## Idempotency contract

`Idempotency-Key` is 16–128 characters, matching `[A-Za-z0-9._:-]`; a UUID is suitable. The logical scope is the authenticated actor and key across protected endpoints. The request fingerprint includes method, path/query, and recursively canonicalized JSON body (object key order does not matter; arrays retain order).

Supported: listing publication, listing pause/readiness, favorites, booking creation, all booking PATCH actions, incident creation/actions, and notice read acknowledgement. Session/profile switching, scenario creation, quotes, and AI matching are outside this contract. Do not blindly retry scenario creation as if it were protected.

- Keys are **required** for incident creation and actions: missing key yields 428 `IDEMPOTENCY_KEY_REQUIRED`. Existing listing/booking routes allow old clients without a key; response says `Idempotency-Status:not-provided`. Those legacy calls do not gain retry protection by merely running on the new backend.
- Response header is `Idempotency-Status:created`, `replayed`, or `not-provided`.
- A receipt stores resource kind/ID and original HTTP status, not another copy of photos, codes, or responses. A replay returns the **current authorized resource state**, not an identical historical JSON body. A replayed collect may return the booking as completed if it was subsequently returned.
- Business changes and the successful receipt share a `BEGIN IMMEDIATE` transaction. Existing inner operations use savepoints. No network call or asynchronous function belongs inside this synchronous transaction.
- Failed requests have no successful receipt. No key expiration/deletion is implemented, so old successful keys cannot silently become fresh commands after a TTL. Production rate limits, quotas, and an explicit receipt-retention strategy remain required.
- `GET /api/commands/:key` reports an actor's committed resource reference. A 404 is not permission to invent a new key for a timed-out operation: the first request may still be in flight. Keep using the original key and payload.
- New client integration should create a key once per intended action, retain it across retries, and bind it to actor/resource/payload. Stop automatic retries on 400/401/403/409/415/428. On timeout/503, retry with bounded exponential backoff and jitter (for example 1, 2, 4 seconds, then show reconciliation/retry). Never resend an old user's operation after profile switching.
- This guarantees one committed database effect for a key against this database, not global exactly-once delivery to external providers. Future payment/notification integrations need a transactional outbox plus provider event IDs, unique constraints, retry budgets, and dead-letter/manual replay controls. No such external delivery is claimed today.

## Storage backup and restore

SQLite uses foreign keys, WAL, synchronous FULL, and a busy timeout. Node 22.20 or newer is the required verified runtime, including the built-in backup API. Keep the database and evidence private. Local single-instance SQLite remains a constraint; horizontal scaling needs a reviewed storage/worker plan.

API startup refuses a missing persistent database. Only an intentional new installation should run `npm run init:db --workspace @sparely/backend`; this command uses exclusive file creation and cannot reset an existing database. Existing installations should restore their backup instead. Tests may explicitly opt into a new fixture database with `allowCreate:true`; `:memory:` remains available to tests.

From the project root:

```powershell
npm run backup --workspace @sparely/backend
```

The command uses SQLite's backup API while the source may be open. It writes a unique `backend/backups/*.db` snapshot, verifies `PRAGMA integrity_check`, and writes a SHA-256/count manifest beside it. Existing targets are never overwritten. Backups contain private records and are ignored by Git. The tool is manual: no backup schedule, off-device copy, encryption, or retention service is configured.

Restore procedure:

1. Put the app into maintenance and stop all API/watchdog processes. Preserve the current database, WAL and SHM files as a recovery set; do not overwrite or delete the only copy.
2. Verify the selected snapshot's manifest hash and SQLite integrity. Test it separately before promoting it.
3. Restore the snapshot into a clean data directory with no stale WAL/SHM sidecars. Preserve the previous recovery set separately. Do not copy only a live `.db` file as a backup.
4. Reconcile operations after the backup timestamp, especially physical handovers and client command receipts, before reopening writes. A restored snapshot cannot contain commits made after it was taken; it must not be represented as zero data loss or guaranteed duplicate protection for those missing operations.
5. Start the API, evaluate recovery queues, and confirm record counts, item holds, and receipts. Do not automatically clear holds when restoring.

The backup test restores a separate database and checks cases, evidence, holds, and duplicate receipts. Live production restore/disaster recovery remains an operator responsibility.

## Verification and remaining launch blockers

I01 adds fault-focused tests for recovery permissions/holds, manual return, stale decisions, deadline deduplication, recipient isolation/pagination, concurrent retry replay, payload mismatch, rollback after inner writes, receipt persistence, snapshot restoration, and storage locks.

Final verification: `npm test` passes 42 tests (41 backend + 1 existing Vite proxy test); backend syntax checks pass. Live HTTP checks confirmed recovery APIs and preserved catalogue availability. Frontend source/config hashes are unchanged. No new interactive frontend verification or frontend build is claimed.

Still required: real identity/authentication; frontend integration of this API; both-party category checklists and acceptance of the inventory snapshot; reachable human support and external delivery; account abuse/rate controls; agreed physical inspection/repair/recovery partners; scheduled private off-device backups and recovery drills. Real payments and any insurance offering require separate actual integrations and reviewed terms. None is inferred from this implementation.
