// How the rooms of a building connect: a graph from doors shared by two rooms, exits through the
// shell, and shortest routes through doors for egress checks and walk-throughs.
import { centroid, openingSegment, pointInPolygon } from '../../core/geometry';
import type { SpaceModel, Vec2 } from '../../core/types';

export interface DoorLink { a: string; b: string; at: Vec2; widthM: number; openingIds: string[] }
export interface Exit { id: string; spaceId: string; at: Vec2; widthM: number }
export interface RoomGraph { links: DoorLink[]; exits: Exit[]; neighbours: Map<string, string[]> }

export interface BuildingRoute {
  /** Spaces passed through, first to last. */
  spaceIds: string[];
  /** Polyline: start, door centres, end. */
  points: Vec2[];
  lengthM: number;
}

export interface Egress { spaceId: string; name: string; exitId: string | null; lengthM: number | null; route: BuildingRoute | null }

export interface BuildingRoutes {
  graph: RoomGraph;
  /** Route between two rooms (centre to centre) through doors, or null when they do not connect. */
  route: (fromSpaceId: string, toSpaceId: string) => BuildingRoute | null;
  /** Shortest way out from each room. */
  egress: Egress[];
  /** Rooms with no way out. */
  trapped: string[];
  /** Longest of the shortest ways out, metres. */
  worstEgressM: number | null;
}

const PASSABLE = new Set(['door', 'opening']);

/** Door links between rooms: two openings in different spaces at the same point form one link. */
export function roomGraph(model: SpaceModel): RoomGraph {
  const spaces = new Map(model.spaces.map((s) => [s.id, s]));
  const doors = model.openings
    .filter((o) => PASSABLE.has(o.kind) && spaces.get(o.spaceId) && o.wallIndex < spaces.get(o.spaceId)!.polygon.length)
    .map((o) => ({ o, c: openingSegment(spaces.get(o.spaceId)!, o).c }));
  const used = new Set<string>();
  const links: DoorLink[] = [];
  for (let i = 0; i < doors.length; i++) {
    if (used.has(doors[i].o.id)) continue;
    for (let j = i + 1; j < doors.length; j++) {
      if (used.has(doors[j].o.id) || doors[j].o.spaceId === doors[i].o.spaceId) continue;
      if (Math.hypot(doors[i].c.x - doors[j].c.x, doors[i].c.y - doors[j].c.y) > 0.15) continue;
      used.add(doors[i].o.id); used.add(doors[j].o.id);
      links.push({ a: doors[i].o.spaceId, b: doors[j].o.spaceId, at: doors[i].c, widthM: Math.min(doors[i].o.widthM, doors[j].o.widthM), openingIds: [doors[i].o.id, doors[j].o.id] });
      break;
    }
  }
  // An unpaired door leads outside when just beyond it is outside every room.
  const exits: Exit[] = [];
  for (const d of doors) {
    if (used.has(d.o.id)) continue;
    const s = spaces.get(d.o.spaceId)!;
    const { inward } = openingSegment(s, d.o);
    const beyond = { x: d.c.x - inward.x * 0.3, y: d.c.y - inward.y * 0.3 };
    if (!model.spaces.some((q) => pointInPolygon(beyond, q.polygon))) exits.push({ id: d.o.id, spaceId: s.id, at: d.c, widthM: d.o.widthM });
  }
  const neighbours = new Map<string, string[]>(model.spaces.map((s) => [s.id, []]));
  for (const l of links) { neighbours.get(l.a)?.push(l.b); neighbours.get(l.b)?.push(l.a); }
  return { links, exits, neighbours };
}

/** A point inside the room to start or end at: its centroid, or the middle of its largest strip. */
export function roomPoint(model: SpaceModel, spaceId: string): Vec2 | null {
  const s = model.spaces.find((x) => x.id === spaceId);
  if (!s) return null;
  const c = centroid(s.polygon);
  if (pointInPolygon(c, s.polygon)) return c;
  // concave room: scan for an inside point near the centroid
  for (let r = 0.2; r < 10; r += 0.2) for (let k = 0; k < 16; k++) {
    const p = { x: c.x + Math.cos(k * Math.PI / 8) * r, y: c.y + Math.sin(k * Math.PI / 8) * r };
    if (pointInPolygon(p, s.polygon)) return p;
  }
  return s.polygon[0];
}

interface Node { id: string; at: Vec2; spaces: string[] }

function shortest(model: SpaceModel, g: RoomGraph, fromSpace: string, goal: (n: Node) => boolean, extraGoals: Node[]): { path: Node[]; length: number } | null {
  const start = roomPoint(model, fromSpace);
  if (!start) return null;
  const nodes: Node[] = [{ id: '__start', at: start, spaces: [fromSpace] }, ...g.links.map((l, i) => ({ id: `link${i}`, at: l.at, spaces: [l.a, l.b] })), ...extraGoals];
  const dist = new Map<string, number>([['__start', 0]]);
  const prev = new Map<string, Node>();
  const open = new Set<Node>([nodes[0]]);
  const done = new Set<string>();
  while (open.size) {
    let cur: Node | null = null, cd = Infinity;
    for (const n of open) { const d = dist.get(n.id) ?? Infinity; if (d < cd) { cd = d; cur = n; } }
    if (!cur) break;
    open.delete(cur); done.add(cur.id);
    if (cur.id !== '__start' && goal(cur)) {
      const path: Node[] = [cur];
      for (let p = prev.get(cur.id); p; p = prev.get(p.id)) path.unshift(p);
      return { path, length: cd };
    }
    for (const n of nodes) {
      if (done.has(n.id) || n === cur) continue;
      if (!n.spaces.some((s) => cur!.spaces.includes(s))) continue;
      const nd = cd + Math.hypot(n.at.x - cur.at.x, n.at.y - cur.at.y);
      if (nd < (dist.get(n.id) ?? Infinity)) { dist.set(n.id, nd); prev.set(n.id, cur); open.add(n); }
    }
  }
  return null;
}

function toRoute(path: Node[], fromSpace: string): BuildingRoute {
  const spaceIds = [fromSpace];
  for (let i = 1; i < path.length; i++) {
    const last = spaceIds[spaceIds.length - 1];
    const next = path[i].spaces.find((s) => s !== last);
    if (next && path[i].spaces.length > 1) spaceIds.push(next);
  }
  let len = 0;
  for (let i = 1; i < path.length; i++) len += Math.hypot(path[i].at.x - path[i - 1].at.x, path[i].at.y - path[i - 1].at.y);
  return { spaceIds, points: path.map((n) => n.at), lengthM: Math.round(len * 100) / 100 };
}

export function buildingRoutes(model: SpaceModel): BuildingRoutes {
  const graph = roomGraph(model);
  const route = (from: string, to: string): BuildingRoute | null => {
    if (from === to) { const p = roomPoint(model, from); return p ? { spaceIds: [from], points: [p], lengthM: 0 } : null; }
    const end = roomPoint(model, to);
    if (!end) return null;
    const goalNode: Node = { id: '__end', at: end, spaces: [to] };
    const r = shortest(model, graph, from, (n) => n.id === '__end', [goalNode]);
    return r ? toRoute(r.path, from) : null;
  };
  const exitNodes: Node[] = graph.exits.map((e) => ({ id: `exit:${e.id}`, at: e.at, spaces: [e.spaceId] }));
  const egress: Egress[] = model.spaces.map((s) => {
    const r = shortest(model, graph, s.id, (n) => n.id.startsWith('exit:'), exitNodes);
    if (!r) return { spaceId: s.id, name: s.name, exitId: null, lengthM: null, route: null };
    const last = r.path[r.path.length - 1];
    return { spaceId: s.id, name: s.name, exitId: last.id.slice(5), lengthM: Math.round(r.length * 100) / 100, route: toRoute(r.path, s.id) };
  });
  const trapped = egress.filter((e) => e.lengthM == null).map((e) => e.spaceId);
  const lens = egress.map((e) => e.lengthM).filter((x): x is number => x != null);
  return { graph, route, egress, trapped, worstEgressM: lens.length ? Math.max(...lens) : null };
}
