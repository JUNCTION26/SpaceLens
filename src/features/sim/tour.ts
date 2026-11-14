// Walking paths for the 3D view: click-to-move through doors and an automatic tour that visits
// every room along the door graph, both planned on the same occupancy grid as the route checks.
import { area } from '../../core/geometry';
import type { SpaceModel, Vec2 } from '../../core/types';
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

export interface TourStop { spaceId: string; name: string; at: Vec2 }
export interface Tour { stops: TourStop[]; points: Vec2[]; lengthM: number }

/**
 * Rooms in the order a visitor would walk them (depth first from the start room through doors),
 * joined into one walking line. Rooms that cannot be reached are left out, and so are closets
 * and WCs under `minAreaM2` (standing in one only shows a wall up close).
 */
export function planTour(model: SpaceModel, g: OccGrid, start: Vec2, minAreaM2 = 6): Tour {
  const graph = roomGraph(model);
  const first = spaceAt(model, start)?.id ?? model.spaces[0]?.id;
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id); order.push(id);
    // nearer neighbours first keeps the walk short
    const here = roomSpot(model, id, g);
    const next = [...(graph.neighbours.get(id) ?? [])].sort((p, q) => {
      const a = roomSpot(model, p, g), b = roomSpot(model, q, g);
      return Math.hypot(a.x - here.x, a.y - here.y) - Math.hypot(b.x - here.x, b.y - here.y);
    });
    for (const n of next) visit(n);
  };
  if (first) visit(first);
  for (const s of model.spaces) if (!seen.has(s.id)) order.push(s.id);
  const stops: TourStop[] = [];
  const points: Vec2[] = [];
  let cur = start, lengthM = 0;
  for (const id of order) {
    const sp = model.spaces.find((s) => s.id === id);
    if (sp && area(sp.polygon) < minAreaM2 && id !== first) continue;
    const at = roomSpot(model, id, g, 0.45);
    const leg = pathBetween(g, cur, at);
    if (!leg) continue;
    for (const p of leg) { lengthM += Math.hypot(p.x - cur.x, p.y - cur.y); points.push(p); cur = p; }
    stops.push({ spaceId: id, name: model.spaces.find((s) => s.id === id)?.name ?? id, at });
  }
  return { stops, points, lengthM: Math.round(lengthM * 10) / 10 };
}
