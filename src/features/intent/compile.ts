import { gemini, hasGemini } from '../../core/gemini';
import { area, wallLength } from '../../core/geometry';
import type { RequirementItem, Requirements, SpaceModel } from '../../core/types';
import { CATALOG, type CatalogEntry } from '../furniture/catalog';

/** Find the best catalog entry for a keyword list (first keyword that matches wins). */
export function matchCatalog(keywords: string[]): CatalogEntry | undefined {
  for (const k of keywords) {
    const kk = k.toLowerCase();
    const hit = CATALOG.find((c) => c.category.toLowerCase() === kk)
      ?? CATALOG.find((c) => c.id.toLowerCase().startsWith(kk))
      ?? CATALOG.find((c) => c.name.toLowerCase().includes(kk))
      ?? CATALOG.find((c) => c.tags.some((t) => t.toLowerCase() === kk));
    if (hit) return hit;
  }
  return undefined;
}

interface ItemRule { re: RegExp; keys: string[] }
const ITEM_RULES: ItemRule[] = [
  { re: /sofa[\s-]?bed|sleeper sofa/, keys: ['sofa-bed', 'sofabed', 'sofa bed'] },
  { re: /treatment (bed|table)|exam(ination)? (bed|table)/, keys: ['treatment', 'treatment-bed', 'exam'] },
  { re: /\bcrib|\bcot\b/, keys: ['crib', 'cot'] },
  { re: /\bdesks?\b/, keys: ['desk'] },
  { re: /\bbeds?\b/, keys: ['bed'] },
  { re: /wardrobe/, keys: ['wardrobe', 'storage'] },
  { re: /\bshel(f|ves)|bookcase/, keys: ['shelf', 'bookcase', 'storage'] },
  { re: /\bstorage\b/, keys: ['storage', 'shelf'] },
  { re: /armchairs?/, keys: ['armchair'] },
  { re: /\bsofas?\b|couch/, keys: ['sofa'] },
  { re: /\btables?\b/, keys: ['table', 'dining'] },
  { re: /\bchairs?\b/, keys: ['chair'] },
  { re: /\bplants?\b/, keys: ['plant'] },
  { re: /\blamps?\b/, keys: ['lamp'] },
  { re: /\brugs?\b|carpet/, keys: ['rug'] },
];

const PURPOSES: Array<{ id: string; re: RegExp }> = [
  { id: 'office', re: /office|work ?space|study\b|workroom/ },
  { id: 'bedroom', re: /bedroom|sleep/ },
  { id: 'guest', re: /guest/ },
  { id: 'studio', re: /studio/ },
  { id: 'cafe', re: /cafe|café|coffee shop/ },
  { id: 'clinic', re: /clinic|treatment room|therapy/ },
  { id: 'kids', re: /kids?|child|playroom|nursery/ },
  { id: 'dining', re: /dining/ },
  { id: 'living', re: /living|lounge/ },
];

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, couple: 2 };

function templateFor(purpose: string, people: number): Array<[string[], number]> {
  const p = Math.max(1, people);
  switch (purpose) {
    case 'office': return [[['desk'], p], [['chair'], p], [['storage', 'shelf'], 1]];
    case 'bedroom': return [[['bed'], 1], [['wardrobe', 'storage'], 1], [['lamp'], 1]];
    case 'guest': return [[['sofa-bed', 'sofabed', 'bed'], 1], [['storage', 'shelf'], 1]];
    case 'studio': return [[['bed', 'sofa-bed'], 1], [['table'], 1], [['chair'], 2], [['sofa'], 1], [['storage'], 1]];
    case 'cafe': return [[['table'], Math.ceil(p / 4)], [['chair'], p]];
    case 'clinic': return [[['treatment', 'treatment-bed'], 1], [['desk'], 1], [['chair'], 2], [['storage'], 1]];
    case 'kids': return [[['bed', 'crib'], 1], [['rug'], 1], [['storage', 'shelf'], 1]];
    case 'dining': return [[['table'], 1], [['chair'], Math.max(4, p)]];
    case 'living': return [[['sofa'], 1], [['armchair'], 1], [['table'], 1], [['rug'], 1], [['lamp'], 1]];
    default: return [];
  }
}

/** Strict SEK parse: "12 000 kr", "12k", "12000 SEK". Returns null if not money-shaped. */
export function parseBudget(t: string): number | null {
  const m = t.match(/(?:under|below|max(?:imum)?|budget(?: of)?|up to|within|around|about)?\s*(\d{1,3}(?:[  .,]\d{3})+|\d+(?:[.,]\d+)?)\s*(k\b|tkr|kkr|thousand)?\s*(kr\b|sek\b|kronor)?/gi);
  if (!m) return null;
  for (const raw of m) {
    const g = /(\d{1,3}(?:[  .,]\d{3})+|\d+(?:[.,]\d+)?)\s*(k\b|tkr|kkr|thousand)?\s*(kr\b|sek\b|kronor)?/i.exec(raw);
    if (!g) continue;
    const hasCue = /under|below|max|budget|up to|within/i.test(raw);
    if (!g[2] && !g[3] && !hasCue) continue;
    let n = /[  .,]\d{3}$/.test(g[1]) && !/^\d+[.,]\d{1,2}$/.test(g[1]) ? Number(g[1].replace(/[  .,]/g, '')) : Number(g[1].replace(',', '.'));
    if (g[2]) n *= 1000;
    if (!Number.isFinite(n) || n <= 0) continue;
    if (!g[2] && !g[3] && n < 100) continue; // "under 2" is not a budget
    return Math.round(n);
  }
  return null;
}

function parsePeople(t: string): number | null {
  const d = t.match(/(\d+)\s*(people|persons|guests|seats|kids|children|users|staff|patients)/);
  if (d) return Number(d[1]);
  const w = t.match(/\bfor (one|two|three|four|five|six|seven|eight|nine|ten|twelve|a couple)\b/);
  if (w) return WORDS[w[1].replace('a ', '')];
  const f = t.match(/\bfor (\d+)\b/);
  if (f) return Number(f[1]);
  return null;
}

export function addItem(items: RequirementItem[], keys: string[], qty: number, notes: string[], label: string) {
  const c = matchCatalog(keys);
  if (!c) { notes.push(`No catalog item for "${label}", skipped.`); return; }
  const ex = items.find((i) => i.catalogId === c.id && !i.keepExistingId);
  if (ex) ex.qty = Math.max(ex.qty, qty); else items.push({ catalogId: c.id, qty });
}

export function compileRules(text: string, model: SpaceModel): Requirements {
  const t = text.toLowerCase();
  const notes: string[] = [];
  const questions: string[] = [];
  const items: RequirementItem[] = [];
  const lockedIds: string[] = [];

  const purpose = PURPOSES.find((p) => p.re.test(t))?.id ?? '';
  const peopleParsed = parsePeople(t);
  const people = Math.min(50, Math.max(1, peopleParsed ?? (purpose === 'bedroom' ? 1 : 1)));
  const budgetSek = parseBudget(text);

  // Keep existing furniture
  const keepRe = /keep (?:the |my |our )?(?:existing |current |old )?([a-z -]+?)(?:[,.;]|\band\b|$)/g;
  let km: RegExpExecArray | null;
  while ((km = keepRe.exec(t))) {
    const word = km[1].trim().replace(/s$/, '');
    const hit = model.furniture.find((f) => !lockedIds.includes(f.id) && (f.category.toLowerCase().includes(word) || f.name.toLowerCase().includes(word) || word.includes(f.category.toLowerCase())));
    if (hit) { lockedIds.push(hit.id); items.push({ catalogId: hit.catalogId, qty: 1, keepExistingId: hit.id }); }
    else notes.push(`Could not find an existing "${word}" in the room.`);
  }

  // Explicit items
  for (const r of ITEM_RULES) {
    const m = t.match(r.re);
    if (!m) continue;
    if (r.keys[0] === 'bed' && /sofa[\s-]?bed|treatment bed/.test(t) && !/\bbed\b(?![\s-]?(?:room))/.test(t.replace(/sofa[\s-]?bed|treatment bed|bedroom/g, ''))) continue;
    if (r.keys[0] === 'sofa' && /sofa[\s-]?bed/.test(t) && !/\bsofa\b(?![\s-]?bed)/.test(t)) continue;
    if (r.keys[0] === 'table' && /treatment table/.test(t)) continue;
    const near = t.slice(Math.max(0, (m.index ?? 0) - 12), m.index).match(/(\d+|one|two|three|four|five|six)\s*$/);
    const qty = near ? (Number(near[1]) || WORDS[near[1]] || 1) : 1;
    // skip if already covered by a kept item of same category
    const c = matchCatalog(r.keys);
    if (c && items.some((i) => i.keepExistingId && i.catalogId === c.id) && qty <= 1) continue;
    addItem(items, r.keys, qty, notes, r.keys[0]);
  }

  // Purpose template fills gaps
  for (const [keys, qty] of templateFor(purpose, people)) {
    const c = matchCatalog(keys);
    if (!c) continue;
    const have = items.filter((i) => i.catalogId === c.id).reduce((s, i) => s + i.qty, 0);
    if (have < qty) {
      const free = items.find((i) => i.catalogId === c.id && !i.keepExistingId);
      if (free) free.qty += qty - have; else items.push({ catalogId: c.id, qty: qty - have });
    }
  }

  // Routes
  const routeTargets: Requirements['routeTargets'] = [];
  if (/(route|path|access|way|walk)[^.]*?(window|balcony)|(window|balcony)[^.]*?(clear|free|access)/.test(t)) routeTargets.push({ kind: 'window' });
  if (/(route|path|access)[^.]*?\b(door|entrance|exit)/.test(t)) routeTargets.push({ kind: 'door' });

  let minRouteWidthM = 0.8;
  if (/wheelchair|accessib|rollator|walker/.test(t)) {
    minRouteWidthM = 0.9;
    notes.push('Accessible route asked: check routes with the wheelchair profile.');
  }
  const w = t.match(/(\d+(?:[.,]\d+)?)\s*(cm|m)\b\s*(?:wide\s*)?(?:route|path|passage|aisle|clearance|walkway)/) ?? t.match(/(?:route|path|passage|aisle|walkway)[^\d]{0,15}(\d+(?:[.,]\d+)?)\s*(cm|m)\b/);
  if (w) {
    const val = Number(w[1].replace(',', '.')) / (w[2] === 'cm' ? 100 : 1);
    if (val >= 0.6 && val <= 2) minRouteWidthM = val;
    else { minRouteWidthM = 0.9; notes.push('Route width unit unclear, set to 90 cm.'); }
  }

  const style = (t.match(/\b(scandinavian|nordic|minimal(?:ist)?|cosy|cozy|industrial|modern|classic|boho|japandi|warm|bright)\b/) ?? [])[1] ?? '';

  if (!purpose) questions.push('What is the room for? (office, bedroom, living, cafe...)');
  if (!items.length) questions.push('Which furniture do you need?');
  if (peopleParsed == null && ['office', 'cafe', 'dining', 'clinic'].includes(purpose)) questions.push('How many people will use it?');

  const out: Requirements = { purpose, people, budgetSek, items, routeTargets, minRouteWidthM, style, lockedIds, notes, questions, compiledBy: 'rules' };
  return ensurePerPerson(out, model);
}

/** A kept desk or chair covers one person; add new ones so every person has one. */
export function ensurePerPerson(r: Requirements, model: SpaceModel): Requirements {
  if (r.people <= 1) return r;
  const items = r.items.map((i) => ({ ...i }));
  for (const kept of r.items.filter((i) => i.keepExistingId)) {
    const cat = `${model.furniture.find((f) => f.id === kept.keepExistingId)?.category ?? ''} ${CATALOG.find((c) => c.id === kept.catalogId)?.category ?? ''}`.toLowerCase();
    const kind = /desk/.test(cat) ? 'desk' : /chair/.test(cat) && !/arm/.test(cat) ? 'chair' : '';
    if (!kind) continue;
    const c = CATALOG.find((x) => x.id === kept.catalogId) ?? matchCatalog([kind]);
    if (!c) continue;
    const total = items.filter((i) => i.catalogId === c.id || i.catalogId === kept.catalogId).reduce((s, i) => s + i.qty, 0);
    const need = r.people - total;
    if (need <= 0) continue;
    const free = items.find((i) => i.catalogId === c.id && !i.keepExistingId);
    if (free) free.qty += need; else items.push({ catalogId: c.id, qty: need });
  }
  return { ...r, items };
}

export const SCHEMA = {
  type: 'OBJECT',
  properties: {
    purpose: { type: 'STRING' },
    people: { type: 'INTEGER' },
    budgetSek: { type: 'NUMBER', nullable: true },
    items: { type: 'ARRAY', items: { type: 'OBJECT', properties: { catalogId: { type: 'STRING' }, qty: { type: 'INTEGER' }, keepExistingId: { type: 'STRING', nullable: true } }, required: ['catalogId', 'qty'] } },
    routeTargets: { type: 'ARRAY', items: { type: 'OBJECT', properties: { kind: { type: 'STRING', enum: ['window', 'door', 'opening'] }, id: { type: 'STRING', nullable: true } }, required: ['kind'] } },
    minRouteWidthM: { type: 'NUMBER' },
    style: { type: 'STRING' },
    notes: { type: 'ARRAY', items: { type: 'STRING' } },
    questions: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['purpose', 'people', 'items', 'routeTargets', 'minRouteWidthM', 'style', 'notes', 'questions'],
};

export function roomSummary(model: SpaceModel): string {
  const lines: string[] = [];
  for (const s of model.spaces) {
    lines.push(`Space ${s.id} "${s.name}": area ${area(s.polygon).toFixed(1)} m2, walls ${s.polygon.map((_, i) => wallLength(s, i).toFixed(2)).join(', ')} m`);
  }
  for (const o of model.openings) lines.push(`${o.kind} ${o.id}: wall ${o.wallIndex}, width ${o.widthM.toFixed(2)} m`);
  for (const f of model.furniture) lines.push(`existing furniture id=${f.id} catalogId=${f.catalogId} "${f.name}" (${f.category})`);
  return lines.join('\n');
}

export function validate(raw: Partial<Requirements>, model: SpaceModel, text: string): Requirements {
  const notes = Array.isArray(raw.notes) ? raw.notes.filter((n) => typeof n === 'string').slice(0, 12) : [];
  const questions = Array.isArray(raw.questions) ? raw.questions.filter((n) => typeof n === 'string').slice(0, 8) : [];
  const ids = new Set(CATALOG.map((c) => c.id));
  const furnIds = new Set(model.furniture.map((f) => f.id));
  const items: RequirementItem[] = [];
  for (const it of Array.isArray(raw.items) ? raw.items : []) {
    if (!it || typeof it.catalogId !== 'string') continue;
    const keep = it.keepExistingId && furnIds.has(it.keepExistingId) ? it.keepExistingId : undefined;
    if (!ids.has(it.catalogId) && !keep) { notes.push(`Dropped unknown item "${it.catalogId}".`); continue; }
    const qty = Math.min(20, Math.max(0, Math.round(Number(it.qty) || 0)));
    if (qty === 0) continue;
    items.push({ catalogId: it.catalogId, qty: keep ? 1 : qty, ...(keep ? { keepExistingId: keep } : {}) });
  }
  let minRouteWidthM = Number(raw.minRouteWidthM);
  if (!(minRouteWidthM >= 0.6 && minRouteWidthM <= 2)) { minRouteWidthM = 0.9; notes.push('Route width unit unclear, set to 90 cm.'); }
  // Budget: trust our strict parser over the model when the text has one.
  const parsed = parseBudget(text);
  let budgetSek: number | null = parsed;
  if (parsed == null && typeof raw.budgetSek === 'number' && raw.budgetSek > 0) { budgetSek = null; notes.push('Ignored a budget not found in your text.'); }
  const openIds = new Set(model.openings.map((o) => o.id));
  const routeTargets = (Array.isArray(raw.routeTargets) ? raw.routeTargets : [])
    .filter((r) => r && ['window', 'door', 'opening'].includes(r.kind))
    .map((r) => ({ kind: r.kind, ...(r.id && openIds.has(r.id) ? { id: r.id } : {}) }));
  const lockedIds = items.flatMap((i) => (i.keepExistingId ? [i.keepExistingId] : []));
  return {
    purpose: String(raw.purpose ?? '').slice(0, 40),
    people: Math.min(50, Math.max(1, Math.round(Number(raw.people) || 1))),
    budgetSek, items, routeTargets, minRouteWidthM,
    style: String(raw.style ?? '').slice(0, 40),
    lockedIds, notes, questions, compiledBy: 'gemini',
  };
}

export async function compileIntent(text: string, model: SpaceModel): Promise<Requirements> {
  if (hasGemini()) {
    try {
      const catalog = CATALOG.map((c) => `${c.id}: ${c.name} ${Math.round(c.w * 100)}x${Math.round(c.d * 100)} cm`).join('\n');
      const prompt = `Turn this furnishing request into a spatial program.\nRequest: """${text}"""\n\nRoom:\n${roomSummary(model)}\n\nCatalog (use only these ids):\n${catalog}\n\nRules: budgetSek in Swedish kronor or null if not stated. minRouteWidthM in metres. To keep existing furniture, add an item with its catalogId, qty 1 and keepExistingId. Add questions only for real ambiguity.`;
      const raw = await gemini<Partial<Requirements>>([{ text: prompt }], { json: true, schema: SCHEMA, system: 'You are a careful interior space planner. Output only JSON matching the schema.' });
      return ensurePerPerson(validate(raw, model, text), model);
    } catch (e) {
      const r = compileRules(text, model);
      r.notes.unshift(`Gemini failed, used rules (${(e as Error).message.slice(0, 60)}).`);
      return r;
    }
  }
  return compileRules(text, model);
}
