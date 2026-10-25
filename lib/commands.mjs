import { createHash } from 'node:crypto';
import { AppError } from './errors.mjs';
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
export const fingerprint = (method, path, body) => createHash('sha256').update(canonical({
  method,
  path,
  body
})).digest('hex');

// Receipts contain resource references, never a second copy of photos or codes.
export class Commands {
  constructor(store) {
    this.store = store;
    this.ready = this.initialize();
  }
  async execute(actor, key, hash, work, {
    required = false
  } = {}) {
    if (!key) {
      if (required) throw new AppError('Send an Idempotency-Key for this operation.', 428, 'IDEMPOTENCY_KEY_REQUIRED');
      return {
        ...(await work()),
        idempotency: 'not-provided'
      };
    }
    if (!/^[A-Za-z0-9._:-]{16,128}$/.test(key)) throw new AppError('Idempotency-Key must contain 16–128 letters, numbers, dots, colons, underscores or hyphens.', 400, 'INVALID_IDEMPOTENCY_KEY');
    return await this.store.transaction(async () => {
      const receipt = await this.store.db.prepare('SELECT * FROM command_receipts WHERE actor_id=? AND key=?').get(actor, key);
      if (receipt) {
        if (receipt.fingerprint !== hash) throw new AppError('This key was already used for a different request. Use a new key for a new operation.', 409, 'IDEMPOTENCY_CONFLICT');
        return {
          ...JSON.parse(receipt.result),
          idempotency: 'replayed'
        };
      }
      const result = await work();
      await this.store.db.prepare('INSERT INTO command_receipts VALUES(?,?,?,?,?)').run(actor, key, hash, JSON.stringify(result), new Date().toISOString());
      return {
        ...result,
        idempotency: 'created'
      };
    });
  }
  async initialize() {
    await this.store.db.exec(`CREATE TABLE IF NOT EXISTS command_receipts(
      actor_id TEXT NOT NULL REFERENCES users(id), key TEXT NOT NULL, fingerprint TEXT NOT NULL,
      result TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(actor_id,key));`);
  }
}
