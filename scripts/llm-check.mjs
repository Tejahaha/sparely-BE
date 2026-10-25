// Try the configured model on sample Sparely requests before relying on it.
//   node --env-file=.env scripts/llm-check.mjs
// Prints, for each sample, how long the model took and what the app would use.
// "fallback" means the model was off, too slow, or its answer failed the app's checks.
import { understand } from '../lib/assistant.mjs';
import { reminderText, reminderTemplate } from '../lib/reminders.mjs';
import { llmModel } from '../lib/llm.mjs';

if (!process.env.LLM_URL) {
  console.error('LLM_URL is not set. Add it to backend/.env, e.g. LLM_URL=http://192.168.1.20:11434');
  process.exit(1);
}
console.log(`Model ${llmModel()} at ${process.env.LLM_URL}\n`);

const searches = [
  'I need to keep 6 boxes and a cycle for 2 months near Madhapur from next Monday',
  'kal se ek hafte ke liye bike parking chahiye Kondapur mein',
  'naaku oka drill kavali shelf pettadaniki, budget 500',
  'Light a product photo shoot this Saturday',
  'hem my curtains, under ₹300',
  'Tell me a story about the sea'
];
const facts = { name: 'Ravi', item: 'Cordless drill', due: '12 Dec, 10:00 am', dueDay: 12, stage: 1, storage: false };

const timed = async work => { const t = performance.now(); const value = await work(); return [value, Math.round(performance.now() - t)]; };
let slow = 0;
const report = (label, ms, value) => { if (ms > 5000) slow++; console.log(`${String(ms).padStart(6)} ms  ${label}\n          → ${value}\n`); };

console.log('SEARCH');
for (const q of searches) {
  const [u, ms] = await timed(() => understand(q));
  report(q, ms, u ? JSON.stringify({ categories: u.categories, keywords: u.keywords, items: u.items, area: u.area, start: u.start?.slice(0, 10), end: u.end?.slice(0, 10), days: u.durationDays, budget: u.budget }) : 'fallback (keyword rules)');
}
console.log('REMINDERS');
for (const stage of [1, 2]) {
  const f = { ...facts, stage };
  const [text, ms] = await timed(() => reminderText(f));
  report(`stage ${stage}`, ms, text === reminderTemplate(f) ? 'fallback (fixed template)' : text);
}
console.log(slow ? `${slow} answers took over 5 s. Check "ollama ps" shows 100% GPU, or try a smaller model.` : 'All answers under 5 s.');
