import type { Vec2 } from '../../core/types';

export interface Box { x0: number; y0: number; x1: number; y1: number }

export const boxesHit = (a: Box, b: Box) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

/** Greedy collision register: `place` adds a box only if it touches nothing already placed. */
export function makePlacer() {
  const placed: Box[] = [];
  return {
    hits: (b: Box) => placed.some((q) => boxesHit(b, q)),
    add: (b: Box) => { placed.push(b); },
    place(b: Box) { if (placed.some((q) => boxesHit(b, q))) return false; placed.push(b); return true; },
  };
}

function inside(p: Vec2, poly: Vec2[]) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}
function segDist(p: Vec2, a: Vec2, b: Vec2) {
  const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

/** Point deepest inside the polygon (pole of inaccessibility, grid search with refinement) and its clearance. */
export function poleOfInaccessibility(poly: Vec2[]): { x: number; y: number; r: number } {
  const xs = poly.map((p) => p.x), ys = poly.map((p) => p.y);
  let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  let best = { x: (x0 + x1) / 2, y: (y0 + y1) / 2, r: -Infinity };
  const score = (p: Vec2) => {
    let d = Infinity;
    for (let i = 0; i < poly.length; i++) d = Math.min(d, segDist(p, poly[i], poly[(i + 1) % poly.length]));
    return inside(p, poly) ? d : -d;
  };
  for (let pass = 0; pass < 4; pass++) {
    const N = 12;
    const sx = (x1 - x0) / N, sy = (y1 - y0) / N;
    for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
      const p = { x: x0 + i * sx, y: y0 + j * sy };
      const r = score(p);
      if (r > best.r) best = { ...p, r };
    }
    x0 = best.x - sx; x1 = best.x + sx; y0 = best.y - sy; y1 = best.y + sy;
  }
  return best;
}

export interface RoomIn { id: string; name: string; polygon: Vec2[]; areaM2: number }
export interface RoomLabel { id: string; x: number; y: number; scale: number; box: Box }

/** One label per room at its visual centre, biggest first; shrunk once, else skipped, if it would not fit or would collide. */
export function placeRoomLabels(rooms: RoomIn[], fs: number, placer = makePlacer()): { labels: RoomLabel[]; placer: ReturnType<typeof makePlacer> } {
  const labels: RoomLabel[] = [];
  for (const r of [...rooms].sort((a, b) => b.areaM2 - a.areaM2)) {
    if (r.polygon.length < 3) continue;
    const c = poleOfInaccessibility(r.polygon);
    for (const scale of [1, 0.75]) {
      const f = fs * 1.2 * scale;
      const hw = Math.max(r.name.length * 0.6 * f, 4.2 * f) / 2, hh = 1.3 * f;
      const box = { x0: c.x - hw, y0: c.y - f, x1: c.x + hw, y1: c.y - f + 2 * hh };
      const corners = [{ x: box.x0, y: box.y0 }, { x: box.x1, y: box.y0 }, { x: box.x0, y: box.y1 }, { x: box.x1, y: box.y1 }];
      if (!corners.every((p) => inside(p, r.polygon))) continue;
      if (!placer.place(box)) continue;
      labels.push({ id: r.id, x: c.x, y: c.y, scale, box });
      break;
    }
  }
  return { labels, placer };
}

export const MIN_CHIP_PX = 56;

/** Axis-aligned box of a chip of size w x h centred at (x,y) rotated by `deg`. */
export function chipBox(x: number, y: number, w: number, h: number, deg: number): Box {
  const a = (deg * Math.PI) / 180, c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
  const hw = (w * c + h * s) / 2, hh = (w * s + h * c) / 2;
  return { x0: x - hw, y0: y - hh, x1: x + hw, y1: y + hh };
}

export interface ChipIn { key: string; lengthM: number; box: Box; priority?: number }

/** Keys of chips to show: long enough on screen and not touching a placed label or earlier chip. */
export function pickChips(chips: ChipIn[], pxPerM: number, placer: ReturnType<typeof makePlacer>): Set<string> {
  const show = new Set<string>();
  for (const c of [...chips].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || b.lengthM - a.lengthM)) {
    if (c.lengthM * pxPerM < MIN_CHIP_PX) continue;
    if (placer.place(c.box)) show.add(c.key);
  }
  return show;
}
