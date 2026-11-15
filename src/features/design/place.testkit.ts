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
