// Deploy this repository as a separate Vercel project rooted at /.
// Set SPARELY_CRON_SCHEDULE=*/5 * * * * only on a plan that supports it.
export const config = {
  functions: { 'api/*.mjs': { maxDuration: 60 } },
  rewrites: [{ source: '/api/:path*', destination: '/api/entry?sparelyPath=:path*' }],
  ...(process.env.SPARELY_CRON_SCHEDULE ? { crons: [{ path: '/api/cron', schedule: process.env.SPARELY_CRON_SCHEDULE }] } : {}),
};
