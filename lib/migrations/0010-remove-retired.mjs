// Owner-approved removal (2026-10-25) of the retired sample listings: the camera kit and the
// old Work & study / Useful spaces listings. Only listings with NO bookings are deleted, so
// no booking, agreement or evidence can lose its listing. Their saves, blocks, photos,
// onboarding facts, pricing and enquiry conversations are deleted with them.
import { migration } from '../migration-registry.mjs';

migration('0010_remove_retired_listings', async db => {
  const rows = await db.query("SELECT l.id FROM listings l WHERE (l.id IN ('camera-kit','work-laptop','monitor','quiet-room') OR l.category IN ('work','spaces')) AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.listing_id=l.id)");
  for (const { id } of rows) {
    for (const c of await db.query('SELECT id FROM conversations WHERE listing_id=? AND booking_id IS NULL', [id])) {
      for (const t of ['conversation_messages', 'conversation_reads', 'appointments']) await db.query(`DELETE FROM ${t} WHERE conversation_id=?`, [c.id], 'run');
      await db.query('DELETE FROM conversations WHERE id=?', [c.id], 'run');
    }
    for (const t of ['favorites', 'listing_blocks', 'listing_photos', 'listing_profiles', 'storage_pricing']) await db.query(`DELETE FROM ${t} WHERE listing_id=?`, [id], 'run');
    await db.query('DELETE FROM listings WHERE id=?', [id], 'run');
  }
});
