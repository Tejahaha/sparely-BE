import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SPARELY_DEMO = 'off';
const { createApplication } = await import('../server.mjs');
const { createVercelHandler } = await import('../lib/vercel-handler.mjs');

test('Vercel adapter forwards API paths, query strings and secure cookies; cron requires its secret', async () => {
  const oldSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = '0123456789abcdef0123456789abcdef';
  const handler = createVercelHandler({ applicationFactory: () => createApplication({ dbPath: ':memory:', watchdogInterval: 0 }), productionChecks: false });
  try {
    const health = await handler.fetch(new Request('https://backend.example/api/entry?sparelyPath=health'));
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);
    const bootstrap = await handler.fetch(new Request('https://backend.example/api/entry?sparelyPath=bootstrap&test=1'));
    assert.equal(bootstrap.status, 200);
    const signup = await handler.fetch(new Request('https://backend.example/api/entry?sparelyPath=auth/signup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Asha Iyer', email: 'asha@example.com', password: 'correct horse battery' })
    }));
    assert.equal(signup.status, 201);
    assert.match(signup.headers.get('set-cookie'), /; Secure(?:;|$)/);
    assert.match(signup.headers.get('set-cookie'), /; HttpOnly;/);
    const foreign = await handler.fetch(new Request('https://backend.example/api/entry?sparelyPath=auth/signup', {
      method: 'POST', headers: { Origin: 'https://foreign.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Other Person', email: 'other@example.com', password: 'correct horse battery' })
    }));
    assert.equal(foreign.status, 403);
    const badPath = await handler.fetch(new Request('https://backend.example/api/entry?sparelyPath=../health'));
    assert.equal(badPath.status, 404);
    const badCron = await handler.runWatchdog(new Request('https://backend.example/api/cron'));
    assert.equal(badCron.status, 401);
    const cron = await handler.runWatchdog(new Request('https://backend.example/api/cron', { headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` } }));
    assert.equal(cron.status, 200);
    assert.equal((await cron.json()).ok, true);
  } finally {
    await handler.close();
    if (oldSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = oldSecret;
  }
});
