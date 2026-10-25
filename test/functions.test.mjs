import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNeonHandler } from '../functions/handler.mjs';
import { createApplication } from '../server.mjs';
import { createServer } from 'node:http';
import { createRemoteProxy } from '../lib/remote-proxy.mjs';

const secret = 'test-only-server-secret-that-is-long-enough';
const request = (path, init = {}) => new Request(`https://function.example${path}`, init);
test('Function rejects unauthenticated work before database startup; authenticated cookies and command headers survive', async () => {
  let starts = 0;
  const handler = createNeonHandler({ secret, applicationFactory: () => { starts++; return createApplication({ dbPath: ':memory:', watchdogInterval: 0 }); } });
  try {
    assert.throws(() => createNeonHandler({ secret: '' }), /ORIGIN_SECRET/);
    assert.equal((await handler.fetch(request('/api/bootstrap'))).status, 401);
    assert.equal((await handler.fetch(request('/internal/watchdog', { method:'POST', headers: { 'x-secret': secret } }))).status, 401);
    assert.equal(starts, 0);
    const bootstrap = await handler.fetch(request('/api/bootstrap', { headers: { 'x-secret': secret } }));
    assert.equal(bootstrap.status, 200);
    assert.equal((await bootstrap.json()).user, null);
    const session = await handler.fetch(request('/api/session', { method:'POST', headers: { 'x-secret':secret, origin:'https://app.example', 'content-type':'application/json' }, body:JSON.stringify({ userId:'kabir' }) }));
    const cookie = session.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/);
    assert.equal((await session.json()).user.id, 'kabir');
    const save = await handler.fetch(request('/api/listings/drill-kit/favorite', { method:'PUT', headers: { 'x-secret':secret, cookie:cookie.split(';')[0], 'x-sparely-actor':'kabir', origin:'https://app.example', 'content-type':'application/json' }, body:JSON.stringify({ saved:true }) }));
    assert.equal(save.status, 200, 'the expected-account header survives the Function hop');
    assert.equal(starts, 1);
    const oversized = await handler.fetch(request('/api/listings', { method:'POST', headers:{ 'x-secret':secret }, body:'x'.repeat(5_000_001) }));
    assert.equal(oversized.status, 413);
    const fake = { version:1, invocation_id:'test-delivery', trigger:{ type:'schedule',id:'trigger-test',name:'sparely-watchdog' }, data:{ scheduled_at:new Date().toISOString() } };
    const tick = await handler.fetch(request('/internal/watchdog', { method:'POST', headers:{ 'x-neon-trigger-invocation-id':'test-delivery','content-type':'application/json' }, body:JSON.stringify(fake) }));
    assert.equal(tick.status, 200);
    assert.equal((await tick.json()).ok, true);
    // Real Neon ingress strips client x-neon-* headers; this trusted-delivery simulation is local only.
  } finally { await handler.close(); }
});

test('server proxy checks browser origins, keeps secrets server-side, forwards retries and handles upstream failure', async () => {
  let calls = 0;
  const upstream = createServer(async (req,res) => {
    calls++;
    assert.equal(req.headers['x-secret'], secret);
    res.writeHead(200, { 'content-type':'application/json', 'set-cookie':'sparely_session=test; HttpOnly; SameSite=Strict; Path=/; Secure', 'idempotency-status':'replayed' });
    res.end(JSON.stringify({ cookie:req.headers.cookie, key:req.headers['idempotency-key'], actor:req.headers['x-sparely-actor'], client:req.headers['x-sparely-client'], path:req.url }));
  });
  await new Promise(resolve => upstream.listen(0,'127.0.0.1',resolve));
  const proxy = createRemoteProxy({ functionUrl:`http://127.0.0.1:${upstream.address().port}/`, secret });
  await new Promise(resolve => proxy.listen(0,'127.0.0.1',resolve));
  const origin = `http://127.0.0.1:${proxy.address().port}`;
  try {
    const foreign = await fetch(origin+'/api/session', { method:'POST', headers:{ Origin:'https://evil.example','content-type':'application/json' }, body:'{}' });
    assert.equal(foreign.status,403); assert.equal(calls,0);
    const reply = await fetch(origin+'/api/bookings?test=1', { method:'POST', headers:{ Origin:origin, Cookie:'sparely_session=test', 'content-type':'application/json', 'idempotency-key':'stable-command-key-123', 'x-sparely-actor':'teja', 'x-sparely-client':'203.0.113.9', 'x-secret':'untrusted-browser-value' }, body:'{}' });
    assert.equal(reply.status,200); assert.equal(reply.headers.get('idempotency-status'),'replayed');
    assert.doesNotMatch(reply.headers.get('set-cookie'),/; Secure/);
    assert.equal(reply.headers.get('x-secret'),null);
    assert.deepEqual(await reply.json(),{ cookie:'sparely_session=test',key:'stable-command-key-123',actor:'teja',client:'127.0.0.1',path:'/api/bookings?test=1' }, 'a browser cannot choose the caller address the proxy reports');
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    const failed = await fetch(origin+'/api/bootstrap');
    assert.equal(failed.status,503); assert.equal(failed.headers.get('retry-after'),'1');
    assert.equal((await failed.json()).retryable,true);
  } finally {
    proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve));
    if (upstream.listening) { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
  }
});
