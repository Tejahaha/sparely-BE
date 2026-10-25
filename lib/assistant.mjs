import { categories } from './seed.mjs';
import { AppError } from './store.mjs';
import { ask, cosine, embed, llmEnabled } from './llm.mjs';
// Plain-language search for the M2 catalogue (Storage, Parking, Tools & cleaning, Creator gear).
// With LLM_URL set, a local model reads the request into fields (category, area, dates, items,
// budget); code checks each field and runs the normal search. Without it, or when the model
// fails, the labelled local rules below are used.
const rules = [{
  matches: /photograph|product photo|shoot|portrait|filming|video|lighting/i,
  category: 'creator',
  terms: ['light', 'tripod'],
  need: 'Lighting and a steady support for photos or video'
}, {
  matches: /podcast|recording|record.*interview|microphone|voice/i,
  category: 'creator',
  terms: ['microphone'],
  need: 'An audio recording setup'
}, {
  matches: /clean|vacuum|dust|move.out|spill/i,
  category: 'tools',
  terms: ['vacuum'],
  need: 'Equipment for a clean-up'
}, {
  matches: /drill|shel(?:f|ves)|assemble|furniture|diy|tool|repair|fix/i,
  category: 'tools',
  terms: ['drill'],
  need: 'Tools for your project'
}, {
  matches: /\b(?:sew|sewing|hem|hems|hemming|stitch\w*|tailor\w*|mend|mending|curtains?|alterations?)\b/i,
  category: 'tools',
  terms: ['sewing'],
  need: 'A sewing machine for mending or hemming'
}, {
  matches: /\b(?:garden\w*|prune|pruning|plants?|balcony|weeds?|weeding|rake|hedges?|leaves|yard)\b/i,
  category: 'tools',
  terms: ['garden'],
  need: 'Garden tools for a tidy-up'
}, {
  matches: /\b(?:store|storage|storing|boxes|bags|luggage|hostel|belongings)\b/i,
  category: 'storage',
  terms: [],
  need: 'A place for your belongings'
}, {
  matches: /park|car|scooter|motorcycle|bike/i,
  category: 'parking',
  terms: [],
  need: 'A parking spot'
}];
const needs = {
  storage: 'A place for your belongings',
  parking: 'A parking spot',
  tools: 'Tools or equipment for the job',
  creator: 'Creator gear for photos, video or sound'
};
const CATEGORY_IDS = categories.map(c => c.id);
const SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['categories', 'keywords', 'items', 'area', 'startDate', 'endDate', 'durationDays', 'budget'],
  properties: {
    categories: { type: 'array', maxItems: 4, items: { type: 'string', enum: CATEGORY_IDS } },
    keywords: { type: 'array', maxItems: 4, items: { type: 'string' } },
    items: { type: 'array', maxItems: 12, items: { type: 'object', additionalProperties: false, required: ['name', 'count'], properties: { name: { type: 'string' }, count: { type: 'integer' } } } },
    area: { type: 'string' },
    startDate: { type: 'string' },
    endDate: { type: 'string' },
    durationDays: { type: 'integer' },
    budget: { type: 'integer' }
  }
};
const SEARCH_SYSTEM = `You turn a request for a neighbourhood rental in India into JSON. The request may mix English with Hindi or Telugu, in any script.
Categories:
- storage: keeping boxes, luggage, furniture or belongings somewhere
- parking: a spot for a car, bike, scooter or cycle
- tools: drill, vacuum, cleaning, sewing machine, garden tools, repairs
- creator: lights, tripod, microphone for photos, video or podcasts
Rules:
- Use only what the request says. Never guess. Unknown text is "", unknown number is 0.
- categories: every category that fits, or [] if none fits.
- keywords: up to 4 short English words for equipment needed, like "drill" or "tripod". [] for storage or parking.
- items: things to store or park, with counts (1 if not said). Names in English.
- area: the neighbourhood if one is named, else "".
- startDate and endDate: YYYY-MM-DD, worked out from today's date below. "kal" means tomorrow, "parso" the day after.
- durationDays: length of time if said ("2 months" is 60, "a week" is 7), else 0.
- budget: maximum rupees if a price limit is said, else 0.
Examples: storing a cycle alongside boxes is storage, not a parking request. Hemming curtains needs tools and keyword "sewing". Lighting a photo shoot needs creator gear and keyword "light"; do not add a microphone unless sound recording is requested.`;
// Rough floor space (sq ft) per stored item, stacking boxes and bags where people usually do.
// ponytail: keyword table, not measurements; the host still confirms the real footprint at booking.
const FOOTPRINT = [[/box|carton|crate/, 1.5], [/bag|suitcase|luggage|trunk/, 2], [/cycle|bicycle/, 12], [/scooter|bike|motorcycle/, 20], [/fridge|refrigerator|washing machine|washer/, 6], [/sofa|couch/, 25], [/bed|mattress/, 20], [/table|desk/, 10], [/chair|stool/, 4], [/tv|television|monitor/, 3], [/shelf|cupboard|wardrobe|almirah/, 12]];
export function storageNeedSqft(items) {
  if (!items?.length) return null;
  const sqft = items.reduce((sum, i) => sum + i.count * (FOOTPRINT.find(([re]) => re.test(i.name.toLowerCase()))?.[1] ?? 3), 0);
  return Math.max(1, Math.ceil(sqft));
}
const istDay = ms => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(ms); // YYYY-MM-DD
const istTime = day => Date.parse(`${day}T10:00:00+05:30`);
// Resolve an explicit English relative weekday with the calendar, not model arithmetic.
// The upcoming occurrence is used; "next Monday" on Monday means seven days later.
function requestedWeekday(query, today) {
  const match = query.match(/\b(?:next|this)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
  if (!match) return null;
  const target = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'].indexOf(match[1].toLowerCase());
  const current = new Date(`${today}T00:00:00Z`).getUTCDay();
  let offset = (target - current + 7) % 7;
  if (!offset && /^next\b/i.test(match[0])) offset = 7;
  return istDay(istTime(today) + offset * 86400_000);
}

// A cycle or bike mentioned in a storage request is something to store, not a parking need.
const storingNotParking = (query, cats) => cats.includes('storage') && cats.includes('parking') && /\b(?:store|storing|storage|keep)\b/i.test(query) && !/\bpark/i.test(query) ? cats.filter(c => c !== 'parking') : cats;
// The model's reading of the request, checked field by field. null when the model is off or failed.
export async function understand(query, now = Date.now()) {
  const today = istDay(now);
  const r = await ask({ system: SEARCH_SYSTEM, prompt: `Today is ${today}.\nRequest: ${query}`, schema: SEARCH_SCHEMA });
  if (!r) return null;
  const day = v => /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(istTime(v)) && istDay(istTime(v)) === v ? v : '';
  const durationDays = Number.isInteger(r.durationDays) && r.durationDays > 0 && r.durationDays <= 366 ? r.durationDays : 0;
  let start = day(r.startDate), end = day(r.endDate);
  const weekday = requestedWeekday(query, today);
  if (weekday) {
    start = weekday;
    // Rebase a stated duration as well; a plausible-looking model end can be wrong.
    end = durationDays ? istDay(istTime(start) + durationDays * 86400_000) : '';
  }
  // A rental length is elapsed days (end is exclusive), not an inclusive date count.
  // Gemma sometimes returned a seven-day stay ending only six days after its start.
  if (start && durationDays) end = istDay(istTime(start) + durationDays * 86400_000);
  if (!start || !end || end <= start || start < today) start = end = '';
  return {
    categories: storingNotParking(query, [...new Set(Array.isArray(r.categories) ? r.categories.filter(c => CATEGORY_IDS.includes(c)) : [])]),
    keywords: [...new Set((Array.isArray(r.keywords) ? r.keywords : []).map(k => String(k).toLowerCase().replace(/[^a-z ]/g, '').trim()).filter(k => k.length >= 3))].slice(0, 4),
    items: (Array.isArray(r.items) ? r.items : []).map(i => ({ name: String(i?.name ?? '').trim().slice(0, 40), count: Number.isInteger(i?.count) && i.count > 0 && i.count < 1000 ? i.count : 1 })).filter(i => i.name).slice(0, 12),
    area: String(r.area ?? '').trim().slice(0, 60),
    start: start ? new Date(istTime(start)).toISOString() : null,
    end: end ? new Date(istTime(end)).toISOString() : null,
    durationDays,
    budget: Number.isInteger(r.budget) && r.budget > 0 && r.budget <= 1_000_000 ? r.budget : null
  };
}
// Relevance by meaning: cosine similarity between the request and each listing's text, from the
// embedding model. A listing is embedded once per process and reused (keyed by its text, so an
// edit re-embeds it). null when the embedding model is off or fails: search then works as before.
// ponytail: in-memory cache cleared at 2,000 entries; store vectors in the database if the catalogue grows.
const vectorCache = new Map();
const listingText = l => { const c = categories.find(x => x.id === l.category); return `search_document: ${l.title}. ${c ? `${c.name}: ${c.description}.` : ''} ${l.tags || ''}. ${l.description || ''} Includes: ${(l.included || []).join(', ')}` };
export async function relevance(query, listings) {
  const texts = listings.map(listingText);
  const missing = [...new Set(texts.filter(t => !vectorCache.has(t)))];
  const got = await embed([`search_query: ${query}`, ...missing]);
  if (!got) return null;
  if (vectorCache.size + missing.length > 2000) vectorCache.clear();
  missing.forEach((t, i) => vectorCache.set(t, got[i + 1]));
  return new Map(listings.map((l, i) => [l.id, cosine(got[0], vectorCache.get(texts[i]))]));
}
// Offered on meaning alone (no category matched) only when the best listing is close enough and
// clearly ahead of the runner-up. Tuned on nomic-embed-text, whose scores bunch up (0.43-0.67 for
// the sample catalogue): this keeps dusty -> vacuum, kurta -> sewing machine, hedge -> garden kit,
// and rejects near-ties such as "bake a cake" or "hang a TV".
export const MEANING_MIN = 0.5, MEANING_GAP = 0.04;

export async function assist(store, userId, input) {
  const query = String(input.query || '').trim().slice(0, 1000);
  if (query.length < 5) throw new AppError('Tell us a little more about what you need.');
  const started = await performance.now();
  const understood = await understand(query);
  const mode = understood ? 'model' : 'local',
    warning = !understood && llmEnabled() ? 'The AI helper is offline right now, so keyword matching was used.' : undefined;
  const budgetMatch = query.match(/(?:₹|rs\.?\s*|inr\s*|budget\s*(?:of\s*)?|under\s*)([\d,]+)/i);
  const budget = budgetMatch ? Number(budgetMatch[1].replaceAll(',', '')) : understood?.budget ?? null;
  // Dates the person set in filters win over dates read from the text.
  const dates = input.start && input.end ? { start: input.start, end: input.end } : understood?.start ? { start: understood.start, end: understood.end } : null;
  let inventory = (await store.search({ city: input.city || 'Hyderabad', ...dates }, userId)).filter(l => l.ownerId !== userId);
  if (understood?.area) {
    const area = understood.area.toLowerCase(), near = l => l.area.toLowerCase().includes(area) || area.includes(l.area.toLowerCase());
    inventory = [...inventory.filter(near), ...inventory.filter(l => !near(l))];
  }
  const scores = inventory.length ? await relevance(query, inventory) : null;
  const sim = l => scores?.get(l.id) ?? 0;
  const needSqft = understood?.categories.includes('storage') ? storageNeedSqft(understood.items) : null;
  const area = understood?.area?.toLowerCase() || '';
  const near = l => !!area && (l.area.toLowerCase().includes(area) || area.includes(l.area.toLowerCase()));
  const fits = l => !needSqft || l.category !== 'storage' || l.storage?.usableSqft == null || l.storage.usableSqft >= needSqft;
  const over = l => !!budget && !!l.quote && l.quote.rental > budget;
  // Order: has room, within budget, in the named area, closest title match, closest meaning, cheapest.
  const rank = term => (a, b) => (fits(b) - fits(a)) || (over(a) - over(b)) || (near(b) - near(a))
    || (term ? titleAt(a, term) - titleAt(b, term) : 0) || (sim(b) - sim(a)) || ((a.quote?.rental ?? a.rate) - (b.quote?.rental ?? b.rate));
  const titleAt = (l, term) => { const at = l.title.toLowerCase().indexOf(term); return at < 0 ? 1000 : at };
  const why = l => [near(l) && `In ${l.area}, the area you named.`, needSqft && l.category === 'storage' && l.storage?.usableSqft != null && (fits(l) ? `Room for the ~${needSqft} sq ft your items need.` : `Smaller than the ~${needSqft} sq ft your items need.`), over(l) && 'Above your budget.'].filter(Boolean).join(' ');
  const matched = understood?.categories.length ? understood.categories.map(category => ({
    category,
    need: needs[category],
    // Equipment words only count when a listing in that category actually has them.
    terms: understood.keywords.filter(k => inventory.some(l => l.category === category && `${l.title} ${l.tags}`.toLowerCase().includes(k)))
  })) : rules.filter(r => r.matches.test(query));
  let selected = [];
  for (const rule of matched) {
    const candidates = inventory.filter(l => l.category === rule.category);
    if (rule.terms.length) for (const term of rule.terms) {
      const found = candidates.filter(l => `${l.title} ${l.tags}`.toLowerCase().includes(term)).sort(rank(term))[0];
      if (found && !selected.some(s => s.listing.id === found.id)) selected.push({
        listing: found,
        reason: `Matches ${term} in the host's listing. ${(found.included[0] || '').replace(/([^.!?])$/, '$1.')} ${why(found)}`.replace(/\s+/g, ' ').trim()
      });
    } else for (const l of [...candidates].sort(rank()).slice(0, 2)) if (!selected.some(s => s.listing.id === l.id)) selected.push({
      listing: l,
      reason: `A ${categories.find(c => c.id === l.category).name.toLowerCase()} option in ${l.area}. ${why(l)}`.trim()
    });
  }
  // No category matched: offer the closest listings by meaning, but only clearly close ones.
  const ranked = !matched.length && scores ? [...inventory].sort((a, b) => sim(b) - sim(a)) : [];
  const byMeaning = !!ranked.length && sim(ranked[0]) >= MEANING_MIN && (ranked.length < 2 || sim(ranked[0]) - sim(ranked[1]) >= MEANING_GAP);
  if (byMeaning) for (const l of ranked.slice(0, 1)) selected.push({
    listing: l,
    reason: `Closest match for what you described. ${(l.included[0] || '').replace(/([^.!?])$/, '$1.')} ${why(l)}`.replace(/\s+/g, ' ').trim()
  });
  const seenCategories = [...new Set([...matched.map(r => r.category), ...selected.map(x => x.listing.category)])];
  const hasDates = !!dates;
  selected = selected.slice(0, 6);
  // Storage is priced by the space needed, so it has no fixed quote and no total here.
  const knownRentalTotal = hasDates && selected.length && selected.every(x => x.listing.quote) ? selected.reduce((s, x) => s + x.listing.quote.rental, 0) : null;
  return {
    mode,
    warning,
    query,
    understood,
    dates,
    categories: seenCategories,
    requirements: [...new Set([...matched.map(r => r.need), ...seenCategories.map(c => needs[c])])],
    semantic: !!scores,
    matchedByMeaning: byMeaning,
    suggestions: selected,
    budget,
    storageNeedSqft: needSqft,
    total: knownRentalTotal,
    withinBudget: budget && knownRentalTotal !== null ? knownRentalTotal <= budget : null,
    questions: [!hasDates && 'What are your collection and return dates?', !seenCategories.length && 'Which kind of item or space would help you?', seenCategories.includes('creator') && 'What equipment do you already have, and which connections does it support?', needSqft && !selected.some(x => x.listing.category === 'storage' && fits(x.listing)) && `None of the listed spaces has room for about ${needSqft} sq ft. Try fewer items, or split them across two spaces.`].filter(Boolean),
    trace: [{
      title: mode === 'model' ? 'Task interpreted with a model' : 'Task interpreted with local rules',
      detail: `${seenCategories.length} relevant ${seenCategories.length === 1 ? 'category' : 'categories'} identified.`,
      source: mode
    }, {
      title: 'Inventory checked',
      detail: `${inventory.length} active listings checked${hasDates ? ' for your dates' : '; dates are still needed'}.`,
      source: 'database'
    }, ...(scores ? [{
      title: byMeaning ? 'Matched by meaning' : 'Ranked by meaning',
      detail: byMeaning ? 'No category fitted the words used, so listings were matched on what they mean.' : 'Listings were compared with your request by meaning to order close options.',
      source: 'embeddings'
    }] : []), {
      title: 'Options assembled',
      detail: `${selected.length} matching listings. Prices and included accessories come directly from host listings.`,
      source: 'rules'
    }],
    durationMs: Math.round((await performance.now()) - started)
  };
}
