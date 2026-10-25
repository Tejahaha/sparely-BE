import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { Pool, types } from 'pg';
import net from 'node:net';

// Opt-in, process-local resolver for networks whose DNS refuses Neon hosts.
// The pg connection still verifies the original hostname's TLS certificate.
const dnsCache = new Map();
async function resolveNeon(host) {
  if (!host.endsWith('.neon.tech')) throw new Error('DNS fallback is restricted to Neon hosts');
  const cached = dnsCache.get(host);
  if (cached && cached.expires > Date.now()) return cached.address;
  const response = await fetch(`https://dns.google/resolve?type=A&name=${encodeURIComponent(host)}`, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error('Database DNS resolver unavailable');
  const data = await response.json();
  const row = data.Answer?.find(record => record.type === 1 && net.isIP(record.data) === 4);
  if (data.Status !== 0 || !row) throw new Error('Database DNS address not available');
  dnsCache.set(host, { address: row.data, expires: Date.now() + Math.min(row.TTL || 30, 300) * 1000 });
  return row.data;
}
const neonStream = () => {
  const socket = new net.Socket(), connect = socket.connect.bind(socket);
  socket.connect = (port, host) => {
    resolveNeon(host).then(address => connect({ port, host: address })).catch(error => socket.destroy(error));
    return socket;
  };
  return socket;
};

export const TABLE_COLUMNS = {
  users: ['id','name','initials','role','area'],
  sessions: ['token','user_id','expires'],
  listings: ['id','owner_id','title','description','category','city','area','rate','unit','deposit','image','photo','details','active','created_at'],
  favorites: ['user_id','listing_id'],
  bookings: ['id','listing_id','renter_id','start','end','status','note','quote','pickup_code','return_code','hold_until','trace','created_at'],
  evidence: ['id','booking_id','stage','note','image','created_at'],
  booking_meta: ['booking_id','policy','details'],
  command_receipts: ['actor_id','key','fingerprint','result','created_at'],
  incidents: ['id','booking_id','reporter_id','type','status','description','last_known','version','created_at','updated_at','review_due_at','plan','resolution'],
  incident_entries: ['id','incident_id','actor_id','kind','note','image','digest','created_at'],
  safety_notices: ['id','recipient_id','dedupe_key','booking_id','incident_id','kind','message','created_at','read_at'],
};

export function postgresSql(sql) {
  sql = sql.replace(/PRAGMA[^;]*;/gi, '').replace(/\bINTEGER\b/g, 'BIGINT');
  sql = sql.replace(/CREATE TABLE IF NOT EXISTS (incident_entries|safety_notices)\(([\s\S]*?)\);/g, (_, table, fields) => `CREATE TABLE IF NOT EXISTS ${table}(${fields},_seq BIGSERIAL UNIQUE);`);
  const ignore = /INSERT OR IGNORE/i.test(sql);
  sql = sql.replace(/INSERT OR IGNORE INTO/gi, 'INSERT INTO');
  sql = sql.replace(/INSERT INTO ([a-z_]+)\s+VALUES/gi, (_, table) => {
    if (!TABLE_COLUMNS[table]) throw new Error('Unknown insert table');
    return `INSERT INTO ${table} (${TABLE_COLUMNS[table].map(c => `"${c}"`).join(',')}) VALUES`;
  });
  if (ignore) sql = sql.replace(/;?\s*$/, ' ON CONFLICT DO NOTHING');
  sql = sql.replace(/\browid\b/g, '_seq').replace(/\bAS ([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, alias) => `AS "${alias}"`);
  sql = sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|\bend\b/g, token => token === 'end' ? '"end"' : token);
  let parameter = 0, quoted = false, output = '';
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      if (quoted && sql[i + 1] === "'") { output += "''"; i++; continue; }
      quoted = !quoted;
    }
    output += ch === '?' && !quoted ? `$${++parameter}` : ch;
  }
  return output;
}

export class Database {
  constructor(source) {
    this.postgres = /^postgres(?:ql)?:\/\//.test(source);
    this.context = new AsyncLocalStorage();
    this.queue = Promise.resolve();
    if (this.postgres) {
      if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('Refusing PostgreSQL connection: NODE_TLS_REJECT_UNAUTHORIZED=0 disables TLS certificate verification.');
      this.pool = new Pool({ connectionString: source, max: 5, connectionTimeoutMillis: 15000, idleTimeoutMillis: 30000,
        ...(process.env.NEON_DNS_FALLBACK === '1' ? { stream: neonStream } : {}),
        statement_timeout: 15000, query_timeout: 30000,
        types: { getTypeParser: (oid, format) => oid === 20 ? value => {
          const number = Number(value); if (!Number.isSafeInteger(number)) throw new Error('Database integer exceeds safe range'); return number;
        } : types.getTypeParser(oid, format) } });
      this.pool.on('error', error => console.error('Postgres idle connection closed:', error.code || 'connection_error'));
    } else this.sqlite = new DatabaseSync(source);
  }
  async exclusive(work) {
    const previous = this.queue;
    let release;
    this.queue = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await work(); } finally { release(); }
  }
  async query(sql, values = [], mode = 'all') {
    const state = this.context.getStore();
    if (this.postgres) {
      const result = await (state?.client || this.pool).query(postgresSql(sql), values);
      return mode === 'run' ? { changes: result.rowCount } : mode === 'get' ? result.rows[0] : result.rows;
    }
    const execute = () => this.sqlite.prepare(sql)[mode](...values);
    return state ? execute() : this.exclusive(execute);
  }
  prepare(sql) {
    return { get: (...values) => this.query(sql, values, 'get'), all: (...values) => this.query(sql, values), run: (...values) => this.query(sql, values, 'run') };
  }
  async exec(sql) {
    if (this.postgres) {
      const translated = postgresSql(sql);
      if (translated.trim()) await (this.context.getStore()?.client || this.pool).query(translated);
    } else if (this.context.getStore()) this.sqlite.exec(sql);
    else await this.exclusive(() => this.sqlite.exec(sql));
  }
  async transaction(work) {
    const current = this.context.getStore();
    if (current) {
      const name = `sparely_${current.depth + 1}`;
      await this.exec(`SAVEPOINT ${name}`);
      try {
        const result = await this.context.run({ ...current, depth: current.depth + 1 }, work);
        await this.exec(`RELEASE SAVEPOINT ${name}`); return result;
      } catch (error) { await this.exec(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}`); throw error; }
    }
    const execute = async () => {
      const client = this.postgres ? await this.pool.connect() : null;
      try {
        if (client) { await client.query('BEGIN'); await client.query("SELECT pg_advisory_xact_lock(794135206)"); }
        else this.sqlite.exec('BEGIN IMMEDIATE');
        const result = await this.context.run({ client, depth: 0 }, work);
        if (client) await client.query('COMMIT'); else this.sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        try { if (client) await client.query('ROLLBACK'); else this.sqlite.exec('ROLLBACK'); } catch {}
        throw error;
      } finally { client?.release(); }
    };
    return this.postgres ? execute() : this.exclusive(execute);
  }
  async close() { if (this.pool) await this.pool.end(); else await this.exclusive(() => this.sqlite.close()); }
}

export const asyncFilter = async (items, predicate) => {
  const matches = await Promise.all(items.map(predicate));
  return items.filter((_, index) => matches[index]);
};
export const asyncSome = async (items, predicate) => (await Promise.all(items.map(predicate))).some(Boolean);
