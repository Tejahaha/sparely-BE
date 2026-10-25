// M5: participant-only enquiries/messages, unread state, call/viewing appointments and
// durable, deduplicated in-app notices. Owned by the M5 work stream.
// A conversation never changes booking price or terms; `reference` (conversation@revision)
// lets a later agreement say exactly which messages it was based on.
import { randomUUID } from 'node:crypto';
import { AppError, fail } from './errors.mjs';

const text = (value, max) => String(value ?? '').trim().slice(0, max);
const PAGE = 30;
const KINDS = ['call', 'viewing'];
const validZone = zone => { try { new Intl.DateTimeFormat('en', { timeZone: zone }); return true; } catch { return false; } };
const istLabel = iso => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date(iso));

export class Messages {
  constructor(store) { this.store = store; this.db = store.db; }

  // ---- access ------------------------------------------------------------------
  // Participants: the renter and the listing owner. An operator may only observe a
  // booking conversation while reviewing a case on that booking (same world).
  async access(id, userId) {
    const c = await this.db.prepare('SELECT * FROM conversations WHERE id=?').get(String(id));
    if (c && userId === c.renter_id) return { c, role: 'renter' };
    if (c && userId === c.host_id) return { c, role: 'host' };
    if (c?.booking_id && (await this.canObserve(c.booking_id, userId))) return { c, role: 'observer' };
    throw new AppError('Conversation not found.', 404, 'CONVERSATION_NOT_FOUND');
  }
  async canObserve(bookingId, userId) {
    try { return (await this.store.booking(bookingId, userId)).canReview; } catch { return false; }
  }
  async participant(id, userId) {
    const a = await this.access(id, userId);
    if (a.role === 'observer') throw new AppError('Operators can read this conversation but not write in it.', 403, 'READ_ONLY');
    return a;
  }

  // ---- conversations -------------------------------------------------------------
  async openEnquiry(listingId, userId) {
    const l = await this.store.visibleListing(listingId, userId);
    if (l.ownerId === userId) throw new AppError('This is your own listing, so there is no host to message.', 403, 'OWN_LISTING');
    fail(l.retired, 'This item is no longer offered on Sparely.', 409);
    fail(l.draft, 'This listing could not be found.', 404);
    return await this.ensure(`enquiry:${l.id}:${userId}`, { kind: 'enquiry', listingId: l.id, bookingId: null, renterId: userId, hostId: l.ownerId });
  }
  async ensure(subject, c) {
    return await this.store.transaction(async () => {
      const existing = await this.db.prepare('SELECT id FROM conversations WHERE subject_key=?').get(subject);
      if (existing) return { id: existing.id, created: false };
      const id = `conv-${randomUUID()}`;
      await this.db.prepare('INSERT INTO conversations(id,subject_key,kind,listing_id,booking_id,renter_id,host_id,revision,last_message_at,created_at) VALUES(?,?,?,?,?,?,?,0,NULL,?)')
        .run(id, subject, c.kind, c.listingId, c.bookingId, c.renterId, c.hostId, new Date().toISOString());
      return { id, created: true };
    });
  }
  // Booking conversation: created on first open by a participant; observers only see an existing one.
  async forBooking(bookingId, userId) {
    const b = await this.store.booking(bookingId, userId);
    let row = await this.db.prepare('SELECT id FROM conversations WHERE subject_key=?').get(`booking:${b.id}`);
    if (!row && (b.isHost || b.isRenter)) row = await this.ensure(`booking:${b.id}`, { kind: 'booking', listingId: b.listing.id, bookingId: b.id, renterId: b.renter.id, hostId: b.listing.ownerId });
    if (!row) return { conversation: null, messages: [] };
    const conversation = await this.view(row.id, userId);
    return { conversation, messages: (await this.page(row.id, userId, {})).messages.slice(-3) };
  }
  async readSeq(id, userId) {
    return (await this.db.prepare('SELECT read_seq FROM conversation_reads WHERE conversation_id=? AND user_id=?').get(id, userId))?.read_seq || 0;
  }
  async unreadIn(id, userId) {
    return (await this.db.prepare('SELECT COUNT(*) AS count FROM conversation_messages WHERE conversation_id=? AND sender_id<>? AND seq>?').get(id, userId, await this.readSeq(id, userId))).count;
  }
  async view(id, userId) {
    const { c, role } = await this.access(id, userId);
    const users = await this.db.prepare('SELECT id,name,initials FROM users WHERE id IN (?,?)').all(c.renter_id, c.host_id);
    const listing = await this.db.prepare('SELECT id,title,image,photo FROM listings WHERE id=?').get(c.listing_id);
    const last = await this.db.prepare('SELECT * FROM conversation_messages WHERE conversation_id=? ORDER BY seq DESC LIMIT 1').get(c.id);
    const enquiry = c.kind === 'booking' ? await this.db.prepare('SELECT id FROM conversations WHERE subject_key=?').get(`enquiry:${c.listing_id}:${c.renter_id}`) : null;
    return {
      id: c.id,
      kind: c.kind,
      listing: { id: listing.id, title: listing.title, image: listing.photo || `/assets/${listing.image}.svg` },
      bookingId: c.booking_id,
      relatedEnquiryId: enquiry && role !== 'observer' ? enquiry.id : null,
      participants: [c.renter_id, c.host_id].map(pid => ({ ...users.find(u => u.id === pid), role: pid === c.renter_id ? 'renter' : 'host' })),
      viewerRole: role,
      readOnly: role === 'observer',
      revision: c.revision,
      reference: `${c.id}@${c.revision}`,
      lastMessage: last ? this.shape(last) : null,
      lastActivityAt: c.last_message_at || c.created_at,
      unreadCount: role === 'observer' ? 0 : await this.unreadIn(c.id, userId),
      readSeq: role === 'observer' ? 0 : await this.readSeq(c.id, userId),
      appointments: await this.appointments(c.id, userId, role),
      bindingTerms: false,
      delivery: 'in_app_only',
      createdAt: c.created_at
    };
  }
  async list(userId) {
    // ponytail: one view() per conversation (N+1); add a joined summary query if inboxes grow large.
    const rows = await this.db.prepare('SELECT id FROM conversations WHERE renter_id=? OR host_id=? ORDER BY COALESCE(last_message_at,created_at) DESC,id DESC LIMIT 200').all(userId, userId);
    const conversations = await Promise.all(rows.map(async r => await this.view(r.id, userId)));
    return { conversations, unreadCount: conversations.reduce((n, c) => n + c.unreadCount, 0), delivery: 'in_app_only' };
  }
  async unreadCount(userId) {
    return (await this.db.prepare(`SELECT COUNT(*) AS count FROM conversation_messages m JOIN conversations c ON c.id=m.conversation_id
      LEFT JOIN conversation_reads r ON r.conversation_id=c.id AND r.user_id=?
      WHERE (c.renter_id=? OR c.host_id=?) AND m.sender_id<>? AND m.seq>COALESCE(r.read_seq,0)`).get(userId, userId, userId, userId)).count;
  }

  // ---- messages ----------------------------------------------------------------
  shape(m) { return { id: m.id, conversationId: m.conversation_id, seq: m.seq, senderId: m.sender_id, body: m.body, createdAt: m.created_at, delivery: 'in_app' }; }
  async message(id, userId) {
    const m = await this.db.prepare('SELECT * FROM conversation_messages WHERE id=?').get(String(id));
    fail(!m, 'Message not found.', 404);
    await this.access(m.conversation_id, userId);
    return this.shape(m);
  }
  // Cursor = sequence number, so pages stay stable while new messages arrive.
  async page(id, userId, { before, after, limit }) {
    await this.access(id, userId);
    const seqOf = (v, name) => { if (v === undefined || v === null || v === '') return null; fail(!/^[0-9]{1,15}$/.test(String(v)), `Use a valid ${name} cursor.`); return Number(v); };
    const b = seqOf(before, 'before'), a = seqOf(after, 'after');
    const n = limit === undefined || limit === null || limit === '' ? PAGE : Number(limit);
    fail(!Number.isInteger(n) || n < 1 || n > 100, 'Use a page size between 1 and 100.');
    const rows = a !== null
      ? await this.db.prepare('SELECT * FROM conversation_messages WHERE conversation_id=? AND seq>? ORDER BY seq ASC LIMIT ?').all(id, a, n + 1)
      : (await this.db.prepare('SELECT * FROM conversation_messages WHERE conversation_id=? AND seq<? ORDER BY seq DESC LIMIT ?').all(id, b ?? Number.MAX_SAFE_INTEGER, n + 1)).reverse();
    const more = rows.length > n, page = a !== null ? rows.slice(0, n) : rows.slice(more ? 1 : 0);
    const { revision } = await this.db.prepare('SELECT revision FROM conversations WHERE id=?').get(id);
    return {
      messages: page.map(m => this.shape(m)),
      nextBefore: a === null && more ? String(page[0].seq) : null,
      hasMoreAfter: a !== null && more,
      revision
    };
  }
  async send(id, userId, input) {
    await this.participant(id, userId);
    const body = String(input.body ?? '').trim();
    fail(body.length < 1, 'Write a message first.');
    fail(body.length > 2000, 'Messages can be up to 2,000 characters.');
    await this.store.accounts.limit(`message:${userId}`, 60, 600_000);
    return await this.store.transaction(async () => {
      const at = new Date().toISOString();
      await this.db.prepare('UPDATE conversations SET revision=revision+1,last_message_at=? WHERE id=?').run(at, id);
      const c = await this.db.prepare('SELECT * FROM conversations WHERE id=?').get(id);
      const messageId = `msg-${randomUUID()}`, recipient = c.renter_id === userId ? c.host_id : c.renter_id;
      // Notice dedupe: one notice per unread burst (keyed on what the recipient last read).
      const recipientRead = await this.readSeq(id, recipient);
      await this.db.prepare('INSERT INTO conversation_messages(id,conversation_id,seq,sender_id,body,created_at) VALUES(?,?,?,?,?,?)').run(messageId, id, c.revision, userId, body, at);
      await this.markRead(id, userId, c.revision);
      const sender = await this.store.user(userId);
      await this.notify({ recipientId: recipient, kind: 'message', dedupeKey: `message:${id}:after:${recipientRead}`, title: `New message from ${sender.name}`, body: body.length > 140 ? `${body.slice(0, 139)}…` : body, link: `conversation/${id}` });
      return { id: messageId, conversationId: id };
    });
  }
  async markRead(id, userId, seq) {
    const { c } = await this.participant(id, userId);
    const upTo = seq === undefined ? c.revision : Number(seq);
    fail(!Number.isInteger(upTo) || upTo < 0, 'Use a valid message sequence.');
    const value = Math.min(upTo, c.revision), at = new Date().toISOString();
    await this.db.prepare('INSERT INTO conversation_reads(conversation_id,user_id,read_seq,updated_at) VALUES(?,?,?,?) ON CONFLICT(conversation_id,user_id) DO UPDATE SET read_seq=CASE WHEN excluded.read_seq>conversation_reads.read_seq THEN excluded.read_seq ELSE conversation_reads.read_seq END,updated_at=excluded.updated_at').run(id, userId, value, at);
    return { conversationId: id, readSeq: Math.max(value, await this.readSeq(id, userId)), unreadCount: await this.unreadIn(id, userId) };
  }

  // ---- appointments (a scheduled human call or viewing; the site places no calls) ----
  appointmentView(a, userId, role) {
    const party = role === 'renter' || role === 'host', live = ['proposed', 'confirmed'].includes(a.status), future = Date.parse(a.starts_at) > Date.now();
    return {
      id: a.id, conversationId: a.conversation_id, kind: a.kind, startsAt: a.starts_at, timezone: a.timezone,
      notes: a.notes, accessQuestions: a.access_questions, status: a.status, proposedBy: a.proposed_by,
      respondedBy: a.responded_by, responseNote: a.response_note, respondedAt: a.responded_at,
      supersedesId: a.supersedes_id, supersededById: a.superseded_by_id, version: a.version, createdAt: a.created_at, updatedAt: a.updated_at,
      canConfirm: party && a.status === 'proposed' && a.proposed_by !== userId && future,
      canDecline: party && a.status === 'proposed' && a.proposed_by !== userId,
      canCancel: party && live,
      canReschedule: party && live
    };
  }
  async appointments(conversationId, userId, role) {
    return (await this.db.prepare('SELECT * FROM appointments WHERE conversation_id=? ORDER BY created_at DESC,id DESC').all(conversationId)).map(a => this.appointmentView(a, userId, role));
  }
  async appointment(id, userId) {
    const a = await this.db.prepare('SELECT * FROM appointments WHERE id=?').get(String(id));
    fail(!a, 'Appointment not found.', 404);
    const { role } = await this.access(a.conversation_id, userId);
    return this.appointmentView(a, userId, role);
  }
  stale(a, expected) {
    if (expected !== a.version) throw new AppError('This appointment changed since you opened it. Review the latest time before deciding.', 409, 'STALE_APPOINTMENT', { currentVersion: a.version, status: a.status });
  }
  async propose(conversationId, userId, input) {
    const { c } = await this.participant(conversationId, userId);
    fail(!KINDS.includes(input.kind), 'Choose a call or a viewing.');
    const startsMs = Date.parse(input.startsAt);
    fail(!Number.isFinite(startsMs), 'Choose a valid time.');
    fail(startsMs < Date.now() + 60_000, 'Choose a time in the future.');
    fail(startsMs > Date.now() + 180 * 86400_000, 'Choose a time within the next six months.');
    const timezone = input.timezone === undefined || input.timezone === '' ? 'Asia/Kolkata' : String(input.timezone).slice(0, 64);
    fail(!validZone(timezone), 'Choose a valid time zone.');
    const startsAt = new Date(startsMs).toISOString(), notes = text(input.notes, 1000), questions = text(input.accessQuestions, 1000);
    return await this.store.transaction(async () => {
      const at = new Date().toISOString(), id = `appt-${randomUUID()}`;
      let old = null;
      if (input.supersedes) {
        old = await this.db.prepare('SELECT * FROM appointments WHERE id=? AND conversation_id=?').get(String(input.supersedes), c.id);
        fail(!old, 'The appointment to reschedule was not found.', 404);
        this.stale(old, input.expectedVersion);
        fail(!['proposed', 'confirmed'].includes(old.status), 'Only a proposed or confirmed appointment can be rescheduled.', 409);
        await this.db.prepare("UPDATE appointments SET status='superseded',superseded_by_id=?,version=version+1,updated_at=? WHERE id=? AND version=?").run(id, at, old.id, old.version);
        await this.clearAppointmentReminders(old.id, at);
      }
      const open = await this.db.prepare("SELECT COUNT(*) AS count FROM appointments WHERE conversation_id=? AND status IN ('proposed','confirmed')").get(c.id);
      fail(open.count >= 5, 'This conversation already has five open appointments. Cancel one first.', 409);
      await this.db.prepare('INSERT INTO appointments(id,conversation_id,kind,starts_at,timezone,notes,access_questions,status,proposed_by,responded_by,response_note,responded_at,supersedes_id,superseded_by_id,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,?,NULL,1,?,?)')
        .run(id, c.id, input.kind, startsAt, timezone, notes, questions, 'proposed', userId, old?.id || null, at, at);
      const other = c.renter_id === userId ? c.host_id : c.renter_id, who = (await this.store.user(userId)).name;
      await this.notify({ recipientId: other, kind: 'appointment_proposed', dedupeKey: `appointment:${id}:proposed`, title: old ? `${who} proposed a new time` : `${who} proposed a ${input.kind}`, body: `${input.kind === 'call' ? 'Call' : 'Viewing'} on ${istLabel(startsAt)} IST. Confirm or decline it in the conversation.`, link: `conversation/${c.id}` });
      return { id, conversationId: c.id };
    });
  }
  async respond(id, userId, input) {
    const row = await this.db.prepare('SELECT * FROM appointments WHERE id=?').get(String(id));
    fail(!row, 'Appointment not found.', 404);
    const { c } = await this.participant(row.conversation_id, userId);
    return await this.store.transaction(async () => {
      const a = await this.db.prepare('SELECT * FROM appointments WHERE id=?').get(row.id);
      this.stale(a, input.expectedVersion);
      const action = input.action, at = new Date().toISOString(), note = text(input.note, 500);
      let status;
      if (action === 'confirm' || action === 'decline') {
        fail(a.status !== 'proposed', 'This appointment is no longer waiting for an answer.', 409);
        fail(a.proposed_by === userId, 'The other person needs to answer your proposal.', 403);
        fail(action === 'confirm' && Date.parse(a.starts_at) <= Date.now(), 'This time has passed. Propose a new one instead.', 409);
        status = action === 'confirm' ? 'confirmed' : 'declined';
      } else if (action === 'cancel') {
        fail(!['proposed', 'confirmed'].includes(a.status), 'This appointment is already closed.', 409);
        status = 'cancelled';
      } else throw new AppError('Choose confirm, decline or cancel.');
      const changed = await this.db.prepare('UPDATE appointments SET status=?,responded_by=?,response_note=?,responded_at=?,version=version+1,updated_at=? WHERE id=? AND version=?').run(status, userId, note || null, at, at, a.id, a.version);
      fail(!changed.changes, 'This appointment changed at the same time. Reload and try again.', 409);
      await this.clearAppointmentReminders(a.id, at);
      const other = c.renter_id === userId ? c.host_id : c.renter_id, who = (await this.store.user(userId)).name;
      const label = `${a.kind === 'call' ? 'call' : 'viewing'} on ${istLabel(a.starts_at)} IST`;
      await this.notify({ recipientId: other, kind: `appointment_${status}`, dedupeKey: `appointment:${a.id}:${status}`, title: `${who} ${status} the ${a.kind}`, body: status === 'confirmed' ? `Confirmed: ${label}. Sparely does not place the call; contact each other as agreed.` : `The ${label} is ${status}.${note ? ` Note: ${note}` : ''}`, link: `conversation/${c.id}` });
      return { id: a.id, conversationId: c.id };
    });
  }

  // ---- notices -----------------------------------------------------------------
  async clearAppointmentReminders(id, at) {
    await this.db.query("UPDATE notices SET read_at=COALESCE(read_at,?) WHERE (kind='appointment_reminder' AND dedupe_key LIKE ?) OR dedupe_key LIKE ?", [at, `%|appointment-reminder:${id}:%`, `%|appointment:${id}:%`], 'run');
  }
  // Durable, deduplicated in-app notice. The same (recipient, dedupeKey) is stored once.
  // Later milestones call this for acceptance, cancellation, claims, etc. Returns true when new.
  async notify({ recipientId, kind, dedupeKey, title, body = '', link = null }) {
    fail(!recipientId || !kind || !dedupeKey || !title, 'A notice needs a recipient, kind, dedupe key and title.', 500);
    const result = await this.db.prepare('INSERT OR IGNORE INTO notices(id,recipient_id,dedupe_key,kind,title,body,link,created_at,read_at) VALUES(?,?,?,?,?,?,?,?,NULL)')
      .run(`notice-${randomUUID()}`, recipientId, `${recipientId}|${dedupeKey}`, kind, text(title, 200), text(body, 1000), link ? text(link, 300) : null, new Date().toISOString());
    return result.changes > 0;
  }
  // Unified inbox: these notices plus the caller's recovery safety notices, newest first.
  // Cursor = base64url(createdAt|id) of the last item; stable while new items arrive.
  async inbox(userId, before, limit) {
    const n = limit === undefined || limit === null || limit === '' ? 50 : Number(limit);
    fail(!Number.isInteger(n) || n < 1 || n > 100, 'Use a page size between 1 and 100.');
    let params = [userId], where = 'recipient_id=?';
    if (before) {
      const decoded = Buffer.from(String(before), 'base64url').toString('utf8'), split = decoded.indexOf('|');
      fail(split < 1 || !Number.isFinite(Date.parse(decoded.slice(0, split))), 'Use a valid inbox cursor.');
      const at = decoded.slice(0, split), id = decoded.slice(split + 1);
      where += ' AND (created_at<? OR (created_at=? AND id<?))'; params = [userId, at, at, id];
    }
    const page = `${where} ORDER BY created_at DESC,id DESC LIMIT ?`;
    const mine = (await this.db.prepare(`SELECT id,kind,title,body,link,created_at AS createdAt,read_at AS readAt FROM notices WHERE ${page}`).all(...params, n + 1))
      .map(r => ({ ...r, source: 'notice', bookingId: null, incidentId: null }));
    const safety = (await this.db.prepare(`SELECT id,kind,message,booking_id AS bookingId,incident_id AS incidentId,created_at AS createdAt,read_at AS readAt FROM safety_notices WHERE ${page}`).all(...params, n + 1))
      .map(({ message, ...r }) => ({ ...r, source: 'safety', title: null, body: message, link: null }));
    // Same order as SQL (byte order on ids is what both SQLite and the cursor use).
    const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
    const items = [...mine, ...safety].sort((a, b) => cmp(b.createdAt, a.createdAt) || cmp(b.id, a.id)).slice(0, n + 1);
    const shown = items.slice(0, n), last = shown.at(-1);
    const count = async table => (await this.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE recipient_id=? AND read_at IS NULL`).get(userId)).count;
    return {
      items: shown,
      nextCursor: items.length > n ? Buffer.from(`${last.createdAt}|${last.id}`).toString('base64url') : null,
      unreadCount: (await count('notices')) + (await count('safety_notices')),
      delivery: 'in_app_only'
    };
  }
  async readInbox(userId, id) {
    if (String(id).startsWith('notice-')) {
      const changed = await this.db.prepare('UPDATE notices SET read_at=COALESCE(read_at,?) WHERE id=? AND recipient_id=?').run(new Date().toISOString(), id, userId);
      fail(!changed.changes, 'Notice not found.', 404);
      return { id, source: 'notice', read: true };
    }
    await this.store.recovery.readNotice(userId, id);
    return { id, source: 'safety', read: true };
  }
}
