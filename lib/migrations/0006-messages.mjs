// M5 migrations: conversations, messages, read markers, appointments, general notices.
// Additive and idempotent only (CREATE ... IF NOT EXISTS). Never delete user records.
import { migration } from '../migration-registry.mjs';

migration('0006_messages', async db => {
  await db.exec(`CREATE TABLE IF NOT EXISTS conversations(
      id TEXT PRIMARY KEY,subject_key TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,listing_id TEXT NOT NULL REFERENCES listings(id),
      booking_id TEXT REFERENCES bookings(id),renter_id TEXT NOT NULL REFERENCES users(id),host_id TEXT NOT NULL REFERENCES users(id),
      revision INTEGER NOT NULL DEFAULT 0,last_message_at TEXT,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS conversations_renter ON conversations(renter_id);
    CREATE INDEX IF NOT EXISTS conversations_host ON conversations(host_id);
    CREATE TABLE IF NOT EXISTS conversation_messages(
      id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),seq INTEGER NOT NULL,
      sender_id TEXT NOT NULL REFERENCES users(id),body TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(conversation_id,seq));
    CREATE TABLE IF NOT EXISTS conversation_reads(
      conversation_id TEXT NOT NULL REFERENCES conversations(id),user_id TEXT NOT NULL REFERENCES users(id),
      read_seq INTEGER NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(conversation_id,user_id));
    CREATE TABLE IF NOT EXISTS appointments(
      id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),kind TEXT NOT NULL,
      starts_at TEXT NOT NULL,timezone TEXT NOT NULL,notes TEXT NOT NULL,access_questions TEXT NOT NULL,status TEXT NOT NULL,
      proposed_by TEXT NOT NULL REFERENCES users(id),responded_by TEXT REFERENCES users(id),response_note TEXT,responded_at TEXT,
      supersedes_id TEXT,superseded_by_id TEXT,version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS appointments_conversation ON appointments(conversation_id);
    CREATE TABLE IF NOT EXISTS notices(
      id TEXT PRIMARY KEY,recipient_id TEXT NOT NULL REFERENCES users(id),dedupe_key TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,
      title TEXT NOT NULL,body TEXT NOT NULL,link TEXT,created_at TEXT NOT NULL,read_at TEXT);
    CREATE INDEX IF NOT EXISTS notices_recipient ON notices(recipient_id,created_at);`);
});
