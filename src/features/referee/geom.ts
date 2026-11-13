// Minimal geometry owned by the referee. Deliberately independent of src/core/geometry.ts.
export interface P { x: number; y: number }
/** Oriented rectangle: centre, half extents along local x / y, rotation (radians). */
export interface ORect { cx: number; cy: number; hw: number; hd: number; rot: number }

export const sub = (a: P, b: P): P => ({ x: a.x - b.x, y: a.y - b.y });
export const dot = (a: P, b: P) => a.x * b.x + a.y * b.y;
export const len = (a: P) => Math.hypot(a.x, a.y);
export const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y);

/** Local (x, y) relative to the rect centre -> plan. */
export function toPlan(r: ORect, lx: number, ly: number): P {
  const c = Math.cos(r.rot), s = Math.sin(r.rot);
  return { x: r.cx + lx * c - ly * s, y: r.cy + lx * s + ly * c };
}
export function toLocal(r: ORect, p: P): P {
  const c = Math.cos(r.rot), s = Math.sin(r.rot);
  const dx = p.x - r.cx, dy = p.y - r.cy;
  return { x: dx * c + dy * s, y: -dx * s + dy * c };
}
export function corners(r: ORect): P[] {
  return [toPlan(r, -r.hw, -r.hd), toPlan(r, r.hw, -r.hd), toPlan(r, r.hw, r.hd), toPlan(r, -r.hw, r.hd)];
}

/** SAT: minimum penetration depth (>0 means overlapping, <=0 separated). */
export function overlapDepth(a: ORect, b: ORect): number {
  const ca = corners(a), cb = corners(b);
  let min = Infinity;
  for (const r of [a, b]) {
    for (const ang of [r.rot, r.rot + Math.PI / 2]) {
      const ax = { x: Math.cos(ang), y: Math.sin(ang) };
      const pa = ca.map((p) => dot(p, ax)), pb = cb.map((p) => dot(p, ax));
      const o = Math.min(Math.max(...pa), Math.max(...pb)) - Math.max(Math.min(...pa), Math.min(...pb));
      if (o < min) min = o;
    }
  }
  return min;
}

export function signedArea(poly: P[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; s += a.x * b.y - b.x * a.y; }
  return s / 2;
}

export function pointInPolygon(p: P, poly: P[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function distPointSeg(p: P, a: P, b: P): number {
  const ab = sub(b, a), l2 = dot(ab, ab);
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
  return dist(p, { x: a.x + ab.x * t, y: a.y + ab.y * t });
}
export function distToBoundary(p: P, poly: P[]): number {
  let m = Infinity;
  for (let i = 0; i < poly.length; i++) m = Math.min(m, distPointSeg(p, poly[i], poly[(i + 1) % poly.length]));
  return m;
}
/** Distance from a point to a rect (0 if inside). */
export function distPointRect(p: P, r: ORect): number {
  const l = toLocal(r, p);
  const dx = Math.max(0, Math.abs(l.x) - r.hw), dy = Math.max(0, Math.abs(l.y) - r.hd);
  return Math.hypot(dx, dy);
}

const cross = (o: P, a: P, b: P) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
/** Proper or touching intersection of segments ab and cd. */
export function segmentsIntersect(a: P, b: P, c: P, d: P): boolean {
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const on = (p: P, q: P, r: P) => Math.abs(cross(p, q, r)) < 1e-12 && Math.min(p.x, q.x) - 1e-12 <= r.x && r.x <= Math.max(p.x, q.x) + 1e-12 && Math.min(p.y, q.y) - 1e-12 <= r.y && r.y <= Math.max(p.y, q.y) + 1e-12;
  return on(c, d, a) || on(c, d, b) || on(a, b, c) || on(a, b, d);
}

export function isSimplePolygon(poly: P[]): boolean {
  const n = poly.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (j === i + 1 || (i === 0 && j === n - 1)) continue;
    if (segmentsIntersect(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n])) return false;
  }
  return true;
}

/** How far (m) the rect pokes outside the polygon: max corner distance outside, plus edge crossings via vertices inside the rect. */
export function rectOutside(r: ORect, poly: P[]): number {
  let out = 0;
  for (const c of corners(r)) if (!pointInPolygon(c, poly)) out = Math.max(out, distToBoundary(c, poly));
  // A reflex vertex poking into the rect means part of the rect is outside (L-shaped notch).
  for (const v of poly) {
    const l = toLocal(r, v);
    const pen = Math.min(r.hw - Math.abs(l.x), r.hd - Math.abs(l.y));
    if (pen > 0) out = Math.max(out, pen);
  }
  return out;
}
