// Practical escape-route and accessibility check for the whole model (every room, every door).
// It is a planning aid built on stated rule-of-thumb defaults, not a code compliance check.
import {
  add, area, centroid, convexOverlap, dist, distPointPolygonEdges, distPointSegment, dot, itemCorners, mul, norm, pointInPolygon,
  polygonInside, segmentsIntersect, sub, doorSwingPolygon,
} from '../../core/geometry';
import type { FurnitureItem, Op, SpaceModel, Vec2 } from '../../core/types';
import { mulberry32 } from '../sim/crowd';
import { isRug, pathLength, smooth } from '../sim/grid';
import { buildSafetyGrid, cellAt, centre, chain, exitCells, shortest, widest, widthAt, type DoorInfo, type Field, type SafetyGrid } from './field';
import { clearWidth, simulateEvacuation, type EvacResult } from './evac';

// ---- Defaults ---------------------------------------------------------------------------------

export const SAFETY_DEFAULTS = {
  routeWidthM: 0.9,
  doorWidthM: 0.8,
  squeezeM: 0.5,
  maxTravelM: 30,
  singleDirectionM: 15,
  deadEndM: 6,
  exitClearM: 0.5,
  twoExitsOccupancy: 30,
  inwardSwingMaxOccupants: 50,
  areaPerPersonM2: 10,
  pinchWidthM: 1.2,
  pinchOccupancy: 10,
  wheelchairRouteM: 0.9,
  wheelchairDoorM: 0.8,
  turningM: 1.5,
  besideM: 0.8,
  doorLeafM: 0.04,
  wheelchairDeadEndM: 3,
  walkSpeedMS: 1.0,
  slowSpeedMS: 0.5,
  doorFlowPerMS: 1.3,
  extinguisherTravelM: 20,
  alarmRadiusM: 7.5,
  maxMoveM: 1.0,
};
export type SafetyConfig = typeof SAFETY_DEFAULTS;
export type SafetyKey = keyof SafetyConfig;

export const SAFETY_DEFAULT_INFO: Record<SafetyKey, { label: string; unit: string; group: 'fire' | 'access' | 'sim'; why: string }> = {
  routeWidthM: { label: 'Escape route width', unit: 'm', group: 'fire', why: 'Lets one person walk fast with a little room to spare, or two pass sideways.' },
  doorWidthM: { label: 'Width at doors', unit: 'm', group: 'fire', why: 'A doorway is short, so a slightly narrower gap is accepted there.' },
  squeezeM: { label: 'Tightest passable gap', unit: 'm', group: 'fire', why: 'Below this an adult cannot get through, even sideways.' },
  maxTravelM: { label: 'Longest walk to an exit', unit: 'm', group: 'fire', why: 'Beyond about 30 m smoke can overtake people before they reach a way out.' },
  singleDirectionM: { label: 'Walk with only one way out', unit: 'm', group: 'fire', why: 'With no alternative route, a shorter limit keeps people from being cut off.' },
  deadEndM: { label: 'Dead-end aisle length', unit: 'm', group: 'fire', why: 'In a dead end you must walk back towards the danger; keep them short.' },
  exitClearM: { label: 'Clear zone at exit doors', unit: 'm', group: 'fire', why: 'Things next to an exit get knocked over and pile up in a rush.' },
  twoExitsOccupancy: { label: 'People needing a second exit', unit: 'people', group: 'fire', why: 'Above about 30 people one blocked door traps everyone; codes set this between 30 and 60.' },
  inwardSwingMaxOccupants: { label: 'Max people for inward exit door', unit: 'people', group: 'fire', why: 'A crowd pushing on a door that opens towards them can hold it shut.' },
  areaPerPersonM2: { label: 'Floor area per person', unit: 'm²', group: 'fire', why: 'Used when furniture does not show how many people use a room; office-like density.' },
  pinchWidthM: { label: 'Comfortable width for a crowd', unit: 'm', group: 'fire', why: 'Two streams of people can move side by side at about 1.2 m.' },
  pinchOccupancy: { label: 'People before pinch points matter', unit: 'people', group: 'fire', why: 'Small groups get through narrow spots; larger groups queue.' },
  wheelchairRouteM: { label: 'Wheelchair route width', unit: 'm', group: 'access', why: 'A manual wheelchair is about 0.7 m wide plus room for hands on the wheels.' },
  wheelchairDoorM: { label: 'Wheelchair door clear width', unit: 'm', group: 'access', why: 'Clear opening a wheelchair can pass without scraping knuckles.' },
  turningM: { label: 'Turning circle', unit: 'm', group: 'access', why: 'Space to turn a wheelchair fully around without reversing.' },
  besideM: { label: 'Space beside beds and desks', unit: 'm', group: 'access', why: 'Room to pull up alongside and transfer or work.' },
  doorLeafM: { label: 'Door leaf allowance', unit: 'm', group: 'access', why: 'An open hinged door eats roughly 4 cm of the frame width.' },
  wheelchairDeadEndM: { label: 'Reversing distance', unit: 'm', group: 'access', why: 'Reversing a wheelchair further than this without a turning spot is hard.' },
  walkSpeedMS: { label: 'Walking speed', unit: 'm/s', group: 'sim', why: 'A brisk but cautious pace indoors, slower than a free walk because of crowding.' },
  slowSpeedMS: { label: 'Slower walking speed', unit: 'm/s', group: 'sim', why: 'Someone with a walking aid, a small child or a heavy bag.' },
  doorFlowPerMS: { label: 'Door flow per metre', unit: 'people/s', group: 'sim', why: 'A widely used figure for how many people pass a metre of door each second.' },
  extinguisherTravelM: { label: 'Walk to an extinguisher', unit: 'm', group: 'fire', why: 'Guidance usually keeps one within 15 to 25 m of anywhere.' },
  alarmRadiusM: { label: 'Smoke alarm reach', unit: 'm', group: 'fire', why: 'A ceiling smoke alarm covers roughly this radius in an open room.' },
  maxMoveM: { label: 'Largest suggested move', unit: 'm', group: 'fire', why: 'Fixes stay small so the room still works the way it is laid out.' },
};

export const NOT_ASSESSED = [
  'Fire resistance of walls, doors and ceilings',
  'How smoke and heat spread',
  'Sprinklers, emergency lighting and alarm wiring',
  'Thresholds, steps, ramps and floor surfaces',
  'Door opening force, locks and panic hardware',
  'Stairs, lifts and floors above or below',
  'Your local building and fire code',
];

// ---- Report types -----------------------------------------------------------------------------

export type Severity = 'critical' | 'important' | 'advice';
export type FindingKind =
  | 'no-exit' | 'trapped' | 'route-width' | 'travel' | 'single-direction' | 'dead-end' | 'door-blocked' | 'door-swing'
  | 'exit-swing' | 'exit-clearance' | 'two-exits' | 'pinch'
  | 'wc-door' | 'wc-route' | 'wc-turn' | 'wc-reach' | 'wc-dead-end';

export interface SafetyFix { label: string; ops: Op[]; movedM: number; verified: true }

export interface SafetyFinding {
  id: string;
  kind: FindingKind;
  area: 'fire' | 'access';
  severity: Severity;
  title: string;
  message: string;
  itemIds: string[];
  at: Vec2;
  /** Route to draw when the finding is shown. */
  route?: Vec2[];
  /** The measured width at `at`, when the finding is about a width. */
  measureM?: number;
  fix?: SafetyFix;
}

export interface ExitInfo { id: string; label: string; spaceId: string; at: Vec2; outward: Vec2; widthM: number; swing: 'in' | 'out' | 'none'; auto: boolean }

export interface RoomEgress {
  spaceId: string;
  name: string;
  exitId: string | null;
  from: Vec2 | null;
  pathPoints: Vec2[];
  lengthM: number | null;
  narrowestM: number | null;
  narrowestAt: Vec2 | null;
  travelTimeS: number | null;
  travelTimeSlowS: number | null;
  exitsReachable: number;
  people: number;
}

export interface RoomOccupancy { spaceId: string; name: string; people: number; seats: number; areaM2: number; basis: string }
export interface OccupancyEstimate { total: number; rooms: RoomOccupancy[]; overridden: boolean }

export type SuggestionKind = 'extinguisher' | 'smoke-alarm' | 'heat-alarm' | 'exit-sign' | 'direction-sign' | 'first-aid' | 'assembly';
export interface Suggestion { kind: SuggestionKind; at: Vec2; dir?: Vec2; label: string; reason: string }

export interface SafetyReport {
  exits: ExitInfo[];
  doors: Array<{ id: string; label: string; exit: boolean; auto: boolean; widthM: number }>;
  egress: RoomEgress[];
  findings: SafetyFinding[];
  score: number;
  headline: string;
  occupancy: OccupancyEstimate;
  suggestions: Suggestion[];
  evacuation: EvacResult | null;
  evacuationSlowS: number | null;
  config: SafetyConfig;
  notAssessed: string[];
}

export interface SafetyOptions {
  config?: Partial<SafetyConfig>;
  /** Total people in the model; replaces the furniture/area estimate. */
  occupancy?: number;
  /** Door id -> counts as an exit (true) or not (false). Unlisted doors: exit when nothing is on the other side. */
  exitOverrides?: Record<string, boolean>;
  /** Skip searching for furniture moves (faster). */
  skipFixes?: boolean;
  seed?: number;
}

// ---- Helpers ----------------------------------------------------------------------------------

const cm = (m: number) => `${Math.round(m * 100)} cm`;
const m1 = (m: number) => `${m.toFixed(1)} m`;
const SEV_ORDER: Record<Severity, number> = { critical: 0, important: 1, advice: 2 };
const label = (f: FurnitureItem) => f.name || f.category;

function polySegDist(poly: Vec2[], a: Vec2, b: Vec2): number {
  if (pointInPolygon(a, poly) || pointInPolygon(b, poly)) return 0;
  let m = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    if (segmentsIntersect(p, q, a, b)) return 0;
    m = Math.min(m, distPointSegment(p, a, b), distPointSegment(a, p, q), distPointSegment(b, p, q));
  }
  return m;
}
const distToPoly = (p: Vec2, poly: Vec2[]) => (pointInPolygon(p, poly) ? 0 : distPointPolygonEdges(p, poly));

function roomOf(model: SpaceModel, p: Vec2): number { return model.spaces.findIndex((s) => s.polygon.length >= 3 && pointInPolygon(p, s.polygon)); }

const SEAT_RE = /chair|stool|seat|armchair/i, SOFA_RE = /sofa|couch|bench/i, DESK_RE = /desk|workstation/i, BED_RE = /bed|crib/i;
export function seatsOf(f: FurnitureItem, all: FurnitureItem[]): number {
  const k = `${f.category} ${f.name}`;
  if (isRug(f) || /table|treatment/i.test(f.category)) return 0;
  if (SOFA_RE.test(k)) return Math.max(1, Math.floor(f.w / 0.6));
  if (SEAT_RE.test(k)) return 1;
  if (BED_RE.test(k)) return /crib/i.test(k) ? 1 : f.w >= 1.2 ? 2 : 1;
  if (DESK_RE.test(k)) return all.some((o) => o !== f && SEAT_RE.test(`${o.category} ${o.name}`) && dist(o, f) < 1.2) ? 0 : 1;
  return 0;
}

/** Where people would be sitting or standing, per seat. */
function seatPositions(f: FurnitureItem, all: FurnitureItem[]): Vec2[] {
  const n = seatsOf(f, all); if (!n) return [];
  if (DESK_RE.test(`${f.category} ${f.name}`)) return [add(f, mul({ x: -Math.sin(f.rotation), y: Math.cos(f.rotation) }, f.d / 2 + 0.4))];
  const ax = { x: Math.cos(f.rotation), y: Math.sin(f.rotation) };
  return Array.from({ length: n }, (_, i) => add(f, mul(ax, (i + 0.5 - n / 2) * (f.w / n))));
}

export function estimateOccupancy(model: SpaceModel, furniture: FurnitureItem[], cfg: SafetyConfig, override?: number): OccupancyEstimate {
  const rooms: RoomOccupancy[] = model.spaces.map((s) => ({ spaceId: s.id, name: s.name, people: 0, seats: 0, areaM2: area(s.polygon), basis: '' }));
  for (const f of furniture) { const r = roomOf(model, f); if (r >= 0) rooms[r].seats += seatsOf(f, furniture); }
  for (const r of rooms) {
    const byArea = Math.ceil(r.areaM2 / Math.max(0.5, cfg.areaPerPersonM2));
    r.people = Math.max(r.seats, byArea);
    r.basis = r.seats >= byArea && r.seats > 0 ? `${r.seats} seats, desks or beds counted` : `${Math.round(r.areaM2)} m² at ${cfg.areaPerPersonM2} m² per person`;
  }
  const est = rooms.reduce((s, r) => s + r.people, 0);
  if (override != null && override >= 0 && Number.isFinite(override)) {
    const target = Math.round(override);
    const shares = rooms.map((r) => (est ? (r.people / est) * target : target / Math.max(1, rooms.length)));
    const base = shares.map(Math.floor);
    let left = target - base.reduce((a, b) => a + b, 0);
    const order = shares.map((s, i) => [s - base[i], i] as const).sort((a, b) => b[0] - a[0]);
    for (const [, i] of order) { if (left <= 0) break; base[i]++; left--; }
    rooms.forEach((r, i) => { r.people = base[i]; r.basis = 'your number, shared by room size'; });
    return { total: target, rooms, overridden: true };
  }
  return { total: est, rooms, overridden: false };
}

// ---- Core analysis ----------------------------------------------------------------------------

interface Ctx {
  model: SpaceModel; furniture: FurnitureItem[]; cfg: SafetyConfig; g: SafetyGrid; exits: DoorInfo[]; sources: number[];
  F: Field | null; tol: number; stand: (i: number) => boolean; okW: (i: number) => boolean; FW: Field | null;
  occupancy: OccupancyEstimate;
}

interface Core { ctx: Ctx; findings: SafetyFinding[]; egress: RoomEgress[] }

function blockersAt(g: SafetyGrid, p: Vec2, furniture: FurnitureItem[], reach: number): FurnitureItem[] {
  const out: FurnitureItem[] = [];
  for (const it of g.items) if (distToPoly(p, it.poly) <= reach) out.push(it.f);
  return out.filter((f) => furniture.includes(f));
}

function doorZone(d: DoorInfo, depthIn: number, depthOut: number): Vec2[] {
  const h = d.widthM / 2;
  return [add(add(d.c, mul(d.dir, -h)), mul(d.outward, depthOut)), add(add(d.c, mul(d.dir, h)), mul(d.outward, depthOut)),
    add(add(d.c, mul(d.dir, h)), mul(d.inward, depthIn)), add(add(d.c, mul(d.dir, -h)), mul(d.inward, depthIn))];
}

function swingZone(model: SpaceModel, d: DoorInfo): Vec2[] | null {
  return doorSwingPolygon(d.space, d.opening);
}

function analyse(model: SpaceModel, furniture: FurnitureItem[], cfg: SafetyConfig, overrides: Record<string, boolean>, occupancy: OccupancyEstimate, full: boolean): Core {
  const g = buildSafetyGrid(model, furniture, overrides);
  const tol = g.cell / 2;
  const exits = g.doors.filter((d) => d.exit);
  const sources = exits.flatMap((d) => exitCells(g, d));
  const stand = (i: number) => g.free[i] === 1 && g.dist[i] + tol >= cfg.squeezeM / 2;
  const reqAt = (i: number) => (g.door[i] >= 0 ? cfg.doorWidthM : cfg.routeWidthM) / 2;
  const wReq = (i: number) => (g.door[i] >= 0 ? cfg.wheelchairDoorM : cfg.wheelchairRouteM) / 2;
  const okW = (i: number) => g.free[i] === 1 && g.dist[i] + tol >= wReq(i);
  const findings: SafetyFinding[] = [];
  const egress: RoomEgress[] = [];
  const ctx: Ctx = { model, furniture, cfg, g, exits, sources, F: null, tol, stand, okW, FW: null, occupancy };

  if (!exits.length || !sources.length) {
    const c = model.spaces[0] ? centroid(model.spaces[0].polygon) : { x: 0, y: 0 };
    findings.push({
      id: 'no-exit', kind: 'no-exit', area: 'fire', severity: 'critical', title: 'No way out is marked',
      message: g.doors.length ? `None of the ${g.doors.length} doors leads outside. Mark the door you would leave by as an exit.` : 'There is no door yet. Add the door you would leave by, then mark it as an exit.',
      itemIds: [], at: c,
    });
    for (const s of model.spaces) egress.push({ spaceId: s.id, name: s.name, exitId: null, from: null, pathPoints: [], lengthM: null, narrowestM: null, narrowestAt: null, travelTimeS: null, travelTimeSlowS: null, exitsReachable: 0, people: occupancy.rooms.find((r) => r.spaceId === s.id)?.people ?? 0 });
    return { ctx, findings, egress };
  }

  const F = shortest(g, sources, stand, (i) => { const r = reqAt(i), d = g.dist[i] + tol; return d >= r ? 0 : 6 * (1 - d / r); });
  ctx.F = F;
  const N = g.cols * g.rows;
  const ratio = new Float32Array(N);
  for (let i = 0; i < N; i++) ratio[i] = stand(i) ? (g.dist[i] + tol) / reqAt(i) : 0;
  const W = widest(g, sources, ratio);
  const perExit = exits.length > 1 ? exits.slice(0, 8).map((d) => shortest(g, exitCells(g, d), stand)) : [];

  // Pinch field: comfortable crowd width away from doors (doors are judged on their own).
  const anyBusy = occupancy.rooms.some((r) => r.people >= cfg.pinchOccupancy);
  const ratio2 = new Float32Array(N);
  if (anyBusy) for (let i = 0; i < N; i++) ratio2[i] = stand(i) ? (g.door[i] >= 0 ? 10 : (g.dist[i] + tol) / (cfg.pinchWidthM / 2)) : 0;
  const W2 = anyBusy ? widest(g, sources, ratio2) : null;

  const widthFindings = new Map<string, { width: number; need: number; at: Vec2; rooms: Set<string>; blockers: FurnitureItem[]; sides: string; route: Vec2[]; kind: 'route-width' | 'pinch'; people: number }>();
  const byId = new Map(furniture.map((f) => [f.id, f]));
  const sidesOf = (wa: ReturnType<typeof widthAt>) => {
    const names = [wa.near, wa.far].map((sg) => (sg?.itemId ? label(byId.get(sg.itemId)!) : 'the wall'));
    return names[0] === names[1] ? (names[0] === 'the wall' ? 'between walls' : `beside ${names[0]}`) : `between ${names[0]} and ${names[1]}`;
  };
  const pathFrom = (i: number) => smooth(g, chain(F, i).map((c) => centre(g, c)), cfg.squeezeM / 2 - tol);

  model.spaces.forEach((s, k) => {
    const people = occupancy.rooms.find((r) => r.spaceId === s.id)?.people ?? 0;
    const roomCells: number[] = [];
    for (let i = 0; i < N; i++) if (g.room[i] === k && stand(i)) roomCells.push(i);
    const reach = roomCells.filter((i) => Number.isFinite(F.len[i]));
    const trapped = roomCells.filter((i) => !Number.isFinite(F.len[i]));
    const cellA = g.cell * g.cell;
    if (trapped.length * cellA >= 0.5) {
      const c = trapped.reduce((a, i) => add(a, centre(g, i)), { x: 0, y: 0 });
      const at = mul(c, 1 / trapped.length);
      const near = new Set<FurnitureItem>();
      for (let j = 0; j < trapped.length; j += 3) for (const f of blockersAt(g, centre(g, trapped[j]), furniture, g.dist[trapped[j]] + 0.08)) near.add(f);
      findings.push({
        id: `trapped:${s.id}`, kind: 'trapped', area: 'fire', severity: 'critical', title: `Part of ${s.name} has no way out`,
        message: `About ${(trapped.length * cellA).toFixed(1)} m² of ${s.name} is cut off from every exit${near.size ? ` by ${[...near].map(label).join(', ')}` : ''}.`,
        itemIds: [...near].map((f) => f.id), at,
      });
    }
    const open = reach.filter((i) => g.dist[i] + tol >= cfg.routeWidthM / 2);
    const pool = open.length ? open : reach;
    if (!pool.length) {
      egress.push({ spaceId: s.id, name: s.name, exitId: null, from: null, pathPoints: [], lengthM: null, narrowestM: null, narrowestAt: null, travelTimeS: null, travelTimeSlowS: null, exitsReachable: 0, people });
      return;
    }
    let far = pool[0];
    for (const i of pool) if (F.len[i] > F.len[far]) far = i;
    const pts = pathFrom(far);
    const lengthM = pathLength(pts);
    const exitDoor = g.doors[g.door[F.src[far]]];
    const ck = W.choke[far];
    // Narrowest point on the way out: each door passed, plus the bottleneck if it is not where you start.
    let wAt: number | null = null, wAtP: Vec2 | null = null;
    const take = (w: number, p: Vec2) => { if (wAt == null || w < wAt) { wAt = w; wAtP = p; } };
    const passed = new Set<number>();
    for (const c of chain(F, far)) if (g.door[c] >= 0) passed.add(g.door[c]);
    for (const k2 of passed) take(g.doors[k2].widthM, g.doors[k2].c);
    if (ck >= 0 && dist(centre(g, ck), centre(g, far)) > 1 && g.door[ck] < 0) take(widthAt(g, centre(g, ck)).width, centre(g, ck));
    const exitsReachable = perExit.length ? perExit.filter((f) => Number.isFinite(f.len[far])).length : 1;
    egress.push({
      spaceId: s.id, name: s.name, exitId: exitDoor?.id ?? null, from: centre(g, far), pathPoints: pts, lengthM,
      narrowestM: wAt, narrowestAt: wAtP,
      travelTimeS: lengthM / cfg.walkSpeedMS, travelTimeSlowS: lengthM / cfg.slowSpeedMS, exitsReachable, people,
    });

    // Width: every open patch of floor must have a route at least as wide as required.
    const groups = new Map<number, number[]>();
    for (const i of open) if (W.B[i] < 1) { const c = W.choke[i]; (groups.get(c) ?? groups.set(c, []).get(c)!).push(i); }
    for (const [c, cells] of groups) {
      if (cells.length * cellA < 0.5 || c < 0) continue;
      const p = centre(g, c), wa = widthAt(g, p), need = g.door[c] >= 0 ? cfg.doorWidthM : cfg.routeWidthM;
      if (wa.width >= need - 0.005) continue;
      const key = `${Math.round(p.x / 0.3)}_${Math.round(p.y / 0.3)}`;
      const worst = cells.reduce((a, i) => (F.len[i] > F.len[a] ? i : a), cells[0]);
      const ids = new Set<string>([wa.near?.itemId, wa.far?.itemId].filter((x): x is string => !!x));
      const bl = furniture.filter((f) => ids.has(f.id) || blockersAt(g, p, [f], g.dist[c] + 0.06).length);
      const prev = widthFindings.get(key);
      if (prev) { prev.rooms.add(s.name); prev.people += people; } else widthFindings.set(key, { width: wa.width, need, at: p, rooms: new Set([s.name]), blockers: bl, sides: sidesOf(wa), route: pathFrom(worst), kind: 'route-width', people });
    }
    // Pinch points for busier rooms.
    if (W2 && people >= cfg.pinchOccupancy && W2.B[far] < 1 && W.B[far] >= 1) {
      const c = W2.choke[far];
      if (c >= 0) {
        const p = centre(g, c), wa = widthAt(g, p);
        const ids = new Set<string>([wa.near?.itemId, wa.far?.itemId].filter((x): x is string => !!x));
        const bl = furniture.filter((f) => ids.has(f.id));
        if (bl.length && wa.width < cfg.pinchWidthM - 0.005 && wa.width >= cfg.routeWidthM - 0.005) {
          const key = `p${Math.round(p.x / 0.3)}_${Math.round(p.y / 0.3)}`;
          const prev = widthFindings.get(key);
          if (prev) { prev.rooms.add(s.name); prev.people += people; } else widthFindings.set(key, { width: wa.width, need: cfg.pinchWidthM, at: p, rooms: new Set([s.name]), blockers: bl, sides: sidesOf(wa), route: pts, kind: 'pinch', people });
        }
      }
    }
    // Travel distance.
    if (lengthM > cfg.maxTravelM) {
      findings.push({
        id: `travel:${s.id}`, kind: 'travel', area: 'fire', severity: 'important', title: `Long walk out of ${s.name}`,
        message: `From the far side of ${s.name} it is ${m1(lengthM)} to ${exitDoor?.label ?? 'the exit'} (guide: ${cfg.maxTravelM} m). About ${Math.round(lengthM / cfg.walkSpeedMS)} s at a brisk walk, ${Math.round(lengthM / cfg.slowSpeedMS)} s for a slower walker.`,
        itemIds: [], at: centre(g, far), route: pts,
      });
    } else if (exitsReachable < 2 && lengthM > cfg.singleDirectionM) {
      findings.push({
        id: `single:${s.id}`, kind: 'single-direction', area: 'fire', severity: 'important', title: `Only one way out of ${s.name}, and it is far`,
        message: `The far side of ${s.name} is ${m1(lengthM)} from the only reachable exit (guide: ${cfg.singleDirectionM} m when there is just one direction to escape).`,
        itemIds: [], at: centre(g, far), route: pts,
      });
    }
    // Second exit for busy rooms.
    if (people >= cfg.twoExitsOccupancy && exitsReachable < 2) {
      findings.push({
        id: `two-exits:${s.id}`, kind: 'two-exits', area: 'fire', severity: 'advice', title: `Plan a second way out of ${s.name}`,
        message: `About ${people} people (${occupancy.rooms[k]?.basis ?? 'estimate'}) share one exit. Above ${cfg.twoExitsOccupancy} people, add a second exit well apart from the first.`,
        itemIds: [], at: exitDoor ? exitDoor.c : centroid(s.polygon),
      });
    }
  });

  for (const [key, w] of widthFindings) {
    const rooms = [...w.rooms].join(' and ');
    const between = ` ${w.sides}`;
    if (w.kind === 'route-width') {
      const severity: Severity = w.width < cfg.squeezeM + 0.1 ? 'critical' : 'important';
      findings.push({
        id: `width:${key}`, kind: 'route-width', area: 'fire', severity, title: `Escape route narrows to ${cm(w.width)}`,
        message: `The way out from ${rooms} squeezes to ${cm(w.width)}${between}. Keep at least ${cm(w.need)} clear${w.need === cfg.routeWidthM ? ` (${cm(cfg.doorWidthM)} at doors)` : ' at doors'}.`,
        itemIds: w.blockers.map((f) => f.id), at: w.at, route: w.route, measureM: w.width,
      });
    } else {
      findings.push({
        id: `pinch:${key}`, kind: 'pinch', area: 'fire', severity: 'advice', title: `Pinch point of ${cm(w.width)} on the way out`,
        message: `About ${w.people} people from ${rooms} pass a ${cm(w.width)} gap${between}. For a group this size ${cm(cfg.pinchWidthM)} lets two lines move side by side.`,
        itemIds: w.blockers.map((f) => f.id), at: w.at, route: w.route, measureM: w.width,
      });
    }
  }

  // Doors: blocked doorways, obstructed swings, exit details.
  const served = new Map<string, number>();
  for (const e of egress) if (e.exitId) served.set(e.exitId, (served.get(e.exitId) ?? 0) + e.people);
  const solid = g.items;
  for (const d of g.doors) {
    const gap = doorZone(d, 0.3, d.neighbour >= 0 ? d.depth + 0.3 : 0.05);
    const inGap = solid.filter((it) => convexOverlap(it.poly, gap) > 0.01).map((it) => it.f);
    if (inGap.length) {
      findings.push({
        id: `door-blocked:${d.id}`, kind: 'door-blocked', area: 'fire', severity: d.exit ? 'critical' : 'important', title: `${d.label} is blocked`,
        message: `${inGap.map(label).join(', ')} stand${inGap.length === 1 ? 's' : ''} in the doorway. A door on an escape route needs its full ${cm(d.widthM)} opening free.`,
        itemIds: inGap.map((f) => f.id), at: d.c,
      });
    }
    const sw = swingZone(model, d);
    const inSwing = sw ? solid.filter((it) => !inGap.includes(it.f) && convexOverlap(it.poly, sw) > 0.01).map((it) => it.f) : [];
    if (inSwing.length) {
      findings.push({
        id: `door-swing:${d.id}`, kind: 'door-swing', area: 'fire', severity: 'important', title: `${d.label} cannot open fully`,
        message: `${inSwing.map(label).join(', ')} ${inSwing.length === 1 ? 'is' : 'are'} inside the ${cm(d.widthM)} arc the door sweeps.`,
        itemIds: inSwing.map((f) => f.id), at: add(d.c, mul(d.opening.swing === 'in' ? d.inward : d.outward, d.widthM / 2)),
      });
    }
    if (d.exit && d.opening.kind === 'door' && d.opening.swing === 'in') {
      const n = served.get(d.id) ?? 0;
      findings.push({
        id: `exit-swing:${d.id}`, kind: 'exit-swing', area: 'fire', severity: n > cfg.inwardSwingMaxOccupants ? 'important' : 'advice', title: `${d.label} opens against the way out`,
        message: n > cfg.inwardSwingMaxOccupants
          ? `About ${n} people leave through a door that opens inwards. Above ${cfg.inwardSwingMaxOccupants} people a crowd can hold it shut; it should open outwards.`
          : `The exit opens inwards. Fine for ${n || 'a few'} people; if more use this room later (over ${cfg.inwardSwingMaxOccupants}), it should open outwards.`,
        itemIds: [], at: d.c,
      });
    }
    if (d.exit) {
      const close = solid.filter((it) => !inGap.includes(it.f) && !inSwing.includes(it.f) && polySegDist(it.poly, d.a, d.b) < cfg.exitClearM - 0.005);
      for (const it of close) {
        const dd = polySegDist(it.poly, d.a, d.b);
        findings.push({
          id: `exit-clear:${d.id}:${it.f.id}`, kind: 'exit-clearance', area: 'fire', severity: 'advice', title: `${label(it.f)} is close to the exit`,
          message: `${label(it.f)} is ${cm(dd)} from ${d.label}. Keep ${cm(cfg.exitClearM)} clear.`,
          itemIds: [it.f.id], at: d.c,
        });
      }
    }
  }

  // Wheelchair: doors, route into every room, turning space.
  for (const d of g.doors) {
    const cw = clearWidth(d, cfg.doorLeafM);
    if (cw < cfg.wheelchairDoorM - 0.005) {
      findings.push({
        id: `wc-door:${d.id}`, kind: 'wc-door', area: 'access', severity: 'important', title: `${d.label} is too narrow for a wheelchair`,
        message: `Clear opening about ${cm(cw)} (${cm(d.widthM)} frame${d.opening.kind === 'door' && d.opening.swing !== 'none' ? ` less ${cm(cfg.doorLeafM)} for the open leaf` : ''}); a wheelchair needs ${cm(cfg.wheelchairDoorM)}.`,
        itemIds: [], at: d.c,
      });
    }
  }
  const FW = shortest(g, sources.filter(okW), okW);
  ctx.FW = FW;
  const wr = new Float32Array(N);
  for (let i = 0; i < N; i++) wr[i] = g.free[i] ? (g.dist[i] + tol) / wReq(i) : 0;
  const WW = widest(g, sources, wr);
  model.spaces.forEach((s, k) => {
    let any = -1, turn = -1, best = -1;
    for (let i = 0; i < N; i++) {
      if (g.room[i] !== k || !g.free[i]) continue;
      if (best < 0 || WW.B[i] > WW.B[best]) best = i;
      if (!Number.isFinite(FW.len[i])) continue;
      any = i;
      if (g.dist[i] + tol >= cfg.turningM / 2) { turn = i; break; }
    }
    if (any < 0) {
      const ck = best >= 0 ? WW.choke[best] : -1;
      const p = ck >= 0 ? centre(g, ck) : centroid(s.polygon);
      const w = ck >= 0 ? widthAt(g, p).width : 0;
      const ids = ck >= 0 ? blockersAt(g, p, furniture, g.dist[ck] + 0.06).map((f) => f.id) : [];
      findings.push({
        id: `wc-route:${s.id}`, kind: 'wc-route', area: 'access', severity: 'important', title: `A wheelchair cannot get into ${s.name}`,
        message: ck >= 0 ? `The widest way in narrows to ${cm(w)}; a wheelchair needs ${cm(cfg.wheelchairRouteM)} (${cm(cfg.wheelchairDoorM)} at doors).` : `No way in at ${cm(cfg.wheelchairRouteM)} wide.`,
        itemIds: ids, at: p,
      });
    } else if (turn < 0) {
      findings.push({
        id: `wc-turn:${s.id}`, kind: 'wc-turn', area: 'access', severity: 'important', title: `No turning space in ${s.name}`,
        message: `Nowhere in ${s.name} that a wheelchair can reach has a clear ${cm(cfg.turningM)} circle, so a wheelchair user would have to reverse out.`,
        itemIds: [], at: centroid(s.polygon),
      });
    }
  });

  if (full) fullChecks(ctx, findings);
  return { ctx, findings, egress };
}

/** Checks that are slower or do not change when a single item moves a little. */
function fullChecks(ctx: Ctx, findings: SafetyFinding[]) {
  const { g, cfg, F, FW, stand, okW, tol, furniture, model } = ctx;
  if (!F || !FW) return;
  const N = g.cols * g.rows;
  // Dead ends: narrow aisles (no room to turn) that you can only leave the way you came.
  const seed = new Uint8Array(N);
  const seeds: number[] = [];
  for (let i = 0; i < N; i++) if (stand(i) && Number.isFinite(F.len[i]) && g.dist[i] + tol >= cfg.turningM / 2) { seed[i] = 1; seeds.push(i); }
  for (const s of ctx.sources) if (!seed[s]) { seed[s] = 1; seeds.push(s); }
  const reachStand = (i: number) => stand(i) && Number.isFinite(F.len[i]);
  const DF = shortest(g, seeds, reachStand);
  const thr = Math.min(cfg.deadEndM, cfg.wheelchairDeadEndM);
  const cand: number[] = [];
  for (let i = 0; i < N; i++) if (Number.isFinite(DF.len[i]) && DF.len[i] > thr) cand.push(i);
  cand.sort((a, b) => DF.len[b] - DF.len[a]);
  const handled = new Uint8Array(N);
  const seatPts = furniture.flatMap((f) => seatPositions(f, furniture));
  let tests = 0;
  for (const c of cand) {
    if (handled[c] || tests++ > 25) continue;
    const ch = chain(DF, c);
    const mouth = centre(g, ch[Math.max(0, ch.length - 2)]);
    const blockR = 0.9;
    const seen = new Uint8Array(N), q = [c]; seen[c] = 1;
    let through = false;
    for (let h = 0; h < q.length && !through; h++) {
      const i = q[h], cc = i % g.cols;
      for (const j of [cc > 0 ? i - 1 : -1, cc < g.cols - 1 ? i + 1 : -1, i - g.cols, i + g.cols]) {
        if (j < 0 || j >= N || seen[j] || !reachStand(j)) continue;
        if (dist(centre(g, j), mouth) < blockR) continue;
        if (seed[j]) { through = true; break; }
        seen[j] = 1; q.push(j);
      }
    }
    if (through) {
      const pc = centre(g, c);
      for (const i of cand) if (dist(centre(g, i), pc) < 1.5) handled[i] = 1;
      continue;
    }
    for (const i of q) handled[i] = 1;
    // Only aisles people use count: wide enough to be a walkway, or someone sits or works in it.
    const inRegion = new Set(q);
    const used = q.some((i) => g.dist[i] + tol >= cfg.routeWidthM / 2) || seatPts.some((p) => inRegion.has(cellAt(g, p)));
    if (!used) continue;
    const len = DF.len[c];
    const route = ch.map((i) => centre(g, i));
    const ids = new Set<string>();
    for (let j = 0; j < ch.length; j += 4) for (const f of blockersAt(g, centre(g, ch[j]), furniture, g.dist[ch[j]] + 0.1)) ids.add(f.id);
    const sidesBy = furniture.filter((f) => ids.has(f.id));
    const sp = model.spaces[g.room[c]];
    if (len > cfg.deadEndM) {
      findings.push({
        id: `dead-end:${sp?.id ?? 'x'}:${Math.round(route[0].x * 2)}_${Math.round(route[0].y * 2)}`, kind: 'dead-end', area: 'fire', severity: 'important',
        title: `Dead end of ${m1(len)}${sp ? ` in ${sp.name}` : ''}`,
        message: `This aisle${sidesBy.length ? ` along ${sidesBy.slice(0, 3).map(label).join(', ')}${sidesBy.length > 3 ? ' and others' : ''}` : ''} only opens at one end: ${m1(len)} back to a choice of direction (guide: ${cfg.deadEndM} m).`,
        itemIds: [...ids], at: route[0], route,
      });
    }
    if (len > cfg.wheelchairDeadEndM && q.some((i) => okW(i) && Number.isFinite(FW.len[i]))) {
      findings.push({
        id: `wc-dead-end:${sp?.id ?? 'x'}:${Math.round(route[0].x * 2)}_${Math.round(route[0].y * 2)}`, kind: 'wc-dead-end', area: 'access', severity: 'advice',
        title: `Wheelchair would reverse ${m1(len)}`,
        message: `This aisle has no clear ${cm(cfg.turningM)} turning circle at its end, so a wheelchair user would back out ${m1(len)}. Leave a turning spot at the end or keep it under ${cfg.wheelchairDeadEndM} m.`,
        itemIds: [...ids], at: route[0], route,
      });
    }
  }

  // Wheelchair reach: room beside beds, desks, tables, sofas and fixtures.
  const IMPORTANT = /bed|desk|table|sofa|toilet|wc|sink|basin|bath|shower|counter|kitchen|stove|oven|fridge|wardrobe/i;
  const noReach = new Map<number, Array<{ f: FurnitureItem; nearest: number }>>();
  const wcRooms = new Set(model.spaces.map((s, k) => k).filter((k) => { for (let i = 0; i < N; i++) if (g.room[i] === k && Number.isFinite(FW.len[i])) return true; return false; }));
  for (const it of g.items) {
    const f = it.f;
    if (!IMPORTANT.test(`${f.category} ${f.name}`) || /coffee|side|night|crib/i.test(f.category)) continue;
    const r = roomOf(model, f); if (r < 0 || !wcRooms.has(r)) continue;
    const pad = 1.2, xs = it.poly.map((p) => p.x), ys = it.poly.map((p) => p.y);
    const c0 = Math.max(0, Math.floor((Math.min(...xs) - pad - g.ox) / g.cell)), c1 = Math.min(g.cols - 1, Math.ceil((Math.max(...xs) + pad - g.ox) / g.cell));
    const r0 = Math.max(0, Math.floor((Math.min(...ys) - pad - g.oy) / g.cell)), r1 = Math.min(g.rows - 1, Math.ceil((Math.max(...ys) + pad - g.oy) / g.cell));
    const side = (i: number) => g.free[i] === 1 && g.dist[i] + tol >= cfg.besideM / 2;
    const inBox = (i: number) => { const c = i % g.cols, rr = Math.floor(i / g.cols); return c >= c0 && c <= c1 && rr >= r0 && rr <= r1; };
    const seen = new Uint8Array(N), q: number[] = [];
    let nearest = Infinity;
    for (let rr = r0; rr <= r1; rr++) for (let c = c0; c <= c1; c++) {
      const i = rr * g.cols + c;
      if (Number.isFinite(FW.len[i])) { nearest = Math.min(nearest, distToPoly(centre(g, i), it.poly)); if (side(i)) { seen[i] = 1; q.push(i); } }
    }
    let ok = false;
    for (let h = 0; h < q.length && !ok; h++) {
      const i = q[h];
      if (distToPoly(centre(g, i), it.poly) <= cfg.besideM / 2 + g.cell * 1.5) { ok = true; break; }
      const c = i % g.cols;
      for (const j of [c > 0 ? i - 1 : -1, c < g.cols - 1 ? i + 1 : -1, i - g.cols, i + g.cols]) {
        if (j < 0 || j >= N || seen[j] || !inBox(j) || !side(j)) continue;
        seen[j] = 1; q.push(j);
      }
    }
    if (!ok) (noReach.get(r) ?? noReach.set(r, []).get(r)!).push({ f, nearest });
  }
  for (const [r, list] of noReach) {
    const sp = model.spaces[r];
    const one = list.length === 1;
    const closest = Math.min(...list.map((x) => x.nearest));
    const names = list.slice(0, 4).map((x) => label(x.f)).join(', ') + (list.length > 4 ? ` and ${list.length - 4} more` : '');
    findings.push({
      id: `wc-reach:${sp.id}`, kind: 'wc-reach', area: 'access', severity: 'advice',
      title: one ? `No wheelchair space beside ${label(list[0].f)}` : `No wheelchair space beside ${list.length} items in ${sp.name}`,
      message: `There is no ${cm(cfg.besideM)} wide spot a wheelchair can reach next to ${names}${Number.isFinite(closest) ? `; the closest it gets is ${cm(Math.max(0, closest - cfg.wheelchairRouteM / 2))} from an edge` : ''}.`,
      itemIds: list.map((x) => x.f.id), at: { x: list[0].f.x, y: list[0].f.y },
    });
  }
}

// ---- Fixes ------------------------------------------------------------------------------------

const DIR_WORD = (d: Vec2) => (Math.abs(d.x) >= Math.abs(d.y) ? (d.x > 0 ? 'right' : 'left') : d.y > 0 ? 'down' : 'up');
const crit = (fs: SafetyFinding[]) => fs.filter((f) => f.severity !== 'advice').length;

interface Plan { item: FurnitureItem; dir: Vec2; minD: number }

function axesOf(f: FurnitureItem): Vec2[] {
  const ax = { x: Math.cos(f.rotation), y: Math.sin(f.rotation) }, ay = { x: -Math.sin(f.rotation), y: Math.cos(f.rotation) };
  return [ax, mul(ax, -1), ay, mul(ay, -1)];
}

function poseValid(model: SpaceModel, item: FurnitureItem, x: number, y: number, others: FurnitureItem[], zones: Vec2[][]): boolean {
  const body = itemCorners({ ...item, x, y });
  const r = roomOf(model, { x, y }); if (r < 0 || !polygonInside(body, model.spaces[r].polygon)) return false;
  for (const o of others) if (o.id !== item.id && !isRug(o) && convexOverlap(body, itemCorners(o)) > 1e-3) return false;
  for (const z of zones) if (convexOverlap(body, z) > 1e-3) return false;
  return true;
}

function searchFix(model: SpaceModel, furniture: FurnitureItem[], cfg: SafetyConfig, overrides: Record<string, boolean>, occ: OccupancyEstimate,
  target: SafetyFinding, before: SafetyFinding[], plans: Plan[], gone: (fs: SafetyFinding[]) => boolean): SafetyFix | undefined {
  const doors = buildSafetyGrid(model, [], overrides, 0.25).doors;
  const zones: Vec2[][] = [];
  for (const d of doors) { zones.push(doorZone(d, 0.3, 0.05)); const sw = swingZone(model, d); if (sw) zones.push(sw); }
  const need = crit(before) - (target.severity === 'advice' ? 0 : 1);
  let checks = 0;
  for (let delta = 0.05; delta <= cfg.maxMoveM + 1e-9; delta += 0.05) {
    for (const p of plans) {
      if (p.item.locked || delta < p.minD - 1e-9) continue;
      {
        const dir = p.dir;
        const x = Math.round((p.item.x + dir.x * delta) * 1000) / 1000, y = Math.round((p.item.y + dir.y * delta) * 1000) / 1000;
        if (!poseValid(model, p.item, x, y, furniture, zones)) continue;
        if (checks++ > 28) return undefined;
        const moved = furniture.map((f) => (f.id === p.item.id ? { ...f, x, y } : f));
        const after = analyse(model, moved, cfg, overrides, occ, false).findings;
        if (gone(after) && crit(after) <= need) {
          const d = Math.round(delta * 100);
          return { label: `Move ${label(p.item)} ${d} cm ${DIR_WORD(dir)}`, ops: [{ type: 'UPDATE_OBJECT', id: p.item.id, patch: { x, y } }], movedM: delta, verified: true };
        }
      }
    }
  }
  return undefined;
}

function addFixes(model: SpaceModel, furniture: FurnitureItem[], cfg: SafetyConfig, overrides: Record<string, boolean>, occ: OccupancyEstimate, findings: SafetyFinding[], g: SafetyGrid) {
  const byId = new Map(furniture.map((f) => [f.id, f]));
  const doorOf = (id: string) => g.doors.find((d) => id.includes(`:${d.id}`));
  for (const f of findings) {
    const items = f.itemIds.map((id) => byId.get(id)).filter((x): x is FurnitureItem => !!x && !x.locked && !isRug(x));
    if (!items.length) continue;
    let plans: Plan[] = [];
    let gone: (fs: SafetyFinding[]) => boolean;
    if (f.kind === 'route-width' || f.kind === 'pinch') {
      const m = /(\d+) cm/.exec(f.title); const now = m ? Number(m[1]) / 100 : 0;
      const needW = f.kind === 'pinch' ? cfg.pinchWidthM : (/at doors\)/.test(f.message) ? cfg.routeWidthM : cfg.doorWidthM);
      const short = Math.max(0.05, needW - now);
      plans = items.map((it) => {
        const poly = itemCorners(it);
        let q = poly[0], bd = Infinity;
        for (let k = 0; k < 4; k++) { const a = poly[k], b = poly[(k + 1) % 4]; const ab = sub(b, a); const t = Math.max(0, Math.min(1, dot(sub(f.at, a), ab) / (dot(ab, ab) || 1))); const p = add(a, mul(ab, t)); const d = dist(p, f.at); if (d < bd) { bd = d; q = p; } }
        const away = norm(sub(q, f.at));
        const axes = axesOf(it).sort((a, b) => dot(b, away) - dot(a, away));
        return [{ item: it, dir: axes[0], minD: Math.max(0.05, short - 0.04) }, ...axes.slice(1).filter((a) => dot(a, away) > -0.5).map((a) => ({ item: it, dir: a, minD: 0.05 }))];
      }).flat();
      gone = (fs) => !fs.some((x) => x.kind === f.kind && dist(x.at, f.at) < 0.45);
    } else if (f.kind === 'trapped') {
      plans = items.flatMap((it) => axesOf(it).map((a) => ({ item: it, dir: a, minD: 0.05 })));
      gone = (fs) => !fs.some((x) => x.id === f.id);
    } else if (f.kind === 'door-blocked' || f.kind === 'door-swing' || f.kind === 'exit-clearance') {
      const d = doorOf(f.id); if (!d) continue;
      plans = items.map((it) => {
        const away = norm(sub(it, d.c));
        const axes = axesOf(it).sort((a, b) => dot(b, away) - dot(a, away));
        return axes.filter((a) => dot(a, away) > -0.2).map((a) => ({ item: it, dir: a, minD: 0.05 }));
      }).flat();
      gone = (fs) => !fs.some((x) => x.id === f.id);
    } else continue;
    const fix = searchFix(model, furniture, cfg, overrides, occ, f, findings, plans, gone);
    if (fix) f.fix = fix;
  }
}

// ---- Suggestions ------------------------------------------------------------------------------

function suggest(ctx: Ctx, egress: RoomEgress[]): Suggestion[] {
  const { g, cfg, model, F, stand } = ctx;
  const out: Suggestion[] = [];
  if (!F) return out;
  const N = g.cols * g.rows;
  const inside = (p: Vec2) => roomOf(model, p) >= 0;
  const served = new Map<string, number>();
  for (const e of egress) if (e.exitId) served.set(e.exitId, (served.get(e.exitId) ?? 0) + Math.max(1, e.people));
  const used = ctx.exits.filter((d) => served.has(d.id));
  const main = [...used].sort((a, b) => (served.get(b.id) ?? 0) - (served.get(a.id) ?? 0))[0] ?? ctx.exits[0];

  const beside = (d: DoorInfo, side: 1 | -1, gapIn = 0.25) => {
    for (const s of [side, -side] as const) {
      const p = add(add(d.c, mul(d.dir, s * (d.widthM / 2 + 0.35))), mul(d.inward, gapIn));
      if (inside(p)) return p;
    }
    return add(d.c, mul(d.inward, 0.6));
  };

  // Extinguishers: one beside each used exit, then more until everywhere is within reach.
  const ext: Vec2[] = (used.length ? used : [main]).map((d) => beside(d, 1));
  const wallsOnly = g.segs.filter((s) => !s.itemId);
  for (let round = 0; round < 8; round++) {
    const src = ext.map((p) => { const c = cellAt(g, p); return c >= 0 && stand(c) ? c : nearestStand(ctx, p); }).filter((c) => c >= 0);
    const E = shortest(g, src, stand);
    let far = -1;
    for (let i = 0; i < N; i++) if (stand(i) && Number.isFinite(E.len[i]) && (far < 0 || E.len[i] > E.len[far])) far = i;
    if (far < 0 || E.len[far] <= cfg.extinguisherTravelM) break;
    const ch = chain(F, far);
    const back = ch.find((c) => F.len[far] - F.len[c] >= cfg.extinguisherTravelM * 0.5) ?? ch[Math.floor(ch.length / 2)];
    const p = centre(g, back);
    let q = p, bd = Infinity;
    for (const s of wallsOnly) { const ab = sub(s.b, s.a); const t = Math.max(0, Math.min(1, dot(sub(p, s.a), ab) / (dot(ab, ab) || 1))); const w = add(s.a, mul(ab, t)); const d = dist(w, p); if (d < bd) { bd = d; q = w; } }
    const spot = bd < 3 ? add(q, mul(norm(sub(p, q)), 0.2)) : p;
    ext.push(inside(spot) ? spot : p);
  }
  ext.forEach((p, i) => out.push({
    kind: 'extinguisher', at: p, label: 'Fire extinguisher',
    reason: i < (used.length || 1) ? 'Beside the exit, so you grab it on the way out and keep your escape behind you.' : `On the escape route, keeping every spot within ${cfg.extinguisherTravelM} m of one.`,
  }));

  // Alarms: every room on the route, bedrooms named; heat alarm in kitchens, none in bathrooms.
  model.spaces.forEach((s) => {
    const k = `${s.name} ${s.purpose ?? ''}`;
    if (/bath|wc|toilet|shower|sauna/i.test(k)) return;
    const kitchen = /kitchen|kök/i.test(k);
    const bedroom = /bed|sleep|sov/i.test(k) || ctx.furniture.some((f) => /bed/i.test(f.category) && roomOf(model, f) === model.spaces.indexOf(s));
    const step = Math.max(1, Math.round(0.25 / g.cell));
    const pts: Array<{ p: Vec2; e: number }> = [];
    for (let i = 0; i < N; i += 1) {
      if (g.room[i] !== model.spaces.indexOf(s)) continue;
      const c = i % g.cols, r = Math.floor(i / g.cols); if (c % step || r % step) continue;
      const p = centre(g, i); if (!pointInPolygon(p, s.polygon)) continue;
      pts.push({ p, e: distPointPolygonEdges(p, s.polygon) });
    }
    if (!pts.length) return;
    const R = cfg.alarmRadiusM;
    const placed: Vec2[] = [];
    const usable = pts.filter((x) => x.e >= 0.5);
    const pool = usable.length ? usable : pts;
    while (placed.length < 6) {
      const unc = pts.filter((x) => !placed.some((a) => dist(a, x.p) <= R));
      if (!unc.length) break;
      let best = pool[0], bc = -1;
      for (const c of pool) {
        const cover = unc.filter((u) => dist(u.p, c.p) <= R).length + c.e * 0.01;
        if (cover > bc) { bc = cover; best = c; }
      }
      placed.push(best.p);
    }
    for (const p of placed) out.push({
      kind: kitchen ? 'heat-alarm' : 'smoke-alarm', at: p,
      label: kitchen ? `Heat alarm (${s.name})` : `Smoke alarm (${s.name})`,
      reason: kitchen ? 'Cooking fumes set off smoke alarms; a heat alarm avoids false alarms.' : bedroom ? 'Wakes people while they sleep. Ceiling, at least 50 cm from walls.' : 'Warns early on the way out. Ceiling, at least 50 cm from walls.',
    });
  });

  // Signs: above each used exit and at each inner door people pass on the way out.
  for (const d of used) out.push({ kind: 'exit-sign', at: add(d.c, mul(d.inward, 0.15)), dir: d.outward, label: `Exit sign above ${d.label}`, reason: 'Marks the way out, also when it is dark or smoky.' });
  const signed = new Set<number>();
  for (const e of egress) {
    if (!e.from) continue;
    const start = cellAt(g, e.from); if (start < 0) continue;
    const ch = chain(F, start);
    for (let j = 1; j < ch.length; j++) {
      const k = g.door[ch[j]];
      if (k < 0 || signed.has(k) || g.doors[k].exit) continue;
      signed.add(k);
      const d = g.doors[k], prev = centre(g, ch[Math.max(0, j - 6)]), next = centre(g, ch[Math.min(ch.length - 1, j + 6)]);
      const dir = norm(sub(next, prev));
      out.push({ kind: 'direction-sign', at: add(d.c, mul(dir, -0.5)), dir, label: `Exit arrow at ${d.label}`, reason: 'Shows which way to go where the route leaves a room.' });
    }
  }
  if (main) {
    const fa = beside(main, -1, 0.3);
    out.push({ kind: 'first-aid', at: fa, label: 'First-aid kit', reason: 'Near the main exit: everyone knows the spot and passes it.' });
    out.push({ kind: 'assembly', at: add(main.c, mul(main.outward, 3)), dir: main.outward, label: 'Assembly point', reason: 'Meet outside, well clear of the building and the doors, and count heads.' });
  }
  return out;
}

function nearestStand(ctx: Ctx, p: Vec2): number {
  const { g, stand } = ctx;
  let best = -1, bd = Infinity;
  for (let i = 0; i < g.free.length; i++) { if (!stand(i)) continue; const d = dist(centre(g, i), p); if (d < bd) { bd = d; best = i; } }
  return best;
}

// ---- Public entry -----------------------------------------------------------------------------

export function resolveConfig(patch?: Partial<SafetyConfig>): SafetyConfig {
  const cfg = { ...SAFETY_DEFAULTS };
  if (patch) for (const k of Object.keys(patch) as SafetyKey[]) { const v = patch[k]; if (typeof v === 'number' && Number.isFinite(v) && v >= 0) cfg[k] = v; }
  return cfg;
}

export function assessSafety(model: SpaceModel, furniture: FurnitureItem[], opts: SafetyOptions = {}): SafetyReport {
  const cfg = resolveConfig(opts.config);
  const overrides = opts.exitOverrides ?? {};
  const occupancy = estimateOccupancy(model, furniture, cfg, opts.occupancy);
  const core = analyse(model, furniture, cfg, overrides, occupancy, true);
  const { ctx, egress } = core;
  const findings = core.findings;
  if (!opts.skipFixes) addFixes(model, furniture, cfg, overrides, occupancy, findings, ctx.g);
  findings.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || (a.area === b.area ? 0 : a.area === 'fire' ? -1 : 1));

  // Evacuation: people at seats, the rest spread over free floor in their room.
  let evacuation: EvacResult | null = null, evacuationSlowS: number | null = null;
  if (ctx.F) {
    const rnd = mulberry32(opts.seed ?? 7);
    const starts: Vec2[] = [];
    occupancy.rooms.forEach((r, k) => {
      const seats = furniture.filter((f) => roomOf(model, f) === k).flatMap((f) => seatPositions(f, furniture));
      const take = seats.slice(0, r.people);
      const pool: number[] = [];
      for (let i = 0; i < ctx.g.free.length; i++) if (ctx.g.room[i] === k && ctx.stand(i) && Number.isFinite(ctx.F!.len[i])) pool.push(i);
      while (take.length < r.people && pool.length) take.push(centre(ctx.g, pool[Math.floor(rnd() * pool.length)]));
      starts.push(...take);
    });
    const run = (v: number) => simulateEvacuation(ctx.g, ctx.F!, starts, ctx.stand, { speedMS: v, flowPerMS: cfg.doorFlowPerMS, leafM: cfg.doorLeafM });
    evacuation = run(cfg.walkSpeedMS);
    evacuationSlowS = run(cfg.slowSpeedMS).timeToClearS;
  }

  const suggestions = suggest(ctx, egress);
  const nC = findings.filter((f) => f.severity === 'critical').length, nI = findings.filter((f) => f.severity === 'important').length, nA = findings.length - nC - nI;
  const score = Math.max(0, Math.min(100, 100 - 25 * nC - 10 * nI - 2 * nA));
  const fireFix = findings.filter((f) => f.area === 'fire' && f.severity !== 'advice').length;
  const headline = fireFix
    ? `${fireFix} ${fireFix === 1 ? 'thing' : 'things'} to fix on the escape ${model.spaces.length > 1 ? 'routes' : 'route'}`
    : findings.some((f) => f.severity !== 'advice')
      ? `Escape routes look clear; ${nC + nI} accessibility ${nC + nI === 1 ? 'issue' : 'issues'} to fix`
      : nA ? `No blocking problems found; ${nA} ${nA === 1 ? 'suggestion' : 'suggestions'}` : 'No problems found with these assumptions';

  return {
    exits: ctx.exits.map((d) => ({ id: d.id, label: d.label, spaceId: d.space.id, at: d.c, outward: d.outward, widthM: d.widthM, swing: d.opening.swing, auto: d.autoExit })),
    doors: ctx.g.doors.map((d) => ({ id: d.id, label: d.label, exit: d.exit, auto: d.autoExit, widthM: d.widthM })),
    egress, findings, score, headline, occupancy, suggestions, evacuation, evacuationSlowS, config: cfg, notAssessed: NOT_ASSESSED,
  };
}

/** Re-runs only the geometric checks (no fixes, no simulation); used to confirm a fix. */
export function quickFindings(model: SpaceModel, furniture: FurnitureItem[], opts: SafetyOptions = {}): SafetyFinding[] {
  const cfg = resolveConfig(opts.config);
  return analyse(model, furniture, cfg, opts.exitOverrides ?? {}, estimateOccupancy(model, furniture, cfg, opts.occupancy), false).findings;
}
