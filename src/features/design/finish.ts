// Finishing pass: runs on a complete, solved layout and makes it look styled. It squares pieces up
// to the walls, closes small wall gaps, evens the nightstand gaps, centres a bed or sofa on its wall,
// then dresses the room with rugs, lamps and a plant from the catalogue. Every change is checked by
// the referee and kept only when it adds no failure the layout did not already have. Locked pieces
// never move, and the main pieces keep their wall and facing: only small finishing nudges.
import type { FurnitureItem, LayoutCandidate, Requirements, Space, SpaceModel, ValidationResult } from '../../core/types';
import { makeItem } from '../furniture/catalog';
import { overlapDepth, signedArea, type ORect, type P } from '../referee/geom';
import { pairSeats, validateLayout } from '../referee/validate';

export interface FinishOptions { req?: Requirements | null; spaceId?: string }
export interface FinishResult { furniture: FurnitureItem[]; added: string[]; adjusted: string[] }

const GAP = 0.005; // snapped wall gap, inside the referee's 1 cm tolerance
const SNAP = 0.15; // pieces this close to a wall are pulled to it
const SQUARE = (3 * Math.PI) / 180; // pieces this close to square are squared up
const HALF_PI = Math.PI / 2;

interface Wall { a: P; t: P; n: P; L: number; angle: number }
function wallsOf(space: Space): Wall[] {
  const p = space.polygon, sgn = signedArea(p) >= 0 ? 1 : -1;
  return p.map((a, i) => {
    const b = p[(i + 1) % p.length], L = Math.hypot(b.x - a.x, b.y - a.y) || 1e-9;
    const t = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
    return { a, t, n: { x: -t.y * sgn, y: t.x * sgn }, L, angle: Math.atan2(t.y, t.x) };
  });
}

const rectOf = (f: FurnitureItem): ORect => ({ cx: f.x, cy: f.y, hw: f.w / 2, hd: f.d / 2, rot: f.rotation });
const cornersOf = (f: FurnitureItem): P[] => {
  const c = Math.cos(f.rotation), s = Math.sin(f.rotation);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => {
    const lx = (u * f.w) / 2, ly = (v * f.d) / 2;
    return { x: f.x + lx * c - ly * s, y: f.y + lx * s + ly * c };
  });
};
/** Plan point of a local offset in `f`'s frame (front is local +y). */
const toPlan = (f: Pick<FurnitureItem, 'x' | 'y' | 'rotation'>, lx: number, ly: number): P => {
  const c = Math.cos(f.rotation), s = Math.sin(f.rotation);
  return { x: f.x + lx * c - ly * s, y: f.y + lx * s + ly * c };
};
const local = (f: Pick<FurnitureItem, 'x' | 'y' | 'rotation'>, p: P): P => {
  const c = Math.cos(f.rotation), s = Math.sin(f.rotation), dx = p.x - f.x, dy = p.y - f.y;
  return { x: dx * c + dy * s, y: -dx * s + dy * c };
};
/** Signed angle in [-PI/4, PI/4) between `a` and the nearest quarter turn of `b`. */
const quarterDiff = (a: number, b: number) => { let d = (a - b) % HALF_PI; if (d < -Math.PI / 4) d += HALF_PI; if (d >= Math.PI / 4) d -= HALF_PI; return d; };

const isRug = (f: FurnitureItem) => f.category === 'rug';
const isHung = (f: FurnitureItem) => f.mount === 'wall' || f.mount === 'ceiling';
const onSurface = (f: FurnitureItem) => !isHung(f) && (f.elevationM ?? 0) > 0.3;
const onFloor = (f: FurnitureItem) => !isRug(f) && !isHung(f) && !onSurface(f);
const isSofa = (f: FurnitureItem) => f.category === 'sofa' || f.category === 'sofa-bed';
const isBed = (f: FurnitureItem) => f.category === 'bed';

/** Gap from `f`'s footprint to a wall it runs parallel to and alongside, else null. */
function wallGap(f: FurnitureItem, w: Wall): number | null {
  if (Math.abs(quarterDiff(f.rotation, w.angle)) > 1e-4) return null;
  const cs = cornersOf(f).map((p) => ({ d: (p.x - w.a.x) * w.n.x + (p.y - w.a.y) * w.n.y, s: (p.x - w.a.x) * w.t.x + (p.y - w.a.y) * w.t.y }));
  const s0 = Math.min(...cs.map((c) => c.s)), s1 = Math.max(...cs.map((c) => c.s));
  if (s1 < 0.05 || s0 > w.L - 0.05) return null;
  return Math.min(...cs.map((c) => c.d));
}

/** Gaps between floor pieces and the walls they run along (exported for tests and checks). */
export function wallGaps(model: SpaceModel, furniture: FurnitureItem[], spaceId?: string): Array<{ id: string; wall: number; gap: number }> {
  const space = spaceId ? model.spaces.find((s) => s.id === spaceId) : model.spaces[0];
  if (!space || space.polygon.length < 3) return [];
  const walls = wallsOf(space), out: Array<{ id: string; wall: number; gap: number }> = [];
  for (const f of furniture.filter(onFloor)) walls.forEach((w, i) => { const g = wallGap(f, w); if (g != null && g > -0.02 && g < 0.6) out.push({ id: f.id, wall: i, gap: g }); });
  return out;
}

const failKey = (r: ValidationResult) => `${r.id}|${[...r.subjectIds].sort().join(',')}`;

export function finishLayout(model: SpaceModel, input: FurnitureItem[], opts: FinishOptions = {}): FinishResult {
  const space = opts.spaceId ? model.spaces.find((s) => s.id === opts.spaceId) : model.spaces[0];
  if (!space || space.polygon.length < 3 || !input.length) return { furniture: input, added: [], adjusted: [] };
  const req = opts.req ?? null, vopts = model.spaces.length > 1 ? { spaceId: space.id } : {};
  const walls = wallsOf(space), doors = model.openings.filter((o) => o.spaceId === space.id && o.kind === 'door');
  const windows = model.openings.filter((o) => o.spaceId === space.id && o.kind === 'window');
  const fails = (fs: FurnitureItem[]) => new Set(validateLayout(model, fs, req, vopts).filter((r) => r.result === 'fail').map(failKey));
  const allowed = fails(input);
  const ok = (fs: FurnitureItem[]) => { for (const k of fails(fs)) if (!allowed.has(k)) return false; return true; };

  let cur = input.map((f) => ({ ...f }));
  const added: string[] = [], adjusted = new Set<string>();
  const byId = (id: string) => cur.find((f) => f.id === id);

  /** Pieces that travel with `f`: its seats and anything standing on its top. */
  const riders = (f: FurnitureItem, fs: FurnitureItem[]): FurnitureItem[] => {
    const seats = pairSeats(fs.filter(onFloor));
    return fs.filter((g) => g.id !== f.id && (seats.get(g.id) === f.id || (onSurface(g) && overlapDepth(rectOf(g), rectOf(f)) > 0.01)));
  };
  /** A copy of `fs` with each id in `moves` shifted by its delta, riders included. */
  const shifted = (fs: FurnitureItem[], moves: Map<string, P>): FurnitureItem[] => {
    const delta = new Map<string, P>();
    for (const [id, d] of moves) {
      const f = fs.find((x) => x.id === id);
      if (!f) continue;
      delta.set(id, d);
      for (const r of riders(f, fs)) if (!moves.has(r.id)) delta.set(r.id, d);
    }
    return fs.map((f) => { const d = delta.get(f.id); return d ? { ...f, x: f.x + d.x, y: f.y + d.y } : f; });
  };
  const tryApply = (next: FurnitureItem[], ids: string[]) => { if (ok(next)) { cur = next; ids.forEach((id) => adjusted.add(id)); return true; } return false; };
  const movable = (f: FurnitureItem) => onFloor(f) && !f.locked;

  // 1. Square up pieces that sit within 3 degrees of their nearest wall.
  {
    const turns = new Map<string, number>();
    for (const f of cur.filter((g) => movable(g) || (isRug(g) && !g.locked))) {
      let best: Wall | null = null, bd = Infinity;
      for (const w of walls) {
        const s = Math.max(0, Math.min(w.L, (f.x - w.a.x) * w.t.x + (f.y - w.a.y) * w.t.y));
        const d = Math.hypot(f.x - (w.a.x + w.t.x * s), f.y - (w.a.y + w.t.y * s));
        if (d < bd) { bd = d; best = w; }
      }
      const diff = best ? quarterDiff(f.rotation, best.angle) : 0;
      if (Math.abs(diff) > 1e-6 && Math.abs(diff) <= SQUARE) turns.set(f.id, f.rotation - diff);
    }
    const turned = (fs: FurnitureItem[], ids: string[]) => fs.map((f) => (ids.includes(f.id) ? { ...f, rotation: turns.get(f.id)! } : f));
    const ids = [...turns.keys()];
    if (ids.length && !tryApply(turned(cur, ids), ids)) for (const id of ids) tryApply(turned(cur, [id]), [id]);
  }

  // 2. Pull pieces within 15 cm of a wall to it.
  const snapMoves = (fs: FurnitureItem[]) => {
    const seats = pairSeats(fs.filter(onFloor)), moves = new Map<string, P>();
    for (const f of fs) {
      if (!movable(f) || seats.has(f.id)) continue;
      const d = { x: 0, y: 0 };
      for (const w of walls) {
        const g = wallGap(f, w);
        if (g != null && g > 0.01 && g <= SNAP) { d.x -= w.n.x * (g - GAP); d.y -= w.n.y * (g - GAP); }
      }
      if (Math.hypot(d.x, d.y) > 1e-6) moves.set(f.id, d);
    }
    return moves;
  };
  const snap = () => {
    const moves = snapMoves(cur);
    if (!moves.size || tryApply(shifted(cur, moves), [...moves.keys()])) return;
    for (const [id, d] of moves) tryApply(shifted(cur, new Map([[id, d]])), [id]);
  };
  snap();

  // 3. Equal gaps between a bed and the nightstands at its head, backs in line with the bed's head.
  for (const bed of cur.filter(isBed)) {
    const sides = cur.filter((f) => f.category === 'nightstand' && movable(f) && Math.abs(quarterDiff(f.rotation, bed.rotation)) < 1e-4).map((ns) => {
      // Half extents of the nightstand along the bed's width and length.
      const turn = Math.abs(Math.sin(ns.rotation - bed.rotation)) > 0.5;
      const hx = turn ? ns.d / 2 : ns.w / 2, hy = turn ? ns.w / 2 : ns.d / 2;
      const l = local(bed, ns);
      return { ns, side: Math.sign(l.x), l, hx, hy, gap: Math.abs(l.x) - bed.w / 2 - hx };
    }).filter((s) => s.gap > -0.02 && s.gap < 0.6 && Math.abs(s.l.y - s.hy + bed.d / 2) < 0.6);
    const left = sides.filter((s) => s.side < 0).sort((a, b) => a.gap - b.gap)[0], right = sides.filter((s) => s.side > 0).sort((a, b) => a.gap - b.gap)[0];
    const pair = [left, right].filter(Boolean);
    if (!pair.length) continue;
    const base = pair.length === 2 ? Math.min(left.gap, right.gap) : pair[0].gap;
    for (const target of [Math.min(0.08, Math.max(0.03, base)), Math.max(0, base)]) {
      const moves = new Map<string, P>();
      for (const s of pair) {
        const p = toPlan(bed, s.side * (bed.w / 2 + target + s.hx), -bed.d / 2 + s.hy);
        if (Math.hypot(p.x - s.ns.x, p.y - s.ns.y) > 1e-4) moves.set(s.ns.id, { x: p.x - s.ns.x, y: p.y - s.ns.y });
      }
      if (!moves.size || tryApply(shifted(cur, moves), [...moves.keys()])) break;
    }
  }

  // 4. Centre a bed or sofa (with what belongs to it) on the wall at its back.
  for (const anchor of cur.filter((f) => (isBed(f) || isSofa(f)) && movable(f))) {
    const a = byId(anchor.id)!, front = { x: -Math.sin(a.rotation), y: Math.cos(a.rotation) };
    const wi = walls.findIndex((w) => { const g = wallGap(a, w); return g != null && g <= 0.02 && front.x * w.n.x + front.y * w.n.y > 0.99; });
    if (wi < 0) continue;
    const w = walls[wi];
    const group = cur.filter((g) => {
      if (g.id === a.id || g.locked || isHung(g)) return false;
      const l = local(a, g);
      if (isBed(a)) return g.category === 'nightstand' && Math.abs(l.x) < a.w / 2 + 0.6 && Math.abs(l.y + a.d / 2) < 0.6;
      return ['coffee-table', 'side-table', 'lamp', 'armchair', 'stool', 'tv-unit'].includes(g.category) && Math.abs(l.x) < a.w / 2 + 1.0 && l.y > -a.d / 2 - 0.05 && l.y < a.d / 2 + 3.2;
    });
    const span = [a, ...group].flatMap((g) => cornersOf(g)).map((p) => (p.x - w.a.x) * w.t.x + (p.y - w.a.y) * w.t.y);
    const shift = w.L / 2 - (Math.min(...span) + Math.max(...span)) / 2;
    if (Math.abs(shift) < 0.01 || Math.abs(shift) > 0.8) continue;
    const moves = new Map<string, P>([a, ...group].map((g) => [g.id, { x: w.t.x * shift, y: w.t.y * shift }]));
    tryApply(shifted(cur, moves), [...moves.keys()]);
  }

  // ---------- decor ----------
  const doorSwings: ORect[] = doors.filter((o) => o.swing === 'in' && o.wallIndex < walls.length).map((o) => {
    const w = walls[o.wallIndex], c = { x: w.a.x + w.t.x * o.offsetM, y: w.a.y + w.t.y * o.offsetM };
    return { cx: c.x + (w.n.x * o.widthM) / 2, cy: c.y + (w.n.y * o.widthM) / 2, hw: o.widthM / 2, hd: o.widthM / 2, rot: w.angle };
  });
  const add = (f: FurnitureItem, extraOk = true) => {
    if (!extraOk || cur.some((g) => g.id === f.id)) return false;
    const next = [...cur, f];
    if (!ok(next)) return false;
    cur = next; added.push(f.id); return true;
  };
  const piece = (catalogId: string, id: string, x: number, y: number, rotation: number, patch: Partial<FurnitureItem> = {}) => ({ ...makeItem(catalogId, { x, y, rotation }), id, ...patch });
  const RUGS = ['rug-80', 'rug-120', 'rug-140', 'rug-160', 'rug-200', 'rug-250'].map((id) => makeItem(id));
  const rugAt = (key: FurnitureItem) => cur.some((g) => isRug(g) && overlapDepth(rectOf(g), rectOf(key)) > 0.05);
  const rugFree = (r: FurnitureItem) => !doorSwings.some((z) => overlapDepth(z, rectOf(r)) > 0.01);
  /** Catalogue rugs that cover `long` x `short`, smallest first; then the bigger misses, largest first. */
  const rugsFor = (long: number, short: number) => {
    const dims = (r: FurnitureItem) => [Math.max(r.w, r.d), Math.min(r.w, r.d)];
    const cover = RUGS.filter((r) => dims(r)[0] >= long && dims(r)[1] >= short);
    const miss = RUGS.filter((r) => !cover.includes(r)).reverse();
    return [...cover, ...miss];
  };
  /** Rug rotation with its long side along `host`'s width. */
  const along = (rug: FurnitureItem, host: FurnitureItem) => host.rotation + (rug.w < rug.d ? HALF_PI : 0);

  // Rug under the seating group: under the sofa's front legs and the whole coffee table.
  for (const sofa of cur.filter(isSofa)) {
    const ct = cur.filter((g) => g.category === 'coffee-table').map((g) => ({ g, l: local(sofa, g) }))
      .filter(({ l }) => l.y > 0 && l.y < sofa.d / 2 + 1.6 && Math.abs(l.x) < sofa.w / 2).sort((p, q) => p.l.y - q.l.y)[0];
    if (!ct || rugAt(ct.g)) continue;
    const near = sofa.d / 2 - 0.2, far = ct.l.y + Math.max(ct.g.w, ct.g.d) / 2 + 0.3;
    const lx = Math.abs(ct.l.x) < 0.4 ? ct.l.x : 0;
    for (const proto of rugsFor(Math.max(sofa.w * 0.9, ct.g.w + 0.6), far - near)) {
      const short = Math.min(proto.w, proto.d);
      if (Math.max(proto.w, proto.d) < ct.g.w + 0.3) continue;
      const placed = [near + short / 2, (near + short / 2 + ct.l.y) / 2, ct.l.y].some((ly) => {
        if (ly - short / 2 > sofa.d / 2 - 0.1 || ly + short / 2 < ct.l.y + Math.min(ct.g.w, ct.g.d) / 2) return false;
        const p = toPlan(sofa, lx, ly);
        const rug = piece(proto.catalogId, `${sofa.id}-rug`, p.x, p.y, along(proto, sofa));
        return add(rug, rugFree(rug));
      });
      if (placed) break;
    }
  }

  // Dining rug: under the table and its chairs, reaching 60 cm past the chairs.
  const seats = pairSeats(cur.filter(onFloor));
  for (const table of cur.filter((g) => g.category === 'table' && !rugAt(g))) {
    const group = [table, ...cur.filter((g) => seats.get(g.id) === table.id)];
    const ls = group.flatMap(cornersOf).map((p) => local(table, p));
    const spanX = Math.max(...ls.map((p) => Math.abs(p.x))) * 2 + 1.2, spanY = Math.max(...ls.map((p) => Math.abs(p.y))) * 2 + 1.2;
    const wide = spanX >= spanY;
    for (const proto of rugsFor(Math.max(spanX, spanY), Math.min(spanX, spanY))) {
      if (Math.min(proto.w, proto.d) < Math.min(table.w, table.d) + 0.6) continue;
      // Long side along the long side of the group.
      const rot = table.rotation + ((proto.w >= proto.d) === wide ? 0 : HALF_PI);
      const rug = piece(proto.catalogId, `${table.id}-rug`, table.x, table.y, rot);
      if (add(rug, rugFree(rug))) break;
    }
  }

  // Bed rug: under the lower two thirds, long side across the bed.
  for (const bed of cur.filter((g) => isBed(g) && !rugAt(g))) {
    for (const proto of rugsFor(bed.w + 0.6, (bed.d * 2) / 3)) {
      const long = Math.max(proto.w, proto.d), short = Math.min(proto.w, proto.d);
      if (long < bed.w + 0.3 || short < bed.d / 2) continue;
      const head = -bed.d / 2 + bed.d / 3;
      const placed = [head + short / 2, Math.min(head + short / 2, bed.d / 2 + 0.6 - short / 2)].some((ly) => {
        const p = toPlan(bed, 0, ly);
        const rug = piece(proto.catalogId, `${bed.id}-rug`, p.x, p.y, along(proto, bed));
        return add(rug, rugFree(rug));
      });
      if (placed) break;
    }
  }

  // Lamps: a floor lamp beside a sofa arm, a table lamp on each nightstand.
  const lamps = () => cur.filter((g) => g.category === 'lamp');
  for (const sofa of cur.filter(isSofa)) {
    const has = lamps().some((l) => { const p = local(sofa, l); return Math.abs(p.x) < sofa.w / 2 + 0.7 && Math.abs(p.y) < sofa.d / 2 + 0.3; });
    if (has) continue;
    outer: for (const id of ['floor-lamp', 'floor-lamp-reading']) {
      const proto = makeItem(id);
      for (const side of [1, -1]) {
        const p = toPlan(sofa, side * (sofa.w / 2 + 0.04 + proto.w / 2), -sofa.d / 2 + proto.d / 2);
        if (add(piece(id, `${sofa.id}-lamp`, p.x, p.y, sofa.rotation))) break outer;
      }
    }
  }
  // A table lamp on the nightstand when the referee accepts a piece standing on another; otherwise a
  // floor lamp beside it, just outside the bed's side clearance, backs in line.
  for (const ns of cur.filter((g) => g.category === 'nightstand')) {
    const bed = cur.filter(isBed).map((b) => ({ b, l: local(b, ns) })).find(({ b, l }) => Math.abs(l.x) < b.w / 2 + 0.8 && Math.abs(l.y + b.d / 2) < 0.8);
    const near = (l: FurnitureItem) => Math.hypot(l.x - ns.x, l.y - ns.y) < Math.max(ns.w, ns.d) / 2 + 0.5;
    if (lamps().some(near)) continue;
    const table = makeItem('table-lamp');
    if (Math.min(ns.w, ns.d) >= table.w + 0.02) {
      const p = toPlan(ns, 0, -Math.max(0, ns.d / 2 - table.d / 2 - 0.04));
      if (add(piece('table-lamp', `${ns.id}-lamp`, p.x, p.y, ns.rotation, { elevationM: ns.h }))) continue;
    }
    if (!bed) continue;
    const side = Math.sign(bed.l.x) || 1, clear = side < 0 ? bed.b.clearance.left : bed.b.clearance.right;
    const nsOuter = Math.abs(bed.l.x) + Math.max(ns.w, ns.d) / 2;
    for (const id of ['floor-lamp-reading', 'floor-lamp']) {
      const proto = makeItem(id);
      const lx = side * (Math.max(bed.b.w / 2 + clear + 0.01, nsOuter + 0.04) + proto.w / 2);
      const p = toPlan(bed.b, lx, -bed.b.d / 2 + proto.d / 2);
      if (add(piece(id, `${ns.id}-lamp`, p.x, p.y, bed.b.rotation))) break;
    }
  }

  // Plant: the brightest empty corner near a window.
  if (windows.length && !cur.some((g) => g.category === 'plant')) {
    const winAt = windows.filter((o) => o.wallIndex < walls.length).map((o) => {
      const w = walls[o.wallIndex];
      return { p: { x: w.a.x + w.t.x * o.offsetM, y: w.a.y + w.t.y * o.offsetM }, size: o.widthM * o.heightM };
    });
    const n = walls.length;
    const spots = walls.map((wb, i) => {
      const wa = walls[(i - 1 + n) % n], c = wb.a;
      const convex = wa.t.x * wb.t.y - wa.t.y * wb.t.x;
      const light = winAt.reduce((s, x) => s + x.size / (0.5 + Math.hypot(x.p.x - c.x, x.p.y - c.y)), 0);
      const nearest = Math.min(...winAt.map((x) => Math.hypot(x.p.x - c.x, x.p.y - c.y)));
      return { i, c, wa, wb, light, nearest, convex: convex * (signedArea(space.polygon) >= 0 ? 1 : -1) > 1e-6 };
    }).filter((s) => s.convex && s.nearest < 3.5).sort((p, q) => q.light - p.light || p.i - q.i);
    outer: for (const s of spots) {
      for (const id of ['plant', 'plant-medium', 'plant-small']) {
        const proto = makeItem(id), r = proto.w / 2 + GAP;
        // Centre at distance r from both walls of the corner.
        const det = s.wa.n.x * s.wb.n.y - s.wa.n.y * s.wb.n.x;
        if (Math.abs(det) < 1e-6) continue;
        const ax = s.wa.n.x * s.c.x + s.wa.n.y * s.c.y + r, bx = s.wb.n.x * s.c.x + s.wb.n.y * s.c.y + r;
        const p = { x: (ax * s.wb.n.y - s.wa.n.y * bx) / det, y: (s.wa.n.x * bx - ax * s.wb.n.x) / det };
        const plant = piece(id, `plant-${space.id}-${s.i}`, p.x, p.y, Math.atan2(-s.wb.n.x, s.wb.n.y));
        // Empty: nothing standing within 30 cm of the pot.
        const halo: ORect = { cx: p.x, cy: p.y, hw: proto.w / 2 + 0.3, hd: proto.d / 2 + 0.3, rot: plant.rotation };
        if (cur.some((g) => onFloor(g) && overlapDepth(halo, rectOf(g)) > 0.01)) continue outer;
        if (add(plant, !doorSwings.some((z) => overlapDepth(z, halo) > 0.01))) break outer;
      }
    }
  }

  // Lamps beside a sofa and pots in corners are pulled flush to the wall too.
  snap();

  for (const id of added) adjusted.delete(id);
  return { furniture: cur, added, adjusted: [...adjusted] };
}

/** Finish every candidate of a design result: decor added, alignment tidied, checks and cost refreshed. */
export function finishCandidates<T extends { candidates: LayoutCandidate[] }>(model: SpaceModel, result: T, req?: Requirements | null): T {
  return {
    ...result,
    candidates: result.candidates.map((cand) => {
      const done = finishLayout(model, cand.furniture, { req });
      if (!done.added.length && !done.adjusted.length) return cand;
      const extra = done.furniture.filter((f) => done.added.includes(f.id) && !f.owned).reduce((s, f) => s + (f.priceSek || 0), 0);
      return { ...cand, furniture: done.furniture, checks: validateLayout(model, done.furniture, req ?? null), metrics: { ...cand.metrics, costSek: cand.metrics.costSek + extra } };
    }),
  };
}
