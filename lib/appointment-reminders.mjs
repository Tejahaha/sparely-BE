// Fixed-time reminders: no model call and no changes to booking/appointment terms.
// The transaction shares the appointment mutation lock so cancelled/replaced times
// cannot generate a new reminder after their cancellation commits.
export async function sendAppointmentReminders(store, now = Date.now()) {
  return await store.transaction(async () => {
    let sent = 0;
    const rows = await store.db.query(`SELECT a.*,c.renter_id,c.host_id
      FROM appointments a JOIN conversations c ON c.id=a.conversation_id
      WHERE a.status='confirmed' AND a.starts_at>? AND a.starts_at<=?`,
    [new Date(now - 15 * 60_000).toISOString(), new Date(now + 15 * 60_000).toISOString()]);
    for (const a of rows) {
      const stage = Date.parse(a.starts_at) > now ? 'soon' : 'now';
      if (stage === 'now') await store.db.query("UPDATE notices SET read_at=COALESCE(read_at,?) WHERE kind='appointment_reminder' AND dedupe_key LIKE ?", [new Date(now).toISOString(), `%|appointment-reminder:${a.id}:${a.starts_at}:soon`], 'run');
      const kind = a.kind === 'call' ? 'Call' : 'Viewing';
      const time = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date(a.starts_at));
      for (const recipientId of [a.renter_id, a.host_id]) {
        if (await store.messages.notify({ recipientId, kind: 'appointment_reminder',
          dedupeKey: `appointment-reminder:${a.id}:${a.starts_at}:${stage}`,
          title: stage === 'soon' ? `${kind} coming up` : `${kind} time`,
          body: `${kind} scheduled for ${time} IST. ${a.kind === 'call' ? 'Contact each other as agreed; Sparely does not place the call.' : 'Check the agreed meeting place and access details in your conversation.'}`,
          link: `conversation/${a.conversation_id}` })) sent++;
      }
    }
    return sent;
  });
}
