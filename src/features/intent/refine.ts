import { gemini, hasGemini, usage } from '../../core/gemini';
import { getState } from '../../core/store';
import type { RequirementItem, Requirements, SpaceModel } from '../../core/types';
import { CATALOG } from '../furniture/catalog';
import { SCHEMA, addItem, compileIntent, ensurePerPerson, matchCatalog, parseBudget, roomSummary, validate } from './compile';

/** What ran and how long it took, shown under the program. */
export interface CompileMeta { by: 'gemini' | 'rules'; model?: string; ms: number; inTokens: number; outTokens: number; error?: string }

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; meta: Omit<CompileMeta, 'by'> }> {
  const t0 = performance.now(); const i0 = usage.inputTokens; const o0 = usage.outputTokens;
  const value = await fn();
  return { value, meta: { model: getState().settings.geminiModel, ms: Math.round(performance.now() - t0), inTokens: usage.inputTokens - i0, outTokens: usage.outputTokens - o0 } };
}

export async function compileWithMeta(text: string, model: SpaceModel): Promise<{ req: Requirements; meta: CompileMeta }> {
  const { value, meta } = await timed(() => compileIntent(text, model));
  const failed = value.notes.find((n) => n.startsWith('Gemini failed'));
  return { req: value, meta: { ...meta, by: value.compiledBy, model: value.compiledBy === 'gemini' ? meta.model : undefined, error: failed } };
}

/** Fields a follow-up may change. Items, when present, is the full new list. */
export interface RefinePatch {
  purpose?: string | null; people?: number | null; budgetSek?: number | null; style?: string | null; minRouteWidthM?: number | null;
  items?: RequirementItem[] | null; routeTargets?: Requirements['routeTargets'] | null; reply?: string;
}

const PATCH_SCHEMA = {
  type: 'OBJECT',
  properties: {
    purpose: { type: 'STRING', nullable: true },
    people: { type: 'INTEGER', nullable: true },
    budgetSek: { type: 'NUMBER', nullable: true },
    style: { type: 'STRING', nullable: true },
    minRouteWidthM: { type: 'NUMBER', nullable: true },
    items: { ...SCHEMA.properties.items, nullable: true },
    routeTargets: { ...SCHEMA.properties.routeTargets, nullable: true },
    reply: { type: 'STRING' },
  },
  required: ['reply'],
};

export function applyPatch(cur: Requirements, p: RefinePatch, model: SpaceModel): Requirements {
  const merged: Partial<Requirements> = {
    ...cur,
    ...(p.purpose ? { purpose: p.purpose } : {}),
    ...(p.people ? { people: p.people } : {}),
    ...(p.style ? { style: p.style } : {}),
    ...(p.minRouteWidthM ? { minRouteWidthM: p.minRouteWidthM } : {}),
    ...(Array.isArray(p.items) ? { items: p.items } : {}),
    ...(Array.isArray(p.routeTargets) && p.routeTargets.length ? { routeTargets: p.routeTargets } : {}),
    notes: [], questions: [],
  };
  const v = validate(merged, model, '');
  const budgetSek = typeof p.budgetSek === 'number' && p.budgetSek > 0 ? Math.round(p.budgetSek) : cur.budgetSek;
  return ensurePerPerson({ ...v, budgetSek, notes: v.notes.filter((n) => n.startsWith('Dropped')), questions: [], compiledBy: cur.compiledBy }, model);
}

const nameOf = (id: string) => CATALOG.find((c) => c.id === id)?.name ?? id;
const priceOf = (r: { catalogId: string; qty: number }[]) => r.reduce((s, i) => s + (CATALOG.find((c) => c.id === i.catalogId)?.priceSek ?? 0) * i.qty, 0);

export function refineRules(cur: Requirements, text: string, model: SpaceModel): { next: Requirements; reply: string } {
  const t = text.toLowerCase();
  const items = cur.items.map((i) => ({ ...i }));
  const said: string[] = [];
  const notes: string[] = [];
  const p: RefinePatch = {};
  if (/coz|cosy|warm|homey/.test(t)) {
    p.style = 'cozy';
    for (const k of ['rug', 'lamp']) if (!items.some((i) => matchCatalog([k])?.id === i.catalogId)) addItem(items, [k], 1, notes, k);
    said.push('cozier, with a rug and lamp');
  }
  if (/cheap|less money|lower budget|save money|budget/.test(t)) {
    p.budgetSek = parseBudget(text) ?? Math.round(((cur.budgetSek ?? priceOf(items)) || 10000) * 0.8 / 100) * 100;
    said.push(`budget ${p.budgetSek} kr`);
  }
  if (/open|spacious|more space|less clutter|roomier/.test(t)) {
    p.minRouteWidthM = Math.min(2, Math.round((cur.minRouteWidthM + 0.1) * 100) / 100);
    const drop = [...items].reverse().find((i) => !i.keepExistingId && /plant|rug|lamp|armchair/.test(i.catalogId));
    if (drop) { items.splice(items.indexOf(drop), 1); said.push(`removed ${nameOf(drop.catalogId)}`); }
    said.push(`route ${Math.round(p.minRouteWidthM * 100)} cm`);
  }
  let m: RegExpExecArray | null;
  const addRe = /\b(?:add|include|need|want)\s+(?:a |an |one |another |some )?(\d+\s+)?([a-z -]+?)(?:[,.;]|\band\b|$)/g;
  while ((m = addRe.exec(t))) {
    const words = m[2].trim().split(/\s+/);
    const c = matchCatalog([words.join('-'), words.join(' '), ...[...words].reverse().map((w) => w.replace(/s$/, ''))]);
    if (!c) { notes.push(`No catalog item for "${m[2].trim()}".`); continue; }
    const qty = m[1] ? Number(m[1]) : 1;
    const ex = items.find((i) => i.catalogId === c.id && !i.keepExistingId);
    if (ex) ex.qty += qty; else items.push({ catalogId: c.id, qty });
    said.push(`added ${qty > 1 ? `${qty} ` : ''}${c.name}`);
  }
  const rmRe = /\b(?:remove|drop|without|skip|no)\s+(?:the |a |an )?([a-z -]+?)(?:[,.;]|\band\b|$)/g;
  while ((m = rmRe.exec(t))) {
    const word = m[1].trim().replace(/s$/, '');
    const idx = items.findIndex((i) => !i.keepExistingId && (i.catalogId.includes(word) || nameOf(i.catalogId).toLowerCase().includes(word)));
    if (idx >= 0) { said.push(`removed ${nameOf(items[idx].catalogId)}`); items.splice(idx, 1); }
  }
  const ppl = t.match(/(\d+)\s*(people|persons|guests|seats)/);
  if (ppl) { p.people = Number(ppl[1]); said.push(`${p.people} people`); }
  const w = t.match(/(\d+)\s*cm/);
  if (w && /route|path|wide|aisle/.test(t)) { p.minRouteWidthM = Number(w[1]) / 100; said.push(`route ${w[1]} cm`); }
  p.items = items;
  const next = applyPatch(cur, p, model);
  next.notes = [...next.notes, ...notes];
  return { next, reply: said.length ? `Changed: ${said.join(', ')}.` : 'Could not read that. Try "add a lamp", "cheaper" or "more open".' };
}

export async function refineIntent(cur: Requirements, text: string, history: string[], model: SpaceModel): Promise<{ next: Requirements; reply: string; meta: CompileMeta }> {
  if (hasGemini()) {
    try {
      const catalog = CATALOG.map((c) => `${c.id}: ${c.name} ${Math.round(c.w * 100)}x${Math.round(c.d * 100)} cm, ${c.priceSek} kr`).join('\n');
      const { purpose, people, budgetSek, items, routeTargets, minRouteWidthM, style } = cur;
      const prompt = `Current program (JSON):\n${JSON.stringify({ purpose, people, budgetSek, items, routeTargets, minRouteWidthM, style })}\n\nEarlier requests:\n${history.slice(-6).join('\n') || 'none'}\n\nNew request: """${text}"""\n\nRoom:\n${roomSummary(model)}\n\nCatalog (use only these ids):\n${catalog}\n\nReturn a PATCH with only the fields that change; leave others null. If items change, return the full new items list and keep items with keepExistingId unless asked. budgetSek in kronor. minRouteWidthM in metres. reply: one short plain sentence saying what you changed.`;
      const { value, meta } = await timed(() => gemini<RefinePatch>([{ text: prompt }], { json: true, schema: PATCH_SCHEMA, system: 'You are a careful interior space planner editing an existing program. Output only JSON matching the schema.', timeoutMs: 30000 }));
      return { next: applyPatch(cur, value, model), reply: String(value.reply ?? 'Updated.').slice(0, 200), meta: { ...meta, by: 'gemini' } };
    } catch (e) {
      const r = refineRules(cur, text, model);
      return { ...r, meta: { by: 'rules', ms: 0, inTokens: 0, outTokens: 0, error: `Gemini failed, used rules (${(e as Error).message.slice(0, 60)}).` } };
    }
  }
  const t0 = performance.now();
  const r = refineRules(cur, text, model);
  return { ...r, meta: { by: 'rules', ms: Math.round(performance.now() - t0), inTokens: 0, outTokens: 0 } };
}

/** Plain list of what changed between two programs. */
export function diffRequirements(a: Requirements, b: Requirements): string[] {
  const out: string[] = [];
  if (a.purpose !== b.purpose) out.push(`Purpose: ${a.purpose || 'none'} to ${b.purpose || 'none'}`);
  if (a.people !== b.people) out.push(`People: ${a.people} to ${b.people}`);
  if (a.budgetSek !== b.budgetSek) out.push(`Budget: ${a.budgetSek ?? 'none'} to ${b.budgetSek ?? 'none'} kr`);
  if (a.style !== b.style) out.push(`Style: ${a.style || 'none'} to ${b.style || 'none'}`);
  if (a.minRouteWidthM !== b.minRouteWidthM) out.push(`Route: ${Math.round(a.minRouteWidthM * 100)} to ${Math.round(b.minRouteWidthM * 100)} cm`);
  const count = (r: Requirements) => { const m = new Map<string, number>(); for (const i of r.items) m.set(i.catalogId, (m.get(i.catalogId) ?? 0) + i.qty); return m; };
  const ca = count(a), cb = count(b);
  for (const id of new Set([...ca.keys(), ...cb.keys()])) {
    const x = ca.get(id) ?? 0, y = cb.get(id) ?? 0;
    if (x !== y) out.push(`${y > x ? '+' : '-'}${Math.abs(y - x)} ${nameOf(id)}`);
  }
  const ta = a.routeTargets.map((r) => r.kind).sort().join(', '), tb = b.routeTargets.map((r) => r.kind).sort().join(', ');
  if (ta !== tb) out.push(`Route to: ${ta || 'none'} to ${tb || 'none'}`);
  return out;
}
