// Walls of a whole building, seen once. Rooms that share a wall each carry it on the same line, so
// a shared wall is drawn and collided with once (by the room listed first), its gaps are the door
// and opening gaps of both rooms, and every point can be asked which room it is in.
import { add, centroid, distPointSegment, mul, norm, openingSegment, pointInPolygon, sub, wallInwardNormal } from '../../core/geometry';
import type { Opening, OpeningKind, Space, SpaceModel, Vec2 } from '../../core/types';

export interface WallGap { s: number; e: number; kind: OpeningKind; opening: Opening }

export interface WallEdge {
  spaceId: string;
  wallIndex: number;
  a: Vec2;
  b: Vec2;
  length: number;
  /** Unit direction a to b and inward normal of the owning room. */
  dir: Vec2;
  inward: Vec2;
  /** Thickness carried by this room's side. */
  thicknessM: number;
  /** Room on the other side, or null for a facade wall. */
  neighbour: string | null;
  /** Thickness carried by the neighbour (0 on the facade). */
  neighbourThicknessM: number;
  /**
   * Distance to the neighbour's facing edge. 0 when both rooms sit on one line (generated plans);
   * the wall thickness for imported plans, whose rooms are net floor areas with the wall between.
   */
  gapM: number;
  /** False when the neighbour draws this wall instead (each side draws its half across a gap). */
  owner: boolean;
  /** Openings of both rooms along this wall, sorted, in metres from `a`. */
  gaps: WallGap[];
}

const NUDGE = 0.05;
const HALL = /(hall|corrid|flur|diele|couloir|entr|ingresso|disimpegno|eingang)/i;
const OUTDOOR = /(balcon|balkon|balcony|terrace|terrazz|terrasse|loggia|veranda|patio|parveke|sitzplatz|deck)/i;
/** Balconies, terraces and loggias: open to the sky, edged by a railing instead of walls. */
export const isOutdoor = (s: Pick<Space, 'name' | 'purpose'>) => s.purpose === 'balcony' || s.purpose === 'terrace' || OUTDOOR.test(`${s.purpose ?? ''} ${s.name}`);

/** Room containing p, or null. */
export function spaceAt(model: SpaceModel, p: Vec2): Space | null {
  for (const s of model.spaces) if (pointInPolygon(p, s.polygon)) return s;
  return null;
}

/** Every wall of every room, with shared walls marked and owned once. */
export function wallEdges(model: SpaceModel): WallEdge[] {
  const index = new Map(model.spaces.map((s, i) => [s.id, i]));
  const out: WallEdge[] = [];
  // bounding boxes and openings per room, so big plans (100+ rooms) stay quick
  const boxes = model.spaces.map((q) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of q.polygon) { if (p.x < x0) x0 = p.x; if (p.y < y0) y0 = p.y; if (p.x > x1) x1 = p.x; if (p.y > y1) y1 = p.y; }
    return { q, x0, y0, x1, y1 };
  });
  const roomAt = (m: Vec2, not: string) => {
    for (const b of boxes) if (b.q.id !== not && m.x >= b.x0 && m.x <= b.x1 && m.y >= b.y0 && m.y <= b.y1 && pointInPolygon(m, b.q.polygon)) return b.q;
    return null;
  };
  const opsBySpace = new Map<string, Opening[]>();
  for (const o of model.openings) { const l = opsBySpace.get(o.spaceId); if (l) l.push(o); else opsBySpace.set(o.spaceId, [o]); }
  for (const s of model.spaces) {
    const n = s.polygon.length;
    for (let i = 0; i < n; i++) {
      const a = s.polygon[i], b = s.polygon[(i + 1) % n];
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      if (length < 1e-6) continue;
      const dir = norm(sub(b, a));
      const inward = wallInwardNormal(s, i);
      // the room just beyond the wall's middle (and both quarter points, for split walls)
      // the room just beyond the wall (middle, then quarter points for split walls), first right
      // behind the line, then across a wall's thickness for plans whose rooms are net areas
      const own = s.walls[i]?.thicknessM ?? 0.1;
      let neighbour: Space | null = null;
      let mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      probe: for (const d of [NUDGE, Math.min(0.65, own * 2 + NUDGE), 0.55]) {
        for (const t of [0.5, 0.25, 0.75]) {
          const m = { x: a.x + (b.x - a.x) * t - inward.x * d, y: a.y + (b.y - a.y) * t - inward.y * d };
          neighbour = roomAt(m, s.id);
          if (neighbour) { mid = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; break probe; }
        }
      }
      let neighbourThicknessM = 0, gapM = 0;
      if (neighbour) {
        let bd = Infinity;
        neighbour.polygon.forEach((p, j) => {
          const d = distPointSegment(mid, p, neighbour!.polygon[(j + 1) % neighbour!.polygon.length]);
          if (d < bd) { bd = d; neighbourThicknessM = neighbour!.walls[j]?.thicknessM ?? 0; }
        });
        gapM = bd > 0.02 ? bd : 0;
      }
      const gaps: WallGap[] = [];
      const addGap = (o: Opening, c: Vec2) => {
        const along = (c.x - a.x) * dir.x + (c.y - a.y) * dir.y;
        const off = Math.abs((c.x - a.x) * -dir.y + (c.y - a.y) * dir.x);
        if (off > 0.06 || along < -0.01 || along > length + 0.01) return;
        if (gaps.some((g) => Math.abs((g.s + g.e) / 2 - along) < 0.1 && g.kind === o.kind)) return;
        gaps.push({ s: Math.max(0, along - o.widthM / 2), e: Math.min(length, along + o.widthM / 2), kind: o.kind, opening: o });
      };
      for (const o of opsBySpace.get(s.id) ?? []) {
        if (o.wallIndex === i) addGap(o, openingSegment(s, o).c);
      }
      if (neighbour) {
        for (const o of opsBySpace.get(neighbour.id) ?? []) {
          if (o.wallIndex >= neighbour.polygon.length) continue;
          addGap(o, openingSegment(neighbour, o).c);
        }
      }
      gaps.sort((p, q) => p.s - q.s);
      const owner = !neighbour || gapM > 0 || (index.get(s.id) ?? 0) < (index.get(neighbour.id) ?? 0);
      out.push({ spaceId: s.id, wallIndex: i, a, b, length, dir, inward, thicknessM: own, neighbour: neighbour?.id ?? null, neighbourThicknessM, gapM, owner, gaps });
    }
  }
  return out;
}

export interface SolidSegment {
  a: Vec2;
  b: Vec2;
  /** Interior walls are centred on the line; facade walls stand outside it. */
  interior: boolean;
  /** Half of the full wall thickness for interior walls, 0 for facade walls (their face is the line). */
  halfM: number;
}

/** Wall pieces a person cannot pass: every owned wall minus its door and opening gaps. */
export function solidSegments(model: SpaceModel, edges = wallEdges(model)): SolidSegment[] {
  const out: SolidSegment[] = [];
  for (const w of edges) {
    if (!w.owner) continue;
    // a wall on a shared line is centred on it; a wall across a gap stands outside both floors,
    // so like a facade its face is the room's edge
    const interior = !!w.neighbour && !w.gapM;
    const halfM = interior ? (w.thicknessM + w.neighbourThicknessM) / 2 : 0;
    let cur = 0;
    const push = (s: number, e: number) => {
      if (e - s < 1e-3) return;
      out.push({ a: add(w.a, mul(w.dir, s)), b: add(w.a, mul(w.dir, e)), interior, halfM });
    };
    for (const g of w.gaps) {
      if (g.kind === 'window') continue;
      push(cur, g.s);
      cur = Math.max(cur, g.e);
    }
    push(cur, w.length);
  }
  return out;
}

/**
 * Floor strips through doorways that cross a wall gap (imported plans keep the wall between two
 * rooms' floors), so routes and walking can pass from one room's floor to the next.
 */
export function doorBridges(edges: WallEdge[]): Vec2[][] {
  const out: Vec2[][] = [];
  for (const w of edges) {
    if (!w.gapM) continue;
    const o = mul(w.inward, -(w.gapM + 0.04));
    for (const g of w.gaps) {
      if (g.kind === 'window') continue;
      const p = add(w.a, mul(w.dir, g.s)), q = add(w.a, mul(w.dir, g.e));
      out.push([add(p, mul(w.inward, 0.02)), add(q, mul(w.inward, 0.02)), add(q, o), add(p, o)]);
    }
  }
  return out;
}

/** On some room's floor or in a doorway between two floors. */
export function onFloor(model: SpaceModel, p: Vec2, bridges: Vec2[][]): boolean {
  return !!spaceAt(model, p) || bridges.some((b) => pointInPolygon(p, b));
}

/** Interior wall pieces only (facade walls are already the edge of the floor). */
export const interiorSolids = (model: SpaceModel, edges?: WallEdge[]) => solidSegments(model, edges).filter((s) => s.interior);

export interface Spawn { pos: Vec2; yaw: number; spaceId: string | null }

/** Camera yaw that looks along plan direction d (walk camera forward is (-sin yaw, -cos yaw)). */
export const yawFor = (d: Vec2) => Math.atan2(-d.x, -d.y);

/**
 * Where a visitor starts: just inside the door that leads outside (the entrance), looking in.
 * Falls back to the first door of the first room, then the middle of the first room.
 */
export function entranceSpawn(model: SpaceModel, inset = 0.8): Spawn {
  const edges = wallEdges(model);
  const byId = new Map(model.spaces.map((x) => [x.id, x]));
  const indoor = (o: Opening) => { const sp = byId.get(o.spaceId); return !!sp && !isOutdoor(sp); };
  const passages = model.openings.filter((o) => o.kind !== 'window' && indoor(o));
  const facadeDoor = passages.find((o) => {
    const e = edges.find((w) => w.spaceId === o.spaceId && w.wallIndex === o.wallIndex);
    return e && !e.neighbour;
  });
  // flats on a shared floor open onto a stair or corridor, not the street: start in a hallway
  const hallDoor = passages.find((o) => HALL.test(`${byId.get(o.spaceId)?.purpose ?? ''} ${byId.get(o.spaceId)?.name ?? ''}`));
  const door = facadeDoor ?? hallDoor ?? passages[0] ?? model.openings.find((o) => o.kind !== 'window');
  const s = door && model.spaces.find((x) => x.id === door.spaceId);
  if (door && s && door.wallIndex < s.polygon.length) {
    const seg = openingSegment(s, door);
    const pos = add(seg.c, mul(seg.inward, inset));
    if (pointInPolygon(pos, s.polygon)) return { pos, yaw: yawFor(seg.inward), spaceId: s.id };
  }
  const first = model.spaces.find((x) => !isOutdoor(x)) ?? model.spaces[0];
  if (!first) return { pos: { x: 0, y: 0 }, yaw: 0, spaceId: null };
  // no door: stand in the corner farthest from the windows, looking at the middle of the room
  const mid = centroid(first.polygon);
  const wins = model.openings.filter((o) => o.kind === 'window' && o.spaceId === first.id && o.wallIndex < first.polygon.length).map((o) => openingSegment(first, o).c);
  let best: { pos: Vec2; score: number } | null = null;
  for (const c of first.polygon) {
    const dx = mid.x - c.x, dy = mid.y - c.y, l = Math.hypot(dx, dy) || 1;
    const pos = { x: c.x + (dx / l) * Math.min(inset, l * 0.5), y: c.y + (dy / l) * Math.min(inset, l * 0.5) };
    if (!pointInPolygon(pos, first.polygon)) continue;
    const score = wins.length ? Math.min(...wins.map((w) => Math.hypot(w.x - pos.x, w.y - pos.y))) : 0;
    if (!best || score > best.score) best = { pos, score };
  }
  if (!best) return { pos: mid, yaw: 0, spaceId: first.id };
  return { pos: best.pos, yaw: yawFor({ x: mid.x - best.pos.x, y: mid.y - best.pos.y }), spaceId: first.id };
}

/** True when a body of radius r standing at p is clear of every solid wall piece. */
export function clearOfWalls(p: Vec2, r: number, solids: SolidSegment[]): boolean {
  for (const s of solids) {
    if (distPointSegment(p, s.a, s.b) < r + s.halfM) return false;
  }
  return true;
}
