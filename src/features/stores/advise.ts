// Helps choose between listings and argue the price. The pick is decided by measured facts
// (fits a free spot in the room, passes the door, price against the budget); a fast model only
// words the reasons, and is told not to change the pick or the numbers.

import { ai, aiReady } from '../../core/ai';
import { convexOverlap, fmtCm, itemCorners, polygonInside, wallLength } from '../../core/geometry';
import type { FurnitureItem, SpaceModel, StoreListing } from '../../core/types';
import { CATALOG } from '../furniture/catalog';
import { findFreeSpot, isWallCategory } from '../objects/placement';
import { testPassage } from '../sim/passage';
import { guessCategory } from './convert';
import { fmtDims, fmtMoney, timeAgo } from './parse';

export interface AdviseContext {
  model: SpaceModel;
  /** Furniture already in the room; defaults to the model's own. */
  furniture?: FurnitureItem[];
  budgetSek?: number | null;
  /** Door the piece comes in through; defaults to the first door. */
  doorId?: string;
  /** An item this purchase would replace (left out of the fit check). */
  replaceId?: string;
  /** SEK per unit for foreign currencies. */
  rates?: Record<string, number>;
}

export type Verdict = 'yes' | 'no' | 'unknown';

export interface ListingFacts {
  index: number;
  title: string;
  priceSek: number | null;
  fitsRoom: Verdict;
  fitNote: string;
  passesDoor: Verdict;
  doorNote: string;
  overBudget: boolean | null;
  footprintM2: number | null;
  score: number;
}

export interface Comparison {
  pick: StoreListing | null;
  pickIndex: number;
  reasons: string[];
  tradeoffs: string[];
  facts: ListingFacts[];
  wordedBy: 'model' | 'rules';
}

function priceSekOf(l: StoreListing, rates: Record<string, number> = {}): number | null {
  if (l.price === null) return null;
  if (l.currency === 'SEK') return l.price;
  const r = rates[l.currency];
  return r ? Math.round(l.price * r) : null;
}

/** Does it have a free spot in the room, and come in through the door? */
export function roomFacts(l: StoreListing, ctx: AdviseContext): Pick<ListingFacts, 'fitsRoom' | 'fitNote' | 'passesDoor' | 'doorNote'> {
  const { model } = ctx;
  const s = l.stated;
  if (!s?.w || !s?.d) return { fitsRoom: 'unknown', fitNote: 'Size not stated.', passesDoor: 'unknown', doorNote: 'Size not stated.' };
  const category = guessCategory(l.title, (l as { category?: string }).category);
  const others = (ctx.furniture ?? model.furniture).filter((f) => f.id !== ctx.replaceId);
  const base = CATALOG.find((e) => e.category === category);
  const probe: FurnitureItem = {
    id: '__probe', catalogId: 'store', name: l.title, category, x: 0, y: 0, rotation: 0, w: s.w, d: s.d, h: s.h ?? 0.8,
    clearance: base ? { ...base.clearance } : { front: 0.5, back: 0, left: 0.1, right: 0.1 },
    locked: false, owned: false, priceSek: 0, priceStatus: 'catalog', color: '#999', sourceKind: 'catalog',
  };

  // Fit: a pose free of walls, other furniture and door swings.
  const pose = findFreeSpot(model, probe, others);
  const body = itemCorners({ ...probe, ...pose });
  const inside = model.spaces.some((sp) => polygonInside(body, sp.polygon));
  const clash = others.some((o) => o.category !== 'rug' && convexOverlap(body, itemCorners(o)) > 1e-3);
  let fitsRoom: Verdict = inside && !clash ? 'yes' : 'no';
  let fitNote = fitsRoom === 'yes' ? 'Has a free spot in the room.' : 'No free spot without moving other furniture.';
  if (fitsRoom === 'yes' && isWallCategory(category)) {
    const longest = Math.max(0, ...model.spaces.flatMap((sp) => sp.polygon.map((_, i) => wallLength(sp, i))));
    if (longest < s.w) { fitsRoom = 'no'; fitNote = `Wider (${fmtCm(s.w)}) than the longest wall (${fmtCm(longest)}).`; }
  }

  // Door: the existing passage check (flat carry), plus a tilt check on paper.
  const door = model.openings.find((o) => o.id === ctx.doorId) ?? model.openings.find((o) => o.kind === 'door');
  if (!door) return { fitsRoom, fitNote, passesDoor: 'unknown', doorNote: 'No door drawn.' };
  let passesDoor: Verdict = 'unknown', doorNote = '';
  try {
    const r = testPassage(model, others, { id: probe.id, name: l.title, w: s.w, d: s.d, h: s.h ?? 0.8 }, door.id, 400_000);
    passesDoor = r.ok ? 'yes' : 'no';
    doorNote = r.ok ? `Carries flat through the ${fmtCm(door.widthM)} door.` : `Does not carry flat through the ${fmtCm(door.widthM)} door.`;
  } catch { /* fall through to the paper check */ }
  if (passesDoor !== 'yes' && s.h) {
    const [a, b] = [s.w, s.d, s.h].sort((x, y) => x - y);
    if (a <= door.widthM - 0.02 && b <= door.heightM - 0.02) {
      passesDoor = 'yes';
      doorNote = `Only tilted on edge: smallest side ${fmtCm(a)} vs ${fmtCm(door.widthM)} door (not simulated).`;
    }
  }
  return { fitsRoom, fitNote, passesDoor, doorNote };
}

function factsFor(listings: StoreListing[], ctx: AdviseContext): ListingFacts[] {
  return listings.map((l, index) => {
    const priceSek = priceSekOf(l, ctx.rates);
    const room = roomFacts(l, ctx);
    const budget = ctx.budgetSek ?? null;
    const overBudget = budget && priceSek !== null ? priceSek > budget : null;
    const footprintM2 = l.stated?.w && l.stated?.d ? Math.round(l.stated.w * l.stated.d * 100) / 100 : null;
    let score = 0;
    if (room.fitsRoom === 'no') score -= 100; else if (room.fitsRoom === 'unknown') score -= 25;
    if (room.passesDoor === 'no') score -= 60; else if (room.passesDoor === 'unknown') score -= 10;
    if (/tilted/.test(room.doorNote)) score -= 5;
    if (overBudget) score -= 30 + (budget ? ((priceSek! - budget) / budget) * 40 : 0);
    if (priceSek === null) score -= 15;
    else score -= (priceSek / Math.max(budget ?? 0, ...listings.map((x) => priceSekOf(x, ctx.rates) ?? 0), 1)) * 20;
    return { index, title: l.title, priceSek, ...room, overBudget, footprintM2, score: Math.round(score * 10) / 10 };
  });
}

function rulesWording(listings: StoreListing[], facts: ListingFacts[], pick: number): { reasons: string[]; tradeoffs: string[] } {
  const p = facts[pick], l = listings[pick];
  const reasons: string[] = [];
  if (p.fitsRoom === 'yes') reasons.push(p.fitNote);
  if (p.passesDoor === 'yes') reasons.push(p.doorNote);
  if (p.priceSek !== null) {
    const cheaper = facts.filter((f) => f.priceSek !== null && f.priceSek < p.priceSek!).length;
    reasons.push(cheaper === 0 ? `Lowest price of the ones compared (${fmtMoney(l.price!, l.currency)}).` : `${fmtMoney(l.price!, l.currency)}${p.overBudget === false ? ', within budget' : ''}.`);
  }
  const tradeoffs: string[] = [];
  for (const f of facts) {
    if (f.index === pick) continue;
    const why = f.fitsRoom === 'no' ? f.fitNote : f.passesDoor === 'no' ? f.doorNote : f.overBudget ? 'Over budget.' : f.priceSek !== null && p.priceSek !== null && f.priceSek > p.priceSek ? `Costs ${Math.round(f.priceSek - p.priceSek)} kr more.` : 'Scores lower on fit and price.';
    tradeoffs.push(`${listings[f.index].title}: ${why}`);
  }
  if (p.fitsRoom !== 'yes') tradeoffs.unshift(`Even the pick: ${p.fitNote}`);
  return { reasons, tradeoffs };
}

const WORD_SCHEMA = {
  type: 'OBJECT',
  properties: { reasons: { type: 'ARRAY', items: { type: 'STRING' } }, tradeoffs: { type: 'ARRAY', items: { type: 'STRING' } } },
  required: ['reasons', 'tradeoffs'],
};

/** Picks the listing that fits best for the money and says why. */
export async function compareListings(listings: StoreListing[], context: AdviseContext): Promise<Comparison> {
  if (!listings.length) return { pick: null, pickIndex: -1, reasons: [], tradeoffs: [], facts: [], wordedBy: 'rules' };
  const facts = factsFor(listings, context);
  const pickIndex = [...facts].sort((a, b) => b.score - a.score)[0].index;
  const fallback = rulesWording(listings, facts, pickIndex);
  if (!aiReady()) return { pick: listings[pickIndex], pickIndex, ...fallback, facts, wordedBy: 'rules' };
  try {
    const table = facts.map((f) => ({
      option: f.index + 1, title: f.title, store: listings[f.index].store,
      price: listings[f.index].price === null ? 'not listed' : fmtMoney(listings[f.index].price!, listings[f.index].currency),
      size: fmtDims(listings[f.index].stated), fitsRoom: f.fitNote, door: f.doorNote, overBudget: f.overBudget,
    }));
    const r = await ai<{ reasons: string[]; tradeoffs: string[] }>({
      task: 'fast', schema: WORD_SCHEMA, temperature: 0.2,
      system: 'You explain a furniture choice that has already been made from measured facts. Do not change the choice. Use only the numbers given. Short plain sentences, no marketing. 2-4 reasons for the pick; one tradeoff per other option (what it does better or worse).',
      parts: [{ text: `Budget: ${context.budgetSek ? `${context.budgetSek} kr` : 'not set'}\nOptions: ${JSON.stringify(table)}\nChosen: option ${pickIndex + 1}.` }],
    });
    const reasons = r.data.reasons?.filter(Boolean).slice(0, 4) ?? [];
    const tradeoffs = r.data.tradeoffs?.filter(Boolean).slice(0, 6) ?? [];
    if (!reasons.length) throw new Error('empty');
    return { pick: listings[pickIndex], pickIndex, reasons, tradeoffs, facts, wordedBy: 'model' };
  } catch {
    return { pick: listings[pickIndex], pickIndex, ...fallback, facts, wordedBy: 'rules' };
  }
}

export interface NegotiationNotes { label: string; notes: string[] }

/** Honest talking points for asking a better deal. Suggestions only; nothing here is promised by the store. */
export function negotiationNotes(listing: StoreListing, others: StoreListing[] = [], rates: Record<string, number> = {}): NegotiationNotes {
  const notes: string[] = [];
  const mine = priceSekOf(listing, rates);
  const cheaper = others
    .filter((o) => o.url !== listing.url && o.price !== null)
    .map((o) => ({ o, sek: priceSekOf(o, rates) }))
    .filter((x) => x.sek !== null && mine !== null && x.sek < mine)
    .sort((a, b) => a.sek! - b.sek!)[0];
  if (cheaper) {
    notes.push(`Price match: ${cheaper.o.store} lists "${cheaper.o.title}" at ${fmtMoney(cheaper.o.price!, cheaper.o.currency)} (read ${timeAgo(cheaper.o.fetchedAt)}). If it is a comparable piece, ask whether they will match or come closer. Bring the link.`);
  }
  const chain = /ikea|jysk|mio|rusta|bauhaus|home24|wayfair|xxxlutz/i.test(listing.store);
  if (chain) {
    notes.push('Large chains rarely change the shelf price. Ask instead about display or returned units of this model (often sold at a discount), and about free delivery or assembly.');
  } else {
    notes.push('Ask for a better price if you pay in one go, or for free delivery and assembly instead of a discount.');
    notes.push('Ask whether a display (floor) model is for sale at a reduced price. Check it for marks first.');
  }
  notes.push('Buying more than one piece? Ask for a bundle price or delivery of everything for one fee.');
  notes.push('Ask whether they refund the difference if the price drops soon after you buy, and when the next sale is.');
  if (listing.price !== null) notes.push(`The ${fmtMoney(listing.price, listing.currency)} price was read ${timeAgo(listing.fetchedAt)}; check it again before you go.`);
  return { label: 'Suggestions only. The store decides; nothing here is a quote.', notes };
}
