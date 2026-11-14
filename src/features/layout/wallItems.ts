// Wall-mounted items (posters, signs, shelves, clocks): they hang flat on a wall facing the room at
// their own height, take no floor space, and keep off doors, windows and each other. Floor checks
// (overlap, clearance, routes) never see them; this placer and the referee's wall check do.
import type { FurnitureItem, Space, SpaceModel, Vec2 } from '../../core/types';
import { add, dist, mul, wallInwardNormal, wallSegment } from '../../core/geometry';

export const isMounted = (f: Pick<FurnitureItem, 'mount'>) => f.mount === 'wall' || f.mount === 'ceiling';

/** Default centre height for a wall item by what it is, metres above the floor. */
export function wallCentreHeight(f: Pick<FurnitureItem, 'category' | 'name' | 'h'>): number {
  const t = `${f.category} ${f.name}`.toLowerCase();
  if (/clock/.test(t)) return 1.8;
  if (/shelf/.test(t)) return 1.5;
  if (/banner|neon/.test(t)) return 1.65;
  if (/sign|plaque/.test(t)) return 1.55;
  return 1.4;
}

/** Underside height for a wall item: its own elevation, else the default centre height, kept under the ceiling. */
export function wallElevation(f: FurnitureItem, ceilingM: number): number {
  const want = f.elevationM ?? Math.max(0.3, wallCentreHeight(f) - f.h / 2);
  return Math.max(0, Math.min(want, ceilingM - f.h - 0.05));
}

const GAP = 0.1;
const ANCHOR = /bed|desk|sofa|cat-tree|scratch|vanity|dresser|tv|armchair|table/;

export interface WallPlacement { placed: FurnitureItem[]; skipped: FurnitureItem[] }

function roomOf(model: SpaceModel, spaceId?: string): Space | undefined {
  return (spaceId ? model.spaces.find((s) => s.id === spaceId) : undefined) ?? model.spaces.find((s) => s.polygon.length >= 3);
}

/**
 * Hang each wall item on a wall of the room. Items keep off every door and window span (with a
 * 10 cm margin) and off each other, and avoid spans hidden by tall furniture standing against the
 * wall. A poster or sign prefers the wall above the piece it belongs with (bed, desk, sofa).
 */
export function placeWallItems(model: SpaceModel, floor: FurnitureItem[], wall: FurnitureItem[], spaceId?: string): WallPlacement {
  const space = roomOf(model, spaceId);
  if (!space || !wall.length) return { placed: [], skipped: space ? [] : wall };
  const n = space.polygon.length;
  const walls = Array.from({ length: n }, (_, i) => {
    const [a, b] = wallSegment(space, i), L = dist(a, b);
    const dir: Vec2 = { x: (b.x - a.x) / (L || 1), y: (b.y - a.y) / (L || 1) }, nrm = wallInwardNormal(space, i);
    const banned: Array<[number, number, number, number]> = []; // [t0, t1, y0, y1]
    for (const o of model.openings) if (o.spaceId === space.id && o.wallIndex === i) banned.push([o.offsetM - o.widthM / 2 - GAP, o.offsetM + o.widthM / 2 + GAP, -1, 99]);
    // Furniture against this wall hides the span up to its top.
    const near: Array<{ t0: number; t1: number; h: number; f: FurnitureItem }> = [];
    for (const f of floor) {
      if (isMounted(f) || f.category === 'rug') continue;
      const c = Math.cos(f.rotation), s = Math.sin(f.rotation);
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => ({ x: f.x + (u * f.w / 2) * c - (v * f.d / 2) * s, y: f.y + (u * f.w / 2) * s + (v * f.d / 2) * c }));
      const off = Math.min(...corners.map((p) => (p.x - a.x) * nrm.x + (p.y - a.y) * nrm.y));
      if (off > 0.25) continue;
      const ts = corners.map((p) => (p.x - a.x) * dir.x + (p.y - a.y) * dir.y);
      const t0 = Math.min(...ts), t1 = Math.max(...ts);
      if (t1 < 0 || t0 > L) continue;
      near.push({ t0, t1, h: f.h, f });
      banned.push([t0 - 0.02, t1 + 0.02, -1, f.h + 0.03]);
    }
    return { i, a, L, dir, nrm, banned, near };
  });
  const placed: FurnitureItem[] = [], skipped: FurnitureItem[] = [];
  // Bigger items first: they have the fewest places to go.
  const order = [...wall].sort((p, q) => q.w - p.w);
  for (const f of order) {
    const y0 = wallElevation(f, model.ceilingM), y1 = y0 + f.h;
    let best: { score: number; w: (typeof walls)[number]; t: number } | null = null;
    const wantsAnchor = /poster|sign|picture|banner|neon|frame|print/.test(`${f.category} ${f.name}`.toLowerCase());
    for (const w of walls) {
      if (w.L < f.w + 0.1) continue;
      for (let t = f.w / 2 + 0.05; t <= w.L - f.w / 2 - 0.05 + 1e-9; t += 0.05) {
        const lo = t - f.w / 2, hi = t + f.w / 2;
        if (w.banned.some(([b0, b1, v0, v1]) => hi > b0 && lo < b1 && y1 > v0 && y0 < v1)) continue;
        let score = 0;
        // Spread out: distance to other wall items.
        for (const p of placed) score += Math.min(2, dist(p, add(w.a, mul(w.dir, t)))) * 0.4;
        const under = w.near.find((x) => t > x.t0 && t < x.t1);
        if (under && ANCHOR.test(`${under.f.category} ${under.f.name}`.toLowerCase())) score += wantsAnchor ? 3 - Math.abs(t - (under.t0 + under.t1) / 2) : 1;
        score -= Math.abs(t - w.L / 2) * 0.15;
        if (!best || score > best.score) best = { score, w, t };
      }
    }
    if (!best) { skipped.push(f); continue; }
    const { w, t } = best;
    const p = add(add(w.a, mul(w.dir, t)), mul(w.nrm, f.d / 2 + 0.002));
    const item: FurnitureItem = { ...f, x: p.x, y: p.y, rotation: Math.atan2(-w.nrm.x, w.nrm.y), elevationM: Math.round(y0 * 1000) / 1000, mount: 'wall' };
    placed.push(item);
    w.banned.push([t - f.w / 2 - GAP, t + f.w / 2 + GAP, y0 - 0.05, y1 + 0.05]);
  }
  return { placed, skipped };
}
