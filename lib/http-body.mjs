export async function limitedBody(stream, limit = 5_000_000) {
  const chunks = []; let size = 0;
  if (!stream) return undefined;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('This upload is too large.'); error.status = 413; throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Forward only the headers needed by Sparely's JSON API.
export function apiHeaders(source) {
  const result = new Headers();
  for (const name of ['content-type', 'cookie', 'idempotency-key', 'authorization', 'x-sparely-actor', 'x-sparely-client', 'x-request-id']) {
    const value = source.get(name); if (value) result.set(name, value);
  }
  return result;
}

// Correlation id: keep a caller's id only when it is short and plain; otherwise make one.
export const acceptRequestId = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{8,128}$/.test(value) ? value : crypto.randomUUID();
