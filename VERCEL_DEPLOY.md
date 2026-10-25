# Backend Vercel deployment

**Status (2026-10-25): ready to deploy from a fresh clone.** Local `main` is a single clean commit: no `.env`, database files or recovery archives (checked; `npm ci`, `npm run check` and `npm test` pass in a standalone clone). Before the first deploy: (1) rotate the Neon database password and `ORIGIN_SECRET`, because the old `origin/main` on GitHub published them; (2) replace the public history with `git push --force origin main`. A normal push cannot remove the old files. Never copy credential values into a ticket or chat.

## Layout and settings

Use this `backend/` repository as the Vercel project root. `api/entry.mjs` adapts the existing Node API to a Vercel Function; `vercel.mjs` routes `/api/*` to it. `api/cron.mjs` exposes a separately authenticated watchdog. The frontend remains a separate Vercel project and rewrites same-origin `/api/*` to this backend origin. There is no client-side database or model credential. The **first Vercel publish can build without the two URLs**; API calls fail closed with 503 until the database and frontend origin are configured. After the frontend URL exists, put its HTTPS origin in the public-only `deployment.config.mjs` and push. `ALLOWED_ORIGINS` in Vercel Project Settings overrides the file.

Set these in **Vercel Project Settings → Environment Variables**, separately for Preview and Production; do not upload `.env`. Use `.env.example` only as a local template.

| Variable | Requirement |
| --- | --- |
| `DATABASE_URL` | New rotated Neon PostgreSQL URL with certificate verification. Never use SQLite or an ephemeral Vercel filesystem. |
| `ALLOWED_ORIGINS` | Optional override for `deployment.config.mjs`; exact HTTPS frontend origin, comma-separated if needed. Include only domains that may send writes. |
| `SPARELY_DEMO` | Required. `on` lets visitors switch into the shared demo profiles (Teja, Aanya, Kabir, Mira) without a password: anyone with the URL can use them, so share the link only with people you trust and keep only sample data there. `off` blocks them; their data stays. Real accounts work either way. Pair `on` with frontend `VITE_PUBLIC_DEMO=on`. |
| `COOKIE_SECURE` | `1`; the adapter also forces Secure cookies. |
| `CRON_SECRET` | New independent random value of at least 32 bytes for `/api/cron`. |
| `SPARELY_CRON_SCHEDULE` | `*/5 * * * *` on a Vercel plan supporting five-minute cron; otherwise leave empty and configure a trusted external five-minute scheduler to call `GET /api/cron` with `Authorization: Bearer <CRON_SECRET>`. |
| `LLM_URL`, `LLM_MODEL`, `LLM_API_KEY`, `LLM_TIMEOUT_MS` | Optional server-only OpenAI-compatible model endpoint. Leave `LLM_URL` unset when no secured, publicly reachable model endpoint is available. |
| `SPARELY_BUILD_ID` | Optional release label shown in `/api/health`. |

`ORIGIN_SECRET` and `NEON_FUNCTION_URL` belong to the separate Neon Function/proxy architecture and are not used by this Vercel API adapter. Rotate the exposed `ORIGIN_SECRET` on any retained Neon Function and proxy before using either architecture again.

## Release sequence

1. Rotate exposed credentials and invalidate exposed sessions/reset codes. Remove the sensitive files from the public repository's history and confirm a fresh clone contains none. Do not rely on a normal deletion commit alone. Keep local backups in private storage and verify who could access their published copies.
2. Run `npm ci`, `npm run check`, `npm test`, `npm run db:status`. The migration ledger must show no changed migrations. Before applying any pending migration, take a verified private backup and run the existing restore drill.
3. Deploy backend with Node 22 or newer, then check `/api/health` and `/api/ready` on its exact HTTPS URL. `/api/ready` must report database and migrations healthy.
4. Deploy the frontend. Put the backend HTTPS origin in frontend `deployment.config.mjs` and the frontend HTTPS origin in backend `deployment.config.mjs`, then push both repositories for automatic redeployment. Production copy defaults to demo off. Use Vercel environment variables instead of those files if Preview and Production need different origins.
5. Verify signup/login, Secure + HttpOnly + SameSite=Strict session cookie, listing read/write, foreign-Origin 403, 401 for unauthenticated cron, and five-minute successful `worker_runs` entries in Operations. Check on both desktop and phone.
6. Keep a private off-device database backup and a practiced restore route. A Vercel rollback restores code, not database contents.

The request path is restricted before forwarding to the existing API. The adapter refuses startup without PostgreSQL, a frontend origin and an explicit `SPARELY_DEMO`. Oversized bodies fail with 413; backend failures return 503 with `Retry-After`, so clients can reconcile writes by their original idempotency key. The API does not silently switch databases. The worker records idempotent runs, but the five-minute schedule must be verified after deployment; request-time catch-up does not deliver reminders on time while nobody visits.

## AI in production

The local `gemma3:4b` Ollama endpoint has responded in a local check, but Vercel cannot reach a laptop's `localhost` or private Wi-Fi address. [OLLAMA_PRODUCTION.md](OLLAMA_PRODUCTION.md) gives a no-domain Tailscale Funnel setup that exposes only an authenticated gateway on the Ollama PC. The model PC and tunnel must stay online. Without a reachable `LLM_URL`, search uses local rules, reminders use safe template wording, and translations show the original text. Never expose Ollama's unauthenticated port directly to the internet.
