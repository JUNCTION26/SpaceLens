// Walking paths for the 3D view: click-to-move through doors and an automatic tour that visits
// every room along the door graph, both planned on the same occupancy grid as the route checks.
import { area, pointInPolygon } from '../../core/geometry';
import type { FurnitureItem, SpaceModel, Vec2 } from '../../core/types';
import { roomGraph } from '../building/connectivity';
import { astar, centreOf, smooth, snapFree, type OccGrid } from './grid';
import { roomSpot } from './routes';
import { spaceAt } from './walls';

/** Shortest clear walking line from a to b (string-pulled), or null when b cannot be reached. */
export function pathBetween(g: OccGrid, a: Vec2, b: Vec2, clearM = 0.25): Vec2[] | null {
  const s = snapFree(g, a, clearM, 12), e = snapFree(g, b, clearM, 16);
  if (s < 0 || e < 0) return null;
  const res = astar(g, s, e, clearM);
  if (!res.reached) return null;
  const pts = smooth(g, res.path.map((c) => centreOf(g, c)), clearM);
  return pts.slice(1).length ? pts.slice(1) : [centreOf(g, e)];
}

export interface TourStop { spaceId: string; name: string; at: Vec2; /** Plan point the visitor faces while pausing here. */ look: Vec2 }
export interface Tour { stops: TourStop[]; points: Vec2[]; lengthM: number; /** Index into `points` of the point each stop is reached at. */ stopIndex: number[] }

export interface RoomNode { id: string; spot: Vec2; /** False for rooms only passed through. */ visit: boolean }
export interface DoorEdge { a: string; b: string; at: Vec2 }
export interface Hop { from: string; to: string; door: Vec2 }

/** Cheapest chain of doors from one room to every other (Dijkstra; a hop costs room spot to door to room spot). */
export function doorPaths(nodes: RoomNode[], doors: DoorEdge[], from: string): Map<string, { cost: number; hops: Hop[] }> {
  const spot = new Map(nodes.map((n) => [n.id, n.spot]));
  const d = (p: Vec2, q: Vec2) => Math.hypot(p.x - q.x, p.y - q.y);
  const best = new Map<string, { cost: number; hops: Hop[] }>([[from, { cost: 0, hops: [] }]]);
  const done = new Set<string>();
  for (;;) {
    let cur: string | null = null, cc = Infinity;
    for (const [id, v] of best) if (!done.has(id) && v.cost < cc) { cc = v.cost; cur = id; }
    if (cur === null) break;
    done.add(cur);
    for (const e of doors) {
      const other = e.a === cur ? e.b : e.b === cur ? e.a : null;
      if (!other || done.has(other) || !spot.has(other)) continue;
      const cost = cc + d(spot.get(cur)!, e.at) + d(e.at, spot.get(other)!);
      if (cost < (best.get(other)?.cost ?? Infinity)) best.set(other, { cost, hops: [...best.get(cur)!.hops, { from: cur, to: other, door: e.at }] });
    }
  }
  return best;
}

/**
 * Room order for the tour: from the room you stand in, always the nearest room not yet seen,
 * measured along the door graph. Returns for each visit the doors to go through; unreachable
 * rooms are left out. `back` is the way from the last room to the start room.
 */
export function tourOrder(nodes: RoomNode[], doors: DoorEdge[], startId: string): { visits: { id: string; hops: Hop[] }[]; back: Hop[] } {
  const todo = new Set(nodes.filter((n) => n.visit && n.id !== startId).map((n) => n.id));
  const visits: { id: string; hops: Hop[] }[] = [];
  const startNode = nodes.find((n) => n.id === startId);
  if (startNode?.visit) visits.push({ id: startId, hops: [] });
  let cur = startId;
  while (todo.size) {
    const paths = doorPaths(nodes, doors, cur);
    let pick: string | null = null, pc = Infinity;
    for (const id of todo) { const p = paths.get(id); if (p && p.cost < pc - 1e-9) { pc = p.cost; pick = id; } }
    if (pick === null) break;
    visits.push({ id: pick, hops: paths.get(pick)!.hops });
    todo.delete(pick); cur = pick;
  }
  return { visits, back: doorPaths(nodes, doors, cur).get(startId)?.hops ?? [] };
}

const HERO = /(sofa|couch|bed|dining|table|desk|kitchen|island|piano|fireplace|tv|bath)/i;
/** The piece worth looking at in a room: the largest footprint, with sofas, beds and tables favoured. */
export function heroPiece(model: SpaceModel, spaceId: string, furniture: FurnitureItem[] = model.furniture): FurnitureItem | null {
  const sp = model.spaces.find((s) => s.id === spaceId);
  if (!sp) return null;
  let best: FurnitureItem | null = null, bs = 0;
  for (const f of furniture) {
    if (!pointInPolygon({ x: f.x, y: f.y }, sp.polygon)) continue;
    const sc = f.w * f.d * (HERO.test(`${f.category} ${f.name}`) ? 2 : 1);
    if (sc > bs) { bs = sc; best = f; }
  }
  return best;
}

const join = (g: OccGrid | undefined, a: Vec2, b: Vec2): Vec2[] => (g ? pathBetween(g, a, b) : null) ?? [b];

/**
 * Rooms in the order a visitor would walk them (nearest unvisited room first along the door graph),
 * joined into one walking line that ends where it started. Rooms that cannot be reached are left
 * out, and so are closets and WCs under `minAreaM2`, which are walked through but not visited.
 * Without a grid the legs are straight lines between room spots and doors.
 */
export function planTour(model: SpaceModel, g: OccGrid | undefined, start: Vec2, minAreaM2 = 6, furniture: FurnitureItem[] = model.furniture): Tour {
  const graph = roomGraph(model);
  const first = spaceAt(model, start)?.id ?? model.spaces[0]?.id;
  if (!first) return { stops: [], points: [], lengthM: 0, stopIndex: [] };
  const nodes: RoomNode[] = model.spaces.map((s) => ({ id: s.id, spot: roomSpot(model, s.id, g, 0.45), visit: s.id === first || area(s.polygon) >= minAreaM2 }));
  const doors: DoorEdge[] = graph.links.map((l) => ({ a: l.a, b: l.b, at: l.at }));
  const spot = new Map(nodes.map((n) => [n.id, n.spot]));
  const { visits, back } = tourOrder(nodes, doors, first);
  const points: Vec2[] = [];
  const stops: TourStop[] = [], stopIndex: number[] = [];
  let cur = start, lengthM = 0;
  const go = (to: Vec2) => {
    for (const p of join(g, cur, to)) { lengthM += Math.hypot(p.x - cur.x, p.y - cur.y); points.push(p); cur = p; }
  };
  for (const v of visits) {
    for (const h of v.hops) { go(h.door); go(spot.get(h.to)!); }
    if (!v.hops.length) go(spot.get(v.id)!);
    const sp = model.spaces.find((s) => s.id === v.id)!;
    const hero = heroPiece(model, v.id, furniture);
    const at = spot.get(v.id)!;
    const look = hero ? { x: hero.x, y: hero.y } : { x: at.x + 1, y: at.y };
    stops.push({ spaceId: v.id, name: sp.name, at, look });
    stopIndex.push(Math.max(0, points.length - 1));
  }
  for (const h of back) { go(h.door); go(spot.get(h.to)!); }
  // One room to visit (alone, or with only a WC or closet off it): walk a loop past its corners and
  // stop once more on the far side, looking back in.
  if (stops.length === 1) {
    const sp = model.spaces.find((s) => s.id === stops[0].spaceId)!;
    const xs = sp.polygon.map((p) => p.x), ys = sp.polygon.map((p) => p.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const inset = Math.min(0.8, (x1 - x0) / 4, (y1 - y0) / 4);
    const corners = [{ x: x0 + inset, y: y0 + inset }, { x: x1 - inset, y: y0 + inset }, { x: x1 - inset, y: y1 - inset }, { x: x0 + inset, y: y1 - inset }]
      .map((c) => { if (!g) return c; const i = snapFree(g, c, 0.4); return i >= 0 ? centreOf(g, i) : c; })
      .filter((c) => pointInPolygon(c, sp.polygon));
    if (corners.length) {
      const near = corners.reduce((b, c, i) => (Math.hypot(c.x - cur.x, c.y - cur.y) < Math.hypot(corners[b].x - cur.x, corners[b].y - cur.y) ? i : b), 0);
      const loop = [...corners.slice(near), ...corners.slice(0, near)];
      let far = loop[0];
      for (const c of loop) { go(c); if (Math.hypot(c.x - start.x, c.y - start.y) > Math.hypot(far.x - start.x, far.y - start.y)) far = c; }
      const centre = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
      const hero = heroPiece(model, sp.id, furniture);
      stops.push({ spaceId: sp.id, name: sp.name, at: far, look: hero ? { x: hero.x, y: hero.y } : centre });
      stopIndex.push(Math.max(0, points.length - 1));
    }
  }
  go(start);
  return { stops, points, lengthM: Math.round(lengthM * 10) / 10, stopIndex };
}

/* ---- Timeline: the tour as camera poses over time ---- */

export interface TourPose { t: number; x: number; y: number; yaw: number; /** Index of the stop being looked at, or -1 while walking. */ stop: number }
export interface TourTimeline { poses: TourPose[]; durationS: number }

export const TOUR_PAUSE_S = 1.5;
const TOUR_DT = 1 / 30;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Simulate the tour at a fixed rate: speed eases up and down (slowing into each stop), the view
 * turns toward the way ahead while walking and toward the hero piece during the 1.5 s pause,
 * and the last pose is the start pose with the start heading.
 */
export function tourTimeline(t: Tour, start: Vec2, startYaw: number, speed = 1.2): TourTimeline {
  const poses: TourPose[] = [];
  const pts = [start, ...t.points];
  const stopAt = new Map<number, number>();
  t.stopIndex.forEach((pi, si) => stopAt.set(pi + 1, si));
  let seg = 1, pos = { ...start }, yaw = startYaw, v = 0, time = 0, hold = 0, holding = -1;
  const push = (stop: number) => poses.push({ t: Math.round(time * 1000) / 1000, x: pos.x, y: pos.y, yaw, stop });
  push(-1);
  const MAX_TURN = 2.2 * TOUR_DT; // rad per step: no snapping, even on a U-turn
  const ease = (target: number, rate: number) => { const d = wrap(target - yaw) * (1 - Math.exp(-rate * TOUR_DT)); yaw = wrap(yaw + Math.max(-MAX_TURN, Math.min(MAX_TURN, d))); };
  for (let n = 0; n < 200000; n++) {
    time += TOUR_DT;
    if (holding >= 0) {
      const s = t.stops[holding];
      ease(Math.atan2(-(s.look.x - pos.x), -(s.look.y - pos.y)), 3);
      hold -= TOUR_DT; push(holding);
      if (hold <= 0) holding = -1;
      continue;
    }
    if (seg >= pts.length) {
      // settled at the start: turn back to the start heading, then finish
      ease(startYaw, 4); push(-1);
      if (Math.abs(wrap(startYaw - yaw)) < 0.01 || n > 150000 || time > 1e6) { yaw = startYaw; push(-1); break; }
      continue;
    }
    const target = pts[seg];
    const dx = target.x - pos.x, dy = target.y - pos.y, dist = Math.hypot(dx, dy);
    // distance left to the next stop (or the end), to brake in time
    let toStop = dist;
    for (let k = seg; k < pts.length - 1 && !stopAt.has(k); k++) toStop += Math.hypot(pts[k + 1].x - pts[k].x, pts[k + 1].y - pts[k].y);
    const want = Math.min(speed, Math.max(0.25, Math.sqrt(2 * 0.9 * toStop)));
    v += (want - v) * (1 - Math.exp(-4 * TOUR_DT));
    const stepLen = v * TOUR_DT;
    if (dist <= stepLen + 1e-6) {
      pos = { x: target.x, y: target.y };
      const si = stopAt.get(seg);
      seg++;
      if (si !== undefined) { holding = si; hold = TOUR_PAUSE_S; v = 0; }
    } else {
      pos = { x: pos.x + (dx / dist) * stepLen, y: pos.y + (dy / dist) * stepLen };
      // face a point a little way ahead so corners are rounded, not snapped
      let ax = target.x, ay = target.y, left = 0.9 - dist, k = seg;
      while (left > 0 && k < pts.length - 1) { const l = Math.hypot(pts[k + 1].x - pts[k].x, pts[k + 1].y - pts[k].y); if (l > left) { ax = pts[k].x + ((pts[k + 1].x - pts[k].x) * left) / l; ay = pts[k].y + ((pts[k + 1].y - pts[k].y) * left) / l; break; } left -= l; k++; ax = pts[k].x; ay = pts[k].y; }
      ease(Math.atan2(-(ax - pos.x), -(ay - pos.y)), 3.5);
      push(-1);
    }
  }
  return { poses, durationS: poses[poses.length - 1].t };
}

/** Pose at time t (clamped), interpolated between samples. */
export function poseAt(tl: TourTimeline, t: number): TourPose {
  const p = tl.poses;
  if (t <= 0) return p[0];
  if (t >= tl.durationS) return p[p.length - 1];
  let lo = 0, hi = p.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (p[m].t <= t) lo = m; else hi = m; }
  const a = p[lo], b = p[hi], k = (t - a.t) / Math.max(1e-9, b.t - a.t);
  return { t, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, yaw: a.yaw + wrap(b.yaw - a.yaw) * k, stop: a.stop };
}

/** Tour progress as a number from 0 to 1. */
export const tourProgress = (tl: TourTimeline, t: number) => (tl.durationS > 0 ? Math.min(1, Math.max(0, t / tl.durationS)) : 1);
