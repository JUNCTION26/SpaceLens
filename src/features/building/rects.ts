// Axis-aligned rectangle helpers shared by the planner and the model assembler.
import type { Vec2 } from '../../core/types';

export interface Rect { x0: number; y0: number; x1: number; y1: number }

export const GRID = 0.05;
export const snap = (x: number, g = GRID) => Math.round(x / g) * g;
export const r2 = (x: number) => Math.round(x * 1000) / 1000;

export const rw = (r: Rect) => r.x1 - r.x0;
export const rh = (r: Rect) => r.y1 - r.y0;
export const rArea = (r: Rect) => Math.max(0, rw(r)) * Math.max(0, rh(r));
export const rShort = (r: Rect) => Math.min(rw(r), rh(r));
export const rLong = (r: Rect) => Math.max(rw(r), rh(r));
export const rCentre = (r: Rect): Vec2 => ({ x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2 });
export const rect = (x0: number, y0: number, x1: number, y1: number): Rect => ({ x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) });
export const rectPoly = (r: Rect): Vec2[] => [{ x: r.x0, y: r.y0 }, { x: r.x1, y: r.y0 }, { x: r.x1, y: r.y1 }, { x: r.x0, y: r.y1 }];

/** A wall line shared by two rectangles: horizontal (constant y) or vertical (constant x). */
export interface Seg { a: Vec2; b: Vec2; horizontal: boolean }
export const segLen = (s: Seg) => Math.abs(s.horizontal ? s.b.x - s.a.x : s.b.y - s.a.y);

const TOL = 1e-6;

/** Segments where the boundaries of two non-overlapping rectangles touch (length > minLen). */
export function touching(p: Rect, q: Rect, minLen = 1e-3): Seg[] {
  const out: Seg[] = [];
  const ox0 = Math.max(p.x0, q.x0), ox1 = Math.min(p.x1, q.x1);
  const oy0 = Math.max(p.y0, q.y0), oy1 = Math.min(p.y1, q.y1);
  if (ox1 - ox0 > minLen && (Math.abs(p.y1 - q.y0) < TOL || Math.abs(p.y0 - q.y1) < TOL)) {
    const y = Math.abs(p.y1 - q.y0) < TOL ? p.y1 : p.y0;
    out.push({ a: { x: ox0, y }, b: { x: ox1, y }, horizontal: true });
  }
  if (oy1 - oy0 > minLen && (Math.abs(p.x1 - q.x0) < TOL || Math.abs(p.x0 - q.x1) < TOL)) {
    const x = Math.abs(p.x1 - q.x0) < TOL ? p.x1 : p.x0;
    out.push({ a: { x, y: oy0 }, b: { x, y: oy1 }, horizontal: false });
  }
  return out;
}

/** Merge collinear, overlapping or touching segments. */
export function mergeSegs(segs: Seg[]): Seg[] {
  const keyed = new Map<string, Seg[]>();
  for (const s of segs) {
    const k = s.horizontal ? `h${r2(s.a.y)}` : `v${r2(s.a.x)}`;
    (keyed.get(k) ?? keyed.set(k, []).get(k)!).push(s);
  }
  const out: Seg[] = [];
  for (const list of keyed.values()) {
    const h = list[0].horizontal;
    const iv = list.map((s) => (h ? [Math.min(s.a.x, s.b.x), Math.max(s.a.x, s.b.x)] : [Math.min(s.a.y, s.b.y), Math.max(s.a.y, s.b.y)])).sort((a, b) => a[0] - b[0]);
    let [c0, c1] = iv[0];
    const flush = () => out.push(h ? { a: { x: c0, y: list[0].a.y }, b: { x: c1, y: list[0].a.y }, horizontal: true } : { a: { x: list[0].a.x, y: c0 }, b: { x: list[0].a.x, y: c1 }, horizontal: false });
    for (let i = 1; i < iv.length; i++) {
      if (iv[i][0] <= c1 + TOL) c1 = Math.max(c1, iv[i][1]);
      else { flush(); [c0, c1] = iv[i]; }
    }
    flush();
  }
  return out;
}

/** Outline of a union of rectangles as a clockwise-on-screen polygon (largest loop if several). */
export function unionOutline(rects: Rect[]): Vec2[] {
  const rs = rects.filter((r) => rArea(r) > 1e-6);
  if (!rs.length) return [];
  if (rs.length === 1) return rectPoly(rs[0]);
  const xs = [...new Set(rs.flatMap((r) => [r2(r.x0), r2(r.x1)]))].sort((a, b) => a - b);
  const ys = [...new Set(rs.flatMap((r) => [r2(r.y0), r2(r.y1)]))].sort((a, b) => a - b);
  const C = xs.length - 1, Rn = ys.length - 1;
  const fill = new Uint8Array(C * Rn);
  for (let j = 0; j < Rn; j++) for (let i = 0; i < C; i++) {
    const cx = (xs[i] + xs[i + 1]) / 2, cy = (ys[j] + ys[j + 1]) / 2;
    if (rs.some((r) => cx > r.x0 && cx < r.x1 && cy > r.y0 && cy < r.y1)) fill[j * C + i] = 1;
  }
  const on = (i: number, j: number) => i >= 0 && j >= 0 && i < C && j < Rn && fill[j * C + i] === 1;
  const edges = new Map<string, Array<[number, number]>>();
  const push = (ax: number, ay: number, bx: number, by: number) => { const k = `${ax},${ay}`; (edges.get(k) ?? edges.set(k, []).get(k)!).push([bx, by]); };
  for (let j = 0; j < Rn; j++) for (let i = 0; i < C; i++) {
    if (!on(i, j)) continue;
    if (!on(i, j - 1)) push(i, j, i + 1, j);
    if (!on(i + 1, j)) push(i + 1, j, i + 1, j + 1);
    if (!on(i, j + 1)) push(i + 1, j + 1, i, j + 1);
    if (!on(i - 1, j)) push(i, j + 1, i, j);
  }
  const loops: Array<Array<[number, number]>> = [];
  while (edges.size) {
    const startKey = edges.keys().next().value as string;
    const [sx, sy] = startKey.split(',').map(Number);
    const loop: Array<[number, number]> = [[sx, sy]];
    let cur: [number, number] = [sx, sy];
    for (let guard = 0; guard < 10000; guard++) {
      const k = `${cur[0]},${cur[1]}`;
      const outs = edges.get(k);
      if (!outs?.length) break;
      const nxt = outs.shift()!;
      if (!outs.length) edges.delete(k);
      if (nxt[0] === sx && nxt[1] === sy) break;
      loop.push(nxt); cur = nxt;
    }
    loops.push(loop);
  }
  const toPoly = (l: Array<[number, number]>) => l.map(([i, j]) => ({ x: xs[i], y: ys[j] }));
  const polyArea = (p: Vec2[]) => { let s = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a.x * b.y - b.x * a.y; } return s / 2; };
  let best = toPoly(loops[0]), ba = polyArea(best);
  for (const l of loops.slice(1)) { const p = toPoly(l), a = polyArea(p); if (a > ba) { best = p; ba = a; } }
  return dropCollinear(best);
}

export function dropCollinear(poly: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[(i - 1 + n) % n], b = poly[i], c = poly[(i + 1) % n];
    const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cr) > 1e-9) out.push(b);
  }
  return out;
}

/**
 * Decompose a rectilinear polygon into rectangles by slabs along x (or y), merging neighbouring
 * slabs that cover the same span.
 */
export function decompose(poly: Vec2[], along: 'x' | 'y'): Rect[] {
  const xs = [...new Set(poly.map((p) => r2(p.x)))].sort((a, b) => a - b);
  const ys = [...new Set(poly.map((p) => r2(p.y)))].sort((a, b) => a - b);
  const inside = (x: number, y: number) => {
    let ins = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) ins = !ins;
    }
    return ins;
  };
  const prim = along === 'x' ? xs : ys, sec = along === 'x' ? ys : xs;
  type Slab = { p0: number; p1: number; spans: Array<[number, number]> };
  const slabs: Slab[] = [];
  for (let i = 0; i < prim.length - 1; i++) {
    const pm = (prim[i] + prim[i + 1]) / 2;
    const spans: Array<[number, number]> = [];
    let open: number | null = null;
    for (let j = 0; j < sec.length - 1; j++) {
      const sm = (sec[j] + sec[j + 1]) / 2;
      const ins = along === 'x' ? inside(pm, sm) : inside(sm, pm);
      if (ins && open == null) open = sec[j];
      if (!ins && open != null) { spans.push([open, sec[j]]); open = null; }
    }
    if (open != null) spans.push([open, sec[sec.length - 1]]);
    slabs.push({ p0: prim[i], p1: prim[i + 1], spans });
  }
  const out: Rect[] = [];
  const active = new Map<string, Rect>();
  for (const s of slabs) {
    const keys = new Set(s.spans.map(([a, b]) => `${a},${b}`));
    for (const [k, r] of [...active]) if (!keys.has(k)) { out.push(r); active.delete(k); }
    for (const [a, b] of s.spans) {
      const k = `${a},${b}`;
      const r = active.get(k);
      if (r) { if (along === 'x') r.x1 = s.p1; else r.y1 = s.p1; }
      else active.set(k, along === 'x' ? { x0: s.p0, x1: s.p1, y0: a, y1: b } : { y0: s.p0, y1: s.p1, x0: a, x1: b });
    }
  }
  out.push(...active.values());
  return out;
}
