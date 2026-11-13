import type { BodyProfileId, FurnitureItem, RouteResult, SpaceModel, Vec2 } from '../../core/types';
import { astar, buildGrid, centreOf, doorInner, pathLength, roomCentroid, smooth, snapFree } from './grid';
import type { OccGrid } from './grid';

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

/** Each door's inner point to each window (0.5 m in front) and to the room centre. */
export function defaultTargets(model: SpaceModel): Target[] {
  const out: Target[] = [];
  const doors = model.openings.filter((o) => o.kind === 'door' || o.kind === 'opening');
  const wins = model.openings.filter((o) => o.kind === 'window');
  doors.forEach((d, di) => {
    const from = doorInner(model, d.id, 0.3); if (!from) return;
    wins.forEach((w, wi) => {
      const to = doorInner(model, w.id, 0.5);
      if (to) out.push({ id: `${d.id}>${w.id}`, label: `Door ${di + 1} to window ${wi + 1}`, from, to });
    });
    out.push({ id: `${d.id}>c`, label: `Door ${di + 1} to centre`, from, to: roomCentroid(model) });
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
export function runRoutes(model: SpaceModel, furniture: FurnitureItem[], profile: BodyProfileId, targets = defaultTargets(model)): RouteRun {
  const g = buildGrid(model, furniture), p = profileOf(profile);
  const routes = targets.map((t) => routeOnGrid(g, t, p));
  const turn = p.turnM && targets[0] ? turningCircle(g, targets[0].from, p) : null;
  return { routes, turn };
}
