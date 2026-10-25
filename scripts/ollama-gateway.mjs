import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { limitedBody } from '../lib/http-body.mjs';

// Run this on the Ollama PC, behind Tailscale Funnel. It exposes only the
// chat-completions and embeddings paths and requires the same bearer token set as LLM_API_KEY
// in the deployed backend. Never expose Ollama's unauthenticated port itself.
export function createOllamaGateway({
  token = process.env.OLLAMA_GATEWAY_TOKEN,
  upstream = process.env.OLLAMA_LOCAL_URL || 'http://127.0.0.1:11434',
} = {}) {
  if (!token || Buffer.byteLength(token) < 32) throw new Error('OLLAMA_GATEWAY_TOKEN must contain at least 32 bytes.');
  const target = new URL(upstream);
  if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || target.pathname !== '/') {
    throw new Error('OLLAMA_LOCAL_URL must be a loopback HTTP origin.');
  }
  const expected = Buffer.from(token);
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    // Chat for search/reminder wording; embeddings for meaning-based search (vectors are large).
    const limits = { '/v1/chat/completions': [64_000, 256_000], '/v1/embeddings': [256_000, 8_000_000] }[req.url];
    if (!limits || req.method !== 'POST') return json(404, { error: 'Not found.' });
    const supplied = /^Bearer (.+)$/.exec(String(req.headers.authorization || ''))?.[1];
    if (!supplied) return json(401, { error: 'Unauthorized' });
    const received = Buffer.from(supplied);
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) return json(401, { error: 'Unauthorized' });
    if (!/^application\/json(?:;|$)/i.test(String(req.headers['content-type'] || ''))) return json(415, { error: 'JSON required.' });
    try {
      const body = await limitedBody(req, limits[0]);
      const response = await fetch(new URL(req.url, target), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(25_000),
      });
      const content = await limitedBody(response.body, limits[1]);
      res.writeHead(response.status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(content);
    } catch (error) {
      json(error.status === 413 ? 413 : 503, { error: error.status === 413 ? 'Request or response too large.' : 'Model unavailable.' });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.OLLAMA_GATEWAY_PORT || 11435);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid OLLAMA_GATEWAY_PORT.');
  createOllamaGateway().listen(port, '127.0.0.1', () => console.log(`Authenticated Ollama gateway listening on 127.0.0.1:${port}`));
}
