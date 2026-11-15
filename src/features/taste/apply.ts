import type { LayoutCandidate, SpaceModel } from '../../core/types';
import type { Weights } from '../layout/solver';
import { layoutFeatures } from './features';
import type { Anchor } from './features';
import type { TasteProfile } from './profile';

export const MIN_C = 0.15; // below this a trait is a guess and is ignored; about 3 consistent actions clear it
const ANCHORS: Anchor[] = ['desk', 'bed', 'sofa'];
const lean = (r: { v: number; c: number }) => (r.c < MIN_C ? 0 : (r.v - 0.5) * 2 * r.c); // -1..1

/** Multipliers on the solver weights (1 = unchanged) and on named design rules. */
export interface TasteWeights { solver: Weights; rules: Record<string, number> }

export function tasteWeights(p: TasteProfile): TasteWeights {
  const open = lean(p.traits.open), hug = lean(p.traits.hug), spend = lean(p.traits.spend);
  const winAvg = ANCHORS.reduce((s, a) => s + lean(p.window[a]), 0) / 3;
  const m = (x: number, k = 0.6) => Math.max(0.3, 1 + x * k);
  return {
    solver: { open: m(open), window: m(winAvg * 1.5), zones: 1, cost: m(-spend, 0.8), wall: m(hug) },
    rules: {
      'open-floor': m(open), 'wall-backed': m(hug), 'desk-daylight': m(lean(p.window.desk)), 'bed-window': m(lean(p.window.bed)),
      balance: m(lean(p.traits.sym)), 'rug-anchor': p.avoid.some((a) => /rug/.test(a.cat)) ? 0.3 : 1,
    },
  };
}

/** Short lines for the planner prompt. Empty when nothing is known yet. */
export function tasteHints(p: TasteProfile): string[] {
  const h: string[] = [];
  const say = (r: { v: number; c: number }, hi: string, lo: string) => { if (r.c >= MIN_C) h.push(r.v >= 0.5 ? hi : lo); };
  say(p.traits.open, 'Keeps the floor open; fewer pieces.', 'Likes a full, furnished room.');
  say(p.traits.hug, 'Prefers furniture against walls.', 'Prefers furniture floating away from walls.');
  say(p.traits.sym, 'Likes symmetric, balanced arrangements.', 'Likes relaxed, asymmetric arrangements.');
  say(p.traits.spend, 'Spends on quality pieces.', 'Keeps costs low.');
  for (const a of ANCHORS) say(p.window[a], `Places the ${a} near the window.`, `Places the ${a} away from the window.`);
  if (p.avoid.length) h.push(`Usually removes: ${p.avoid.slice(0, 3).map((a) => a.cat).join(', ')}.`);
  if (p.materials[0]) h.push(`Prefers ${p.materials[0].name}.`);
  if (p.palette[0]) h.push(`Favourite colour ${p.palette[0].name}.`);
  return h.slice(0, 7);
}

const hexRgb = (c: string): [number, number, number] | null => {
  const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
};
const near = (a: string, b: string) => {
  const x = hexRgb(a), y = hexRgb(b);
  return x && y ? Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) < 90 : a.toLowerCase() === b.toLowerCase();
};

/** 0..1, how well one candidate fits the person. 0.5 when nothing is known. */
export function tasteScore(c: LayoutCandidate, model: SpaceModel, p: TasteProfile): number {
  const f = layoutFeatures(model, c.furniture);
  let sum = 0, w = 0;
  const fit = (feat: number, r: { v: number; c: number }) => { if (r.c >= MIN_C) { sum += r.c * (1 - Math.abs(feat - r.v)); w += r.c; } };
  fit(f.open, p.traits.open); fit(f.hug, p.traits.hug); fit(f.sym, p.traits.sym); fit(f.density, p.traits.density);
  for (const a of ANCHORS) if (f.rel[a] !== undefined) fit(f.rel[a]!, { v: 1 - p.window[a].v, c: p.window[a].c });
  for (const a of p.avoid) if (c.furniture.some((x) => x.category === a.cat)) w += Math.min(1, a.w / 3);
  else { sum += Math.min(1, a.w / 3); w += Math.min(1, a.w / 3); }
  const pal = p.palette.slice(0, 3), mats = p.materials.slice(0, 2);
  const n = Math.max(1, c.furniture.length);
  if (pal.length) { sum += 0.5 * c.furniture.filter((x) => pal.some((q) => near(q.name, x.color))).length / n; w += 0.5; }
  if (mats.length) { sum += 0.5 * c.furniture.filter((x) => x.material && mats.some((q) => q.name === x.material!.toLowerCase())).length / n; w += 0.5; }
  return w ? sum / w : 0.5;
}

/** Candidates ordered by fit; unchanged order while the profile is a guess. */
export function rankByTaste(candidates: LayoutCandidate[], p: TasteProfile, model: SpaceModel): LayoutCandidate[] {
  if (p.confidence < MIN_C) return candidates;
  return candidates
    .map((c, i) => ({ c, i, s: tasteScore(c, model, p) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.c);
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Up to 3 short chips (1 to 3 words) for the strongest things learned so far. */
export function learnedChips(p: TasteProfile): string[] {
  const out: Array<{ s: number; t: string }> = [];
  const lr = (r: { v: number; c: number }, hi: string, lo: string) => { const s = Math.abs(r.v - 0.5) * 2 * r.c; if (r.c >= MIN_C && s >= 0.1) out.push({ s, t: r.v >= 0.5 ? hi : lo }); };
  lr(p.traits.open, 'Open floor', 'Full rooms');
  lr(p.traits.hug, 'Against walls', 'Floating');
  lr(p.traits.sym, 'Symmetric', 'Relaxed layout');
  lr(p.traits.spend, 'Premium', 'Low cost');
  for (const a of ANCHORS) lr(p.window[a], `${cap(a)} by window`, `${cap(a)} away`);
  for (const a of p.avoid.slice(0, 2)) out.push({ s: 0.3 + Math.min(1, a.w / 3) * 0.7, t: `No ${a.cat.replace(/s$/, '')}s` });
  if (p.materials[0]) out.push({ s: 0.2 + Math.min(1, p.materials[0].w / 2) * 0.6, t: cap(p.materials[0].name) });
  return out.sort((a, b) => b.s - a.s).slice(0, 3).map((x) => x.t);
}
