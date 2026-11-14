// Whole-floor planning: a rectilinear outer shell plus a room programme in, several distinct
// floor plans out. Each plan is built from corridor "blocks": every rectangle of the shell gets
// a hall running along it, rooms are sliced into the bands on either side so each one touches
// both the hall and the facade, small rooms without windows are tucked against the hall, and
// optional end zones hold rooms across the full width. A local search then improves a score made
// of named criteria (area fit, daylight, adjacency, circulation share, privacy gradient, wall
// length, wet rooms grouped) and every option reports those criteria with numbers.
import type { Vec2 } from '../../core/types';
import { isWet, type ProgrammeRoom, type RoomProgramme } from './programme';
import {
  decompose, mergeSegs, rArea, rect, rectPoly, rLong, rShort, rCentre, snap, touching, unionOutline,
  type Rect, type Seg, segLen, r2,
} from './rects';

// ---------- public types ----------

export interface ShellEntrance { wallIndex: number; offsetM: number; widthM?: number }
/** A facade where windows may go: the whole wall, or one window when offset and width are given. */
export interface ShellWindow { wallIndex: number; offsetM?: number; widthM?: number }

export interface PlanOptions {
  /** Number of distinct options to return (default 3). */
  count?: number;
  seed?: number;
  /** Local-search steps per structural family (default 1400). */
  iterations?: number;
  corridorWidthM?: number;
  exteriorWallM?: number;
  interiorWallM?: number;
}

export interface PlanRoom {
  id: string;
  /** Programme row id, null for the hall. */
  programmeId: string | null;
  name: string;
  purpose: string;
  privacy: ProgrammeRoom['privacy'];
  isHall: boolean;
  rects: Rect[];
  polygon: Vec2[];
  areaM2: number;
  targetM2: number;
  minAreaM2: number;
  minWidthM: number;
  /** Short side of the room's main rectangle. */
  widthM: number;
  /** Long / short side of the main rectangle. */
  aspect: number;
  /** Length of the room's walls on the outer shell. */
  facadeM: number;
  /** Facade length where windows are allowed. */
  daylightM: number;
  needsWindow: boolean;
}

export interface PlanDoor {
  id: string;
  /** Room ids; b is 'outside' for doors in the shell. */
  a: string;
  b: string;
  at: Vec2;
  /** Orientation of the wall the door sits in. */
  horizontal: boolean;
  widthM: number;
  kind: 'door' | 'opening';
  /** Room the leaf swings into. */
  swingInto: string;
}

export interface PlanWindow { roomId: string; a: Vec2; b: Vec2 }

export interface Criterion {
  id: 'reach' | 'proportion' | 'area' | 'daylight' | 'adjacency' | 'circulation' | 'privacy' | 'walls' | 'wet';
  name: string;
  /** 0..1 */
  score: number;
  weight: number;
  /** Plain sentence with numbers. */
  detail: string;
  value: number;
  unit: string;
}

export interface BuildingPlan {
  id: string;
  name: string;
  summary: string;
  family: string;
  seed: number;
  shell: Vec2[];
  rooms: PlanRoom[];
  doors: PlanDoor[];
  windows: PlanWindow[];
  criteria: Criterion[];
  /** 0..100 */
  score: number;
  internalWallM: number;
  circulationM2: number;
  circulationShare: number;
  totalAreaM2: number;
  corridorWidthM: number;
  exteriorWallM: number;
  interiorWallM: number;
  /** Problems a builder should know about (empty when every check passes). */
  issues: string[];
}

// ---------- rng ----------

export function seeded(seed: number) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

// ---------- shell ----------

interface Ctx {
  shell: Vec2[];
  area: number;
  perimeter: number;
  facades: Seg[];
  windowSegs: Seg[];
  /** User-fixed windows (only these are drawn when given). */
  fixedWindows: Seg[];
  entrance: Vec2;
  entranceW: number;
  extraEntrances: Vec2[];
  rooms: ProgrammeRoom[];
  wc: number;
  home: boolean;
  doorW: number;
}

const EPS = 1e-6;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

function signedArea(p: Vec2[]) { let s = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a.x * b.y - b.x * a.y; } return s / 2; }

function pointOnWall(shell: Vec2[], wallIndex: number, offset: number): Vec2 {
  const n = shell.length, a = shell[((wallIndex % n) + n) % n], b = shell[(((wallIndex + 1) % n) + n) % n];
  const L = Math.hypot(b.x - a.x, b.y - a.y) || 1, t = clamp(offset, 0, L) / L;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function wallSeg(shell: Vec2[], i: number, o0?: number, o1?: number): Seg {
  const n = shell.length, a = shell[i % n], b = shell[(i + 1) % n];
  const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const p = (o: number) => ({ x: r2(a.x + (b.x - a.x) * clamp(o, 0, L) / L), y: r2(a.y + (b.y - a.y) * clamp(o, 0, L) / L) });
  const s = p(o0 ?? 0), e = p(o1 ?? L);
  const horizontal = Math.abs(a.y - b.y) < 1e-6;
  const [lo, hi] = horizontal ? (s.x <= e.x ? [s, e] : [e, s]) : (s.y <= e.y ? [s, e] : [e, s]);
  return { a: lo, b: hi, horizontal };
}

/** Clean the shell: right angles only, clockwise on screen, no collinear points. */
export function normaliseShell(shell: Vec2[]): Vec2[] {
  let p = shell.map((q) => ({ x: r2(q.x), y: r2(q.y) }));
  p = p.filter((q, i) => { const r = p[(i + 1) % p.length]; return Math.abs(q.x - r.x) > EPS || Math.abs(q.y - r.y) > EPS; });
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    if (Math.abs(a.x - b.x) > 1e-3 && Math.abs(a.y - b.y) > 1e-3) throw new Error('The shell needs right-angled corners only');
  }
  if (signedArea(p) < 0) p.reverse();
  const out: Vec2[] = [];
  for (let i = 0; i < p.length; i++) {
    const a = p[(i - 1 + p.length) % p.length], b = p[i], c = p[(i + 1) % p.length];
    if (Math.abs((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)) > EPS) out.push(b);
  }
  if (out.length < 4) throw new Error('The shell needs at least four corners');
  return out;
}

// ---------- blocks (one per shell rectangle) ----------

type Side = 'A' | 'B';

interface Block {
  rect: Rect;
  axis: 'x' | 'y';
  flip: boolean;
  L: number;
  W: number;
  parent: number;
  attach: null | { type: 'slot' | 'tip'; side?: Side; end?: 0 | 1; childVRange: [number, number] };
  allowE: [boolean, boolean];
  entry: null | { kind: 'side'; side: Side; u: number } | { kind: 'end'; end: 0 | 1; v: number };
  children: number[];
}

interface Family { key: string; label: string; blocks: Block[] }

function toLocal(b: Block, p: Vec2) {
  const { rect: r } = b;
  return b.axis === 'x'
    ? { u: b.flip ? r.x1 - p.x : p.x - r.x0, v: p.y - r.y0 }
    : { u: b.flip ? r.y1 - p.y : p.y - r.y0, v: p.x - r.x0 };
}
function toGlobalRect(b: Block, u0: number, u1: number, v0: number, v1: number): Rect {
  const { rect: r } = b;
  if (b.axis === 'x') {
    const xs = b.flip ? [r.x1 - u1, r.x1 - u0] : [r.x0 + u0, r.x0 + u1];
    return rect(r2(xs[0]), r2(r.y0 + v0), r2(xs[1]), r2(r.y0 + v1));
  }
  const ys = b.flip ? [r.y1 - u1, r.y1 - u0] : [r.y0 + u0, r.y0 + u1];
  return rect(r2(r.x0 + v0), r2(ys[0]), r2(r.x0 + v1), r2(ys[1]));
}

function makeBlock(r: Rect, axis: 'x' | 'y', flip: boolean, parent: number): Block {
  const L = axis === 'x' ? r.x1 - r.x0 : r.y1 - r.y0, W = axis === 'x' ? r.y1 - r.y0 : r.x1 - r.x0;
  return { rect: r, axis, flip, L, W, parent, attach: null, allowE: [true, true], entry: null, children: [] };
}

function onFacade(ctx: Ctx, p: Vec2) {
  return ctx.facades.some((s) => (s.horizontal ? Math.abs(p.y - s.a.y) < 1e-3 && p.x >= s.a.x - 1e-3 && p.x <= s.b.x + 1e-3 : Math.abs(p.x - s.a.x) < 1e-3 && p.y >= s.a.y - 1e-3 && p.y <= s.b.y + 1e-3));
}

function buildFamily(ctx: Ctx, rects: Rect[], rootIdx: number, rootAxis: 'x' | 'y'): Family | null {
  const blocks: Block[] = [makeBlock(rects[rootIdx], rootAxis, false, -1)];
  const done = new Set([rootIdx]);
  for (let guard = 0; guard < rects.length && done.size < rects.length; guard++) {
    for (let ri = 0; ri < rects.length; ri++) {
      if (done.has(ri)) continue;
      const r = rects[ri];
      for (let bi = 0; bi < blocks.length; bi++) {
        const pb = blocks[bi];
        const seg = touching(pb.rect, r).sort((a, b) => segLen(b) - segLen(a))[0];
        if (!seg || segLen(seg) < ctx.wc + 0.6) continue;
        const la = toLocal(pb, seg.a), lb = toLocal(pb, seg.b);
        const constV = Math.abs(la.v - lb.v) < 1e-6;
        let child: Block;
        if (constV) {
          const axis = pb.axis === 'x' ? 'y' : 'x';
          const at = axis === 'y' ? seg.a.y : seg.a.x;
          const flip = Math.abs((axis === 'y' ? r.y1 : r.x1) - at) < 1e-6;
          child = makeBlock(r, axis, flip, bi);
          child.attach = { type: 'slot', side: la.v < 1e-6 ? 'A' : 'B', childVRange: [0, 0] };
        } else {
          const axis = pb.axis;
          const at = axis === 'x' ? seg.a.x : seg.a.y;
          const flip = Math.abs((axis === 'x' ? r.x1 : r.y1) - at) < 1e-6;
          child = makeBlock(r, axis, flip, bi);
          const end: 0 | 1 = la.u < 1e-6 ? 0 : 1;
          child.attach = { type: 'tip', end, childVRange: [0, 0] };
          pb.allowE[end] = false;
        }
        const ca = toLocal(child, seg.a), cb = toLocal(child, seg.b);
        child.attach!.childVRange = [Math.min(ca.v, cb.v), Math.max(ca.v, cb.v)];
        child.allowE[0] = false;
        pb.children.push(blocks.length);
        blocks.push(child);
        done.add(ri);
        break;
      }
    }
  }
  if (done.size < rects.length) return null;
  // Entrance: the block whose outer edge carries it.
  const e = ctx.entrance;
  let placed = false;
  for (const b of blocks) {
    const { u, v } = toLocal(b, e);
    if (u < -1e-3 || u > b.L + 1e-3 || v < -1e-3 || v > b.W + 1e-3) continue;
    if (Math.abs(v) < 1e-3 || Math.abs(v - b.W) < 1e-3) { b.entry = { kind: 'side', side: Math.abs(v) < 1e-3 ? 'A' : 'B', u }; placed = true; break; }
    if (Math.abs(u) < 1e-3 || Math.abs(u - b.L) < 1e-3) {
      const end: 0 | 1 = Math.abs(u) < 1e-3 ? 0 : 1;
      if (end === 0 && b.attach) continue;
      b.entry = { kind: 'end', end, v }; b.allowE[end] = false; placed = true; break;
    }
  }
  if (!placed) return null;
  const dims = (r: Rect) => `${(r.x1 - r.x0).toFixed(1)}x${(r.y1 - r.y0).toFixed(1)}`;
  return { key: `${blocks.map((b) => `${dims(b.rect)}${b.axis}${b.flip ? 'f' : ''}`).join('|')}`, label: '', blocks };
}

function families(ctx: Ctx): Family[] {
  const out: Family[] = [];
  const seen = new Set<string>();
  for (const along of ['x', 'y'] as const) {
    const rects = decompose(ctx.shell, along);
    const order = rects.map((_, i) => i).sort((a, b) => rArea(rects[b]) - rArea(rects[a]));
    for (const ri of order.slice(0, 2)) {
      for (const axis of ['x', 'y'] as const) {
        const f = buildFamily(ctx, rects, ri, axis);
        if (!f || seen.has(f.key)) continue;
        seen.add(f.key);
        out.push(f);
      }
    }
  }
  return out;
}

// ---------- genome & decoding ----------

interface Genome { regions: number[][]; cf: number[] }
interface RegionDef { block: number; kind: Side | 'E0' | 'E1' }

const regionDefs = (fam: Family): RegionDef[] => fam.blocks.flatMap((b, bi) => {
  const r: RegionDef[] = [{ block: bi, kind: 'A' }, { block: bi, kind: 'B' }];
  if (b.allowE[0]) r.push({ block: bi, kind: 'E0' });
  if (b.allowE[1]) r.push({ block: bi, kind: 'E1' });
  return r;
});

interface Placed { room: number; rects: Rect[]; target: number }
interface Layout { placed: Placed[]; hall: Rect[]; c: number[] }

const flexOf = (r: ProgrammeRoom) => (r.privacy === 'service' ? 0.2 : r.purpose === 'phone' ? 0.1 : 1);

/** Share `capacity` m² between rooms: start at preferred, spread surplus by flexibility, take shortfall from slack. */
function share(rooms: ProgrammeRoom[], capacity: number): number[] {
  const pref = rooms.map((r) => r.preferredAreaM2);
  const sum = pref.reduce((s, x) => s + x, 0);
  const extra = capacity - sum;
  if (extra >= 0) {
    const w = rooms.map((r) => r.preferredAreaM2 * flexOf(r)); const ws = w.reduce((s, x) => s + x, 0) || 1;
    return pref.map((p, i) => p + extra * w[i] / ws);
  }
  const slack = rooms.map((r) => Math.max(0.05, r.preferredAreaM2 - r.minAreaM2)); const ss = slack.reduce((s, x) => s + x, 0);
  if (-extra <= ss) return pref.map((p, i) => p + extra * slack[i] / ss);
  const k = capacity / sum;
  return pref.map((p) => p * k);
}

const MIN_BAND = 2.4;
const MIN_GAP = 2.2;

function decode(ctx: Ctx, fam: Family, defs: RegionDef[], g: Genome): Layout {
  const { wc } = ctx;
  const B = fam.blocks;
  const ws = ctx.home ? Math.max(wc, 1.6) : Math.max(wc, 2.2);
  // 1. corridor positions
  const c: number[] = new Array(B.length).fill(0);
  const corridorGlobal = (bi: number) => toGlobalRect(B[bi], 0, Math.min(0.01, B[bi].L), c[bi], c[bi] + wc);
  for (let bi = 0; bi < B.length; bi++) {
    const b = B[bi];
    const span = Math.max(0, b.W - wc);
    let lo = 0, hi = span;
    if (b.attach?.type === 'tip') {
      const pr = corridorGlobal(b.parent);
      const p0 = toLocal(b, { x: pr.x0, y: pr.y0 }).v, p1 = toLocal(b, { x: pr.x1, y: pr.y1 }).v;
      c[bi] = snap(Math.min(p0, p1));
      continue;
    }
    if (b.attach?.type === 'slot') { lo = b.attach.childVRange[0]; hi = b.attach.childVRange[1] - wc; }
    for (const ch of b.children) {
      const cb = B[ch];
      if (cb.attach?.type !== 'tip') continue;
      const pa = toGlobalRect(cb, 0, 0.01, cb.attach.childVRange[0], cb.attach.childVRange[1]);
      const v0 = toLocal(b, { x: pa.x0, y: pa.y0 }).v, v1 = toLocal(b, { x: pa.x1, y: pa.y1 }).v;
      lo = Math.max(lo, Math.min(v0, v1)); hi = Math.min(hi, Math.max(v0, v1) - wc);
    }
    if (b.entry?.kind === 'end') {
      const half = ctx.entranceW / 2 + 0.05;
      const elo = b.entry.v + half - wc, ehi = b.entry.v - half;
      if (elo <= ehi) { lo = Math.max(lo, elo); hi = Math.min(hi, ehi); } else { lo = hi = b.entry.v - wc / 2; }
    }
    let x = g.cf[bi] * span;
    if (x < MIN_BAND) x = x < MIN_BAND / 2 ? 0 : MIN_BAND;
    if (span - x < MIN_BAND) x = span - x < MIN_BAND / 2 ? span : span - MIN_BAND;
    c[bi] = snap(clamp(x, Math.min(lo, hi), Math.max(lo, hi)));
    c[bi] = clamp(c[bi], 0, span);
  }
  // 2. slots (entry + wing connections) per block side
  const slots: Array<Array<{ side: Side; u0: number; u1: number }>> = B.map(() => []);
  for (let bi = 0; bi < B.length; bi++) {
    const b = B[bi];
    if (b.entry?.kind === 'side') slots[bi].push({ side: b.entry.side, u0: b.entry.u - ws / 2, u1: b.entry.u + ws / 2 });
    for (const ch of b.children) {
      const cb = B[ch];
      if (cb.attach?.type !== 'slot') continue;
      const gr = corridorGlobal(ch);
      const a = toLocal(b, { x: gr.x0, y: gr.y0 }).u, z = toLocal(b, { x: gr.x1, y: gr.y1 }).u;
      slots[bi].push({ side: cb.attach.side!, u0: Math.min(a, z), u1: Math.max(a, z) });
    }
    for (const s of slots[bi]) { s.u0 = snap(clamp(s.u0, 0, b.L)); s.u1 = snap(clamp(s.u1, 0, b.L)); }
  }
  // 3. targets
  const shellArea = ctx.area;
  const hallEst = B.reduce((s, b, bi) => s + b.L * wc + slots[bi].reduce((t, sl) => t + (sl.u1 - sl.u0) * (b.W - wc) / 2, 0), 0);
  const targetsAll = share(ctx.rooms, shellArea - hallEst);
  const regions = g.regions.map((r) => [...r]);
  // 4. end zones
  const E: Array<[number, number]> = B.map(() => [0, 0]);
  const overflow: number[] = [];
  defs.forEach((d, ri) => {
    if (d.kind !== 'E0' && d.kind !== 'E1') return;
    const b = B[d.block], k = d.kind === 'E0' ? 0 : 1;
    if (!regions[ri].length) return;
    const need = regions[ri].reduce((s, i) => s + targetsAll[i], 0) / b.W;
    const minDepth = Math.max(MIN_BAND, ...regions[ri].map((i) => ctx.rooms[i].minWidthM));
    E[d.block][k] = snap(Math.max(minDepth, need));
  });
  for (let bi = 0; bi < B.length; bi++) {
    const b = B[bi];
    const su0 = Math.min(b.L, ...slots[bi].map((s) => s.u0)), su1 = Math.max(0, ...slots[bi].map((s) => s.u1));
    let [e0, e1] = E[bi];
    e0 = Math.min(e0, su0); e1 = Math.min(e1, b.L - su1);
    const maxE = Math.max(0, b.L - Math.max(2.4, wc));
    if (e0 + e1 > maxE) { const k = maxE / (e0 + e1); e0 = snap(e0 * k); e1 = snap(e1 * k); }
    E[bi] = [e0 < 1.8 ? 0 : e0, e1 < 1.8 ? 0 : e1];
  }
  defs.forEach((d, ri) => {
    if ((d.kind === 'E0' && E[d.block][0] === 0) || (d.kind === 'E1' && E[d.block][1] === 0)) { overflow.push(...regions[ri]); regions[ri] = []; }
  });
  // Bands too thin to hold a room hand their rooms on.
  const depthOf = (d: RegionDef) => (d.kind === 'A' ? c[d.block] : d.kind === 'B' ? B[d.block].W - wc - c[d.block] : 99);
  defs.forEach((d, ri) => { if ((d.kind === 'A' || d.kind === 'B') && depthOf(d) < 1.5) { overflow.push(...regions[ri]); regions[ri] = []; } });
  if (overflow.length) {
    let best = -1, bd = -1;
    defs.forEach((d, ri) => { if (d.kind === 'A' || d.kind === 'B') { const a = depthOf(d) * B[d.block].L; if (depthOf(d) >= 1.5 && a > bd) { bd = a; best = ri; } } });
    if (best >= 0) regions[best].push(...overflow);
  }

  const placed: Placed[] = [];
  const hall: Rect[] = [];
  for (let bi = 0; bi < B.length; bi++) {
    const b = B[bi];
    const [e0, e1] = E[bi];
    const cs = c[bi];
    hall.push(toGlobalRect(b, e0, b.L - e1, cs, cs + wc));
    for (const side of ['A', 'B'] as const) {
      const v0 = side === 'A' ? 0 : cs + wc, v1 = side === 'A' ? cs : b.W;
      const D = v1 - v0;
      if (D < 1e-6) continue;
      const ri = defs.findIndex((d) => d.block === bi && d.kind === side);
      const list = ri >= 0 ? regions[ri] : [];
      // slots on this side, snapped to ends and merged
      const ss = slots[bi].filter((s) => s.side === side).map((s) => ({ ...s })).sort((p, q) => p.u0 - q.u0);
      const lo = e0, hi = b.L - e1;
      for (const s of ss) { s.u0 = Math.max(s.u0, lo); s.u1 = Math.min(s.u1, hi); if (s.u0 - lo < MIN_GAP) s.u0 = lo; if (hi - s.u1 < MIN_GAP) s.u1 = hi; }
      const merged: Array<{ u0: number; u1: number }> = [];
      for (const s of ss) {
        const last = merged[merged.length - 1];
        if (last && s.u0 - last.u1 < MIN_GAP) last.u1 = Math.max(last.u1, s.u1); else merged.push({ u0: s.u0, u1: s.u1 });
      }
      const gaps: Array<[number, number]> = [];
      let cur = lo;
      for (const m of merged) { if (m.u0 - cur > 1e-6) gaps.push([cur, m.u0]); cur = Math.max(cur, m.u1); }
      if (hi - cur > 1e-6) gaps.push([cur, hi]);
      for (const m of merged) if (m.u1 - m.u0 > 1e-6) hall.push(toGlobalRect(b, m.u0, m.u1, v0, v1));
      // distribute the ordered rooms into the gaps by the midpoint of their running width
      const totalLen = gaps.reduce((s, [a, z]) => s + z - a, 0);
      const wsum = list.reduce((s, i) => s + targetsAll[i], 0) || 1;
      const buckets: number[][] = gaps.map(() => []);
      let acc = 0;
      for (const i of list) {
        const mid = (acc + targetsAll[i] / 2) / wsum * totalLen; acc += targetsAll[i];
        let run = 0, k = 0;
        for (; k < gaps.length - 1; k++) { run += gaps[k][1] - gaps[k][0]; if (mid < run) break; }
        if (gaps.length) buckets[k].push(i);
      }
      for (let k = 0; k < gaps.length; k++) {
        if (buckets[k].length) continue;
        const prev = buckets[k - 1], next = buckets[k + 1];
        if (prev && prev.length > 1) buckets[k].push(prev.pop()!);
        else if (next && next.length > 1) buckets[k].push(next.shift()!);
      }
      for (let k = 0; k < gaps.length; k++) {
        const [a, z] = gaps[k];
        if (!buckets[k].length) { hall.push(toGlobalRect(b, a, z, v0, v1)); continue; }
        sliceBand(ctx, b, buckets[k], targetsAll, a, z, v0, v1, side, placed);
      }
    }
    for (const k of [0, 1] as const) {
      const ek = E[bi][k];
      if (!ek) continue;
      const ri = defs.findIndex((d) => d.block === bi && d.kind === (k === 0 ? 'E0' : 'E1'));
      const list = ri >= 0 ? regions[ri] : [];
      const u0 = k === 0 ? 0 : b.L - ek, u1 = k === 0 ? ek : b.L;
      if (!list.length) { hall.push(toGlobalRect(b, u0, u1, 0, b.W)); continue; }
      const t = share(list.map((i) => ctx.rooms[i]), ek * b.W);
      const tot = t.reduce((s, x) => s + x, 0);
      let v = 0;
      list.forEach((i, j) => {
        const nv = j === list.length - 1 ? b.W : snap(v + t[j] / tot * b.W);
        placed.push({ room: i, rects: [toGlobalRect(b, u0, u1, v, nv)], target: targetsAll[i] });
        v = nv;
      });
    }
  }
  return { placed, hall: hall.filter((r) => rArea(r) > 1e-4), c };
}

/** Slice one band segment [a, z] x [v0, v1] into rooms that all touch the hall side. */
function sliceBand(ctx: Ctx, b: Block, list: number[], targetsAll: number[], a: number, z: number, v0: number, v1: number, side: Side, out: Placed[]) {
  const D = v1 - v0, len = z - a;
  const rooms = list.map((i) => ctx.rooms[i]);
  const t = share(rooms, len * D);
  // rooms too narrow at full depth (and not needing daylight) sit against the hall in a cluster
  const cluster = rooms.map((r, j) => !r.needsWindow && (t[j] / D < r.minWidthM || D / (t[j] / D) > 2.2));
  // depth of the cluster strip: pick the depth that keeps cluster rooms best proportioned
  const cl = rooms.map((_, j) => j).filter((j) => cluster[j]);
  let dc = D;
  if (cl.length && cl.length < rooms.length) {
    let best = Infinity;
    for (let d = 1.2; d <= D - 1.0 + 1e-6; d += 0.05) {
      let cost = 0;
      for (const j of cl) {
        const w = t[j] / d, r = rooms[j];
        cost += Math.max(0, r.minWidthM - w) * 4 + Math.max(0, Math.max(w, d) / Math.min(w, d) - 2.0);
      }
      cost += d * 0.01;
      if (cost < best) { best = cost; dc = snap(d); }
    }
  }
  if (D - dc < 1.0) dc = D;
  // widths along the band
  const hallAtHigh = side === 'A'; // side A: hall at v1; side B: hall at v0
  const widths = rooms.map((_, j) => (cluster[j] && dc < D ? t[j] / dc : t[j] / D));
  // group consecutive cluster rooms; the strip behind each group joins a full-depth neighbour
  const absorb: Array<{ into: number; from: number; to: number }> = [];
  if (dc < D) {
    for (let j = 0; j < rooms.length;) {
      if (!cluster[j]) { j++; continue; }
      let k = j; while (k + 1 < rooms.length && cluster[k + 1]) k++;
      const into = j > 0 ? j - 1 : k + 1 < rooms.length ? k + 1 : -1;
      absorb.push({ into, from: j, to: k });
      if (into >= 0) {
        const groupW = widths.slice(j, k + 1).reduce((s, x) => s + x, 0);
        widths[into] = Math.max(0.6, widths[into] - groupW * (D - dc) / D);
      }
      j = k + 1;
    }
  }
  const sum = widths.reduce((s, x) => s + x, 0) || 1;
  const cuts: number[] = [a];
  let acc = a;
  for (let j = 0; j < rooms.length; j++) { acc += widths[j] / sum * len; cuts.push(j === rooms.length - 1 ? z : snap(acc)); }
  const rectsOf: Rect[][] = rooms.map(() => []);
  for (let j = 0; j < rooms.length; j++) {
    const u0 = cuts[j], u1 = cuts[j + 1];
    if (cluster[j] && dc < D) {
      const cv0 = hallAtHigh ? v1 - dc : v0, cv1 = hallAtHigh ? v1 : v0 + dc;
      rectsOf[j].push(toGlobalRect(b, u0, u1, cv0, cv1));
    } else rectsOf[j].push(toGlobalRect(b, u0, u1, v0, v1));
  }
  for (const ab of absorb) {
    const u0 = cuts[ab.from], u1 = cuts[ab.to + 1];
    const sv0 = hallAtHigh ? v0 : v0 + dc, sv1 = hallAtHigh ? v1 - dc : v1;
    const strip = toGlobalRect(b, u0, u1, sv0, sv1);
    if (ab.into >= 0) rectsOf[ab.into].push(strip);
    else rectsOf[ab.from].push(strip); // all cluster: the first one takes the full depth
  }
  rooms.forEach((_, j) => out.push({ room: list[j], rects: rectsOf[j].filter((r) => rArea(r) > 1e-4), target: targetsAll[list[j]] }));
}

// ---------- evaluation ----------

interface Eval {
  score: number;
  criteria: Criterion[];
  rooms: PlanRoom[];
  doors: PlanDoor[];
  windows: PlanWindow[];
  issues: string[];
  internalWallM: number;
  circulationM2: number;
  circulationShare: number;
}

function overlapOnLine(e: Seg, s: Seg): number {
  if (e.horizontal !== s.horizontal) return 0;
  if (e.horizontal) { if (Math.abs(e.a.y - s.a.y) > 1e-3) return 0; return Math.max(0, Math.min(e.b.x, s.b.x) - Math.max(e.a.x, s.a.x)); }
  if (Math.abs(e.a.x - s.a.x) > 1e-3) return 0;
  return Math.max(0, Math.min(e.b.y, s.b.y) - Math.max(e.a.y, s.a.y));
}
function overlapSegs(e: Seg, s: Seg): Seg | null {
  const l = overlapOnLine(e, s);
  if (l < 1e-3) return null;
  return e.horizontal
    ? { a: { x: Math.max(e.a.x, s.a.x), y: e.a.y }, b: { x: Math.min(e.b.x, s.b.x), y: e.a.y }, horizontal: true }
    : { a: { x: e.a.x, y: Math.max(e.a.y, s.a.y) }, b: { x: e.a.x, y: Math.min(e.b.y, s.b.y) }, horizontal: false };
}
const rectEdges = (r: Rect): Seg[] => [
  { a: { x: r.x0, y: r.y0 }, b: { x: r.x1, y: r.y0 }, horizontal: true },
  { a: { x: r.x0, y: r.y1 }, b: { x: r.x1, y: r.y1 }, horizontal: true },
  { a: { x: r.x0, y: r.y0 }, b: { x: r.x0, y: r.y1 }, horizontal: false },
  { a: { x: r.x1, y: r.y0 }, b: { x: r.x1, y: r.y1 }, horizontal: false },
];
/** p minus the part of it covered by o (both axis-aligned). */
function subtractSeg(p: Seg, o: Seg): Seg[] {
  const ov = overlapSegs(p, o);
  if (!ov) return [p];
  const h = p.horizontal;
  const [p0, p1] = h ? [p.a.x, p.b.x] : [p.a.y, p.b.y];
  const [o0, o1] = h ? [ov.a.x, ov.b.x] : [ov.a.y, ov.b.y];
  const mk = (s0: number, s1: number): Seg => (h ? { a: { x: s0, y: p.a.y }, b: { x: s1, y: p.a.y }, horizontal: true } : { a: { x: p.a.x, y: s0 }, b: { x: p.a.x, y: s1 }, horizontal: false });
  const out: Seg[] = [];
  if (o0 - p0 > 1e-3) out.push(mk(p0, o0));
  if (p1 - o1 > 1e-3) out.push(mk(o1, p1));
  return out;
}

/** Outer edges of a union of rectangles (edges not shared between its own rectangles). */
export function outerEdges(rects: Rect[]): Seg[] {
  const out: Seg[] = [];
  rects.forEach((r, i) => {
    for (const e of rectEdges(r)) {
      let parts: Seg[] = [e];
      rects.forEach((q, j) => { if (i !== j) for (const t of touching(r, q)) parts = parts.flatMap((p) => subtractSeg(p, t)); });
      out.push(...parts);
    }
  });
  return out;
}

function sharedBetween(a: Rect[], b: Rect[]): Seg[] {
  const segs: Seg[] = [];
  for (const p of a) for (const q of b) segs.push(...touching(p, q, 0.01));
  return segs.length ? mergeSegs(segs) : [];
}

const OPEN_PLAN = new Set(['living', 'kitchen', 'dining', 'cafe', 'counter']);

function evaluate(ctx: Ctx, lay: Layout): Eval {
  const issues: string[] = [];
  const rooms: PlanRoom[] = [];
  const hallId = 'hall';
  const hallRects = lay.hall;
  const mainRect = (rs: Rect[]) => rs.reduce((m, r) => (rArea(r) > rArea(m) ? r : m), rs[0]);
  const facadeOf = (rs: Rect[]) => {
    let f = 0, d = 0;
    for (const e of outerEdges(rs)) for (const s of ctx.facades) f += overlapOnLine(e, s);
    for (const e of outerEdges(rs)) for (const s of ctx.windowSegs) d += overlapOnLine(e, s);
    return { f, d };
  };
  {
    const fd = facadeOf(hallRects);
    const area = hallRects.reduce((s, r) => s + rArea(r), 0);
    const m = mainRect(hallRects);
    rooms.push({ id: hallId, programmeId: null, name: ctx.home ? 'Hall' : 'Corridor', purpose: 'hall', privacy: 'public', isHall: true, rects: hallRects, polygon: unionOutline(hallRects), areaM2: area, targetM2: 0, minAreaM2: 0, minWidthM: ctx.wc, widthM: m ? rShort(m) : 0, aspect: m ? rLong(m) / Math.max(0.01, rShort(m)) : 1, facadeM: fd.f, daylightM: fd.d, needsWindow: false });
  }
  for (const p of lay.placed) {
    const r = ctx.rooms[p.room];
    if (!p.rects.length) { issues.push(`${r.name} did not fit`); continue; }
    const m = mainRect(p.rects);
    const fd = facadeOf(p.rects);
    rooms.push({
      id: `room-${r.id}`, programmeId: r.id, name: r.name, purpose: r.purpose, privacy: r.privacy, isHall: false,
      rects: p.rects, polygon: unionOutline(p.rects), areaM2: p.rects.reduce((s, q) => s + rArea(q), 0), targetM2: r.preferredAreaM2,
      minAreaM2: r.minAreaM2, minWidthM: r.minWidthM, widthM: rShort(m), aspect: rLong(m) / Math.max(0.01, rShort(m)),
      facadeM: fd.f, daylightM: fd.d, needsWindow: r.needsWindow,
    });
  }
  const idx = new Map(rooms.map((r, i) => [r.id, i]));
  const n = rooms.length;
  // shared walls
  const shared: Seg[][][] = rooms.map(() => rooms.map(() => [] as Seg[]));
  let internalWallM = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const s = sharedBetween(rooms[i].rects, rooms[j].rects);
    shared[i][j] = s; shared[j][i] = s;
    internalWallM += s.reduce((t, q) => t + segLen(q), 0);
  }
  const sharedLen = (i: number, j: number) => shared[i][j].reduce((t, q) => t + segLen(q), 0);

  // doors
  const doors: PlanDoor[] = [];
  const doorW = (r: PlanRoom) => (['wc', 'storage', 'phone'].includes(r.purpose) ? Math.min(0.8, ctx.doorW) : ctx.doorW);
  const placeDoor = (i: number, j: number, w: number, kind: PlanDoor['kind'], swingInto: number) => {
    const segs = [...shared[i][j]].sort((p, q) => segLen(q) - segLen(p));
    const s = segs[0];
    if (!s || segLen(s) < w + 0.2) return false;
    const L = segLen(s);
    // near a corner of the room the door serves, closest to the entrance
    const along = (t: number) => (s.horizontal ? { x: s.a.x + t, y: s.a.y } : { x: s.a.x, y: s.a.y + t });
    const inset = L >= w + 0.5 ? 0.15 + w / 2 : L / 2;
    const c1 = along(inset), c2 = along(L - inset);
    const e = ctx.entrance;
    const at = Math.hypot(c1.x - e.x, c1.y - e.y) <= Math.hypot(c2.x - e.x, c2.y - e.y) ? c1 : c2;
    doors.push({ id: `door-${doors.length + 1}`, a: rooms[i].id, b: rooms[j].id, at: { x: r2(at.x), y: r2(at.y) }, horizontal: s.horizontal, widthM: w, kind, swingInto: rooms[swingInto].id });
    return true;
  };
  const connected = new Set<number>([0]);
  const viaPublic = (k: number) => rooms[k].isHall || rooms[k].privacy === 'public';
  const linked = new Set<string>();
  const key = (i: number, j: number) => (i < j ? `${i}-${j}` : `${j}-${i}`);
  for (let i = 1; i < n; i++) if (placeDoor(0, i, doorW(rooms[i]), 'door', i)) { connected.add(i); linked.add(key(0, i)); }
  for (let round = 0; round < n; round++) {
    let grew = false;
    for (let i = 1; i < n; i++) {
      if (connected.has(i)) continue;
      const opts = [...connected].filter((k) => viaPublic(k) && sharedLen(i, k) >= doorW(rooms[i]) + 0.2).sort((p, q) => sharedLen(i, q) - sharedLen(i, p));
      for (const k of opts) {
        const open = OPEN_PLAN.has(rooms[i].purpose) && OPEN_PLAN.has(rooms[k].purpose);
        if (placeDoor(k, i, open ? 1.2 : doorW(rooms[i]), open ? 'opening' : 'door', i)) { connected.add(i); linked.add(key(i, k)); grew = true; break; }
      }
    }
    if (!grew) break;
  }
  // open-plan pairs that asked to be together get an opening
  for (let i = 1; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (linked.has(key(i, j))) continue;
    const a = rooms[i], b = rooms[j];
    if (!OPEN_PLAN.has(a.purpose) || !OPEN_PLAN.has(b.purpose)) continue;
    const pa = ctx.rooms.find((r) => r.id === a.programmeId), pb = ctx.rooms.find((r) => r.id === b.programmeId);
    if (!pa?.adjacentTo.includes(b.programmeId!) && !pb?.adjacentTo.includes(a.programmeId!)) continue;
    if (placeDoor(i, j, 1.2, 'opening', j)) linked.add(key(i, j));
  }
  // entrance
  const roomAt = (p: Vec2) => rooms.findIndex((r) => outerEdges(r.rects).some((e) => overlapOnLine(e, e.horizontal ? { a: { x: p.x - 0.01, y: p.y }, b: { x: p.x + 0.01, y: p.y }, horizontal: true } : { a: { x: p.x, y: p.y - 0.01 }, b: { x: p.x, y: p.y + 0.01 }, horizontal: false }) > 0));
  const ent = roomAt(ctx.entrance);
  const facadeHorizontal = (p: Vec2) => ctx.facades.find((s) => overlapOnLine(s, s.horizontal ? { a: { x: p.x - 0.01, y: p.y }, b: { x: p.x + 0.01, y: p.y }, horizontal: true } : { a: { x: p.x, y: p.y - 0.01 }, b: { x: p.x, y: p.y + 0.01 }, horizontal: false }) > 0)?.horizontal ?? true;
  if (ent >= 0) doors.push({ id: 'entrance', a: rooms[ent].id, b: 'outside', at: ctx.entrance, horizontal: facadeHorizontal(ctx.entrance), widthM: ctx.entranceW, kind: 'door', swingInto: rooms[ent].id });
  ctx.extraEntrances.forEach((p, k) => {
    const ri = roomAt(p);
    if (ri >= 0) doors.push({ id: `exit-${k + 1}`, a: rooms[ri].id, b: 'outside', at: p, horizontal: facadeHorizontal(p), widthM: ctx.entranceW, kind: 'door', swingInto: rooms[ri].id });
  });
  if (ent !== 0) issues.push('The entrance does not open into the hall');

  // reachability without passing through private rooms
  const adj: number[][] = rooms.map(() => []);
  for (const d of doors) { if (d.b === 'outside') continue; const i = idx.get(d.a)!, j = idx.get(d.b)!; adj[i].push(j); adj[j].push(i); }
  const start = ent >= 0 ? ent : 0;
  const dist = new Array(n).fill(Infinity);
  dist[start] = 0;
  const entryPt: Vec2[] = rooms.map(() => ctx.entrance);
  const queue = [start];
  const seen = new Set([start]);
  while (queue.length) {
    queue.sort((p, q) => dist[p] - dist[q]);
    const i = queue.shift()!;
    if (i !== start && !viaPublic(i)) continue;
    for (const d of doors) {
      if (d.b === 'outside') continue;
      const a = idx.get(d.a)!, b = idx.get(d.b)!;
      const j = a === i ? b : b === i ? a : -1;
      if (j < 0) continue;
      const nd = dist[i] + Math.abs(d.at.x - entryPt[i].x) + Math.abs(d.at.y - entryPt[i].y);
      if (nd < dist[j]) { dist[j] = nd; entryPt[j] = d.at; if (!seen.has(j)) { seen.add(j); queue.push(j); } else queue.push(j); }
    }
  }
  const progRooms = rooms.filter((r) => !r.isHall);
  const reached = progRooms.filter((r) => Number.isFinite(dist[idx.get(r.id)!])).length;
  const missing = ctx.rooms.length - progRooms.length;
  for (const r of progRooms) if (!Number.isFinite(dist[idx.get(r.id)!])) issues.push(`${r.name} cannot be reached without passing through a private room`);

  // criteria
  const C: Criterion[] = [];
  const reachScore = ctx.rooms.length ? reached / ctx.rooms.length : 1;
  C.push({ id: 'reach', name: 'Every room reachable', score: reachScore * (ent === 0 ? 1 : 0.8), weight: 3, value: reached, unit: 'rooms', detail: `${reached} of ${ctx.rooms.length} rooms reachable from the entrance through the hall${ent === 0 ? '' : '; entrance not into the hall'}` });

  let propOk = 0;
  for (const r of progRooms) {
    const sliver = r.rects.some((q) => rShort(q) < 0.9);
    const ok = r.aspect <= 2.22 && r.widthM >= r.minWidthM - 0.02 && !sliver;
    if (ok) propOk++;
    else if (r.widthM < r.minWidthM - 0.02) issues.push(`${r.name} is ${r.widthM.toFixed(2)} m wide (needs ${r.minWidthM.toFixed(1)} m)`);
    else if (sliver) issues.push(`${r.name} has a narrow leg`);
    else issues.push(`${r.name} is long and thin (1:${r.aspect.toFixed(1)})`);
  }
  const propScore = progRooms.length ? propOk / ctx.rooms.length : 1;
  C.push({ id: 'proportion', name: 'Proportions & widths', score: propScore, weight: 2.5, value: propOk, unit: 'rooms', detail: `${propOk} of ${ctx.rooms.length} rooms between 1:1 and 1:2.2 and at least their minimum width` });

  let fitSum = 0, devSum = 0;
  for (const r of progRooms) {
    const dev = (r.areaM2 - r.targetM2) / r.targetM2;
    devSum += Math.abs(dev);
    let s = clamp(1 - Math.abs(dev) * 1.6, 0, 1);
    if (r.areaM2 < r.minAreaM2 * 0.97) { s = 0; issues.push(`${r.name} is ${r.areaM2.toFixed(1)} m² (minimum ${r.minAreaM2} m²)`); }
    fitSum += s;
  }
  const areaScore = ctx.rooms.length ? fitSum / ctx.rooms.length : 1;
  const meanDev = progRooms.length ? devSum / progRooms.length : 0;
  C.push({ id: 'area', name: 'Area fit', score: areaScore, weight: 2, value: Math.round(meanDev * 100), unit: '%', detail: `Rooms are on average ${Math.round(meanDev * 100)}% off their preferred area` });

  const needs = progRooms.filter((r) => r.needsWindow);
  const lit = needs.filter((r) => r.daylightM >= 1.0);
  for (const r of needs) if (r.daylightM < 1.0) issues.push(`${r.name} has no facade for a window`);
  C.push({ id: 'daylight', name: 'Daylight', score: needs.length ? lit.length / needs.length : 1, weight: 2, value: lit.length, unit: 'rooms', detail: `${lit.length} of ${needs.length} rooms that need a window are on a facade` });

  const pairs = new Map<string, [string, string]>();
  for (const r of ctx.rooms) for (const a of r.adjacentTo) { const k = [r.id, a].sort().join('|'); if (!pairs.has(k)) pairs.set(k, [r.id, a]); }
  let adjOk = 0;
  for (const [a, b] of pairs.values()) {
    const i = idx.get(`room-${a}`), j = idx.get(`room-${b}`);
    if (i != null && j != null && sharedLen(i, j) >= 0.9) adjOk++;
  }
  C.push({ id: 'adjacency', name: 'Adjacencies', score: pairs.size ? adjOk / pairs.size : 1, weight: 1, value: adjOk, unit: 'pairs', detail: `${adjOk} of ${pairs.size} wanted neighbours share a wall` });

  const total = rooms.reduce((s, r) => s + r.areaM2, 0);
  const circ = rooms[0].areaM2;
  const share = total ? circ / total : 0;
  const circScore = share < 0.08 ? clamp(1 - (0.08 - share) / 0.05, 0, 1) : share > 0.15 ? clamp(1 - (share - 0.15) / 0.1, 0, 1) : 1;
  C.push({ id: 'circulation', name: 'Circulation share', score: circScore, weight: 1, value: Math.round(share * 1000) / 10, unit: '%', detail: `Hall is ${circ.toFixed(1)} m², ${(share * 100).toFixed(1)}% of the floor (target 8-15%)` });

  const pub = progRooms.filter((r) => r.privacy === 'public' && Number.isFinite(dist[idx.get(r.id)!]));
  const pri = progRooms.filter((r) => r.privacy === 'private' && Number.isFinite(dist[idx.get(r.id)!]));
  let good = 0, all = 0;
  for (const p of pub) for (const q of pri) { all++; if (dist[idx.get(p.id)!] <= dist[idx.get(q.id)!] + 0.5) good++; }
  C.push({ id: 'privacy', name: 'Privacy gradient', score: all ? good / all : 1, weight: 1, value: all ? Math.round(good / all * 100) : 100, unit: '%', detail: `${all ? Math.round(good / all * 100) : 100}% of public rooms come before private rooms on the way in` });

  const hallPerim = outerEdges(hallRects).reduce((s, e) => s + segLen(e), 0);
  const ideal = Math.max(1, (progRooms.reduce((s, r) => s + 4 * Math.sqrt(r.areaM2), 0) + hallPerim - ctx.perimeter) / 2);
  C.push({ id: 'walls', name: 'Wall length (cost)', score: clamp(ideal / Math.max(1, internalWallM), 0, 1), weight: 0.75, value: Math.round(internalWallM * 10) / 10, unit: 'm', detail: `${internalWallM.toFixed(1)} m of internal walls` });

  const wet = progRooms.filter((r) => isWet(r));
  let wetOk = 0;
  for (const r of wet) {
    const i = idx.get(r.id)!;
    const near = wet.some((o) => {
      if (o === r) return false;
      const j = idx.get(o.id)!;
      if (sharedLen(i, j) > 0.5) return true;
      const a = rCentre(mainRectOf(r)), b = rCentre(mainRectOf(o));
      return Math.hypot(a.x - b.x, a.y - b.y) <= 4.5;
    });
    if (near) wetOk++;
  }
  C.push({ id: 'wet', name: 'Wet rooms grouped', score: wet.length > 1 ? wetOk / wet.length : 1, weight: 0.75, value: wetOk, unit: 'rooms', detail: wet.length > 1 ? `${wetOk} of ${wet.length} wet rooms next to or near another wet room` : 'One wet room' });

  if (missing > 0) issues.push(`${missing} room${missing > 1 ? 's' : ''} did not fit`);
  const wsum = C.reduce((s, c) => s + c.weight, 0);
  let score = C.reduce((s, c) => s + c.score * c.weight, 0) / wsum * 100;
  if (ent !== 0) score -= 8;
  score -= missing * 10;

  // windows
  const windows: PlanWindow[] = [];
  for (const r of rooms) {
    if (ctx.fixedWindows.length) {
      for (const e of outerEdges(r.rects)) for (const s of ctx.fixedWindows) { const o = overlapSegs(e, s); if (o && segLen(o) >= 0.4) windows.push({ roomId: r.id, a: o.a, b: o.b }); }
      continue;
    }
    if (!r.needsWindow) continue;
    const segs: Seg[] = [];
    for (const e of outerEdges(r.rects)) for (const s of ctx.windowSegs) { const o = overlapSegs(e, s); if (o && segLen(o) >= 1.0) segs.push(o); }
    for (const s of segs) {
      // keep the entrance clear
      const L = segLen(s);
      const bays = Math.max(1, Math.floor(L / 3.2));
      const ww = clamp(Math.min(L / bays - 0.6, r.purpose === 'living' ? 2.4 : 1.6), 0.6, 2.4);
      for (let k = 0; k < bays; k++) {
        const mid = (k + 0.5) * L / bays;
        const p0 = mid - ww / 2, p1 = mid + ww / 2;
        const pt = (t: number) => (s.horizontal ? { x: r2(s.a.x + t), y: s.a.y } : { x: s.a.x, y: r2(s.a.y + t) });
        const a = pt(p0), b = pt(p1);
        const nearDoor = doors.some((d) => d.b === 'outside' && Math.hypot(d.at.x - (a.x + b.x) / 2, d.at.y - (a.y + b.y) / 2) < (ww + d.widthM) / 2 + 0.2);
        if (!nearDoor) windows.push({ roomId: r.id, a, b });
      }
    }
  }
  return { score, criteria: C, rooms, doors, windows, issues, internalWallM, circulationM2: circ, circulationShare: share };
}
const mainRectOf = (r: PlanRoom) => r.rects.reduce((m, q) => (rArea(q) > rArea(m) ? q : m), r.rects[0]);

// ---------- search ----------

function initialGenome(ctx: Ctx, fam: Family, defs: RegionDef[], rnd: () => number, variant: number): Genome {
  const regions: number[][] = defs.map(() => []);
  const cf = fam.blocks.map(() => 0.5);
  const cap = defs.map((d) => (d.kind === 'A' || d.kind === 'B' ? fam.blocks[d.block].L * Math.max(0, (fam.blocks[d.block].W - ctx.wc) / 2) : 0));
  const order = ctx.rooms.map((_, i) => i).sort((a, b) => ctx.rooms[b].preferredAreaM2 - ctx.rooms[a].preferredAreaM2 || a - b);
  const ends = defs.map((d, i) => (d.kind === 'E0' || d.kind === 'E1' ? i : -1)).filter((i) => i >= 0);
  if (variant % 2 === 1 && ends.length) {
    // seed an end zone with the public rooms (living across the far end)
    const ez = ends[Math.floor(rnd() * ends.length)];
    for (const i of order.filter((i) => ctx.rooms[i].privacy === 'public').slice(0, 2)) regions[ez].push(i);
  }
  for (const i of order) {
    if (regions.some((r) => r.includes(i))) continue;
    let best = -1, bc = -Infinity;
    cap.forEach((c, ri) => { if (c - (rnd() * 0.15 * c) > bc && (defs[ri].kind === 'A' || defs[ri].kind === 'B')) { bc = c; best = ri; } });
    if (best < 0) best = 0;
    regions[best].push(i);
    cap[best] -= ctx.rooms[i].preferredAreaM2;
  }
  return { regions, cf };
}

function mutate(g: Genome, rnd: () => number): Genome {
  const regions = g.regions.map((r) => [...r]);
  const cf = [...g.cf];
  const nonEmpty = regions.map((r, i) => (r.length ? i : -1)).filter((i) => i >= 0);
  const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
  const m = rnd();
  if (m < 0.32 && nonEmpty.length) {
    const from = pick(nonEmpty), k = Math.floor(rnd() * regions[from].length);
    const [room] = regions[from].splice(k, 1);
    const to = Math.floor(rnd() * regions.length);
    regions[to].splice(Math.floor(rnd() * (regions[to].length + 1)), 0, room);
  } else if (m < 0.62 && nonEmpty.length) {
    const a = pick(nonEmpty), b = pick(nonEmpty);
    const i = Math.floor(rnd() * regions[a].length), j = Math.floor(rnd() * regions[b].length);
    [regions[a][i], regions[b][j]] = [regions[b][j], regions[a][i]];
  } else if (m < 0.78 && nonEmpty.length) {
    const a = pick(nonEmpty);
    if (regions[a].length > 1) { const i = Math.floor(rnd() * (regions[a].length - 1)); [regions[a][i], regions[a][i + 1]] = [regions[a][i + 1], regions[a][i]]; }
  } else if (m < 0.84 && nonEmpty.length) {
    regions[pick(nonEmpty)].reverse();
  } else {
    const b = Math.floor(rnd() * cf.length);
    cf[b] = clamp(cf[b] + (rnd() - 0.5) * 0.25, 0, 1);
  }
  return { regions, cf };
}

interface Run { fam: Family; famIndex: number; g: Genome; ev: Eval; lay: Layout; seed: number }

function optimise(ctx: Ctx, fam: Family, famIndex: number, seed: number, iters: number, variant: number): Run {
  const defs = regionDefs(fam);
  const rnd = seeded(seed);
  let g = initialGenome(ctx, fam, defs, rnd, variant);
  let lay = decode(ctx, fam, defs, g);
  let ev = evaluate(ctx, lay);
  let best: Run = { fam, famIndex, g, ev, lay, seed };
  let T = 6;
  const cool = Math.pow(0.05 / T, 1 / Math.max(1, iters));
  for (let it = 0; it < iters; it++) {
    const g2 = mutate(g, rnd);
    const l2 = decode(ctx, fam, defs, g2);
    const e2 = evaluate(ctx, l2);
    if (e2.score >= ev.score || rnd() < Math.exp((e2.score - ev.score) / T)) {
      g = g2; lay = l2; ev = e2;
      if (ev.score > best.ev.score) best = { fam, famIndex, g, ev, lay, seed };
    }
    T *= cool;
  }
  return best;
}

function describe(ctx: Ctx, run: Run): { name: string; summary: string } {
  const b0 = run.fam.blocks[0];
  const along = b0.axis === 'x' ? 'east-west' : 'north-south';
  const single = run.lay.c[0] < 0.05 || run.lay.c[0] > b0.W - ctx.wc - 0.05;
  const endRooms = run.ev.rooms.filter((r) => !r.isHall && r.rects.length === 1 && rLong(r.rects[0]) >= b0.W - 0.01 && b0.W > 4).map((r) => r.name);
  const wing = run.fam.blocks.length > 1 ? ', hall turns into the wing' : '';
  const name = `${single ? 'Single-sided hall' : 'Central hall'} ${along}${endRooms.length ? `, ${endRooms[0].toLowerCase()} across the end` : ''}${wing}`;
  const c = (id: Criterion['id']) => run.ev.criteria.find((x) => x.id === id)!;
  const summary = `${c('circulation').value}% circulation, ${run.ev.internalWallM.toFixed(1)} m internal walls, ${c('daylight').value}/${ctx.rooms.filter((r) => r.needsWindow).length} daylit`;
  return { name: name.charAt(0).toUpperCase() + name.slice(1), summary };
}

/**
 * Plan a whole floor. `shell` is the inner face of the outer walls (rectilinear, metres);
 * entrances and windows are given on its walls. Returns distinct options, best first.
 */
export function planBuilding(shell: Vec2[], entrances: ShellEntrance[], windows: ShellWindow[], programme: RoomProgramme, opts: PlanOptions = {}): BuildingPlan[] {
  const raw = shell;
  const poly = normaliseShell(shell);
  if (!programme.rooms.length) return [];
  // entrances / windows are given against the caller's wall numbering
  const entPts = (entrances.length ? entrances : [{ wallIndex: 0, offsetM: Math.hypot(raw[1].x - raw[0].x, raw[1].y - raw[0].y) / 2 }]).map((e) => {
    const p = pointOnWall(raw, e.wallIndex, e.offsetM);
    return { x: r2(p.x), y: r2(p.y) };
  });
  const facades = mergeSegs(poly.map((_, i) => wallSeg(poly, i)));
  const fixed = windows.filter((w) => w.offsetM != null && w.widthM != null).map((w) => wallSeg(raw, w.wallIndex, w.offsetM! - w.widthM! / 2, w.offsetM! + w.widthM! / 2));
  const wallWin = windows.filter((w) => w.offsetM == null || w.widthM == null).map((w) => wallSeg(raw, w.wallIndex));
  const windowSegs = windows.length ? mergeSegs([...wallWin, ...fixed]) : facades;
  let perim = 0; for (let i = 0; i < poly.length; i++) perim += Math.hypot(poly[(i + 1) % poly.length].x - poly[i].x, poly[(i + 1) % poly.length].y - poly[i].y);
  const ctx: Ctx = {
    shell: poly, area: Math.abs(signedArea(poly)), perimeter: perim, facades, windowSegs, fixedWindows: fixed,
    entrance: entPts[0], entranceW: entrances[0]?.widthM ?? 1.0, extraEntrances: entPts.slice(1),
    rooms: programme.rooms, wc: opts.corridorWidthM ?? programme.corridorWidthM ?? 1.2,
    home: programme.kind === 'home', doorW: programme.kind === 'home' ? 0.9 : 1.0,
  };
  if (!onFacade(ctx, ctx.entrance)) throw new Error('The entrance must be on an outer wall');
  const fams = families(ctx);
  if (!fams.length) throw new Error('Could not find a hall layout for this shell');
  const seed = opts.seed ?? 1;
  const iters = opts.iterations ?? 1400;
  const runs: Run[] = [];
  fams.forEach((f, fi) => {
    for (let v = 0; v < 2; v++) runs.push(optimise(ctx, f, fi, (seed * 7919 + fi * 104729 + v * 1299709) >>> 0, iters, v));
  });
  runs.sort((a, b) => b.ev.score - a.ev.score);
  // pick distinct options: best per family first, then others that differ in room placement
  const count = Math.max(1, opts.count ?? 3);
  const sig = (r: Run) => `${r.famIndex}:${r.ev.rooms.filter((x) => !x.isHall).map((x) => `${x.programmeId}@${Math.round(rCentre(mainRectOf(x)).x)},${Math.round(rCentre(mainRectOf(x)).y)}`).sort().join(';')}`;
  const chosen: Run[] = [];
  const seenSig = new Set<string>();
  const usedFam = new Set<number>();
  for (const r of runs) { if (chosen.length >= count) break; if (usedFam.has(r.famIndex)) continue; usedFam.add(r.famIndex); seenSig.add(sig(r)); chosen.push(r); }
  for (const r of runs) { if (chosen.length >= count) break; const s = sig(r); if (seenSig.has(s)) continue; seenSig.add(s); chosen.push(r); }
  chosen.sort((a, b) => b.ev.score - a.ev.score);
  const exteriorWallM = opts.exteriorWallM ?? 0.3, interiorWallM = opts.interiorWallM ?? 0.1;
  return chosen.map((r, k) => {
    const d = describe(ctx, r);
    return {
      id: `plan-${seed}-${k + 1}`, name: d.name, summary: d.summary, family: r.fam.key, seed: r.seed, shell: poly,
      rooms: r.ev.rooms, doors: r.ev.doors, windows: r.ev.windows, criteria: r.ev.criteria, score: Math.round(r.ev.score * 10) / 10,
      internalWallM: Math.round(r.ev.internalWallM * 10) / 10, circulationM2: Math.round(r.ev.circulationM2 * 10) / 10,
      circulationShare: r.ev.circulationShare, totalAreaM2: Math.round(ctx.area * 10) / 10, corridorWidthM: ctx.wc,
      exteriorWallM, interiorWallM, issues: [...new Set(r.ev.issues)],
    };
  });
}

/** Convenience shells. */
export const rectShell = (w: number, d: number): Vec2[] => rectPoly({ x0: 0, y0: 0, x1: w, y1: d });
/** L-shape: full width w across the top `armD` metres, then a `legW` wide leg down to depth d on the left. */
export function lShell(w: number, d: number, legW: number, armD: number): Vec2[] {
  return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: armD }, { x: legW, y: armD }, { x: legW, y: d }, { x: 0, y: d }];
}
