import { bounds, distPointPolygonEdges, openingSegment, signedArea } from '../../core/geometry';
import type { FurnitureItem, SpaceModel, Vec2 } from '../../core/types';

/** What a layout looks like, as numbers from 0 to 1. Shared by the event log and the ranking. */
export interface LayoutFeatures {
  open: number;      // share of floor left free
  density: number;   // how many pieces for the room size
  hug: number;       // share of pieces backed against a wall
  sym: number;       // mirror balance
  cost: number;      // total price, SEK
  rel: Partial<Record<Anchor, number>>; // nearest-window distance per anchor piece, 0 near .. 1 far
}
export type Anchor = 'desk' | 'bed' | 'sofa';

export const anchorOf = (cat: string): Anchor | null =>
  /desk/.test(cat) ? 'desk' : /^(bed|sofa-bed)|bed$/.test(cat) && !/nightstand|side/.test(cat) ? 'bed' : /^sofa/.test(cat) ? 'sofa' : null;

const clamp = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : Number.isFinite(x) ? x : 0);
const isFloor = (f: FurnitureItem) => (f.mount ?? 'floor') === 'floor' && !/rug/.test(f.category);

export function roomOf(model: SpaceModel) {
  const space = model.spaces[0];
  const poly: Vec2[] = space?.polygon ?? [];
  const area = Math.abs(signedArea(poly)) || 1;
  const b = bounds(poly.length ? poly : [{ x: 0, y: 0 }, { x: 1, y: 1 }]);
  const windows = space ? model.openings.filter((o) => o.kind === 'window' && o.spaceId === space.id).map((o) => openingSegment(space, o).c) : [];
  return { poly, area, b, diag: Math.hypot(b.w, b.h) || 1, windows };
}
type Room = ReturnType<typeof roomOf>;

export function wallGap(room: Room, f: FurnitureItem): number {
  return Math.max(0, distPointPolygonEdges({ x: f.x, y: f.y }, room.poly) - Math.min(f.w, f.d) / 2);
}
export function windowDist(room: Room, f: { x: number; y: number }): number | null {
  if (!room.windows.length) return null;
  return Math.min(...room.windows.map((c) => Math.hypot(c.x - f.x, c.y - f.y))) / room.diag;
}

export function layoutFeatures(model: SpaceModel, furniture: FurnitureItem[]): LayoutFeatures {
  const room = roomOf(model);
  const floor = furniture.filter(isFloor);
  const foot = floor.reduce((s, f) => s + f.w * f.d, 0);
  const cx = room.b.minX + room.b.w / 2, cy = room.b.minY + room.b.h / 2;
  const mirrored = (axis: 'x' | 'y') => {
    if (floor.length < 2) return 0.5;
    let hit = 0;
    for (const f of floor) {
      const m = axis === 'x' ? { x: 2 * cx - f.x, y: f.y } : { x: f.x, y: 2 * cy - f.y };
      if (floor.some((g) => g.category === f.category && Math.hypot(g.x - m.x, g.y - m.y) < 0.45)) hit++;
    }
    return hit / floor.length;
  };
  const rel: LayoutFeatures['rel'] = {};
  for (const f of floor) {
    const a = anchorOf(f.category), d = windowDist(room, f);
    if (a && d !== null && rel[a] === undefined) rel[a] = clamp(d * 1.6);
  }
  return {
    open: clamp(1 - foot / room.area * 2.2),
    density: clamp(floor.length / (room.area * 0.55)),
    hug: floor.length ? floor.filter((f) => wallGap(room, f) < 0.15).length / floor.length : 0.5,
    sym: Math.max(mirrored('x'), mirrored('y')),
    cost: furniture.reduce((s, f) => s + (f.owned ? 0 : f.priceSek), 0),
    rel,
  };
}
