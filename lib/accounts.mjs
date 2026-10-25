import { createHash, randomBytes, randomInt, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { AppError, fail } from './errors.mjs';

const scrypt = promisify(scryptCallback);
const COST = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const emailOf = value => String(value || '').trim().toLowerCase().slice(0, 254);
const sha256 = value => createHash('sha256').update(value).digest('hex');
export const SESSION_MS = 7 * 86400_000;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 32, COST);
  return `scrypt$${COST.N}$${COST.r}$${COST.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}
export async function verifyPassword(password, stored) {
  const [scheme, N, r, p, salt, expected] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const key = await scrypt(password, Buffer.from(salt, 'base64'), 32, { N: Number(N), r: Number(r), p: Number(p), maxmem: COST.maxmem });
  const want = Buffer.from(expected, 'base64');
  return want.length === key.length && timingSafeEqual(want, key);
}
const checkPassword = password => fail(typeof password !== 'string' || password.length < 10 || password.length > 200, 'Use a password of at least 10 characters.');
const checkEmail = email => fail(!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email), 'Enter a valid email address.');

// Real accounts live in the "account" world; the shared hackathon profiles are the
// "demo" world. Listings, bookings, cases and operator review never cross worlds.
export class Accounts {
  constructor(store) { this.store = store; this.db = store.db; }

  async world(userId) {
    return (await this.db.prepare('SELECT 1 FROM accounts WHERE user_id=?').get(userId)) ? 'account' : 'demo';
  }
  async account(userId) {
    const a = await this.db.prepare('SELECT email,email_verified AS emailVerified,created_at AS createdAt FROM accounts WHERE user_id=?').get(userId);
    return a ? { email: a.email, emailVerified: !!a.emailVerified, createdAt: a.createdAt } : null;
  }

  // Fixed-window limits stored in the database, so they hold across API instances.
  async limit(bucket, max, windowMs) {
    const now = Date.now(), window = now - (now % windowMs);
    await this.db.prepare('INSERT INTO rate_limits(bucket,window_start,count) VALUES(?,?,1) ON CONFLICT(bucket,window_start) DO UPDATE SET count=rate_limits.count+1').run(bucket, window);
    const row = await this.db.prepare('SELECT count FROM rate_limits WHERE bucket=? AND window_start=?').get(bucket, window);
    if (randomInt(100) === 0) await this.db.prepare('DELETE FROM rate_limits WHERE window_start<?').run(now - 2 * 86400_000);
    if (row.count > max) throw new AppError('Too many attempts. Please wait a little and try again.', 429, 'RATE_LIMITED', { retryAfterSeconds: Math.ceil((window + windowMs - now) / 1000) });
  }

  async signup(input, clientKey) {
    await this.limit(`signup:${clientKey}`, 10, 3600_000);
    const email = emailOf(input.email), name = String(input.name || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    checkEmail(email); checkPassword(input.password);
    fail(name.length < 2, 'Tell us your name.');
    const area = String(input.area || '').trim().slice(0, 80);
    const hash = await hashPassword(input.password);
    return await this.store.transaction(async () => {
      fail(await this.db.prepare('SELECT 1 FROM accounts WHERE email=?').get(email), 'An account with this email already exists. Sign in instead.', 409);
      const id = `u-${randomUUID()}`, initials = name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
      // Every signup is an ordinary member; operators are provisioned only by the admin script.
      await this.db.prepare('INSERT INTO users(id,name,initials,role,area) VALUES(?,?,?,?,?)').run(id, name, initials, 'Member', area || 'Not set');
      await this.db.prepare('INSERT INTO accounts(user_id,email,password_hash,email_verified,created_at) VALUES(?,?,?,0,?)').run(id, email, hash, new Date().toISOString());
      return id;
    });
  }

  async login(input, clientKey) {
    const email = emailOf(input.email);
    await this.limit(`login-ip:${clientKey}`, 50, 15 * 60_000);
    await this.limit(`login:${email}`, 10, 15 * 60_000);
    const row = await this.db.prepare('SELECT user_id,password_hash FROM accounts WHERE email=?').get(email);
    // Same work and message whether or not the email exists.
    const ok = await verifyPassword(String(input.password || ''), row?.password_hash || 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    fail(!row || !ok, 'That email and password do not match.', 401);
    return row.user_id;
  }

  async changePassword(userId, input, keepToken) {
    const row = await this.db.prepare('SELECT password_hash FROM accounts WHERE user_id=?').get(userId);
    fail(!row, 'Demo profiles do not have passwords.', 403);
    fail(!(await verifyPassword(String(input.current || ''), row.password_hash)), 'Your current password is not correct.', 401);
    checkPassword(input.next);
    await this.db.prepare('UPDATE accounts SET password_hash=? WHERE user_id=?').run(await hashPassword(input.next), userId);
    await this.db.prepare('DELETE FROM sessions WHERE user_id=? AND token<>?').run(userId, keepToken);
  }

  // No email provider is configured, so recovery is operator-assisted: an operator
  // issues a one-time code and gives it to the verified person out of band.
  async issueReset(operatorId, input) {
    const operator = await this.store.user(operatorId);
    fail(operator.role !== 'Operator' || (await this.world(operatorId)) !== 'account', 'Only an account operator can issue a reset code.', 403);
    await this.limit(`reset-issue:${operatorId}`, 20, 3600_000);
    const row = await this.db.prepare('SELECT user_id FROM accounts WHERE email=?').get(emailOf(input.email));
    fail(!row, 'No account uses that email.', 404);
    const code = String(randomInt(10 ** 7, 10 ** 8));
    await this.db.prepare('INSERT INTO password_resets(token_hash,user_id,expires,used_at,issued_by) VALUES(?,?,?,NULL,?)').run(sha256(`${row.user_id}:${code}`), row.user_id, Date.now() + 30 * 60_000, operatorId);
    return { code, expiresInMinutes: 30 };
  }
  async reset(input, clientKey) {
    const email = emailOf(input.email);
    await this.limit(`reset:${email}`, 8, 15 * 60_000);
    await this.limit(`reset-ip:${clientKey}`, 30, 15 * 60_000);
    checkPassword(input.password);
    const account = await this.db.prepare('SELECT user_id FROM accounts WHERE email=?').get(email);
    const hash = account ? sha256(`${account.user_id}:${String(input.code || '').trim()}`) : '';
    return await this.store.transaction(async () => {
      const token = account && await this.db.prepare('SELECT * FROM password_resets WHERE token_hash=? AND used_at IS NULL AND expires>?').get(hash, Date.now());
      fail(!token, 'That reset code is not valid or has expired. Ask an operator for a new one.', 400);
      await this.db.prepare('UPDATE password_resets SET used_at=? WHERE token_hash=?').run(new Date().toISOString(), hash);
      await this.db.prepare('UPDATE accounts SET password_hash=? WHERE user_id=?').run(await hashPassword(input.password), account.user_id);
      await this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(account.user_id);
      return account.user_id;
    });
  }

  // Admin-only (server CLI). Never reachable over HTTP.
  async setOperator(email, grant) {
    const row = await this.db.prepare('SELECT user_id FROM accounts WHERE email=?').get(emailOf(email));
    fail(!row, 'No account uses that email.', 404);
    await this.db.prepare('UPDATE users SET role=? WHERE id=?').run(grant ? 'Operator' : 'Member', row.user_id);
    return row.user_id;
  }
}
