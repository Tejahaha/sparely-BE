import net from 'node:net';
import https from 'node:https';
const cache = new Map();
export async function resolveNeon(host) {
  if (!host.endsWith('.neon.tech')) throw new Error('DNS fallback is restricted to Neon hosts');
  const cached = cache.get(host);
  if (cached && cached.expires > Date.now()) return cached.address;
  const response = await fetch(`https://dns.google/resolve?type=A&name=${encodeURIComponent(host)}`, { signal:AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error('Database DNS resolver unavailable');
  const data = await response.json();
  const row = data.Answer?.find(record => record.type === 1 && net.isIP(record.data) === 4);
  if (data.Status !== 0 || !row) throw new Error('Neon DNS address not available');
  cache.set(host, { address:row.data, expires:Date.now()+Math.min(row.TTL || 30,300)*1000 });
  return row.data;
}

// Local opt-in only. Original HTTPS hostname, SNI and certificate validation are preserved.
export async function fetchNeon(input, init = {}) {
  const url = new URL(input);
  if (process.env.NEON_DNS_FALLBACK !== '1' || !url.hostname.endsWith('.neon.tech')) return fetch(url, init);
  if (url.protocol !== 'https:') throw new Error('Neon fallback requires HTTPS');
  const address = await resolveNeon(url.hostname);
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method:init.method || 'GET', headers:Object.fromEntries(new Headers(init.headers)), signal:init.signal,
      lookup:(_host, options, callback) => options.all ? callback(null,[{ address,family:4 }]) : callback(null,address,4)
    }, res => {
      const chunks=[];
      res.on('data', chunk => chunks.push(chunk)); res.on('error',reject);
      res.on('end', () => {
        const headers = new Headers();
        for (let i=0;i<res.rawHeaders.length;i+=2) headers.append(res.rawHeaders[i],res.rawHeaders[i+1]);
        resolve(new Response([101,204,205,304].includes(res.statusCode) || init.method === 'HEAD' ? null : Buffer.concat(chunks), { status:res.statusCode, headers }));
      });
    });
    req.on('error',reject); req.end(init.body);
  });
}
