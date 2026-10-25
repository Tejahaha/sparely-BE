// Server-side administration (never exposed over HTTP).
//   npm run admin -- operator grant someone@example.com
//   npm run admin -- operator revoke someone@example.com
import { Store } from '../lib/store.mjs';
const [area, action, email] = process.argv.slice(2);
const url = process.env.SPARELY_DATABASE_URL || process.env.DATABASE_URL;
try {
  if (area !== 'operator' || !['grant', 'revoke'].includes(action) || !email) throw new Error('Usage: npm run admin -- operator grant|revoke <account email>');
  if (!url) throw new Error('DATABASE_URL is not configured.');
  const store = new Store(url, { seed: false });
  try {
    await store.ready;
    await store.accounts.setOperator(email, action === 'grant');
    console.log(`Operator role ${action === 'grant' ? 'granted to' : 'revoked from'} ${email.toLowerCase()}.`);
  } finally { await store.close(); }
} catch (error) { console.error(error.message); process.exitCode = 1; }
