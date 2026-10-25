// Upload check shared by every image validator: the declared data-URL type must match the
// decoded bytes (magic numbers). SVG, HTML and relabelled files are rejected.
const signatures = {
  png: b => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpeg: b => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  webp: b => b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
};

// Default limit matches the existing contract: ≤ 3 MB decoded (request bodies stay ≤ 5 MB).
export function checkImage(dataUrl, { maxBytes = 3_000_000 } = {}) {
  if (typeof dataUrl !== 'string') return { ok: false, reason: 'not_a_data_url' };
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl.length <= Math.ceil(maxBytes / 3) * 4 + 30 ? dataUrl : '');
  if (!match) return { ok: false, reason: dataUrl.startsWith('data:image/') ? 'unsupported_or_too_large' : 'not_a_data_url' };
  const [, type, base64] = match;
  if (base64.length % 4) return { ok: false, reason: 'invalid_base64' };
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length || bytes.length > maxBytes) return { ok: false, reason: 'too_large' };
  if (!signatures[type](bytes)) return { ok: false, reason: 'content_does_not_match_type' };
  return { ok: true, type, bytes: bytes.length };
}
