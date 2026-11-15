// Wall-mounted items (posters, signs, shelves, clocks): they hang flat on a wall facing the room at
// their own height, take no floor space, and keep off doors, windows and each other. Floor checks
// (overlap, clearance, routes) never see them; this placer and the referee's wall check do.
import type { FurnitureItem, Space, SpaceModel, Vec2 } from '../../core/types';
import { add, dist, mul, wallInwardNormal, wallSegment } from '../../core/geometry';
import { eyeCentre, fitOnWall, heroWall, pairAround } from '../themes/kits';

/** A wall piece that may carry art direction: the room's hero piece, hung first and centred on the wall facing the door. */
export type WallItem = FurnitureItem & { hero?: boolean };

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
/** Clear space between two wall items. */
const ITEM_GAP = 0.3;
/** Lowest ceiling margin: nothing hangs with its top edge higher than ceiling minus this, or 2.1 m. */
const topLimit = (ceilingM: number) => Math.min(2.1, ceilingM - 0.4);
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
  type W = (typeof walls)[number];
  const ceiling = model.ceilingM;
  const elevOf = (f: FurnitureItem) => Math.max(0, Math.min(wallElevation(f, ceiling), topLimit(ceiling) - f.h));
  const clear = (w: W, t: number, f: FurnitureItem, y0: number, gap = 0) =>
    t - f.w / 2 >= 0.05 && t + f.w / 2 <= w.L - 0.05 + 1e-9 && !w.banned.some(([b0, b1, v0, v1]) => t + f.w / 2 > b0 - gap + 1e-9 && t - f.w / 2 < b1 + gap - 1e-9 && y0 + f.h > v0 && y0 < v1);
  const commit = (f: FurnitureItem, w: W, t: number, y0: number) => {
    const p = add(add(w.a, mul(w.dir, t)), mul(w.nrm, f.d / 2 + 0.002));
    placed.push({ ...f, x: p.x, y: p.y, rotation: Math.atan2(-w.nrm.x, w.nrm.y), elevationM: Math.round(y0 * 1000) / 1000, mount: 'wall' });
    w.banned.push([t - f.w / 2 - ITEM_GAP, t + f.w / 2 + ITEM_GAP, y0 - 0.05, y0 + f.h + 0.05]);
  };

  const pool = [...wall];
  // The hero piece: centred on the wall facing the main door, at eye height, clear of openings and tall furniture.
  const hero = pool.find((f) => (f as WallItem).hero);
  let heroAt: { w: W; t: number; f: FurnitureItem } | null = null;
  if (hero) {
    pool.splice(pool.indexOf(hero), 1);
    const door = model.openings.find((o) => o.spaceId === space.id && o.kind === 'door');
    const longest = [...walls].sort((p, q) => q.L - p.L);
    const facing = door ? walls[heroWall(door.wallIndex, n)] : longest[0];
    const centre = eyeCentre(hero.elevationM !== undefined ? hero.elevationM + hero.h / 2 : 1.5);
    const y0 = Math.max(0, Math.min(centre - hero.h / 2, topLimit(ceiling) - hero.h));
    for (const w of [facing, ...longest.filter((x) => x !== facing)]) {
      if (!w || w.L < hero.w + 0.2) continue;
      const spans = w.banned.filter(([, , v0, v1]) => y0 + hero.h > v0 && y0 < v1).map(([b0, b1]) => ({ from: b0 + GAP, to: b1 - GAP, kind: 'window' as const }));
      const t = fitOnWall(w.L, hero.w, spans, w.L / 2);
      if (t !== null && clear(w, t, hero, y0)) { commit(hero, w, t, y0); heroAt = { w, t, f: hero }; break; }
    }
    if (!heroAt) pool.push(hero);
  }
  // Symmetric pairs (left and right pieces) go either side of the hero when there is room.
  if (heroAt) {
    const left = pool.find((f) => /\bleft\b/i.test(f.name)), right = pool.find((f) => /\bright\b/i.test(f.name));
    const a = heroAt;
    const y0h = placed[0].elevationM!;
    if (left && right) {
      const iw = Math.max(left.w, right.w);
      const at = pairAround(a.t, a.f.w, iw, a.w.L, ITEM_GAP);
      const mk = (f: FurnitureItem) => y0h + a.f.h / 2 - f.h / 2;
      if (at && clear(a.w, at[0], left, mk(left), -1e-6) && clear(a.w, at[1], right, mk(right), -1e-6)) {
        commit(left, a.w, at[0], mk(left)); commit(right, a.w, at[1], mk(right));
        pool.splice(pool.indexOf(left), 1); pool.splice(pool.indexOf(right), 1);
      }
    }
  }
  // Everything else spreads over the remaining walls, biggest first, with a gap between neighbours.
  const order = pool.sort((p, q) => q.w - p.w);
  for (const f of order) {
    const y0 = elevOf(f), y1 = y0 + f.h;
    let best: { score: number; w: W; t: number } | null = null;
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
    commit(f, best.w, best.t, y0);
  }
  return { placed, skipped };
}
