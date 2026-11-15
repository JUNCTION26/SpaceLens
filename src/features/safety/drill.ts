// Fire drill: a deterministic walk-out of everyone in the plan. People start at seats and beds,
// follow the shortest clear path to the nearest open exit, slow down in passages narrower than
// 0.9 m and queue at every door and tight gap. Pure: no DOM, no store.
import { area, centroid, distPointPolygonEdges, pointInPolygon } from '../../core/geometry';
import type { FurnitureItem, SpaceModel, Vec2 } from '../../core/types';
import { smooth } from '../sim/grid';
import { isOutdoor } from '../sim/walls';
import { seatsOf } from './assess';
import { buildSafetyGrid, cellAt, centre, chain, exitCells, shortest, type DoorInfo, type Field, type SafetyGrid } from './field';

export const DRILL = {
  speedMS: 1.2,
  narrowM: 0.9,
  /** One person per this many seconds for each 0.8 m of clear width. */
  headwayS: 0.75,
  headwayWidthM: 0.8,
  bodyRadiusM: 0.2,
  queueSpacingM: 0.45,
  targetS: 150,
  dwellingM2PerPerson: 10,
  officeM2PerPerson: 5,
  /** Timeline sample step, seconds. */
  dt: 0.25,
} as const;

export interface DrillOptions {
  seed?: number;
  /** Total people; default from room areas. */
  occupants?: number;
  /** Explicit start points (tests, replays). Overrides occupants. */
  starts?: Vec2[];
  /** Fire origin; default is the middle of the fullest room. */
  fire?: Vec2;
  /** Block the exit nearest the fire. */
  blockExit?: boolean;
  exitOverrides?: Record<string, boolean>;
}

export interface DrillPerson {
  id: number;
  start: Vec2;
  exitId: string | null;
  escaped: boolean;
  /** Seconds after the alarm when the person is through the exit door. */
  exitS: number | null;
  /** Position every `dt` seconds from 0 until exitS (or just the start when stuck). */
  track: Vec2[];
  waitS: number;
}

export interface Bottleneck {
  id: string;
  kind: 'door' | 'gap';
  at: Vec2;
  widthM: number;
  queue: number;
  lostS: number;
  doorId?: string;
  itemIds: string[];
}

export interface DrillFix { label: string; itemId?: string; openingId?: string }

export interface DrillExit { id: string; label: string; at: Vec2; widthM: number; blocked: boolean }

export interface DrillResult {
  people: DrillPerson[];
  dt: number;
  totalS: number;
  allOut: boolean;
  pass: boolean;
  fire: Vec2;
  blockedId: string | null;
  exits: DrillExit[];
  bottleneck: Bottleneck | null;
  fix: DrillFix | null;
  occupants: number;
}

function rng(seed: number) {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const OFFICE_RE = /office|work|meeting|conference|class|studio|lab|open space/i;
const DESK_RE = /desk|workstation/i;

function roomIsOffice(model: SpaceModel, i: number, furniture: FurnitureItem[]): boolean {
  const s = model.spaces[i];
  if (OFFICE_RE.test(`${s.purpose ?? ''} ${s.name}`)) return true;
  const desks = furniture.filter((f) => DESK_RE.test(`${f.category} ${f.name}`) && pointInPolygon(f, s.polygon)).length;
  return desks >= 3;
}

/** Default head count per room: 1 per 10 m² in dwellings, 1 per 5 m² in offices. */
export function defaultOccupants(model: SpaceModel, furniture: FurnitureItem[]): number[] {
  return model.spaces.map((s, i) => {
    if (s.polygon.length < 3 || isOutdoor(s)) return 0;
    const per = roomIsOffice(model, i, furniture) ? DRILL.officeM2PerPerson : DRILL.dwellingM2PerPerson;
    return Math.max(1, Math.round(area(s.polygon) / per));
  });
}

function seatSpots(f: FurnitureItem, all: FurnitureItem[]): Vec2[] {
  const n = seatsOf(f, all);
  if (!n) return [];
  const ax = { x: Math.cos(f.rotation), y: Math.sin(f.rotation) };
  const fwd = { x: -Math.sin(f.rotation), y: Math.cos(f.rotation) };
  if (DESK_RE.test(`${f.category} ${f.name}`)) return [{ x: f.x + fwd.x * (f.d / 2 + 0.4), y: f.y + fwd.y * (f.d / 2 + 0.4) }];
  return Array.from({ length: n }, (_, i) => {
    const o = (i + 0.5 - n / 2) * (f.w / n);
    return { x: f.x + ax.x * o, y: f.y + ax.y * o };
  });
}

interface Gate {
  id: string;
  kind: 'door' | 'gap';
  at: Vec2;
  widthM: number;
  doorId?: string;
  next: number;
  passes: number[];
  maxQueue: number;
  maxWait: number;
  users: number;
}

interface PathGate { gate: Gate; s: number }

const dst = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

function nearbyItems(g: SafetyGrid, p: Vec2, reach: number): string[] {
  return g.items.filter((it) => distPointPolygonEdges(p, it.poly) <= reach || pointInPolygon(p, it.poly)).map((it) => it.f.id);
}

export function runDrill(model: SpaceModel, furniture: FurnitureItem[], opts: DrillOptions = {}): DrillResult {
  const rand = rng(opts.seed ?? 1);
  const g = buildSafetyGrid(model, furniture, opts.exitOverrides ?? {});
  const tol = g.cell / 2;
  const ok = (i: number) => g.free[i] === 1 && g.dist[i] + tol >= DRILL.bodyRadiusM;
  const allExits = g.doors.filter((d) => d.exit);

  // ---- who and where
  const spaceOfCell = (i: number) => g.room[i];
  let starts: Vec2[] = [];
  const roomPeople = defaultOccupants(model, furniture);
  if (opts.starts) starts = opts.starts.slice();
  else {
    let counts = roomPeople.slice();
    const total = counts.reduce((a, b) => a + b, 0);
    if (opts.occupants != null && total > 0) {
      const target = Math.max(0, Math.round(opts.occupants));
      const shares = counts.map((c) => (c / total) * target);
      const base = shares.map(Math.floor);
      let left = target - base.reduce((a, b) => a + b, 0);
      const order = shares.map((s, i) => [s - base[i], i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
      for (const [, i] of order) { if (left <= 0) break; base[i]++; left--; }
      counts = base;
    }
    model.spaces.forEach((s, r) => {
      const n = counts[r];
      if (!n) return;
      const seats = furniture.filter((f) => pointInPolygon(f, s.polygon)).flatMap((f) => seatSpots(f, furniture)).filter((p) => pointInPolygon(p, s.polygon));
      // seeded shuffle
      for (let i = seats.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [seats[i], seats[j]] = [seats[j], seats[i]]; }
      const chosen = seats.slice(0, n);
      if (chosen.length < n) {
        const cells: number[] = [];
        for (let i = 0; i < g.free.length; i++) if (spaceOfCell(i) === r && g.free[i] && g.dist[i] >= 0.35) cells.push(i);
        const pool = cells.length ? cells : [];
        while (chosen.length < n && pool.length) chosen.push(centre(g, pool[Math.floor(rand() * pool.length)]));
      }
      starts.push(...chosen);
    });
  }

  // ---- fire and the blocked exit
  const peopleByRoom = model.spaces.map((s) => starts.filter((p) => pointInPolygon(p, s.polygon)).length);
  const fullest = Math.max(0, peopleByRoom.indexOf(Math.max(...peopleByRoom, 0)));
  const fire = opts.fire ?? (model.spaces[fullest] ? centroid(model.spaces[fullest].polygon) : { x: 0, y: 0 });
  let blocked: DoorInfo | null = null;
  if (opts.blockExit && allExits.length) blocked = allExits.reduce((b, d) => (dst(d.c, fire) < dst(b.c, fire) ? d : b), allExits[0]);
  const open = allExits.filter((d) => d !== blocked);

  const exits: DrillExit[] = allExits.map((d) => ({ id: d.id, label: d.label, at: d.c, widthM: d.widthM, blocked: d === blocked }));

  // ---- fields per open exit
  const penalty = (i: number) => (g.dist[i] < 0.45 ? (0.45 - g.dist[i]) * 4 : 0);
  const fields: Array<{ d: DoorInfo; f: Field }> = open.map((d) => ({ d, f: shortest(g, exitCells(g, d), ok, penalty) }));
  const gates = new Map<string, Gate>();
  const gapGates: Gate[] = [];

  interface Walker {
    p: DrillPerson; pts: Vec2[]; cum: number[]; T: number[]; gates: PathGate[]; gi: number;
    t: number; s: number; segs: Array<{ t0: number; t1: number; s0: number; s1: number }>; done: boolean; L: number;
  }
  const walkers: Walker[] = [];
  const people: DrillPerson[] = [];

  starts.forEach((st0, id) => {
    const person: DrillPerson = { id, start: st0, exitId: null, escaped: false, exitS: null, track: [st0], waitS: 0 };
    people.push(person);
    if (!fields.length) return;
    // nearest reachable cell, then the exit with the shortest walk
    let ci = cellAt(g, st0);
    if (ci < 0 || !ok(ci) || fields.every((x) => !Number.isFinite(x.f.len[ci]))) {
      let best = -1, bd = Infinity;
      const c0 = cellAt(g, st0);
      const R = 40;
      const cx = c0 % g.cols, cy = Math.floor(c0 / g.cols);
      if (c0 >= 0) for (let dr = -R; dr <= R; dr++) for (let dc = -R; dc <= R; dc++) {
        const r = cy + dr, c = cx + dc; if (r < 0 || c < 0 || r >= g.rows || c >= g.cols) continue;
        const i = r * g.cols + c; if (!ok(i) || fields.every((x) => !Number.isFinite(x.f.len[i]))) continue;
        const d = dr * dr + dc * dc; if (d < bd) { bd = d; best = i; }
      }
      ci = best;
    }
    if (ci < 0) return;
    const st = centre(g, ci);
    person.start = st; person.track = [st];
    let pick = fields[0], pl = Infinity;
    for (const x of fields) { const l = x.f.len[ci]; if (l < pl) { pl = l; pick = x; } }
    if (!Number.isFinite(pl)) return;
    const cells = chain(pick.f, ci);
    let pts: Vec2[] = [st, ...cells.map((c) => centre(g, c))];
    pts = smooth(g, pts, 0.45);
    // densify to 5 cm so widths and speeds are sampled along the real line
    const dense: Vec2[] = [pts[0]];
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1], b = pts[k], L = dst(a, b), n = Math.max(1, Math.ceil(L / 0.05));
      for (let q = 1; q <= n; q++) dense.push({ x: a.x + (b.x - a.x) * q / n, y: a.y + (b.y - a.y) * q / n });
    }
    const cum = [0];
    for (let k = 1; k < dense.length; k++) cum.push(cum[k - 1] + dst(dense[k - 1], dense[k]));
    const T = [0];
    const widthAtK: number[] = [];
    for (let k = 0; k < dense.length; k++) {
      const c = cellAt(g, dense[k]);
      widthAtK.push(c < 0 ? 0 : 2 * g.dist[c]);
    }
    for (let k = 1; k < dense.length; k++) {
      const w = Math.min(widthAtK[k], widthAtK[k - 1]);
      const f = w >= DRILL.narrowM ? 1 : Math.max(0.35, w / DRILL.narrowM);
      T.push(T[k - 1] + (cum[k] - cum[k - 1]) / (DRILL.speedMS * f));
    }
    // gates on this path: every door crossed, every narrow stretch, then the exit door
    const pg: PathGate[] = [];
    const L = cum[cum.length - 1];
    let k = 0;
    while (k < dense.length) {
      const c = cellAt(g, dense[k]);
      const di = c >= 0 ? g.door[c] : -1;
      if (di >= 0 && di !== pick.d.idx) {
        let e = k; while (e + 1 < dense.length) { const c2 = cellAt(g, dense[e + 1]); if (c2 < 0 || g.door[c2] !== di) break; e++; }
        const d = g.doors[di];
        let bk = k, bd = Infinity; for (let q = k; q <= e; q++) { const dd = dst(dense[q], d.c); if (dd < bd) { bd = dd; bk = q; } }
        const gid = `door:${d.id}`;
        if (!gates.has(gid)) gates.set(gid, { id: gid, kind: 'door', at: d.c, widthM: d.widthM, doorId: d.id, next: 0, passes: [], maxQueue: 0, maxWait: 0, users: 0 });
        pg.push({ gate: gates.get(gid)!, s: cum[bk] });
        k = e + 1; continue;
      }
      if (di < 0 && widthAtK[k] < DRILL.narrowM) {
        let e = k;
        while (e + 1 < dense.length) { const c2 = cellAt(g, dense[e + 1]); if (c2 < 0 || g.door[c2] >= 0 || widthAtK[e + 1] >= DRILL.narrowM) break; e++; }
        let bk = k; for (let q = k; q <= e; q++) if (widthAtK[q] < widthAtK[bk]) bk = q;
        const at = dense[bk];
        let gate = gapGates.find((x) => dst(x.at, at) < 0.6);
        if (!gate) {
          gate = { id: `gap:${gapGates.length}`, kind: 'gap', at, widthM: widthAtK[bk], next: 0, passes: [], maxQueue: 0, maxWait: 0, users: 0 };
          gapGates.push(gate); gates.set(gate.id, gate);
        } else gate.widthM = Math.min(gate.widthM, widthAtK[bk]);
        pg.push({ gate, s: cum[bk] });
        k = e + 1; continue;
      }
      k++;
    }
    const exitGid = `door:${pick.d.id}`;
    if (!gates.has(exitGid)) gates.set(exitGid, { id: exitGid, kind: 'door', at: pick.d.c, widthM: pick.d.widthM, doorId: pick.d.id, next: 0, passes: [], maxQueue: 0, maxWait: 0, users: 0 });
    // the exit door is always the last gate, at the end of the path
    const last = pg.findIndex((x) => x.gate.id === exitGid);
    if (last >= 0) pg.splice(last, 1);
    pg.push({ gate: gates.get(exitGid)!, s: L });
    pg.sort((a, b) => a.s - b.s);
    person.exitId = pick.d.id;
    walkers.push({ p: person, pts: dense, cum, T, gates: pg, gi: 0, t: 0, s: 0, segs: [], done: false, L });
  });

  // ---- time
  const tOfS = (w: Walker, s: number) => {
    const { cum, T } = w;
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < s) lo = m + 1; else hi = m; }
    if (lo === 0) return 0;
    const f = (s - cum[lo - 1]) / ((cum[lo] - cum[lo - 1]) || 1);
    return T[lo - 1] + (T[lo] - T[lo - 1]) * f;
  };
  const sOfT = (w: Walker, tw: number) => {
    const { cum, T } = w;
    if (tw <= 0) return 0;
    if (tw >= T[T.length - 1]) return cum[cum.length - 1];
    let lo = 0, hi = T.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (T[m] < tw) lo = m + 1; else hi = m; }
    const f = (tw - T[lo - 1]) / ((T[lo] - T[lo - 1]) || 1);
    return cum[lo - 1] + (cum[lo] - cum[lo - 1]) * f;
  };
  const posAtS = (w: Walker, s: number): Vec2 => {
    const { cum, pts } = w;
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < s) lo = m + 1; else hi = m; }
    if (lo === 0) return pts[0];
    const f = (s - cum[lo - 1]) / ((cum[lo] - cum[lo - 1]) || 1);
    return { x: pts[lo - 1].x + (pts[lo].x - pts[lo - 1].x) * f, y: pts[lo - 1].y + (pts[lo].y - pts[lo - 1].y) * f };
  };

  type Seg = Walker['segs'][number];
  const arrival = (w: Walker) => w.t + tOfS(w, w.gates[w.gi].s) - tOfS(w, w.s);
  for (;;) {
    let w: Walker | null = null, wa = Infinity;
    for (const x of walkers) if (!x.done) { const a = arrival(x); if (a < wa - 1e-9 || (Math.abs(a - wa) <= 1e-9 && w && x.p.id < w.p.id)) { wa = a; w = x; } }
    if (!w) break;
    const { gate, s: sg } = w.gates[w.gi];
    const head = DRILL.headwayS * DRILL.headwayWidthM / Math.max(0.2, gate.widthM);
    const pass = Math.max(wa, gate.next);
    const ahead = gate.passes.filter((x) => x > wa + 1e-9).length;
    gate.next = pass + head; gate.passes.push(pass); gate.users++;
    gate.maxQueue = Math.max(gate.maxQueue, ahead + 1);
    const lost = pass - wa;
    if (lost > gate.maxWait) gate.maxWait = lost;
    w.p.waitS += lost;
    const push = (t0: number, t1: number, s0: number, s1: number) => { if (t1 - t0 > 1e-9 || Math.abs(s1 - s0) > 1e-9) w!.segs.push({ t0, t1, s0, s1 }); };
    if (lost > 1e-6) {
      const sq = Math.max(w.s, sg - DRILL.queueSpacingM * ahead);
      const tq = w.t + tOfS(w, sq) - tOfS(w, w.s);
      const tgo = pass - (tOfS(w, sg) - tOfS(w, sq));
      push(w.t, tq, w.s, sq);
      push(tq, Math.max(tq, tgo), sq, sq);
      push(Math.max(tq, tgo), pass, sq, sg);
    } else push(w.t, pass, w.s, sg);
    w.t = pass; w.s = sg; w.gi++;
    if (w.gi >= w.gates.length) { w.done = true; w.p.escaped = true; w.p.exitS = pass; }
  }

  // ---- timelines
  const posAt = (w: Walker, t: number): Vec2 => {
    const sg = w.segs;
    let seg: Seg | undefined = sg[0];
    for (const x of sg) { if (t >= x.t0) seg = x; else break; }
    if (!seg) return w.pts[0];
    if (t >= seg.t1) return posAtS(w, seg.s1);
    if (seg.s0 === seg.s1) return posAtS(w, seg.s0);
    const base = tOfS(w, seg.s0) + (t - seg.t0);
    return posAtS(w, Math.min(seg.s1, sOfT(w, base)));
  };
  for (const w of walkers) {
    const end = w.p.exitS ?? 0;
    const n = Math.ceil(end / DRILL.dt);
    w.p.track = [];
    for (let k = 0; k <= n; k++) w.p.track.push(posAt(w, Math.min(end, k * DRILL.dt)));
  }

  const exitTimes = people.map((p) => p.exitS).filter((x): x is number => x != null);
  const allOut = people.length > 0 && people.every((p) => p.escaped);
  const totalS = exitTimes.length ? Math.max(...exitTimes) : 0;

  // ---- worst bottleneck and the fix that answers it
  let worst: Gate | null = null;
  for (const gt of gates.values()) if (gt.maxWait >= 0.5 && (!worst || gt.maxWait > worst.maxWait)) worst = gt;
  let bottleneck: Bottleneck | null = null;
  if (worst) {
    const reach = worst.kind === 'door' ? Math.max(0.9, worst.widthM) : Math.max(0.5, worst.widthM);
    bottleneck = { id: worst.id, kind: worst.kind, at: worst.at, widthM: worst.widthM, queue: worst.maxQueue, lostS: Math.round(worst.maxWait * 10) / 10, doorId: worst.doorId, itemIds: nearbyItems(g, worst.at, reach) };
  }
  let fix: DrillFix | null = null;
  if (bottleneck) {
    const it = furniture.find((f) => bottleneck!.itemIds.includes(f.id) && !f.locked) ?? furniture.find((f) => bottleneck!.itemIds.includes(f.id));
    const word = it ? (it.category || it.name).toLowerCase().replace(/[^a-z ]+/g, ' ').trim().split(/\s+/).slice(-1)[0] : '';
    if (it && word) fix = { label: `Move ${word}`, itemId: it.id };
    else if (bottleneck.kind === 'door' && bottleneck.doorId) fix = bottleneck.widthM < 0.9 ? { label: 'Widen door', openingId: bottleneck.doorId } : { label: 'Add exit' };
    else fix = { label: 'Widen gap' };
  } else if (!allOut && people.length) fix = { label: 'Add exit' };

  return { people, dt: DRILL.dt, totalS, allOut, pass: allOut && totalS <= DRILL.targetS, fire, blockedId: blocked?.id ?? null, exits, bottleneck, fix, occupants: people.length };
}

/** Where a person is at time t, or null once they are out. */
export function personAt(p: DrillPerson, t: number, dt: number): Vec2 | null {
  if (!p.track.length) return null;
  if (p.exitS != null && t >= p.exitS) return null;
  const f = Math.max(0, t) / dt, i = Math.min(p.track.length - 1, Math.floor(f));
  const a = p.track[i], b = p.track[Math.min(p.track.length - 1, i + 1)], u = Math.min(1, f - i);
  return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
}

export const fmtClock = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
