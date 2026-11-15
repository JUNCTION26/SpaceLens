// The largest box a replacement for an item could fill where the item stands, without leaving
// the room or running into a neighbour. Pure geometry in the item's own frame: for each of its
// four sides, how far is it to the nearest wall or neighbouring item across the item's span.

import type { FurnitureItem, Space, SpaceModel, Vec2 } from '../../core/types';

export interface FitWindow {
  /** Metres. Width runs across the item's front, depth front to back. */
  w: number; d: number; h: number;
  /** Free gap past each side of the current footprint, metres. */
  gap: { left: number; right: number; front: number; back: number };
}

type Seg = [Vec2, Vec2];

const polySegs = (p: Vec2[]): Seg[] => p.map((a, i) => [a, p[(i + 1) % p.length]] as Seg);

function itemRect(it: FurnitureItem): Vec2[] {
  const c = Math.cos(it.rotation), s = Math.sin(it.rotation);
  return ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([a, b]) => {
    const lx = (a * it.w) / 2, ly = (b * it.d) / 2;
    return { x: it.x + lx * c - ly * s, y: it.y + lx * s + ly * c };
  });
}

/** Distance from the +x edge (at `half`) to the nearest segment inside the band |y| < lat. */
function gapAlongX(segs: Seg[], half: number, lat: number): number {
  let best = Infinity;
  const eps = 1e-6;
  for (const [a, b] of segs) {
    // Clip the segment to the band -lat < y < lat.
    let t0 = 0, t1 = 1;
    const dy = b.y - a.y;
    if (Math.abs(dy) < 1e-12) { if (Math.abs(a.y) >= lat - eps) continue; }
    else {
      const ta = (-lat + eps - a.y) / dy, tb = (lat - eps - a.y) / dy;
      t0 = Math.max(t0, Math.min(ta, tb)); t1 = Math.min(t1, Math.max(ta, tb));
      if (t0 > t1) continue;
    }
    const x0 = a.x + (b.x - a.x) * t0, x1 = a.x + (b.x - a.x) * t1;
    if (Math.max(x0, x1) <= half + eps) continue; // behind or beside this side
    best = Math.min(best, Math.max(half, Math.min(x0, x1)));
  }
  return best === Infinity ? 0 : best - half;
}

export function fitWindow(item: FurnitureItem, model: Pick<SpaceModel, 'spaces' | 'furniture' | 'ceilingM'>): FitWindow {
  // The room it stands in: the one containing its centre, else the first.
  const inside = (p: Vec2, poly: Vec2[]): boolean => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      if ((poly[i].y > p.y) !== (poly[j].y > p.y) && p.x < ((poly[j].x - poly[i].x) * (p.y - poly[i].y)) / (poly[j].y - poly[i].y) + poly[i].x) c = !c;
    }
    return c;
  };
  const space: Space | undefined = model.spaces.find((s) => inside({ x: item.x, y: item.y }, s.polygon)) ?? model.spaces[0];
  const world: Seg[] = space ? polySegs(space.polygon) : [];
  const top = (item.elevationM ?? 0) + item.h;
  for (const o of model.furniture) {
    if (o.id === item.id || o.mount === 'wall' || o.mount === 'ceiling') continue;
    if ((o.elevationM ?? 0) >= top) continue; // hangs above the item
    world.push(...polySegs(itemRect(o)));
  }
  // To the item's frame (rotation undone, centre at origin).
  const c = Math.cos(-item.rotation), s = Math.sin(-item.rotation);
  const local: Seg[] = world.map(([a, b]) => {
    const f = (p: Vec2): Vec2 => ({ x: (p.x - item.x) * c - (p.y - item.y) * s, y: (p.x - item.x) * s + (p.y - item.y) * c });
    return [f(a), f(b)];
  });
  // Turn the frame so each side in turn faces +x.
  const turned = (k: number): Seg[] => {
    const cc = Math.cos((k * Math.PI) / 2), ss = Math.sin((k * Math.PI) / 2);
    const g = (p: Vec2): Vec2 => ({ x: p.x * cc + p.y * ss, y: -p.x * ss + p.y * cc });
    return local.map(([a, b]) => [g(a), g(b)] as Seg);
  };
  const hw = item.w / 2, hd = item.d / 2;
  const gap = {
    right: gapAlongX(turned(0), hw, hd),
    front: gapAlongX(turned(1), hd, hw), // +y
    left: gapAlongX(turned(2), hw, hd),
    back: gapAlongX(turned(3), hd, hw),
  };
  const cl = item.clearance;
  // Space the item already keeps clear for use is not given away.
  const grow = (g: number, keep: number): number => Math.max(0, g - Math.max(0, keep));
  const w = item.w + grow(gap.left, cl.left) + grow(gap.right, cl.right);
  const d = item.d + grow(gap.front, cl.front) + grow(gap.back, cl.back);
  const h = Math.max(item.h, model.ceilingM - (item.elevationM ?? 0));
  return { w: round(w), d: round(d), h: round(Math.min(h, model.ceilingM)), gap };
}

const round = (v: number): number => Math.round(v * 1000) / 1000;

/** True when a stated size (metres, any part may be missing) fits the window. All three must be stated. */
export function fitsWindow(stated: { w?: number; d?: number; h?: number } | undefined, win: Pick<FitWindow, 'w' | 'd' | 'h'>): boolean {
  if (!stated || stated.w === undefined || stated.d === undefined || stated.h === undefined) return false;
  const tol = 0.005;
  return stated.w <= win.w + tol && stated.d <= win.d + tol && stated.h <= win.h + tol;
}
