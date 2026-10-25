import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createOllamaGateway } from '../scripts/ollama-gateway.mjs';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });

test('Ollama gateway exposes only authenticated bounded chat and embedding requests', async () => {
  const upstream = createServer((req, res) => {
    assert.ok(['/v1/chat/completions', '/v1/embeddings'].includes(req.url));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url === '/v1/embeddings' ? { data: [{ index: 0, embedding: [0.1, 0.2] }] } : { choices: [{ message: { content: '{"ok":true}' } }] }));
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
    assert.equal((await fetch(`${base}/v1/embeddings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    const vectors = await fetch(`${base}/v1/embeddings`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{"input":["x"]}' });
    assert.deepEqual((await vectors.json()).data[0].embedding, [0.1, 0.2]);
    assert.equal((await fetch(`${base}/api/pull`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' })).status, 404, 'model management stays private');
  } finally {
    await close(gateway);
    await close(upstream);
  }
});
