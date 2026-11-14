import type { BodyProfileId, FurnitureItem, RouteResult, SpaceModel, Vec2 } from '../../core/types';
import { pointInPolygon } from '../../core/geometry';
import { astar, buildGrid, centreOf, doorInner, pathLength, roomCentroid, smooth, snapFree } from './grid';
import type { OccGrid } from './grid';
import { wallEdges } from './walls';

export interface BodyProfile { id: BodyProfileId; label: string; widthM: number; turnM?: number; note: string }
export const PROFILES: BodyProfile[] = [
  { id: 'adult', label: 'Adult', widthM: 0.6, note: 'Adult walking, 0.60 m wide' },
  { id: 'child', label: 'Child', widthM: 0.45, note: 'Child, 0.45 m wide' },
  { id: 'wheelchair', label: 'Wheelchair', widthM: 0.9, turnM: 1.5, note: 'Wheelchair, 0.90 m wide, 1.50 m turning circle' },
  { id: 'stroller', label: 'Stroller', widthM: 0.65, note: 'Stroller, 0.65 m wide' },
  { id: 'cart', label: 'Cart', widthM: 0.75, note: 'Delivery cart, 0.75 m wide' },
];
export const profileOf = (id: BodyProfileId) => PROFILES.find((p) => p.id === id)!;

export interface Target { id: string; label: string; from: Vec2; to: Vec2 }

/**
 * One room: each door's inner point to each window of that room (0.5 m in front) and to the room
 * centre. A building: from each entrance to the middle of every room, through its doors.
 */
export function defaultTargets(model: SpaceModel, g?: OccGrid): Target[] {
  if (model.spaces.length > 1) return buildingTargets(model, g);
  const out: Target[] = [];
  const doors = model.openings.filter((o) => o.kind === 'door' || o.kind === 'opening');
  const wins = model.openings.filter((o) => o.kind === 'window');
  doors.forEach((d, di) => {
    const from = doorInner(model, d.id, 0.3); if (!from) return;
    wins.filter((w) => w.spaceId === d.spaceId).forEach((w, wi) => {
      const to = doorInner(model, w.id, 0.5);
      if (to) out.push({ id: `${d.id}>${w.id}`, label: `Door ${di + 1} to window ${wi + 1}`, from, to });
    });
    out.push({ id: `${d.id}>c`, label: `Door ${di + 1} to centre`, from, to: roomCentroid(model, d.spaceId) });
  });
  return out;
}

/** Doors and openings on the facade (the ways in), in model order. */
export function entranceDoors(model: SpaceModel) {
  const edges = wallEdges(model);
  return model.openings.filter((o) => o.kind !== 'window' && edges.some((w) => w.spaceId === o.spaceId && w.wallIndex === o.wallIndex && !w.neighbour));
}

/** A free spot in a room near its middle: furniture often stands right on the centroid. */
export function roomSpot(model: SpaceModel, spaceId: string, g?: OccGrid, clearM = 0.35): Vec2 {
  const c = roomCentroid(model, spaceId);
  const s = model.spaces.find((x) => x.id === spaceId);
  if (!g || !s) return c;
  let best: Vec2 | null = null, bd = Infinity;
  const xs = s.polygon.map((p) => p.x), ys = s.polygon.map((p) => p.y);
  for (let y = Math.min(...ys); y <= Math.max(...ys); y += g.cell * 2) for (let x = Math.min(...xs); x <= Math.max(...xs); x += g.cell * 2) {
    const i = Math.floor((y - g.oy) / g.cell) * g.cols + Math.floor((x - g.ox) / g.cell);
    if (i < 0 || i >= g.dist.length || g.dist[i] < clearM) continue;
    const p = { x, y };
    if (!pointInPolygon(p, s.polygon)) continue;
    const d = (x - c.x) ** 2 + (y - c.y) ** 2;
    if (d < bd) { bd = d; best = p; }
  }
  return best ?? c;
}

function buildingTargets(model: SpaceModel, g?: OccGrid): Target[] {
  const ins = entranceDoors(model);
  const starts = ins.length ? ins : model.openings.filter((o) => o.kind !== 'window').slice(0, 1);
  const out: Target[] = [];
  starts.forEach((d, di) => {
    const from = doorInner(model, d.id, 0.3); if (!from) return;
    const tag = starts.length > 1 ? `Entrance ${di + 1}` : 'Entrance';
    for (const s of model.spaces) {
      out.push({ id: `${d.id}>${s.id}`, label: `${tag} to ${s.name}`, from, to: roomSpot(model, s.id, g) });
    }
  });
  return out;
}

export function routeOnGrid(g: OccGrid, t: Target, p: BodyProfile): RouteResult {
  const hw = p.widthM / 2;
  const base = { id: `${t.id}:${p.id}`, profile: p.id, label: t.label };
  const snap = (q: Vec2) => { const i = snapFree(g, q, hw, 16); return i >= 0 ? i : snapFree(g, q, 0.01, 10); };
  const s = snap(t.from), e = snap(t.to);
  if (s < 0 || e < 0) return { ...base, points: [t.from], ok: false, lengthM: null, narrowestM: 0, narrowestAt: t.from };
  const res = astar(g, s, e, hw);
  let mn = Infinity, at = res.path[0];
  if (res.reached) {
    for (const c of res.path) if (g.dist[c] < mn) { mn = g.dist[c]; at = c; }
  } else {
    // locate the choke: tightest cell on an unrestricted path
    const loose = astar(g, s, e, 0.01);
    if (loose.reached) { for (const c of loose.path) if (g.dist[c] < mn) { mn = g.dist[c]; at = c; } }
    else { mn = 0; at = loose.closest; }
  }
  const raw = res.path.map((c) => centreOf(g, c));
  const pts = smooth(g, raw, res.reached ? hw : Math.min(hw, g.dist[s]));
  return {
    ...base, points: pts.length ? pts : [t.from], ok: res.reached, lengthM: res.reached ? pathLength(pts) : null,
    narrowestM: Number.isFinite(mn) ? 2 * mn : null, narrowestAt: centreOf(g, at),
  };
}

export interface TurnCheck { ok: boolean; at?: Vec2 }
/** Is there a spot reachable from `from` where the full turning circle fits? */
export function turningCircle(g: OccGrid, from: Vec2, p: BodyProfile): TurnCheck {
  const R = (p.turnM ?? 1.5) / 2, hw = p.widthM / 2, s = snapFree(g, from, hw, 10);
  if (s < 0) return { ok: false };
  const seen = new Uint8Array(g.cols * g.rows), q = [s]; seen[s] = 1; let best = -1;
  while (q.length) {
    const i = q.pop()!;
    if (g.dist[i] >= R && (best < 0 || g.dist[i] > g.dist[best])) best = i;
    const c = i % g.cols;
    const nb = [c > 0 ? i - 1 : -1, c < g.cols - 1 ? i + 1 : -1, i - g.cols, i + g.cols];
    for (const j of nb) { if (j < 0 || j >= seen.length || seen[j] || g.dist[j] < hw) continue; seen[j] = 1; q.push(j); }
  }
  return best < 0 ? { ok: false } : { ok: true, at: centreOf(g, best) };
}

export interface RouteRun { routes: RouteResult[]; turn: TurnCheck | null }
export function runRoutes(model: SpaceModel, furniture: FurnitureItem[], profile: BodyProfileId, targets?: Target[]): RouteRun {
  const g = buildGrid(model, furniture), p = profileOf(profile);
  targets = targets ?? defaultTargets(model, g);
  const routes = targets.map((t) => routeOnGrid(g, t, p));
  const turn = p.turnM && targets[0] ? turningCircle(g, targets[0].from, p) : null;
  return { routes, turn };
}
