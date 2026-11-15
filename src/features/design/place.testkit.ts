// Geometry helpers for layout scenario tests. A piece's front is its local +y, turned by `rotation`.
import type { FurnitureItem, SpaceModel } from '../../core/types';

type P = { x: number; y: number };
const corners = (f: FurnitureItem): P[] => {
  const c = Math.cos(f.rotation), s = Math.sin(f.rotation);
  return ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([a, b]) => {
    const lx = (a * f.w) / 2, ly = (b * f.d) / 2;
    return { x: f.x + lx * c - ly * s, y: f.y + lx * s + ly * c };
  });
};
const segDist = (p: P, a: P, b: P) => {
  const ab = { x: b.x - a.x, y: b.y - a.y }, l2 = ab.x * ab.x + ab.y * ab.y;
  const u = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / l2)) : 0;
  return Math.hypot(p.x - a.x - ab.x * u, p.y - a.y - ab.y * u);
};
const inside = (p: P, poly: P[]) => {
  let r = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) r = !r;
  }
  return r;
};

/** Shortest gap between two footprints (0 when they touch or overlap). */
export function gapBetween(a: FurnitureItem, b: FurnitureItem): number {
  const A = corners(a), B = corners(b);
  if (A.some((p) => inside(p, B)) || B.some((p) => inside(p, A))) return 0;
  let m = Infinity;
  for (let i = 0; i < 4; i++) for (const p of B) m = Math.min(m, segDist(p, A[i], A[(i + 1) % 4]));
  for (let i = 0; i < 4; i++) for (const p of A) m = Math.min(m, segDist(p, B[i], B[(i + 1) % 4]));
  return m;
}

/** Position of `other` along `host`'s width axis (negative = host's left). */
export function localX(host: FurnitureItem, other: FurnitureItem): number {
  return (other.x - host.x) * Math.cos(host.rotation) + (other.y - host.y) * Math.sin(host.rotation);
}
/** Position of `other` along `host`'s depth axis (positive = in front). */
export function localY(host: FurnitureItem, other: FurnitureItem): number {
  return -(other.x - host.x) * Math.sin(host.rotation) + (other.y - host.y) * Math.cos(host.rotation);
}

/** Angle (radians) between the way `seat` faces and the direction to `target`'s centre. */
export function facingErr(seat: FurnitureItem, target: FurnitureItem): number {
  const fx = -Math.sin(seat.rotation), fy = Math.cos(seat.rotation);
  const dx = target.x - seat.x, dy = target.y - seat.y, l = Math.hypot(dx, dy) || 1;
  return Math.acos(Math.max(-1, Math.min(1, (fx * dx + fy * dy) / l)));
}

/** Angle (radians) between the way `seat` faces and the direction to the nearest point of `target`'s footprint. */
export function facingErrRect(seat: FurnitureItem, target: FurnitureItem): number {
  const T = corners(target), p = { x: seat.x, y: seat.y };
  let best = T[0], bd = Infinity;
  for (let i = 0; i < 4; i++) {
    const a = T[i], b = T[(i + 1) % 4], ab = { x: b.x - a.x, y: b.y - a.y }, l2 = ab.x * ab.x + ab.y * ab.y;
    const u = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / l2)) : 0;
    const q = { x: a.x + ab.x * u, y: a.y + ab.y * u }, d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < bd) { bd = d; best = q; }
  }
  const fx = -Math.sin(seat.rotation), fy = Math.cos(seat.rotation);
  const dx = best.x - p.x, dy = best.y - p.y, l = Math.hypot(dx, dy) || 1;
  return Math.acos(Math.max(-1, Math.min(1, (fx * dx + fy * dy) / l)));
}

/** Clear gap between `host`'s front edge and `other`'s nearest edge, along the host's depth axis. */
export function frontGap(host: FurnitureItem, other: FurnitureItem): number {
  const ly = localY(host, other);
  const ext = corners(other).map((p) => -(p.x - host.x) * Math.sin(host.rotation) + (p.y - host.y) * Math.cos(host.rotation));
  void ly;
  return Math.min(...ext) - host.d / 2;
}

/** Index of the wall the piece's back rests on (within 5 cm, facing into the room), or -1. */
export function backWall(m: SpaceModel, f: FurnitureItem, tol = 0.05): number {
  const poly = m.spaces[0].polygon;
  const s = Math.sin(f.rotation), c = Math.cos(f.rotation);
  const back = { x: f.x + (s * f.d) / 2, y: f.y - (c * f.d) / 2 };
  let best = -1, bd = tol;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const d = segDist(back, a, b);
    // The piece's back direction must be across the wall, not along it.
    const ex = b.x - a.x, ey = b.y - a.y, el = Math.hypot(ex, ey);
    const along = Math.abs((s * ex - c * ey) / el);
    if (d <= bd && along < 0.2) { bd = d; best = i; }
  }
  return best;
}

/** Like backWall, but against every room of a building: true when the piece's back rests on any wall. */
export function backToAnyWall(m: SpaceModel, f: FurnitureItem, tol = 0.08): boolean {
  return m.spaces.some((sp) => backWall({ ...m, spaces: [sp] }, f, tol) >= 0);
}

const DEG20 = (20 * Math.PI) / 180;
const SEAT = /^(chair|desk-chair|office-chair|stool|dining-chair|bar-stool)$/;
const HOST = /desk|table|counter|bar|vanity/;
/** Task seats: chairs and stools that belong to a desk or table (armchairs and sofas are not counted). */
export const isTaskSeat = (f: FurnitureItem) => (SEAT.test(f.category) || SEAT.test(f.catalogId ?? '')) && !/pouf|step-stool|clinic-stool/.test(f.catalogId ?? '');
/** Pieces a task seat can belong to. */
export const isSeatHost = (f: FurnitureItem) => (HOST.test(f.category) || HOST.test(f.catalogId ?? '')) && !/coffee|side|bedside|night|dressing/.test(`${f.category} ${f.catalogId}`);

/**
 * Chairs that are neither at a desk or table (within `gapM`, facing it within 20 degrees) nor
 * standing with their back to a wall. Each entry says what the nearest host was and why it failed.
 */
export function looseChairs(m: SpaceModel, list: FurnitureItem[], gapM = 0.7): string[] {
  const hosts = list.filter(isSeatHost);
  const out: string[] = [];
  for (const c of list.filter(isTaskSeat)) {
    const ok = hosts.some((h) => gapBetween(c, h) < gapM && facingErrRect(c, h) < DEG20);
    if (ok || backToAnyWall(m, c)) continue;
    const h = hosts.slice().sort((a, b) => gapBetween(c, a) - gapBetween(c, b))[0];
    out.push(h
      ? `${c.id} (${c.category}) at ${c.x.toFixed(2)},${c.y.toFixed(2)}: nearest ${h.category} ${gapBetween(c, h).toFixed(2)} m away, facing off by ${Math.round((facingErrRect(c, h) * 180) / Math.PI)} deg`
      : `${c.id} (${c.category}) at ${c.x.toFixed(2)},${c.y.toFixed(2)}: no desk or table, back not to a wall`);
  }
  return out;
}
