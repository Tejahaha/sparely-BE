import { createVercelHandler } from '../lib/vercel-handler.mjs';

const handler = createVercelHandler();
export default { fetch: request => handler.runWatchdog(request) };
