import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createOllamaGateway } from '../scripts/ollama-gateway.mjs';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });

test('Ollama gateway exposes only authenticated bounded chat requests', async () => {
  const upstream = createServer((req, res) => {
    assert.equal(req.url, '/v1/chat/completions');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
  });
  await listen(upstream);
  const token = '0123456789abcdef0123456789abcdef';
  const gateway = createOllamaGateway({ token, upstream: `http://127.0.0.1:${upstream.address().port}` });
  await listen(gateway);
  const base = `http://127.0.0.1:${gateway.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/tags`)).status, 404);
    assert.equal((await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    const good = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(good.status, 200);
    assert.equal((await good.json()).choices[0].message.content, '{"ok":true}');
    const big = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: 'x'.repeat(65_000) });
    assert.equal(big.status, 413);
  } finally {
    await close(gateway);
    await close(upstream);
  }
});
