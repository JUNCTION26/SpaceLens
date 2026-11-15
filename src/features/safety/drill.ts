// Fire drill: a deterministic walk-out of everyone in the plan. People start at seats and beds, wait
// out a reaction delay, then walk the clear path to the exit with the shortest expected time (walk
// plus the queue ahead). Walking speed depends on the person type and falls with crowd density and
// counter-flow; doors and tight gaps pass people at a rate set by their clear width; a growing fire
// closes cells so late leavers reroute. Every figure comes from DRILL or DRILL_ASSUMPTIONS below.
// Pure: no DOM, no store.
import { area, centroid, distPointPolygonEdges, pointInPolygon } from '../../core/geometry';
import type { FurnitureItem, SpaceModel, Vec2 } from '../../core/types';
import { smooth } from '../sim/grid';
import { isOutdoor } from '../sim/walls';
import { seatsOf } from './assess';
import { buildSafetyGrid, cellAt, centre, chain, exitCells, shortest, type DoorInfo, type Field, type SafetyGrid } from './field';

export const DRILL = {
  /** Adult free-flow speed; kept for importers, see PERSON_TYPES for the per-type values. */
  speedMS: 1.2,
  narrowM: 0.9,
  /** Door and gap flow: persons per second per metre of effective width (SFPE handbook value, 1.3). */
  flowPerMS: 1.3,
  /** Boundary layer left unused at each side of a door and of a tight gap, metres. */
  doorEdgeM: 0.15,
  gapEdgeM: 0.1,
  /** Kept for importers: nominal headway at 0.8 m. */
  headwayS: 0.75,
  headwayWidthM: 0.8,
  bodyRadiusM: 0.2,
  queueSpacingM: 0.45,
  targetS: 150,
  dwellingM2PerPerson: 10,
  officeM2PerPerson: 5,
  /** Timeline sample step, seconds. */
  dt: 0.25,
  /** Crowd window radius for density and counter-flow, metres. */
  crowdRadiusM: 1.2,
  /** Speed lost when everyone nearby walks the opposite way (scaled by the opposing share). */
  counterFlowLoss: 0.25,
  /** Fire radius at the alarm, metres, and how fast it grows; capped at fireCapM. */
  fireStartM: 0.5,
  fireGrowthMS: 0.015,
  fireCapM: 3,
  /** Smoke margin kept clear around the fire edge, metres. */
  fireMarginM: 0.3,
  /** Fire cells are refreshed this often, seconds. */
  fireStageS: 20,
  /** A person may switch exit once, if the wait at the first exit is at least this long and the other exit saves this much. */
  switchMinWaitS: 8,
  switchMarginS: 5,
  switchAtShare: 0.4,
} as const;

export type PersonType = 'adult' | 'child' | 'mobility';
export type DrillUse = 'dwelling' | 'office';

export interface DrillAssumption { id: string; title: string; value: number; unit: string; basis: string }

export const PERSON_TYPES: Record<PersonType, { label: string; speedMS: number; assumptionId: string }> = {
  adult: { label: 'Adult', speedMS: 1.2, assumptionId: 'drill-speed-adult' },
  child: { label: 'Child', speedMS: 0.9, assumptionId: 'drill-speed-child' },
  mobility: { label: 'Reduced mobility', speedMS: 0.7, assumptionId: 'drill-speed-mobility' },
};

/** Share of each person type by use. Planning assumptions, not statistics for any one building. */
export const TYPE_SHARES: Record<DrillUse, Record<PersonType, number>> = {
  dwelling: { adult: 0.65, child: 0.25, mobility: 0.1 },
  office: { adult: 0.93, child: 0, mobility: 0.07 },
};

/** Seconds from the alarm until a person starts to move, by use (before a +-25% seeded spread). */
export const REACTION_S: Record<DrillUse, number> = { dwelling: 60, office: 30 };

export const DRILL_ASSUMPTIONS: Record<string, DrillAssumption> = {
  'drill-speed-adult': { id: 'drill-speed-adult', title: 'Adult walking speed', value: 1.2, unit: 'm/s', basis: 'Planning assumption: unimpeded walking speed of an adult.' },
  'drill-speed-child': { id: 'drill-speed-child', title: 'Child walking speed', value: 0.9, unit: 'm/s', basis: 'Planning assumption: shorter stride than an adult.' },
  'drill-speed-mobility': { id: 'drill-speed-mobility', title: 'Reduced-mobility walking speed', value: 0.7, unit: 'm/s', basis: 'Planning assumption: a person who walks slowly or with an aid.' },
  'drill-share-dwelling': { id: 'drill-share-dwelling', title: 'Household mix', value: 65, unit: '% adults', basis: 'Planning assumption: 65% adults, 25% children, 10% reduced mobility.' },
  'drill-share-office': { id: 'drill-share-office', title: 'Workplace mix', value: 93, unit: '% adults', basis: 'Planning assumption: 93% adults, 7% reduced mobility.' },
  'drill-reaction-dwelling': { id: 'drill-reaction-dwelling', title: 'Reaction delay, dwelling', value: 60, unit: 's', basis: 'Planning assumption: people may be asleep or unsure the alarm is real.' },
  'drill-reaction-office': { id: 'drill-reaction-office', title: 'Reaction delay, workplace', value: 30, unit: 's', basis: 'Planning assumption: awake and used to alarm tests.' },
  'drill-flow': { id: 'drill-flow', title: 'Door and gap flow', value: 1.3, unit: 'persons/s per m', basis: 'Specific flow through an opening, applied to its width minus a boundary layer at each side (0.15 m door, 0.10 m gap).' },
  'drill-density': { id: 'drill-density', title: 'Speed falls with density', value: 5.4, unit: 'persons/m2', basis: 'Walking speed times 1 - exp(-1.913 (1/density - 1/5.4)); standstill at 5.4 persons per square metre.' },
  'drill-counterflow': { id: 'drill-counterflow', title: 'Counter-flow slowing', value: 25, unit: '% at most', basis: 'Planning assumption: speed lost in proportion to the share of neighbours walking the other way.' },
  'drill-fire': { id: 'drill-fire', title: 'Fire growth', value: 0.015, unit: 'm/s', basis: 'Planning assumption: fire edge starts at 0.5 m and grows 1.5 cm per second up to 3 m; cells inside it are closed to later leavers.' },
  'drill-target': { id: 'drill-target', title: 'Target time out', value: 150, unit: 's', basis: 'Planning assumption: everyone out within 2.5 minutes of the alarm.' },
};

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
  /** Everyone is this type (tests). */
  mix?: PersonType;
  /** Everyone reacts after exactly this many seconds (tests). */
  reactionS?: number;
  /** Fire growth, m/s; 0 keeps the fire at its starting size. */
  fireGrowthMS?: number;
  /** Allow one exit switch per person. Default true. */
  switching?: boolean;
  /** Turn density and counter-flow slowing off (tests). */
  freeFlow?: boolean;
}

export type DrillState = 'waiting' | 'walking' | 'queuing';

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
  type: PersonType;
  speedMS: number;
  /** Seconds before the person starts to move. */
  reactionS: number;
  /** Lowest speed factor met on the way, 1 = free flow. */
  slowestFactor: number;
  /** Time-ordered phases covering 0..exitS. */
  phases: Array<{ state: DrillState; t0: number; t1: number }>;
  /** Exit first chosen, when the person changed their mind once on the way. */
  switchedFrom?: string;
}

export interface Bottleneck {
  id: string;
  kind: 'door' | 'gap';
  at: Vec2;
  widthM: number;
  queue: number;
  /** Seconds the longest-waiting person lost here. */
  lostS: number;
  /** Length of the queue behind the opening, metres. */
  lengthM: number;
  doorId?: string;
  itemIds: string[];
}

export interface DrillFix { label: string; itemId?: string; openingId?: string }

export interface DrillExit { id: string; label: string; at: Vec2; widthM: number; blocked: boolean; used: number; closedByFireS: number | null }

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
  /** Seconds until 50, 90 and 100% of people are out; null when that share never got out. */
  timeTo: { p50: number | null; p90: number | null; p100: number | null };
  targetS: number;
  targetMet: boolean;
  stuck: number;
  switched: number;
  /** Fire radius over time, for drawing. */
  fireTrace: Array<{ t: number; radiusM: number }>;
  /** What was compromised or assumed, in words. */
  notes: string[];
  assumptions: DrillAssumption[];
}

export function fireRadius(t: number, growthMS: number = DRILL.fireGrowthMS): number {
  return Math.min(DRILL.fireCapM, DRILL.fireStartM + Math.max(0, growthMS) * Math.max(0, t));
}

/** Seconds between people through an opening of this clear width. */
export function headwayFor(widthM: number, edgeM: number = DRILL.doorEdgeM): number {
  return 1 / (DRILL.flowPerMS * Math.max(0.2, widthM - 2 * edgeM));
}

/** Walking speed factor at a density in persons per square metre (1 at open floor, 0.05 at a crush). */
export function densityFactor(rho: number): number {
  if (rho <= 0.01) return 1;
  return Math.min(1, Math.max(0.05, 1 - Math.exp(-1.913 * (1 / rho - 1 / 5.4))));
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

/** Largest-remainder split of n people over weights, deterministic. */
function split(n: number, weights: number[]): number[] {
  const tot = weights.reduce((a, b) => a + b, 0) || 1;
  const sh = weights.map((w) => (w / tot) * n);
  const base = sh.map(Math.floor);
  let left = n - base.reduce((a, b) => a + b, 0);
  const order = sh.map((s, i) => [s - base[i], i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) { if (left <= 0) break; base[i]++; left--; }
  return base;
}

interface Plan { ci: number; exit: DoorInfo; first?: { dense: Vec2[]; exit: DoorInfo; stg: number } }

interface Walker {
  p: DrillPerson; plan: Plan; pts: Vec2[]; cum: number[]; T: number[]; nf: number[]; fac: number[]; gates: PathGate[]; gi: number;
  t: number; s: number; segs: Array<{ t0: number; t1: number; s0: number; s1: number }>; done: boolean; L: number; r: number; v: number; exitWait: number;
}

export function runDrill(model: SpaceModel, furniture: FurnitureItem[], opts: DrillOptions = {}): DrillResult {
  const rand = rng(opts.seed ?? 1);
  const g = buildSafetyGrid(model, furniture, opts.exitOverrides ?? {});
  const tol = g.cell / 2;
  const ok = (i: number) => g.free[i] === 1 && g.dist[i] + tol >= DRILL.bodyRadiusM;
  const allExits = g.doors.filter((d) => d.exit);
  const growth = opts.fireGrowthMS ?? DRILL.fireGrowthMS;
  const notes: string[] = [];

  // ---- who and where
  let starts: Vec2[] = [];
  const roomPeople = defaultOccupants(model, furniture);
  if (opts.starts) starts = opts.starts.slice();
  else {
    let counts = roomPeople.slice();
    const total = counts.reduce((a, b) => a + b, 0);
    if (opts.occupants != null && total > 0) counts = split(Math.max(0, Math.round(opts.occupants)), counts);
    model.spaces.forEach((s, r) => {
      const n = counts[r];
      if (!n) return;
      const seats = furniture.filter((f) => pointInPolygon(f, s.polygon)).flatMap((f) => seatSpots(f, furniture)).filter((p) => pointInPolygon(p, s.polygon));
      for (let i = seats.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [seats[i], seats[j]] = [seats[j], seats[i]]; }
      const chosen = seats.slice(0, n);
      if (chosen.length < n) {
        const cells: number[] = [];
        for (let i = 0; i < g.free.length; i++) if (g.room[i] === r && g.free[i] && g.dist[i] >= 0.35) cells.push(i);
        while (chosen.length < n && cells.length) chosen.push(centre(g, cells[Math.floor(rand() * cells.length)]));
      }
      starts.push(...chosen);
    });
  }

  // ---- person types, speeds, reaction delays (by the use of the room they start in)
  const useOf = (p: Vec2): DrillUse => {
    const r = model.spaces.findIndex((s) => s.polygon.length >= 3 && pointInPolygon(p, s.polygon));
    return r >= 0 && roomIsOffice(model, r, furniture) ? 'office' : 'dwelling';
  };
  const uses = starts.map(useOf);
  const types: PersonType[] = starts.map(() => 'adult');
  if (opts.mix) types.fill(opts.mix);
  else for (const use of ['dwelling', 'office'] as DrillUse[]) {
    const idx = uses.map((u, i) => (u === use ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) continue;
    const order: PersonType[] = ['adult', 'child', 'mobility'];
    const cnt = split(idx.length, order.map((k) => TYPE_SHARES[use][k]));
    const bag = order.flatMap((k, j) => Array<PersonType>(cnt[j]).fill(k));
    for (let i = bag.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [bag[i], bag[j]] = [bag[j], bag[i]]; }
    idx.forEach((pi, j) => { types[pi] = bag[j]; });
  }
  const reaction = starts.map((_, i) => (opts.reactionS != null ? Math.max(0, opts.reactionS) : REACTION_S[uses[i]] * (0.75 + 0.5 * rand())));

  // ---- fire and the blocked exit
  const peopleByRoom = model.spaces.map((s) => starts.filter((p) => pointInPolygon(p, s.polygon)).length);
  const fullest = Math.max(0, peopleByRoom.indexOf(Math.max(...peopleByRoom, 0)));
  const fire = opts.fire ?? (model.spaces[fullest] ? centroid(model.spaces[fullest].polygon) : { x: 0, y: 0 });
  let blocked: DoorInfo | null = null;
  if (opts.blockExit && allExits.length) blocked = allExits.reduce((b, d) => (dst(d.c, fire) < dst(b.c, fire) ? d : b), allExits[0]);
  const open = allExits.filter((d) => d !== blocked);
  const penalty = (i: number) => (g.dist[i] < 0.45 ? (0.45 - g.dist[i]) * 4 : 0);

  // cells closed by the fire, refreshed per stage; fields per open exit per stage
  const stageCache = new Map<number, { ok: (i: number) => boolean; fields: Array<{ d: DoorInfo; f: Field | null }> }>();
  const stage = (k: number) => {
    let c = stageCache.get(k);
    if (c) return c;
    const rad = fireRadius(k * DRILL.fireStageS, growth) + DRILL.fireMarginM;
    const fb = new Uint8Array(g.cols * g.rows);
    const r2 = rad * rad;
    for (let i = 0; i < fb.length; i++) {
      const x = g.ox + ((i % g.cols) + 0.5) * g.cell - fire.x, y = g.oy + (Math.floor(i / g.cols) + 0.5) * g.cell - fire.y;
      if (x * x + y * y <= r2) fb[i] = 1;
    }
    const okF = (i: number) => ok(i) && !fb[i];
    const fields = open.map((d) => {
      const src = exitCells(g, d);
      if (!src.length || src.every((i) => fb[i])) return { d, f: null };
      return { d, f: shortest(g, src, okF, penalty) };
    });
    c = { ok: okF, fields };
    stageCache.set(k, c);
    return c;
  };
  const stageOf = (t: number) => Math.floor(t / DRILL.fireStageS);

  // ---- choose a start cell and exit for everyone, in order of decision time
  const people: DrillPerson[] = starts.map((st0, id) => ({
    id, start: st0, exitId: null, escaped: false, exitS: null, track: [st0], waitS: 0, type: types[id], speedMS: PERSON_TYPES[types[id]].speedMS,
    reactionS: reaction[id], slowestFactor: 1, phases: [],
  }));
  const plans: Array<Plan | null> = people.map(() => null);
  const estFree = new Map<string, number>();
  const order = people.map((p) => p.id).sort((a, b) => reaction[a] - reaction[b] || a - b);
  for (const id of order) {
    const person = people[id];
    const st = stage(stageOf(reaction[id]));
    if (!st.fields.some((x) => x.f)) continue;
    const reach = (i: number) => st.fields.some((x) => x.f && Number.isFinite(x.f.len[i]));
    let ci = cellAt(g, person.start);
    if (ci < 0 || !st.ok(ci) || !reach(ci)) {
      const c0 = cellAt(g, person.start);
      let best = -1, bd = Infinity;
      if (c0 >= 0) {
        const R = 40, cx = c0 % g.cols, cy = Math.floor(c0 / g.cols);
        for (let dr = -R; dr <= R; dr++) for (let dc = -R; dc <= R; dc++) {
          const r = cy + dr, c = cx + dc; if (r < 0 || c < 0 || r >= g.rows || c >= g.cols) continue;
          const i = r * g.cols + c; if (!st.ok(i) || !reach(i)) continue;
          const d = dr * dr + dc * dc; if (d < bd) { bd = d; best = i; }
        }
      }
      ci = best;
    }
    if (ci < 0) continue;
    person.start = centre(g, ci); person.track = [person.start];
    // expected finish at each exit = walk + the queue already assigned to it
    let pick: DoorInfo | null = null, pf = Infinity, parr = 0;
    for (const x of st.fields) {
      if (!x.f || !Number.isFinite(x.f.len[ci])) continue;
      const arr = reaction[id] + x.f.len[ci] / person.speedMS;
      const fin = Math.max(arr, estFree.get(x.d.id) ?? 0) + headwayFor(x.d.widthM);
      if (fin < pf - 1e-9) { pf = fin; pick = x.d; parr = arr; }
    }
    if (!pick) continue;
    estFree.set(pick.id, Math.max(parr, estFree.get(pick.id) ?? 0) + headwayFor(pick.widthM));
    plans[id] = { ci, exit: pick };
  }

  // ---- paths, gates, speeds
  const densify = (pts: Vec2[]): Vec2[] => {
    const dense: Vec2[] = [pts[0]];
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1], b = pts[k], L = dst(a, b), n = Math.max(1, Math.ceil(L / 0.05));
      for (let q = 1; q <= n; q++) dense.push({ x: a.x + (b.x - a.x) * q / n, y: a.y + (b.y - a.y) * q / n });
    }
    return dense;
  };
  const cellsDense = (ci: number, f: Field, from?: Vec2): Vec2[] => {
    const st = from ?? centre(g, ci);
    return densify(smooth(g, [st, ...chain(f, ci).map((c) => centre(g, c))], 0.45));
  };

  const build = (list: Array<Plan | null>) => {
    const gates = new Map<string, Gate>();
    const gapGates: Gate[] = [];
    const walkers: Walker[] = [];
    list.forEach((plan, id) => {
      if (!plan) return;
      const person = people[id];
      let dense: Vec2[];
      if (plan.first) {
        const fb = stage(plan.first.stg).fields.find((x) => x.d === plan.exit)?.f;
        const tail = fb ? cellsDense(plan.ci, fb, plan.first.dense[plan.first.dense.length - 1]) : [];
        dense = [...plan.first.dense, ...tail.slice(1)];
      } else {
        const f = stage(stageOf(reaction[id])).fields.find((x) => x.d === plan.exit)!.f!;
        dense = cellsDense(plan.ci, f, person.start);
      }
      const cum = [0];
      for (let k = 1; k < dense.length; k++) cum.push(cum[k - 1] + dst(dense[k - 1], dense[k]));
      const widthAtK = dense.map((p) => { const c = cellAt(g, p); return c < 0 ? 0 : 2 * g.dist[c]; });
      const nf = [1];
      for (let k = 1; k < dense.length; k++) { const w = Math.min(widthAtK[k], widthAtK[k - 1]); nf.push(w >= DRILL.narrowM ? 1 : Math.max(0.35, w / DRILL.narrowM)); }
      const T = [0];
      for (let k = 1; k < dense.length; k++) T.push(T[k - 1] + (cum[k] - cum[k - 1]) / (person.speedMS * nf[k]));
      const exitDoor = plan.exit;
      const pg: PathGate[] = [];
      const L = cum[cum.length - 1];
      let k = 0;
      while (k < dense.length) {
        const c = cellAt(g, dense[k]);
        const di = c >= 0 ? g.door[c] : -1;
        if (di >= 0 && di !== exitDoor.idx) {
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
      const exitGid = `door:${exitDoor.id}`;
      if (!gates.has(exitGid)) gates.set(exitGid, { id: exitGid, kind: 'door', at: exitDoor.c, widthM: exitDoor.widthM, doorId: exitDoor.id, next: 0, passes: [], maxQueue: 0, maxWait: 0, users: 0 });
      const last = pg.findIndex((x) => x.gate.id === exitGid);
      if (last >= 0) pg.splice(last, 1);
      pg.push({ gate: gates.get(exitGid)!, s: L });
      pg.sort((a, b) => a.s - b.s);
      person.exitId = exitDoor.id;
      walkers.push({ p: person, plan, pts: dense, cum, T, nf, fac: dense.map(() => 1), gates: pg, gi: 0, t: 0, s: 0, segs: [], done: false, L, r: reaction[id], v: person.speedMS, exitWait: 0 });
    });
    return { gates, walkers };
  };

  const idxOfS = (cum: number[], s: number) => {
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < s) lo = m + 1; else hi = m; }
    return lo;
  };
  const tOfS = (w: Walker, s: number) => {
    const lo = idxOfS(w.cum, s);
    if (lo === 0) return 0;
    const f = (s - w.cum[lo - 1]) / ((w.cum[lo] - w.cum[lo - 1]) || 1);
    return w.T[lo - 1] + (w.T[lo] - w.T[lo - 1]) * f;
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
    const lo = idxOfS(w.cum, s);
    if (lo === 0) return w.pts[0];
    const f = (s - w.cum[lo - 1]) / ((w.cum[lo] - w.cum[lo - 1]) || 1);
    return { x: w.pts[lo - 1].x + (w.pts[lo].x - w.pts[lo - 1].x) * f, y: w.pts[lo - 1].y + (w.pts[lo].y - w.pts[lo - 1].y) * f };
  };

  /** Slow people by local density and counter-flow, from where everyone is when walking freely. */
  const crowd = (walkers: Walker[]) => {
    if (opts.freeFlow || walkers.length < 2) return;
    const STEP = 0.5, R = DRILL.crowdRadiusM, area = Math.PI * R * R;
    for (let iter = 0; iter < 2; iter++) {
      const bk = new Map<string, Array<{ id: number; x: number; y: number; hx: number; hy: number }>>();
      for (const w of walkers) {
        const end = w.r + w.T[w.T.length - 1];
        for (let t = 0; t <= end + 1e-9; t += STEP) {
          const s = t <= w.r ? 0 : sOfT(w, t - w.r);
          const a = posAtS(w, s), b = posAtS(w, Math.min(w.L, s + 0.3));
          const hl = Math.hypot(b.x - a.x, b.y - a.y);
          const key = `${Math.round(t / STEP)}|${Math.floor(a.x)}|${Math.floor(a.y)}`;
          let arr = bk.get(key); if (!arr) { arr = []; bk.set(key, arr); }
          arr.push({ id: w.p.id, x: a.x, y: a.y, hx: t <= w.r || hl < 1e-6 ? 0 : (b.x - a.x) / hl, hy: t <= w.r || hl < 1e-6 ? 0 : (b.y - a.y) / hl });
        }
      }
      for (const w of walkers) {
        const stride = 5;
        for (let k = 0; k < w.pts.length; k += stride) {
          const t = w.r + w.T[k], p = w.pts[k], q = w.pts[Math.min(w.pts.length - 1, k + 6)];
          const hl = Math.hypot(q.x - p.x, q.y - p.y) || 1, hx = (q.x - p.x) / hl, hy = (q.y - p.y) / hl;
          const sk = Math.round(t / STEP), bx = Math.floor(p.x), by = Math.floor(p.y);
          let n = 0, opp = 0;
          for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
            const arr = bk.get(`${sk}|${bx + dx}|${by + dy}`); if (!arr) continue;
            for (const o of arr) {
              if (o.id === w.p.id || Math.hypot(o.x - p.x, o.y - p.y) > R) continue;
              n++; if (o.hx * hx + o.hy * hy < -0.3) opp++;
            }
          }
          const f = Math.min(densityFactor((n + 1) / area), 1) * (1 - DRILL.counterFlowLoss * (n ? opp / n : 0));
          for (let j = k; j < Math.min(w.pts.length, k + stride); j++) w.fac[j] = f;
        }
        for (let k = 1; k < w.pts.length; k++) w.T[k] = w.T[k - 1] + (w.cum[k] - w.cum[k - 1]) / (w.v * w.nf[k] * w.fac[k]);
      }
    }
    for (const w of walkers) w.p.slowestFactor = Math.round(Math.min(1, ...w.fac) * 100) / 100;
  };

  type Seg = Walker['segs'][number];
  const simulate = (walkers: Walker[]) => {
    for (const w of walkers) w.t = w.r;
    const arrival = (w: Walker) => w.t + tOfS(w, w.gates[w.gi].s) - tOfS(w, w.s);
    for (;;) {
      let w: Walker | null = null, wa = Infinity;
      for (const x of walkers) if (!x.done) { const a = arrival(x); if (a < wa - 1e-9 || (Math.abs(a - wa) <= 1e-9 && w && x.p.id < w.p.id)) { wa = a; w = x; } }
      if (!w) break;
      const { gate, s: sg } = w.gates[w.gi];
      const head = headwayFor(gate.widthM, gate.kind === 'door' ? DRILL.doorEdgeM : DRILL.gapEdgeM);
      const pass = Math.max(wa, gate.next);
      const ahead = gate.passes.filter((x) => x >= wa - 1e-9).length;
      gate.next = pass + head; gate.passes.push(pass); gate.users++;
      gate.maxQueue = Math.max(gate.maxQueue, ahead + 1);
      const lost = pass - wa;
      if (lost > gate.maxWait) gate.maxWait = lost;
      w.p.waitS += lost;
      if (w.gi === w.gates.length - 1) w.exitWait = lost;
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
  };

  // round 1
  let round = build(plans);
  crowd(round.walkers);
  simulate(round.walkers);

  // round 2: anyone who waited long at their exit may switch once, at the switch point, if another exit is quicker
  let switched = 0;
  if (opts.switching !== false && open.length > 1 && round.walkers.length) {
    const wait = new Map<string, { sum: number; n: number }>();
    for (const w of round.walkers) { const e = wait.get(w.plan.exit.id) ?? { sum: 0, n: 0 }; e.sum += w.exitWait; e.n++; wait.set(w.plan.exit.id, e); }
    const extra = new Map<string, number>();
    const plans2 = plans.slice();
    const changed: number[] = [];
    for (const w of [...round.walkers].sort((a, b) => a.p.id - b.p.id)) {
      if (w.exitWait < DRILL.switchMinWaitS || w.p.exitS == null) continue;
      const sSw = w.L * DRILL.switchAtShare;
      if (w.L - sSw < 1.5) continue;
      const k = idxOfS(w.cum, sSw);
      const tSw = w.r + tOfS(w, w.cum[k]);
      const cSw = cellAt(g, w.pts[k]);
      if (cSw < 0) continue;
      const st = stage(stageOf(tSw));
      let alt: DoorInfo | null = null, best = w.p.exitS - DRILL.switchMarginS;
      for (const x of st.fields) {
        if (!x.f || x.d === w.plan.exit || !Number.isFinite(x.f.len[cSw])) continue;
        const e = wait.get(x.d.id);
        const est = tSw + x.f.len[cSw] / w.v + (e ? e.sum / e.n : 0) + (extra.get(x.d.id) ?? 0) + headwayFor(x.d.widthM);
        if (est < best - 1e-9) { best = est; alt = x.d; }
      }
      if (!alt) continue;
      extra.set(alt.id, (extra.get(alt.id) ?? 0) + headwayFor(alt.widthM));
      plans2[w.p.id] = { ci: cSw, exit: alt, first: { dense: w.pts.slice(0, k + 1), exit: w.plan.exit, stg: stageOf(tSw) } };
      changed.push(w.p.id);
    }
    if (changed.length) {
      for (const p of people) { p.escaped = false; p.exitS = null; p.waitS = 0; }
      const before = Math.max(...round.walkers.map((w) => w.p.exitS ?? 0));
      const alt = build(plans2);
      crowd(alt.walkers);
      simulate(alt.walkers);
      const after = alt.walkers.length ? Math.max(...alt.walkers.map((w) => w.p.exitS ?? Infinity)) : Infinity;
      if (after < before - 1e-6) { round = alt; switched = changed.length; for (const id of changed) people[id].switchedFrom = plans[id]!.exit.id; }
      else { for (const p of people) { p.escaped = false; p.exitS = null; p.waitS = 0; } round = build(plans); crowd(round.walkers); simulate(round.walkers); }
    }
  }
  const { gates, walkers } = round;

  // ---- timelines
  const posAt = (w: Walker, t: number): Vec2 => {
    const sg = w.segs;
    let seg: Seg | undefined = sg[0];
    for (const x of sg) { if (t >= x.t0) seg = x; else break; }
    if (!seg || t < seg.t0) return w.pts[0];
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
    const ph: DrillPerson['phases'] = [];
    const add = (state: DrillState, t0: number, t1: number) => {
      if (t1 - t0 < 1e-6) return;
      const lastP = ph[ph.length - 1];
      if (lastP && lastP.state === state && Math.abs(lastP.t1 - t0) < 1e-6) lastP.t1 = t1; else ph.push({ state, t0, t1 });
    };
    add('waiting', 0, Math.min(end, w.r));
    for (const sg of w.segs) add(sg.s0 === sg.s1 ? 'queuing' : 'walking', sg.t0, sg.t1);
    w.p.phases = ph;
  }

  const exitTimes = people.map((p) => p.exitS).filter((x): x is number => x != null).sort((a, b) => a - b);
  const n = people.length;
  const allOut = n > 0 && people.every((p) => p.escaped);
  const totalS = exitTimes.length ? exitTimes[exitTimes.length - 1] : 0;
  const q = (share: number) => { const need = Math.ceil(share * n - 1e-9); return n && need >= 1 && exitTimes.length >= need ? exitTimes[need - 1] : null; };
  const timeTo = { p50: q(0.5), p90: q(0.9), p100: q(1) };
  const stuck = people.filter((p) => !p.escaped).length;

  // ---- worst queue and the fix that answers it
  let worst: Gate | null = null;
  for (const gt of gates.values()) if (gt.maxWait >= 0.5 && (!worst || gt.maxWait > worst.maxWait)) worst = gt;
  let bottleneck: Bottleneck | null = null;
  if (worst) {
    const reach = worst.kind === 'door' ? Math.max(0.9, worst.widthM) : Math.max(0.5, worst.widthM);
    bottleneck = {
      id: worst.id, kind: worst.kind, at: worst.at, widthM: worst.widthM, queue: worst.maxQueue, lostS: Math.round(worst.maxWait * 10) / 10,
      lengthM: Math.round(worst.maxQueue * DRILL.queueSpacingM * 100) / 100, doorId: worst.doorId, itemIds: nearbyItems(g, worst.at, reach),
    };
  }
  let fix: DrillFix | null = null;
  if (bottleneck) {
    const it = furniture.find((f) => bottleneck!.itemIds.includes(f.id) && !f.locked) ?? furniture.find((f) => bottleneck!.itemIds.includes(f.id));
    const word = it ? (it.category || it.name).toLowerCase().replace(/[^a-z ]+/g, ' ').trim().split(/\s+/).slice(-1)[0] : '';
    if (it && word) fix = { label: `Move ${word}`, itemId: it.id };
    else if (bottleneck.kind === 'door' && bottleneck.doorId) fix = bottleneck.widthM < 0.9 ? { label: 'Widen door', openingId: bottleneck.doorId } : { label: 'Add exit' };
    else fix = { label: 'Widen gap' };
  } else if (!allOut && n) fix = { label: 'Add exit' };

  // ---- exits, fire trace and what to say about the run
  const used = new Map<string, number>();
  for (const p of people) if (p.escaped && p.exitId) used.set(p.exitId, (used.get(p.exitId) ?? 0) + 1);
  const closedAt = (d: DoorInfo): number | null => {
    if (growth <= 0) return dst(d.c, fire) <= DRILL.fireStartM + DRILL.fireMarginM ? 0 : null;
    const need = dst(d.c, fire) - DRILL.fireMarginM;
    if (need > DRILL.fireCapM) return null;
    return Math.max(0, Math.round(((need - DRILL.fireStartM) / growth) * 10) / 10);
  };
  const exits: DrillExit[] = allExits.map((d) => ({ id: d.id, label: d.label, at: d.c, widthM: d.widthM, blocked: d === blocked, used: used.get(d.id) ?? 0, closedByFireS: closedAt(d) }));
  const horizon = Math.max(totalS, 10);
  const fireTrace: DrillResult['fireTrace'] = [];
  for (let t = 0; t <= horizon + 1e-9; t += Math.max(5, horizon / 24)) fireTrace.push({ t: Math.round(t * 10) / 10, radiusM: Math.round(fireRadius(t, growth) * 100) / 100 });

  if (!allExits.length) notes.push('The plan has no exit door, so nobody can get out.');
  else if (!open.length) notes.push('The only exit is blocked, so nobody can get out.');
  if (stuck && open.length) notes.push(`${stuck} ${stuck === 1 ? 'person has' : 'people have'} no clear route to an exit.`);
  for (const e of exits) if (!e.blocked && e.closedByFireS != null && e.closedByFireS < totalS) notes.push(`The fire reaches ${e.label} after ${Math.round(e.closedByFireS)} s; people who set off later use another exit.`);
  if (switched) notes.push(`${switched} ${switched === 1 ? 'person changed' : 'people changed'} exit once because of the queue.`);
  if (!opts.starts && opts.occupants == null) notes.push('Head count is estimated from room areas (one per 10 m2 in homes, one per 5 m2 in offices).');
  const usedIds = new Set<string>(['drill-flow', 'drill-density', 'drill-counterflow', 'drill-fire', 'drill-target']);
  for (const p of people) usedIds.add(PERSON_TYPES[p.type].assumptionId);
  for (const u of new Set(uses)) { usedIds.add(`drill-share-${u}`); usedIds.add(`drill-reaction-${u}`); }

  return {
    people, dt: DRILL.dt, totalS, allOut, pass: allOut && totalS <= DRILL.targetS, fire, blockedId: blocked?.id ?? null, exits, bottleneck, fix, occupants: n,
    timeTo, targetS: DRILL.targetS, targetMet: allOut && totalS <= DRILL.targetS, stuck, switched, fireTrace, notes,
    assumptions: Object.values(DRILL_ASSUMPTIONS).filter((a) => usedIds.has(a.id)),
  };
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
