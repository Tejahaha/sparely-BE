// AI helpers (search, reminders, translation). Additive and idempotent only.
import { migration } from '../migration-registry.mjs';

// Per-person settings kept apart from the users table (whose positional inserts stay as they are).
// Translations are a cache beside the original message; the original is always the record.
migration('0011_ai_settings_and_translations', async db => {
  await db.exec(`CREATE TABLE IF NOT EXISTS user_settings(user_id TEXT PRIMARY KEY REFERENCES users(id),language TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS message_translations(message_id TEXT NOT NULL REFERENCES conversation_messages(id),language TEXT NOT NULL,body TEXT NOT NULL,model TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(message_id,language));`);
});
