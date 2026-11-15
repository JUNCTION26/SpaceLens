// Wheelchair view: where a body of 0.35 m radius cannot pass.
import type { FurnitureItem, SpaceModel, Vec2 } from '../../core/types';
import { roomGraph } from '../building/connectivity';
import { astar, buildGrid, centreOf, snapFree, type OccGrid } from './grid';
import { roomSpot } from './routes';
import { BODY } from './collide';

export interface Pinch { kind: 'door' | 'room'; at: Vec2; spaceId?: string; widthM?: number }

/** Doors narrower than the chair, and rooms that cannot be reached from `start` at that width. */
export function wheelchairPinches(model: SpaceModel, furniture: FurnitureItem[], start: Vec2, g: OccGrid = buildGrid(model, furniture), r: number = BODY.wheelchair): Pinch[] {
  const out: Pinch[] = [];
  const graph = roomGraph(model);
  for (const l of graph.links) if (l.widthM < 2 * r) out.push({ kind: 'door', at: l.at, widthM: l.widthM });
  for (const e of graph.exits) if (e.widthM < 2 * r) out.push({ kind: 'door', at: e.at, widthM: e.widthM });
  const s = snapFree(g, start, r, 12);
  if (s < 0) return [...out, { kind: 'room', at: start }];
  for (const sp of model.spaces) {
    const to = roomSpot(model, sp.id, g, r);
    const e = snapFree(g, to, r, 16);
    if (e < 0) { out.push({ kind: 'room', at: to, spaceId: sp.id }); continue; }
    const res = astar(g, s, e, r);
    if (!res.reached) out.push({ kind: 'room', at: centreOf(g, res.closest), spaceId: sp.id });
  }
  return out;
}
