// Wall dressing: the pieces that make a furnished room read as a real interior. Framed art hangs
// over the sofa and bed, floor-length curtains flank each window, a floating shelf sits above each
// desk, a mirror goes in bedrooms and halls, and a wall TV faces the sofa when one is wanted.
// Everything here hangs flat on a wall (mount 'wall'), so it never counts as floor space.
import type { FurnitureItem, Opening, Space, SpaceModel, Vec2 } from '../../core/types';
import { dist, wallInwardNormal, wallSegment } from '../../core/geometry';
import { isMounted, placeWallItems } from './wallItems';

export interface DressOptions {
  spaceId?: string;
  /** A TV was asked for: hang one on the wall the sofa faces. */
  tv?: boolean;
  /** The room is a hall or entrance (gets a mirror even without a bed). */
  hall?: boolean;
}

/** Gap between the top of a sofa back or headboard and the bottom of the art above it. */
export const ART_GAP = 0.25;
const CURTAIN_W = 0.4, CURTAIN_D = 0.08, CURTAIN_MARGIN = 0.08;
const EDGE = 0.03;

interface Wall { i: number; a: Vec2; dir: Vec2; nrm: Vec2; L: number }

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const rotationFor = (nrm: Vec2) => Math.atan2(-nrm.x, nrm.y);

function wallsOf(space: Space): Wall[] {
  return space.polygon.map((_, i) => {
    const [a, b] = wallSegment(space, i), L = dist(a, b) || 1e-9;
    return { i, a, dir: { x: (b.x - a.x) / L, y: (b.y - a.y) / L }, nrm: wallInwardNormal(space, i), L };
  });
}

function make(kind: string, name: string, category: string, host: string, w: number, d: number, h: number, wall: Wall, t: number, elevationM: number, color: string, material: string, priceSek: number, suffix = ''): FurnitureItem {
  return {
    id: `dress:${kind}:${host}${suffix}`, catalogId: `wall-${kind}`, name, category,
    x: wall.a.x + wall.dir.x * t + wall.nrm.x * (d / 2 + 0.002), y: wall.a.y + wall.dir.y * t + wall.nrm.y * (d / 2 + 0.002),
    rotation: rotationFor(wall.nrm), w, d, h, clearance: { front: 0, back: 0, left: 0, right: 0 },
    locked: false, owned: false, priceSek, priceStatus: 'estimated', color, material, sourceKind: 'catalog',
    mount: 'wall', elevationM: Math.round(elevationM * 1000) / 1000,
  };
}

/** The wall a piece stands against with its back, and where along that wall its centre is. */
function backWall(walls: Wall[], f: FurnitureItem, reach = 0.25): { wall: Wall; t: number } | null {
  const c = Math.cos(f.rotation), s = Math.sin(f.rotation);
  const back = { x: f.x + (s * f.d) / 2, y: f.y - (c * f.d) / 2 }, away = { x: s, y: -c };
  let best: { wall: Wall; t: number; gap: number } | null = null;
  for (const w of walls) {
    if (w.nrm.x * away.x + w.nrm.y * away.y > -0.97) continue;
    const t = (back.x - w.a.x) * w.dir.x + (back.y - w.a.y) * w.dir.y;
    const gap = (back.x - w.a.x) * w.nrm.x + (back.y - w.a.y) * w.nrm.y;
    if (t < 0 || t > w.L || gap > reach || gap < -0.05) continue;
    if (!best || gap < best.gap) best = { wall: w, t, gap };
  }
  return best;
}

/** Whether a span [t - w/2, t + w/2] of a wall, at heights y0..y1, runs into a door or window. */
function hitsOpening(space: Space, model: SpaceModel, wall: Wall, t: number, w: number, y0: number, y1: number, margin = 0.05): boolean {
  return model.openings.some((o: Opening) => {
    if (o.spaceId !== space.id || o.wallIndex !== wall.i) return false;
    const lo = o.offsetM - o.widthM / 2 - margin, hi = o.offsetM + o.widthM / 2 + margin;
    if (t + w / 2 <= lo || t - w / 2 >= hi) return false;
    const oy0 = o.kind === 'window' ? o.sillM : 0, oy1 = o.kind === 'window' ? o.sillM + o.heightM : o.heightM;
    return y1 > oy0 - margin && y0 < oy1 + margin;
  });
}

const catOf = (f: FurnitureItem) => f.category;
const isSofa = (f: FurnitureItem) => catOf(f) === 'sofa' || catOf(f) === 'sofa-bed';

/** Dress the walls of a room around the given floor furniture. Returns only the new wall pieces. */
export function dressWalls(model: SpaceModel, furniture: FurnitureItem[], opts: DressOptions = {}): FurnitureItem[] {
  const space = (opts.spaceId ? model.spaces.find((s) => s.id === opts.spaceId) : undefined) ?? model.spaces.find((s) => s.polygon.length >= 3);
  if (!space || space.polygon.length < 3) return [];
  const walls = wallsOf(space), ceiling = model.ceilingM;
  const floor = furniture.filter((f) => !isMounted(f) && f.category !== 'rug');
  const out: FurnitureItem[] = [];
  const topOk = (y0: number, h: number) => y0 + h <= ceiling - 0.2;
  const clashes = (p: FurnitureItem) => out.some((q) => Math.hypot(p.x - q.x, p.y - q.y) < (p.w + q.w) / 2 + 0.1 && (p.elevationM ?? 0) < (q.elevationM ?? 0) + q.h && (q.elevationM ?? 0) < (p.elevationM ?? 0) + p.h);

  // Curtains: a floor-length panel on each side of every window.
  const ch = Math.min(2.4, ceiling - 0.1);
  for (const o of model.openings) {
    if (o.spaceId !== space.id || o.kind !== 'window') continue;
    const wall = walls[o.wallIndex];
    if (!wall) continue;
    ([['l', -1], ['r', 1]] as const).forEach(([side, sgn]) => {
      const t = o.offsetM + sgn * (o.widthM / 2 + CURTAIN_MARGIN + CURTAIN_W / 2);
      if (t - CURTAIN_W / 2 < EDGE || t + CURTAIN_W / 2 > wall.L - EDGE) return;
      const others = model.openings.some((p) => p.id !== o.id && p.spaceId === space.id && p.wallIndex === o.wallIndex && Math.abs(p.offsetM - t) < p.widthM / 2 + CURTAIN_W / 2);
      if (others) return;
      out.push(make('curtain', 'Curtain', 'curtain', o.id, CURTAIN_W, CURTAIN_D, ch, wall, t, 0, '#d9d2c5', 'linen', 790, `:${side}`));
    });
  }

  // Framed art above each sofa and bed, centred, bottom 25 cm over the back or headboard.
  for (const f of floor) {
    if (!isSofa(f) && catOf(f) !== 'bed') continue;
    const hit = backWall(walls, f);
    if (!hit) continue;
    const w = clamp(f.w * 0.6, 0.5, 1.3), h = clamp(w * 0.65, 0.4, 0.85), y0 = f.h + ART_GAP;
    if (!topOk(y0, h) || hit.t - w / 2 < EDGE || hit.t + w / 2 > hit.wall.L - EDGE || hitsOpening(space, model, hit.wall, hit.t, w, y0, y0 + h)) continue;
    const art = make('art', 'Framed art', 'wall-art', f.id, w, 0.03, h, hit.wall, hit.t, y0, '#3a3f45', 'framed print', 590);
    if (!clashes(art)) out.push(art);
  }

  // Floating shelf above each desk.
  for (const f of floor) {
    if (catOf(f) !== 'desk') continue;
    const hit = backWall(walls, f);
    if (!hit) continue;
    const w = clamp(f.w * 0.8, 0.6, 1.2), y0 = clamp(f.h + 0.55, 1.2, 1.5);
    if (!topOk(y0, 0.04) || hit.t - w / 2 < EDGE || hit.t + w / 2 > hit.wall.L - EDGE || hitsOpening(space, model, hit.wall, hit.t, w, y0, y0 + 0.2)) continue;
    const sh = make('shelf', 'Floating shelf', 'wall-shelf', f.id, w, 0.22, 0.04, hit.wall, hit.t, y0, '#c4a27c', 'oak veneer', 390);
    if (!clashes(sh)) out.push(sh);
  }

  // Wall TV on the wall the sofa faces, centred on the sofa.
  if (opts.tv) {
    const sofa = floor.find(isSofa);
    if (sofa) {
      const c = Math.cos(sofa.rotation), s = Math.sin(sofa.rotation), front = { x: -s, y: c };
      let best: { wall: Wall; t: number; r: number } | null = null;
      for (const w of walls) {
        const den = front.x * w.nrm.x + front.y * w.nrm.y;
        if (den > -0.5) continue; // the wall must face back toward the sofa
        const r = ((w.a.x - sofa.x) * w.nrm.x + (w.a.y - sofa.y) * w.nrm.y) / den;
        if (r <= 0) continue;
        const hx = sofa.x + front.x * r, hy = sofa.y + front.y * r;
        const t = (hx - w.a.x) * w.dir.x + (hy - w.a.y) * w.dir.y;
        if (t < 0 || t > w.L) continue;
        if (!best || r < best.r) best = { wall: w, t, r };
      }
      if (best) {
        const w = 1.1, h = 0.65, d = 0.05;
        // Above a TV unit if one stands there, else at seated eye height.
        const under = floor.find((f) => f.category === 'tv-unit' && backWall(walls, f, 0.3)?.wall === best!.wall);
        const y0 = Math.max(0.85, (under?.h ?? 0) + 0.15);
        const t = clamp(best.t, w / 2 + EDGE, best.wall.L - w / 2 - EDGE);
        if (best.wall.L >= w + 2 * EDGE && topOk(y0, h) && !hitsOpening(space, model, best.wall, t, w, y0, y0 + h)) {
          const set = make('tv', 'Wall TV', 'wall-tv', sofa.id, w, d, h, best.wall, t, y0, '#16181b', 'glass and steel', 5990);
          if (!clashes(set)) out.push(set);
        }
      }
    }
  }

  // Mirror in bedrooms and halls: on any free wall span, at full-length height.
  if (opts.hall || floor.some((f) => catOf(f) === 'bed')) {
    const mirror = make('mirror', 'Wall mirror', 'wall-mirror', 'room', 0.5, 0.03, 1.2, walls[0], 0.25, 0.5, '#cfd8dc', 'glass and steel', 890);
    const { placed } = placeWallItems(model, floor, [mirror], space.id);
    const m = placed[0];
    if (m && !clashes(m)) out.push(m);
  }
  return out;
}
