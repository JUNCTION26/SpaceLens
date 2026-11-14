// Relations: how strongly a layout honours each one (0..1), and where a dependent piece goes
// once the piece it depends on has a pose.
import type { DesignProgram, FurnitureItem, Relation, RelationKind } from '../../core/types';
import { pointInPolygon, type P } from '../referee/geom';
import { band, frontOf, polyDist, rightOf, toPlanOf, type AItem, type LayoutCtx, type RoomCtx } from './rules';

export interface Pose { x: number; y: number; rotation: number }

const dot = (a: P, b: P) => a.x * b.x + a.y * b.y;
const sub = (a: P, b: P): P => ({ x: a.x - b.x, y: a.y - b.y });
const normv = (a: P): P => { const l = Math.hypot(a.x, a.y) || 1; return { x: a.x / l, y: a.y / l }; };
const distp = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y);
/** Rotation that makes an item's front (local +y) face direction n. */
export const rotationFacing = (n: P) => Math.atan2(-n.x, n.y);
const at = (a: AItem): P => ({ x: a.f.x, y: a.f.y });

// ---------------------------------------------------------------- scoring
type Target = { kind: 'item'; a: AItem } | { kind: 'point'; p: P; label: string } | { kind: 'wall'; i: number } | null;
function resolve(L: LayoutCtx, target: string | undefined, from: P): Target {
  if (!target) return null;
  const a = L.byId.get(target);
  if (a) return { kind: 'item', a };
  if (target === 'room-centre') return { kind: 'point', p: L.room.centre, label: 'the middle of the room' };
  if (target === 'window' || target === 'door') {
    const list = target === 'window' ? L.room.windows : L.room.doors;
    if (!list.length) return null;
    const best = list.reduce((p, q) => (distp(q.c, from) < distp(p.c, from) ? q : p));
    return { kind: 'point', p: best.c, label: `the ${target}` };
  }
  const m = /^wall:(\d+)$/.exec(target);
  if (m && L.room.walls[Number(m[1])]) return { kind: 'wall', i: Number(m[1]) };
  const op = L.room.openings.find((o) => o.id === target);
  if (op) return { kind: 'point', p: op.c, label: `the ${op.kind}` };
  return null;
}
const targetPoint = (t: Target): P | null => (t?.kind === 'item' ? at(t.a) : t?.kind === 'point' ? t.p : null);
function edgeDist(a: AItem, t: Target): number {
  if (!t) return Infinity;
  if (t.kind === 'item') return polyDist(a.poly, t.a.poly);
  if (t.kind === 'point') { let m = Infinity; for (const p of a.poly) m = Math.min(m, distp(p, t.p)); return Math.min(m, pointInPolygon(t.p, a.poly) ? 0 : m); }
  return Infinity;
}

/** How well a relation holds, 0..1, or null when it cannot be judged (missing piece). */
export function relationScore(rel: Relation, L: LayoutCtx): number | null {
  const s = L.byId.get(rel.subject);
  if (!s) return null;
  const t = resolve(L, rel.target, at(s));
  if (rel.target && !t) return null;
  const range = rel.distanceM;
  switch (rel.kind) {
    case 'against-wall': {
      if (t?.kind === 'wall') return s.back && s.back.wall === t.i ? band(s.back.gap, 0, 0.05, 0.4) : 0.2;
      return s.back ? band(s.back.gap, 0, 0.05, 0.4) : 0;
    }
    case 'in-corner': {
      const gaps = L.room.walls.map((w) => Math.min(...s.poly.map((p) => Math.abs(dot(sub(p, w.a), w.n)))));
      const sorted = [...gaps].sort((a, b) => a - b);
      return band(sorted[0], 0, 0.08, 0.5) * band(sorted[1], 0, 0.08, 0.6);
    }
    case 'near-window': case 'away-from-door': case 'apart-from': case 'beside': {
      const d = edgeDist(s, t);
      if (!Number.isFinite(d)) return null;
      if (rel.kind === 'near-window') return band(d, range?.[0] ?? 0, range?.[1] ?? 1.5, 2);
      if (rel.kind === 'away-from-door' || rel.kind === 'apart-from') return band(d, range?.[0] ?? 1.2, range?.[1] ?? 99, Math.max(0.5, range?.[0] ?? 1.2));
      return band(d, range?.[0] ?? 0, range?.[1] ?? 0.5, 0.8);
    }
    case 'faces': case 'paired-seat': {
      const p = targetPoint(t);
      if (!p) return null;
      const c = dot(s.front, normv(sub(p, at(s))));
      let sc = band(c, 0.92, 1, 0.9);
      if (range && t?.kind === 'item') sc *= band(distp(at(s), at(t.a)), range[0], range[1], 0.8);
      if (rel.kind === 'paired-seat' && t?.kind === 'item') sc *= band(polyDist(s.poly, t.a.poly), 0, 0.15, 0.5);
      return sc;
    }
    case 'flanks': {
      if (t?.kind !== 'item') return null;
      const b = t.a, rel2 = sub(at(s), at(b));
      const lx = Math.abs(dot(rel2, b.right)), ly = dot(rel2, b.front);
      return band(lx - b.f.w / 2 - s.f.w / 2, -0.01, 0.08, 0.3) * band(Math.abs(ly - s.f.d / 2 + b.f.d / 2), 0, 0.1, 0.4);
    }
    case 'in-front-of': {
      if (t?.kind !== 'item') return null;
      const b = t.a, r = sub(at(s), at(b));
      const along = dot(r, b.front), lat = Math.abs(dot(r, b.right));
      const half = Math.abs(dot(b.front, s.front)) > 0.7 ? s.f.d / 2 : s.f.w / 2;
      const gap = along - b.f.d / 2 - half;
      return band(gap, range?.[0] ?? 0.35, range?.[1] ?? 0.6, 0.3) * band(lat, 0, 0.15, 0.6);
    }
    case 'centered-on': {
      const p = targetPoint(t);
      if (!p) return null;
      return band(distp(at(s), p), 0, 0.25, 1.2);
    }
    case 'on-rug': {
      if (t?.kind !== 'item') return null;
      const inside = s.poly.filter((p) => pointInPolygon(p, t.a.poly)).length;
      return inside / 4;
    }
    case 'aligned-with': {
      if (t?.kind !== 'item') return null;
      const d = Math.min(Math.abs(s.f.x - t.a.f.x), Math.abs(s.f.y - t.a.f.y));
      return band(d, 0, 0.03, 0.4);
    }
  }
  return null;
}

/** Weighted mean of every relation that can be judged, 0..1 (1 when there are none). */
export function programScore(program: DesignProgram, L: LayoutCtx): number {
  let w = 0, s = 0;
  for (const r of program.relations) {
    const v = relationScore(r, L);
    if (v == null) continue;
    w += r.weight; s += r.weight * v;
  }
  return w ? s / w : 1;
}

// ---------------------------------------------------------------- structure
/** Relations that decide where a piece goes (the piece hangs off its target), strongest first. */
const STRUCTURAL: RelationKind[] = ['paired-seat', 'flanks', 'in-front-of', 'faces', 'beside', 'centered-on'];
export function isStructural(rel: Relation, items: Map<string, FurnitureItem>): boolean {
  const t = rel.target ? items.get(rel.target) : undefined;
  const s = items.get(rel.subject);
  if (!t || !s || t.id === s.id) return false;
  if (rel.kind === 'faces') return t.category === 'tv-unit' && /^sofa/.test(s.category);
  if (rel.kind === 'beside') return (rel.distanceM?.[1] ?? 0.5) <= 1.0 && ['armchair', 'lamp', 'side-table', 'plant'].includes(s.category);
  if (rel.kind === 'centered-on') return s.category === 'rug';
  return STRUCTURAL.includes(rel.kind);
}
export const structuralRank = (k: RelationKind) => { const i = STRUCTURAL.indexOf(k); return i < 0 ? 99 : i; };

// ---------------------------------------------------------------- placement generators
const poseAt = (parent: Pose, lx: number, ly: number, rotation: number): Pose => ({ ...toPlanOf(parent, lx, ly), rotation });

/** Seat arrangements round a host: lists of poses (one per seat, in order), best first. */
export function seatArrangements(host: FurnitureItem, seats: FurnitureItem[], mirror = false): Pose[][] {
  if (!seats.length) return [[]];
  const desk = /desk|counter/.test(host.category);
  type Side = 'front' | 'back' | 'left' | 'right';
  const sides: Side[] = desk ? ['front'] : (['front', 'back', 'left', 'right'] as Side[]).filter((s) => host.clearance[s] >= 0.3);
  if (!sides.length) sides.push('front');
  const span = (s: Side) => (s === 'front' || s === 'back' ? host.w : host.d);
  const sw = Math.max(...seats.map((s) => s.w));
  const cap = (s: Side) => Math.max(1, Math.floor((span(s) + 0.1) / (sw + 0.08)));
  // Every way to spread the seats over the sides, balanced and long-side-first preferred.
  const combos: number[][] = [];
  const rec = (i: number, left: number, acc: number[]) => {
    if (i === sides.length) { if (!left) combos.push([...acc]); return; }
    for (let n = Math.min(cap(sides[i]), left); n >= 0; n--) { acc.push(n); rec(i + 1, left - n, acc); acc.pop(); }
  };
  rec(0, seats.length, []);
  if (!combos.length) { const c = sides.map(() => 0); c[0] = seats.length; combos.push(c); }
  const opp: Record<Side, Side> = { front: 'back', back: 'front', left: 'right', right: 'left' };
  const pref = (c: number[]) => {
    let p = 0;
    sides.forEach((s, i) => {
      const j = sides.indexOf(opp[s]);
      p += Math.abs(c[i] - (j >= 0 ? c[j] : 0)) * 2; // unbalanced opposite sides
      if (c[i] && span(s) < Math.max(host.w, host.d) - 0.05) p += 0.5; // ends before long sides
    });
    return p;
  };
  combos.sort((a, b) => pref(a) - pref(b));
  const out: Pose[][] = [];
  for (const c of combos.slice(0, 6)) {
    const poses: Pose[] = [];
    let k = 0;
    sides.forEach((s, i) => {
      for (let j = 0; j < c[i]; j++) {
        const seat = seats[k++];
        const u = ((j + 0.5) / c[i] - 0.5) * span(s) * (c[i] > 1 ? 1 : 0);
        const off = (desk ? 0.03 : 0.05) + seat.d / 2;
        if (s === 'front') poses.push(poseAt(host, u, host.d / 2 + off, host.rotation + Math.PI));
        else if (s === 'back') poses.push(poseAt(host, u, -host.d / 2 - off, host.rotation));
        else if (s === 'left') poses.push(poseAt(host, -host.w / 2 - off, u, host.rotation - Math.PI / 2));
        else poses.push(poseAt(host, host.w / 2 + off, u, host.rotation + Math.PI / 2));
      }
    });
    out.push(poses);
  }
  if (mirror && out.length > 1) out.push(out.shift()!);
  return out;
}

/** Nightstand beside the head of the bed, back in line with the headboard. */
export function flankOptions(bed: FurnitureItem, ns: FurnitureItem, sideOrder: Array<-1 | 1>): Pose[] {
  return sideOrder.map((sg) => poseAt(bed, sg * (bed.w / 2 + 0.02 + ns.w / 2), -bed.d / 2 + ns.d / 2, bed.rotation));
}

/** A piece straight out in front of its parent (coffee table before a sofa). */
export function inFrontOptions(parent: FurnitureItem, child: FurnitureItem, range: [number, number] = [0.45, 0.5]): Pose[] {
  const gaps = [range[0] + 0.005, (range[0] + range[1]) / 2, range[1]];
  return gaps.map((g) => poseAt(parent, 0, parent.d / 2 + g + child.d / 2, parent.rotation));
}

/** Free distance from a point to the room outline along a direction. */
function wallRay(room: RoomCtx, o: P, d: P): number {
  let best = Infinity;
  for (const w of room.walls) {
    const e = sub(w.b, w.a), den = d.x * e.y - d.y * e.x;
    if (Math.abs(den) < 1e-12) continue;
    const q = sub(w.a, o), t = (q.x * e.y - q.y * e.x) / den, u = (q.x * d.y - q.y * d.x) / den;
    if (t > 1e-6 && u >= -1e-9 && u <= 1 + 1e-9) best = Math.min(best, t);
  }
  return best;
}

/** A sofa facing a TV unit: back on the opposite wall when that is in range, otherwise floating at a good distance with a walkway behind. */
export function facingOptions(room: RoomCtx, tv: FurnitureItem, sofa: FurnitureItem, range: [number, number] = [2.1, 3.5]): Pose[] {
  const front = frontOf(tv.rotation);
  const screen = toPlanOf(tv, 0, -tv.d / 2 + 0.05);
  const edge = toPlanOf(tv, 0, tv.d / 2);
  const free = wallRay(room, edge, front);
  const rot = tv.rotation + Math.PI;
  const out: Pose[] = [];
  // Eye sits ~35 cm in front of the sofa back.
  const sofaCentreForEye = (eye: number) => eye + 0.35 - sofa.d / 2;
  const wallCentre = free + tv.d / 2 - sofa.d / 2 - 0.005;
  const eyeAtWall = free + tv.d - 0.05 - 0.35;
  const diag = Math.max(0.8, Math.min(1.9, tv.w * 0.9));
  const lo = Math.max(range[0], 1.5 * diag), hi = Math.min(Math.max(range[1], lo + 0.4), 2.5 * diag + 0.3);
  if (eyeAtWall <= hi + 0.6) out.push(poseAt(tv, 0, wallCentre, rot));
  for (const eye of [(lo + hi) / 2, lo + 0.15, hi - 0.1]) {
    const c = sofaCentreForEye(eye) - (tv.d / 2 - 0.05);
    const behind = wallCentre - c;
    if (behind >= 0.85) out.push(poseAt(tv, 0, tv.d / 2 + c, rot));
  }
  void screen;
  return out;
}

/** Armchair at an end of the coffee table turned towards it, lamp beside a seat, etc. */
export function besideOptions(parent: FurnitureItem, child: FurnitureItem, range: [number, number] | undefined, mirror: boolean, opposite: boolean): Pose[] {
  const sides: Array<-1 | 1> = mirror ? [-1, 1] : [1, -1];
  const out: Pose[] = [];
  if (child.category === 'armchair' || child.category === 'side-table') {
    const gaps = range ? [Math.max(range[0], child.clearance.front + 0.01), (range[0] + range[1]) / 2, range[1]] : [0.5];
    const r = rightOf(parent.rotation);
    for (const sg of sides) for (const g of gaps) {
      const lx = sg * (parent.w / 2 + g + child.d / 2);
      out.push(poseAt(parent, lx, 0, rotationFacing({ x: -r.x * sg, y: -r.y * sg })));
    }
    if (opposite) for (const g of gaps) out.push(poseAt(parent, 0, parent.d / 2 + g + child.d / 2, parent.rotation + Math.PI));
    return out;
  }
  // Lamps and plants: beside the parent, towards its back.
  for (const sg of sides) out.push(poseAt(parent, sg * (parent.w / 2 + 0.04 + child.w / 2), -parent.d / 2 + child.d / 2 + 0.03, parent.rotation));
  return out;
}

/** Rug under a group: under the front legs of the seating, or wide enough for pulled-out chairs. */
export function rugOptions(rug: FurnitureItem, target: FurnitureItem, seat?: FurnitureItem): Array<Pose & { swap: boolean }> {
  const long = Math.max(rug.w, rug.d), short = Math.min(rug.w, rug.d);
  const swap = rug.w < rug.d; // rotate the rug so its long side runs along the seat
  const out: Array<Pose & { swap: boolean }> = [];
  const along = (base: FurnitureItem, ly: number) => {
    const p = toPlanOf(base, 0, ly);
    // Rug long side parallel to base's width: local x of rug along base x.
    return { x: p.x, y: p.y, rotation: base.rotation + (swap ? Math.PI / 2 : 0), swap };
  };
  if (seat) {
    // Near edge 20 cm under the seat front.
    out.push(along(seat, seat.d / 2 - 0.2 + short / 2));
    out.push(along(seat, seat.d / 2 - 0.1 + short / 2));
    out.push(along(target, 0));
    return out;
  }
  if (/table/.test(target.category)) {
    const sw = target.w >= target.d ? swap : !swap;
    const p = { x: target.x, y: target.y, rotation: target.rotation + (sw ? Math.PI / 2 : 0), swap: sw };
    out.push(p);
    return out;
  }
  if (/bed/.test(target.category)) {
    out.push(along(target, target.d / 2 - short / 2 + 0.55));
    out.push(along(target, target.d / 2 - short / 2 + 0.4));
  }
  out.push(along(target, 0));
  void long;
  return out;
}
