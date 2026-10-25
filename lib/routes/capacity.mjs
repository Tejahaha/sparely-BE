// HTTP routes for lib/capacity.mjs (M4). Return undefined when not handled here.
import { timeRange } from '../store.mjs';

export default async function routes({ req, url, input, user, store, json, command }) {
  const path = url.pathname;
  if (path === '/api/pricing/caps' && req.method === 'GET') return json(await store.capacity.listCaps(user.id));
  if (path === '/api/pricing/caps' && req.method === 'POST') return await command('value', async () => ({ cap: await store.capacity.setCap(user.id, input) }), 201);
  let match = path.match(/^\/api\/listings\/([^/]+)\/storage-rate$/);
  if (match && req.method === 'PUT') return await command('listing', async () => await store.capacity.setRate(user.id, match[1], input));
  match = path.match(/^\/api\/listings\/([^/]+)\/capacity$/);
  if (match && req.method === 'GET') {
    const l = await store.visibleListing(match[1], user.id);
    const { start, end } = timeRange(url.searchParams.get('start'), url.searchParams.get('end'));
    return json({ mode: l.storage?.mode || null, usableSqft: l.storage?.usableSqft ?? null, availableSqft: await store.capacity.availableSqft(l, start, end) });
  }
  return undefined;
}
