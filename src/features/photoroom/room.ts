// One photo of a real room -> an editable SpaceModel.
// Gemini reads the photo into a rectangle seen from the camera (back wall ahead, left and right walls to the
// sides, front wall behind the camera). Everything built from it is marked photo-inferred and estimated;
// the one wall the person measures afterwards becomes user-measured.

import { uid } from '../../core/geometry';
import type { FurnitureItem, Measurement, Opening, SpaceModel, WallMeta } from '../../core/types';
import { catalogEntry, findByKeyword, makeItem } from '../furniture/catalog';
import { rotationFacing } from '../objects/placement';

export type WallName = 'back' | 'right' | 'front' | 'left';
export type Facing = 'camera' | 'back' | 'left' | 'right';

/** Plan wall index for each side: polygon (0,0) (W,0) (W,D) (0,D), the camera at the bottom looking up. */
export const WALL_INDEX: Record<WallName, number> = { back: 0, right: 1, front: 2, left: 3 };
export const WALL_LABEL: Record<WallName, string> = { back: 'Back wall', right: 'Right wall', front: 'Front wall', left: 'Left wall' };

/** Photo categories and the catalogue piece each one starts from. 'other' becomes a custom object. */
export const KIND_TO_CATALOG: Record<string, string> = {
  sofa: 'sofa-3', 'small-sofa': 'sofa-2', armchair: 'armchair', bed: 'bed-double', 'single-bed': 'bed-single',
  'coffee-table': 'coffee-table', 'dining-table': 'dining-4', 'side-table': 'nightstand', chair: 'chair', desk: 'desk-140',
  'office-chair': 'office-chair', bookshelf: 'bookshelf', wardrobe: 'wardrobe-100', dresser: 'dresser', nightstand: 'nightstand',
  'tv-unit': 'tv-unit', sideboard: 'sideboard', rug: 'rug-160', plant: 'plant', 'floor-lamp': 'floor-lamp', bench: 'bench',
  stool: 'bar-stool', cabinet: 'storage-cabinet', counter: 'counter', 'kitchen-island': 'kitchen-island', toilet: 'toilet',
  washbasin: 'washbasin', bathtub: 'bathtub', shower: 'shower', 'washing-machine': 'washing-machine', crib: 'crib',
};
export const PHOTO_KINDS = [...Object.keys(KIND_TO_CATALOG), 'other'];

export interface PhotoOpening { kind: 'door' | 'window' | 'opening'; wall: WallName; at: number; widthM: number; heightM: number; sillM: number }
export interface PhotoItem {
  label: string; kind: string; widthM: number; depthM: number; heightM: number;
  /** Floor position of the centre: x 0 = left wall .. 1 = right wall, y 0 = back wall .. 1 = front wall. */
  x: number; y: number;
  against: WallName | 'none'; facing: Facing; color: string; material: string;
}
export interface PhotoRoomEstimate {
  roomType: string; widthM: number; depthM: number; ceilingM: number;
  /** 0..1, how sure the model is about the size. */
  confidence: number; cues: string[];
  /** 0..1 per wall: how sure the model is about that wall's length (several photos can see some walls better than others). */
  wallConfidence: Record<WallName, number>;
  photoCount: number;
  openings: PhotoOpening[]; furniture: PhotoItem[];
}

export const DEFAULT_CEILING_M = 2.5;
/** Walls the photos barely show: drawn as unknown (dashed) until someone types their length. */
export const LOW_WALL = 0.5;
const WALLS: WallName[] = ['back', 'right', 'front', 'left'];
const OPENING_WIDTH = { door: [0.6, 1.3], window: [0.4, 3.5], opening: [0.6, 3] } as const;
const OPENING_HEIGHT = { door: [1.8, 2.4], window: [0.4, 2.2], opening: [1.8, 2.6] } as const;
const FACINGS: Facing[] = ['camera', 'back', 'left', 'right'];

export const PHOTO_ROOM_SCHEMA = {
  type: 'OBJECT',
  properties: {
    roomType: { type: 'STRING' },
    cues: { type: 'ARRAY', items: { type: 'STRING' } },
    widthM: { type: 'NUMBER' }, depthM: { type: 'NUMBER' }, ceilingM: { type: 'NUMBER' }, confidence: { type: 'NUMBER' },
    wallConfidence: {
      type: 'OBJECT',
      properties: { back: { type: 'NUMBER' }, right: { type: 'NUMBER' }, front: { type: 'NUMBER' }, left: { type: 'NUMBER' } },
      required: WALLS,
    },
    openings: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          kind: { type: 'STRING', enum: ['door', 'window', 'opening'] }, wall: { type: 'STRING', enum: WALLS },
          at: { type: 'NUMBER' }, widthM: { type: 'NUMBER' }, heightM: { type: 'NUMBER' }, sillM: { type: 'NUMBER' },
        },
        required: ['kind', 'wall', 'at', 'widthM', 'heightM', 'sillM'],
      },
    },
    furniture: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          label: { type: 'STRING' }, kind: { type: 'STRING', enum: PHOTO_KINDS },
          widthM: { type: 'NUMBER' }, depthM: { type: 'NUMBER' }, heightM: { type: 'NUMBER' },
          x: { type: 'NUMBER' }, y: { type: 'NUMBER' },
          against: { type: 'STRING', enum: [...WALLS, 'none'] }, facing: { type: 'STRING', enum: FACINGS },
          color: { type: 'STRING' }, material: { type: 'STRING' },
        },
        required: ['label', 'kind', 'widthM', 'depthM', 'heightM', 'x', 'y', 'against', 'facing', 'color', 'material'],
      },
    },
  },
  required: ['roomType', 'cues', 'widthM', 'depthM', 'ceilingM', 'confidence', 'wallConfidence', 'openings', 'furniture'],
  propertyOrdering: ['roomType', 'cues', 'widthM', 'depthM', 'ceilingM', 'confidence', 'wallConfidence', 'openings', 'furniture'],
};

export const PHOTO_ROOM_PROMPT = `One photo of a real room. Rebuild its floor plan as a rectangle, seen from where the camera stands:
the back wall is the wall the camera faces, left and right walls are to the sides, the front wall is behind the camera.

Scale first. Use what you can see: interior doors are about 2.0 m high and 0.8 to 0.9 m wide, home ceilings 2.4 to 2.7 m,
sofa seats 0.45 m high, tables 0.72 to 0.76 m high, double beds 2.0 m long, kitchen counters 0.9 m high, floor tiles or boards,
windows, people. List the cues you used in "cues" (a few words each).

widthM: the back wall's length. depthM: the side walls' full length, including the floor behind the camera (if the camera is
clearly inside the room, add a plausible 0.5 to 1.5 m behind it). ceilingM: ceiling height. confidence: 0 to 1, how sure you are
about the size (0.3 if you only guessed from furniture, 0.7 or more with a door or a known object in full view).

openings: every door, window or open passage you can see. "at" is the centre along the wall as a fraction: on the back and front
walls 0 = left end, 1 = right end as seen from the camera; on the left and right walls 0 = the end nearest the camera, 1 = the back
corner. widthM, heightM and sillM (0 for doors) in metres.

furniture: every piece of furniture and large object standing on the floor, including rugs, floor lamps and large plants; skip
small decor and wall art. For each: label (2 or 3 words, like "grey sofa"), kind from the list (use "other" only when nothing fits),
widthM along its front, depthM front to back, heightM, the floor position of its centre as fractions x (0 = left wall, 1 = right
wall) and y (0 = back wall, 1 = front wall), "against" = the wall its back touches or "none", "facing" = where its front points,
color as a hex code of its main colour, material in one word. Only list what you actually see.`;

/** Several photos (or video frames) of the same room, answered once as a single consistent room. */
export const MULTI_PHOTO_ROOM_PROMPT = `${PHOTO_ROOM_PROMPT}

Several photos follow, all of the SAME room from different spots, in no fixed order. Return ONE room, not one per photo.
Pick the camera position of the photo that shows the most of the room and use its back, left, right and front walls for the whole answer.
Match walls, windows, doors and furniture across photos by what they look like and where they stand, and list each real object once.
Use every photo to fix the true length of each wall and to place things that the first view hides. Trust a photo with a door or known object in full view most.
wallConfidence: for each of back, right, front, left, 0 to 1, how sure you are of that wall's length (low for a wall no photo shows, 0.3 or less).`;

const num = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
const pick = <T extends string>(v: unknown, list: readonly T[], dflt: T): T => (list.includes(v as T) ? (v as T) : dflt);
const hex = (v: unknown) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v.trim()) ? v.trim().toLowerCase() : '');

/** Cleans a raw model answer: every number clamped to a plausible range, unknown words replaced. Never throws. */
export function parseEstimate(raw: unknown): PhotoRoomEstimate {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const widthM = num(r.widthM, 1.2, 15, 4);
  const depthM = num(r.depthM, 1.2, 15, 4);
  const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') as Record<string, unknown>[] : []);
  const openings: PhotoOpening[] = arr(r.openings).slice(0, 12).map((o) => {
    const kind = pick(o.kind, ['door', 'window', 'opening'] as const, 'window');
    return {
      kind, wall: pick(o.wall, WALLS, 'back'), at: num(o.at, 0, 1, 0.5),
      widthM: num(o.widthM, OPENING_WIDTH[kind][0], OPENING_WIDTH[kind][1], kind === 'door' ? 0.85 : 1.2),
      heightM: num(o.heightM, OPENING_HEIGHT[kind][0], OPENING_HEIGHT[kind][1], kind === 'window' ? 1.2 : 2.05),
      sillM: kind === 'window' ? num(o.sillM, 0, 2, 0.85) : 0,
    };
  });
  const furniture: PhotoItem[] = arr(r.furniture).slice(0, 30).map((f) => {
    const kind = pick(f.kind, PHOTO_KINDS, 'other');
    const label = (typeof f.label === 'string' && f.label.trim() ? f.label.trim() : kind.replace(/-/g, ' ')).slice(0, 40);
    return {
      label, kind,
      widthM: num(f.widthM, 0.15, 4.5, 0.8), depthM: num(f.depthM, kind === 'rug' ? 0.4 : 0.15, 4.5, 0.6),
      heightM: kind === 'rug' ? 0.01 : num(f.heightM, 0.05, 2.6, 0.8),
      x: num(f.x, 0, 1, 0.5), y: num(f.y, 0, 1, 0.5),
      against: pick(f.against, [...WALLS, 'none'] as const, 'none'), facing: pick(f.facing, FACINGS, 'camera'),
      color: hex(f.color), material: typeof f.material === 'string' ? f.material.slice(0, 24) : '',
    };
  });
  const confidence = num(r.confidence, 0, 1, 0.4);
  const wc = (r.wallConfidence && typeof r.wallConfidence === 'object' ? r.wallConfidence : {}) as Record<string, unknown>;
  return {
    roomType: typeof r.roomType === 'string' ? r.roomType.slice(0, 40) : 'room',
    widthM, depthM, ceilingM: confidence < 0.35 ? DEFAULT_CEILING_M : num(r.ceilingM, 2.1, 4.5, DEFAULT_CEILING_M), confidence,
    wallConfidence: Object.fromEntries(WALLS.map((w) => [w, num(wc[w], 0, 1, confidence)])) as Record<WallName, number>,
    photoCount: Math.round(num(r.photoCount, 1, 6, 1)),
    cues: Array.isArray(r.cues) ? r.cues.filter((c) => typeof c === 'string').slice(0, 8) as string[] : [],
    openings, furniture,
  };
}

/** Distance from the wall's start corner for a fraction "at" as defined in the prompt. */
export function offsetAlong(wall: WallName, at: number, W: number, D: number): number {
  switch (wall) {
    case 'back': return at * W; // (0,0) -> (W,0), left to right
    case 'right': return (1 - at) * D; // (W,0) -> (W,D), back corner to camera
    case 'front': return (1 - at) * W; // (W,D) -> (0,D)
    case 'left': return at * D; // (0,D) -> (0,0), camera to back corner
  }
}

const INWARD: Record<WallName, { x: number; y: number }> = { back: { x: 0, y: 1 }, right: { x: -1, y: 0 }, front: { x: 0, y: -1 }, left: { x: 1, y: 0 } };
const FACE_DIR: Record<Facing, { x: number; y: number }> = { camera: { x: 0, y: 1 }, back: { x: 0, y: -1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The catalogue piece closest to a photo item: its category first, then the words of its label (for "other"). */
export function resolveCatalogId(kind: string, label = ''): string | undefined {
  return KIND_TO_CATALOG[kind] ?? findByKeyword(label)?.id;
}

/** Sizes in metres kept within a sane band around the catalogue piece (or a generic band when there is none). */
export function clampSize(p: { widthM: number; depthM: number; heightM: number; kind?: string }, catalogId?: string): { w: number; d: number; h: number } {
  const e = catalogId ? catalogEntry(catalogId) : undefined;
  const between = (v: number, ref: number | undefined, lo: number, hi: number, abs: [number, number]) =>
    ref ? Math.min(ref * hi, Math.max(ref * lo, v)) : Math.min(abs[1], Math.max(abs[0], v));
  const flat = p.kind === 'rug' || (e !== undefined && e.h <= 0.02);
  return {
    w: between(p.widthM, e?.w, 0.4, 2.2, [0.15, 3.5]),
    d: between(p.depthM, e?.d, 0.4, 2.2, [0.15, 3.5]),
    h: flat ? Math.min(p.heightM, 0.02) : between(p.heightM, e?.h, 0.5, 1.8, [0.05, 2.5]),
  };
}

/** The wall closest to a floor point of a W x D room, and how far it is. */
export function nearestWall(x: number, y: number, W: number, D: number): { wall: WallName; distM: number } {
  const c: Array<[WallName, number]> = [['back', y], ['right', W - x], ['front', D - y], ['left', x]];
  const [wall, distM] = c.reduce((a, b) => (b[1] < a[1] ? b : a));
  return { wall, distM };
}

/** An opening placed on its wall: width clamped to the wall, centre kept clear of the corners. */
export function placeOpening(o: PhotoOpening, W: number, D: number): { wallIndex: number; offsetM: number; widthM: number } {
  const wallLen = o.wall === 'back' || o.wall === 'front' ? W : D;
  const [lo, hi] = OPENING_WIDTH[o.kind];
  const width = Math.max(Math.min(lo, wallLen - 0.1), Math.min(o.widthM, hi, wallLen - 0.1));
  const raw = offsetAlong(o.wall, Math.min(1, Math.max(0, o.at)), W, D);
  const offset = Math.min(wallLen - width / 2 - 0.05, Math.max(width / 2 + 0.05, raw));
  return { wallIndex: WALL_INDEX[o.wall], offsetM: +offset.toFixed(2), widthM: +width.toFixed(2) };
}

/** The wall photographed most clearly: the best wall confidence, the back wall winning ties. */
export function mostVisibleWall(wc: Record<WallName, number>): WallName {
  return (['back', 'left', 'right', 'front'] as WallName[]).reduce((a, b) => (wc[b] > wc[a] ? b : a));
}

const halfExtent = (f: { w: number; d: number; rotation: number }) => ({
  hx: (Math.abs(Math.cos(f.rotation)) * f.w + Math.abs(Math.sin(f.rotation)) * f.d) / 2,
  hy: (Math.abs(Math.sin(f.rotation)) * f.w + Math.abs(Math.cos(f.rotation)) * f.d) / 2,
});

/** Moves items apart (largest first stays put) and back inside the room so no two footprints overlap. Rugs may overlap. */
export function nudgeApart(items: FurnitureItem[], W: number, D: number): FurnitureItem[] {
  const out = items.map((f) => ({ ...f }));
  const order = out.map((_, i) => i).sort((a, b) => out[b].w * out[b].d - out[a].w * out[a].d);
  const placed: FurnitureItem[] = [];
  const inside = (f: FurnitureItem) => {
    const { hx, hy } = halfExtent(f);
    f.x = hx * 2 >= W ? W / 2 : Math.min(W - hx, Math.max(hx, f.x));
    f.y = hy * 2 >= D ? D / 2 : Math.min(D - hy, Math.max(hy, f.y));
  };
  for (const i of order) {
    const f = out[i];
    inside(f);
    if (f.h > 0.02) {
      for (let pass = 0; pass < 8; pass++) {
        const a = halfExtent(f);
        const hit = placed.find((o) => {
          const b = halfExtent(o);
          return Math.abs(f.x - o.x) < a.hx + b.hx - 0.01 && Math.abs(f.y - o.y) < a.hy + b.hy - 0.01;
        });
        if (!hit) break;
        const b = halfExtent(hit);
        const px = a.hx + b.hx - Math.abs(f.x - hit.x), py = a.hy + b.hy - Math.abs(f.y - hit.y);
        if (px < py) f.x += (f.x >= hit.x ? 1 : -1) * (px + 0.02); else f.y += (f.y >= hit.y ? 1 : -1) * (py + 0.02);
        inside(f);
      }
      placed.push(f);
    }
    f.x = +f.x.toFixed(3); f.y = +f.y.toFixed(3);
  }
  return out;
}

/** A furniture item at its estimated place: backed against its wall when it has one, kept inside the room. */
export function itemFromPhoto(p: PhotoItem, W: number, D: number): FurnitureItem {
  const catalogId = resolveCatalogId(p.kind, p.label);
  const size = clampSize(p, catalogId);
  p = { ...p, widthM: size.w, depthM: size.d, heightM: size.h };
  const near = p.against === 'none' ? nearestWall(p.x * W, p.y * D, W, D) : null;
  const dir = p.against !== 'none' ? INWARD[p.against] : FACE_DIR[p.facing];
  const rotation = rotationFacing(dir) + 0; // no -0
  const sideways = Math.abs(dir.x) > 0.5; // width runs along y
  const halfX = (sideways ? p.depthM : p.widthM) / 2;
  const halfY = (sideways ? p.widthM : p.depthM) / 2;
  const fit = (v: number, half: number, size: number) => (2 * half >= size ? size / 2 : Math.min(size - half, Math.max(half, v)));
  let x = fit(p.x * W, halfX, W);
  let y = fit(p.y * D, halfY, D);
  if (p.against === 'back') y = halfY;
  if (p.against === 'front') y = D - halfY;
  if (p.against === 'left') x = halfX;
  if (p.against === 'right') x = W - halfX;
  if (near) {
    // Close to a wall without being marked against it: sit it flush.
    const half = near.wall === 'back' || near.wall === 'front' ? halfY : halfX;
    if (near.distM - half < 0.15) {
      if (near.wall === 'back') y = halfY;
      if (near.wall === 'front') y = D - halfY;
      if (near.wall === 'left') x = halfX;
      if (near.wall === 'right') x = W - halfX;
    }
  }
  const base = catalogId ? makeItem(catalogId, { x, y, rotation }) : {
    ...makeItem('storage-cabinet', { x, y, rotation }), catalogId: 'custom', category: 'decor', clearance: { front: 0.4, back: 0, left: 0, right: 0 },
  };
  const entry = catalogId ? catalogEntry(catalogId) : undefined;
  return {
    ...base,
    x: +x.toFixed(3), y: +y.toFixed(3),
    name: cap(p.label), w: +p.widthM.toFixed(2), d: +p.depthM.toFixed(2), h: +p.heightM.toFixed(2),
    color: p.color || entry?.color || '#9aa3ad', material: p.material || entry?.material,
    // It is already in the room: the person owns it.
    owned: true, priceSek: 0, priceStatus: 'owned', sourceKind: 'photo-inferred',
  };
}

/** Builds the room. Walls and openings are photo-inferred and estimated, with a tolerance that grows as confidence drops. */
export function buildPhotoRoom(est: PhotoRoomEstimate, opts: { photoUrl?: string; name?: string } = {}): SpaceModel {
  const W = +est.widthM.toFixed(2), D = +est.depthM.toFixed(2);
  const spaceId = uid('sp');
  const evId = uid('ev');
  const tol = (l: number, w: WallName) => +(0.1 + (1 - Math.min(est.confidence, est.wallConfidence?.[w] ?? est.confidence)) * 0.25 * l).toFixed(2);
  const wallStatus = (w: WallName) => ((est.wallConfidence?.[w] ?? est.confidence) < LOW_WALL ? 'unknown' as const : 'estimated' as const);
  const measurements: Measurement[] = WALLS.map((w, i) => ({
    id: uid('m'), label: WALL_LABEL[w], valueM: i % 2 ? D : W, sourceKind: 'photo-inferred', status: wallStatus(w),
    toleranceM: tol(i % 2 ? D : W, w), evidenceIds: [evId], targetId: `${spaceId}:${i}`,
  }));
  const walls: WallMeta[] = WALLS.map((w, i) => ({ thicknessM: 0.12, sourceKind: 'photo-inferred', status: wallStatus(w), measurementId: measurements[i].id }));
  const openings: Opening[] = est.openings.map((o) => {
    const pl = placeOpening(o, W, D);
    const heightM = Math.min(o.heightM, est.ceilingM - 0.05), sillM = Math.min(o.sillM, Math.max(0, est.ceilingM - 0.4 - heightM));
    return {
      id: uid('op'), kind: o.kind, spaceId, wallIndex: pl.wallIndex, offsetM: pl.offsetM, widthM: pl.widthM,
      heightM: +heightM.toFixed(2), sillM: +sillM.toFixed(2), swing: o.kind === 'door' ? 'in' : 'none', hinge: 'start', sourceKind: 'photo-inferred', status: 'estimated',
    };
  });
  return {
    id: uid('m'), name: opts.name ?? cap(est.roomType || 'Room'), version: 1, units: 'm', ceilingM: est.ceilingM,
    sourceLabel: 'Photo estimate',
    spaces: [{ id: spaceId, name: cap(est.roomType || 'Room'), purpose: est.roomType, polygon: [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: D }, { x: 0, y: D }], walls }],
    openings,
    furniture: nudgeApart(est.furniture.map((f) => itemFromPhoto(f, W, D)), W, D),
    measurements,
    evidence: [{ id: evId, kind: 'photo', label: est.photoCount > 1 ? `Room photos (${est.photoCount})` : 'Room photo', imageUrl: opts.photoUrl, note: est.cues.join(', '), createdAt: Date.now() }],
  };
}

/**
 * Rescales the whole room so one wall has the measured length. Every length (plan, openings, ceiling, furniture)
 * scales by the same factor, because the size error of a photo estimate is one shared scale error.
 * The measured wall becomes user-measured and verified; the others stay estimated.
 */
export function rescaleRoom(model: SpaceModel, spaceId: string, wallIndex: number, measuredM: number): SpaceModel {
  const space = model.spaces.find((s) => s.id === spaceId);
  if (!space || !(measuredM > 0)) return model;
  const a = space.polygon[wallIndex], b = space.polygon[(wallIndex + 1) % space.polygon.length];
  const current = Math.hypot(b.x - a.x, b.y - a.y);
  if (!(current > 0)) return model;
  const k = measuredM / current;
  const s = (v: number) => +(v * k).toFixed(3);
  const wallId = `${spaceId}:${wallIndex}`;
  const mId = uid('m');
  const measurements = model.measurements.map((m) => (m.targetId?.startsWith(`${spaceId}:`) ? { ...m, valueM: s(m.valueM), toleranceM: m.toleranceM && s(m.toleranceM) } : m))
    .filter((m) => m.targetId !== wallId);
  measurements.push({ id: mId, label: 'Measured wall', valueM: measuredM, sourceKind: 'user-measured', status: 'verified', toleranceM: 0.01, evidenceIds: [], targetId: wallId });
  return {
    ...model,
    version: model.version + 1,
    ceilingM: s(model.ceilingM),
    spaces: model.spaces.map((sp) => (sp.id !== spaceId ? sp : {
      ...sp,
      polygon: sp.polygon.map((p) => ({ x: s(p.x), y: s(p.y) })),
      walls: sp.walls.map((w, i) => (i === wallIndex ? { ...w, sourceKind: 'user-measured', status: 'verified', measurementId: mId } : w)),
    })),
    openings: model.openings.map((o) => (o.spaceId !== spaceId ? o : { ...o, offsetM: s(o.offsetM), widthM: s(o.widthM), heightM: s(o.heightM), sillM: s(o.sillM) })),
    furniture: model.furniture.map((f) => ({ ...f, x: s(f.x), y: s(f.y), w: s(f.w), d: s(f.d), h: f.h <= 0.02 ? f.h : s(f.h) })),
    measurements,
  };
}
