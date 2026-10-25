import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.woff2':'font/woff2', '.jpg':'image/jpeg', '.png':'image/png', '.webp':'image/webp', '.json':'application/json' };
export async function serveStatic(req, res, url, frontendRoot) {
  if (!['GET','HEAD'].includes(req.method)) { res.writeHead(405); return res.end('Method not allowed.'); }
  const root = existsSync(resolve(frontendRoot, 'dist/index.html')) ? resolve(frontendRoot, 'dist') : resolve(frontendRoot, 'public');
  const path = resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
  if (!path.startsWith(root + sep)) { res.writeHead(404); return res.end('Not found.'); }
  try { await stat(path); } catch { res.writeHead(404); return res.end('Not found.'); }
  const body = await readFile(path);
  res.writeHead(200, { 'Content-Type':mime[extname(path)] || 'application/octet-stream', 'Content-Length':body.length, 'Cache-Control':'no-cache', 'X-Content-Type-Options':'nosniff' });
  res.end(req.method === 'HEAD' ? undefined : body);
}
