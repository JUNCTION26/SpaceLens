import type { Anchor } from './features';
import { anchorOf } from './features';
import type { Signal } from './signals';

export type Trait = 'open' | 'hug' | 'sym' | 'density' | 'spend';
export interface Reading { v: number; c: number } // value 0..1 and confidence 0..1
export interface TasteProfile {
  traits: Record<Trait, Reading>;
  /** 1 = this piece sits near the window, 0 = far from it. */
  window: Record<Anchor, Reading>;
  palette: Array<{ name: string; w: number }>;
  materials: Array<{ name: string; w: number }>;
  /** Categories the person keeps removing. */
  avoid: Array<{ cat: string; w: number }>;
  /** Overall evidence, 0..1. */
  confidence: number;
  events: number;
}

export const HALF_LIFE_DAYS = 21;
const DAY = 86_400_000;
const PRIOR = 0.5;
const clamp = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

class Acc {
  sum = 0; w = 0;
  add(v: number, w: number) { this.sum += clamp(v) * w; this.w += w; }
  read(): Reading { return { v: (this.sum + 0.5 * PRIOR) / (this.w + 0.5), c: 1 - Math.exp(-this.w / 2.5) }; }
}
const spendOf = (sek: number) => clamp(Math.log(Math.max(sek, 1) / 5000) / Math.log(20));

export function buildProfile(log: Signal[], now = Date.now()): TasteProfile {
  const t: Record<Trait, Acc> = { open: new Acc(), hug: new Acc(), sym: new Acc(), density: new Acc(), spend: new Acc() };
  const win: Record<Anchor, Acc> = { desk: new Acc(), bed: new Acc(), sofa: new Acc() };
  const pal = new Map<string, number>(), mat = new Map<string, number>(), net = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string, w: number) => m.set(k, (m.get(k) ?? 0) + w);

  for (const s of log) {
    const d = Math.pow(0.5, Math.max(0, now - s.t) / (HALF_LIFE_DAYS * DAY));
    switch (s.k) {
      case 'apply': case 'skip': {
        const pos = s.k === 'apply', w = (pos ? 1 : 0.35) * d, x = (v: number) => (pos ? v : 1 - v);
        t.open.add(x(s.f.open), w); t.hug.add(x(s.f.hug), w); t.sym.add(x(s.f.sym), w); t.density.add(x(s.f.density), w);
        if (pos && s.f.cost > 0) t.spend.add(spendOf(s.f.cost), 0.4 * d);
        for (const a of Object.keys(s.f.rel) as Anchor[]) win[a].add(x(1 - (s.f.rel[a] ?? 0.5)), w);
        break;
      }
      case 'move': {
        t.hug.add(1 - s.gap / 0.6, 0.8 * d);
        const a = anchorOf(s.cat);
        if (a && s.win !== null && s.winBefore !== null && Math.abs(s.win - s.winBefore) > 0.02) win[a].add(s.win < s.winBefore ? 1 : 0, 1.5 * d);
        break;
      }
      case 'remove': bump(net, s.cat, d); t.open.add(1, 0.5 * d); t.density.add(0, 0.4 * d); break;
      case 'add': bump(net, s.cat, -d); t.open.add(0, 0.5 * d); t.density.add(1, 0.4 * d); break;
      case 'color': bump(pal, s.v.toLowerCase(), d); break;
      case 'material': bump(mat, s.v.toLowerCase(), d); break;
      case 'custom': bump(pal, s.color.toLowerCase(), 0.5 * d); if (s.material) bump(mat, s.material.toLowerCase(), 0.5 * d); break;
      case 'budget': t.spend.add(spendOf(s.sek), 1.2 * d); break;
      case 'clear': break;
    }
  }
  const top = (m: Map<string, number>) => [...m].map(([name, w]) => ({ name, w })).sort((a, b) => b.w - a.w).slice(0, 5);
  const traits = Object.fromEntries(Object.entries(t).map(([k, a]) => [k, a.read()])) as Record<Trait, Reading>;
  const window = Object.fromEntries(Object.entries(win).map(([k, a]) => [k, a.read()])) as Record<Anchor, Reading>;
  const confidence = Math.max(...Object.values(traits).map((r) => r.c), ...Object.values(window).map((r) => r.c));
  return {
    traits, window, palette: top(pal), materials: top(mat), confidence, events: log.length,
    avoid: [...net].filter(([, w]) => w >= 1.5).map(([cat, w]) => ({ cat, w })).sort((a, b) => b.w - a.w),
  };
}
