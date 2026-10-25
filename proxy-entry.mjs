// Node request/response handler for a trusted frontend host's /api/* route.
// Protect the demo frontend at the host, or add real user authentication first.
import { createRemoteHandler } from './lib/remote-proxy.mjs';
export default createRemoteHandler({
  functionUrl: process.env.NEON_FUNCTION_URL,
  secret: process.env.ORIGIN_SECRET,
  appOrigin: process.env.APP_ORIGIN
});
