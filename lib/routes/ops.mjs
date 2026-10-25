// HTTP routes for lib/ops.mjs. Return undefined when the request is not handled here.
// ctx: { req, res, url, input, user, store, json, command, AppError, fail }
export default async function routes({ req, url, user, store, json, fail }) {
  if (url.pathname === '/api/operations/diagnostics' && req.method === 'GET') {
    // Operators only (demo or account world). The payload holds no personal data, so the
    // shared demo operator sees the same diagnostics as an account operator.
    fail(user.role !== 'Operator', 'Only operators can view system diagnostics.', 403);
    return json(await store.ops.diagnostics(user.id));
  }
  return undefined;
}
