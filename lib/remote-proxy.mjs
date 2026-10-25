import { createServer } from 'node:http';
import { acceptRequestId, apiHeaders, limitedBody } from './http-body.mjs';
import { serveStatic } from './static.mjs';
import { fetchNeon } from './neon-dns.mjs';

export function createRemoteHandler({ functionUrl, secret, appOrigin, frontendRoot, allowedOrigins = [] }) {
  const base = new URL(functionUrl);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1','localhost'].includes(base.hostname))) throw new Error('The Function URL must use HTTPS.');
  if (base.username || base.password || base.hash || base.search || base.pathname !== '/') throw new Error('Use the exact root Neon invocation URL.');
  if (!secret || Buffer.byteLength(secret) < 32) throw new Error('ORIGIN_SECRET of at least 32 bytes is required.');
  if (appOrigin && new URL(appOrigin).origin !== appOrigin) throw new Error('APP_ORIGIN must be an exact origin without a trailing slash or path.');
  return async (req, res) => {
    const requestId = acceptRequestId(req.headers['x-request-id']);
    res.setHeader('X-Request-Id', requestId);
    const json = (value, status) => { res.writeHead(status, { 'Content-Type':'application/json', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff' }); res.end(JSON.stringify(value)); };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!url.pathname.startsWith('/api/')) {
        if (frontendRoot) return await serveStatic(req, res, url, frontendRoot);
        return json({ error:'Not found.' }, 404);
      }
      const expectedOrigin = appOrigin || `http://${req.headers.host}`;
      if (['POST','PUT','PATCH','DELETE'].includes(req.method) && req.headers.origin && req.headers.origin !== expectedOrigin && !allowedOrigins.includes(req.headers.origin)) return json({ error:'Request origin is not allowed.' }, 403);
      const target = new URL(base); target.pathname = url.pathname; target.search = url.search;
      const headers = apiHeaders(new Headers(Object.entries(req.headers).filter(([,value]) => typeof value === 'string')));
      headers.set('x-secret', secret);
      headers.set('x-request-id', requestId);
      // Overwrite any client-supplied value: only this trusted proxy states the caller address.
      headers.set('x-sparely-client', req.socket.remoteAddress || 'unknown');
      if (req.headers.origin) headers.set('origin', req.headers.origin);
      const body = ['GET','HEAD'].includes(req.method) ? undefined : await limitedBody(req);
      const upstream = await fetchNeon(target, { method:req.method, headers, body, redirect:'manual', signal:AbortSignal.timeout(60_000) });
      const data = Buffer.from(await upstream.arrayBuffer());
      for (const [key, value] of upstream.headers) {
        if (!['connection','keep-alive','transfer-encoding','content-encoding','content-length','set-cookie'].includes(key)) res.setHeader(key, value);
      }
      const origin = new URL(expectedOrigin);
      // Plain-HTTP access (localhost or a LAN/Tailscale peer) cannot keep Secure cookies.
      const insecureLocal = origin.protocol === 'http:';
      const cookies = upstream.headers.getSetCookie().map(cookie => insecureLocal ? cookie.replace(/;\s*Secure(?=;|$)/ig, '') : cookie);
      if (cookies.length) res.setHeader('Set-Cookie', cookies);
      res.writeHead(upstream.status, { 'Content-Length':data.length }); res.end(req.method === 'HEAD' ? undefined : data);
    } catch (error) {
      console.error(JSON.stringify({ at: new Date().toISOString(), level: 'error', event: 'proxy_failed', requestId, error: String(error.code || error.status || 'upstream_error') }));
      if (!res.headersSent) {
        const tooLarge = error.status === 413;
        if (!tooLarge) res.setHeader('Retry-After','1');
        json({ error:tooLarge ? error.message : 'Hosted backend unavailable. Reconcile the operation before retrying.', retryable:!tooLarge }, tooLarge ? 413 : 503);
      } else res.end();
    }
  };
}

export const createRemoteProxy = options => createServer(createRemoteHandler(options));
