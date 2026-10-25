// Polite in-app return reminders for overdue rentals (storage: goods not yet collected).
// When and how often is fixed here: stage 1 once the grace period ends, stage 2 after a day.
// A model (if LLM_URL is set) only writes the wording, in the renter's language; code checks
// it and uses the fixed template whenever the text is missing, odd, or mentions money or threats.
import { ask, numbersOf } from './llm.mjs';
import { attentionFor } from './rental-policy.mjs';
import { LANGUAGES } from './messages.mjs';

const ist = iso => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date(iso));
const istDayOfMonth = iso => Number(new Intl.DateTimeFormat('en-IN', { day: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date(iso)));
// Words a reminder must never contain: money, penalties, police, legal threats.
const FORBIDDEN = /₹|\brs\.?\s*\d|rupee|\b(?:fine|fees?|charges?|payments?|pay|paid|money)\b|penalt|police|legal|court|lawyer|जुर्माना|पुलिस|रुपये|జరిమానా|పోలీసు|రూపాయ/i;

export function reminderTemplate({ name, item, due, stage, storage }) {
  const task = storage ? `collect your things from “${item}”` : `return “${item}”`;
  return stage === 1
    ? `Hi ${name}, a friendly reminder: you were due to ${task} on ${due} IST. Please arrange it with the host today. If you need more time, you can request an extension on the booking.`
    : `Hi ${name}, “${item}” is still ${storage ? 'not collected' : 'not returned'}. It was due on ${due} IST. Please contact the host today or request an extension on the booking. If it stays unresolved, the Sparely team may step in to help you both.`;
}

export async function reminderText(facts, language = 'en') {
  const fallback = reminderTemplate(facts);
  const r = await ask({
    system: `You write one short, polite in-app reminder for an OVERDUE rental on a neighbourhood rental app in India. The due date has already passed; never imply it is a future deadline. Write it in ${LANGUAGES[language] || 'English'} (Hindi in Devanagari, Telugu in Telugu script). Use only the facts given. Never mention money, fees, fines, police or legal action. Stage 1 is a friendly first reminder. Stage 2 is a firmer second reminder that says the Sparely team may step in to help. Always suggest contacting the host or requesting an extension on the booking. Do not include any dates, times, numbers or placeholders: the app adds the exact deadline separately. At most 3 sentences.`,
    prompt: JSON.stringify({ renterName: facts.name, item: facts.item, stage: facts.stage, task: facts.storage ? 'collect their stored belongings' : 'return the item' }),
    schema: { type: 'object', additionalProperties: false, required: ['message'], properties: { message: { type: 'string' } } },
    maxTokens: 300
  });
  const raw = String(r?.message ?? '').trim();
  const dueLabel = { en: 'Was due', hi: 'समय-सीमा', te: 'గడువు' }[language] || 'Was due';
  const text = raw.split('{{due}}').length === 2 ? raw.replace('{{due}}', `${facts.due} IST`)
    : !numbersOf(raw).length ? `${raw}\n${dueLabel}: ${facts.due} IST.` : raw;
  const allowed = new Set(numbersOf(`${facts.name} ${facts.item} ${facts.due}`)), found = numbersOf(text);
  const ok = raw.length >= 20 && text.length <= 600 && !FORBIDDEN.test(text)
    && found.every(n => allowed.has(n)) // no invented numbers
    && text.includes(facts.due) && !/[{}]/.test(text); // preserve the whole date/time, not just its day number
  return ok ? text : fallback;
}

let running = false;
// Called by the background worker. A notice row is the record that a stage was sent, so a crash
// or restart simply retries; the dedupe key makes a repeat impossible.
export async function sendReminders(store) {
  if (running) return 0; // a slow model must not let worker ticks pile up
  running = true;
  try {
    let sent = 0;
    const rows = await store.db.prepare("SELECT b.*,l.title AS listing_title,l.category AS listing_category,u.name AS renter_name FROM bookings b JOIN listings l ON l.id=b.listing_id JOIN users u ON u.id=b.renter_id WHERE b.status='active'").all();
    for (const b of rows) {
      const meta = await store.metadata(b.id);
      const attention = attentionFor(b, meta.details, await store.now(b.id), meta.policy);
      if (attention?.kind !== 'overdue') continue;
      const stage = attention.lateMinutes >= 24 * 60 ? 2 : 1;
      // The end time is in the key, so an extension starts the reminders afresh.
      const dedupeKey = `reminder:${b.id}:${b.end}:${stage}`;
      if (await store.db.prepare('SELECT 1 FROM notices WHERE dedupe_key=?').get(`${b.renter_id}|${dedupeKey}`)) continue;
      const facts = { name: String(b.renter_name).split(' ')[0], item: b.listing_title, due: ist(b.end), dueDay: istDayOfMonth(b.end), stage, storage: b.listing_category === 'storage' };
      const language = await store.messages.language(b.renter_id);
      const body = await reminderText(facts, language === 'original' ? 'en' : language);
      if (await store.messages.notify({ recipientId: b.renter_id, kind: 'return_reminder', dedupeKey, title: stage === 1 ? 'Return reminder' : 'Second return reminder', body, link: `booking/${b.id}` })) sent++;
    }
    return sent;
  } finally {
    running = false;
  }
}
