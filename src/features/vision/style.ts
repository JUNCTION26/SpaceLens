import type { FurnitureItem, Op, SpaceModel } from '../../core/types';
import { add, convexOverlap, itemCorners, mul, norm, sub, uid, wallInwardNormal, wallSegment } from '../../core/geometry';
import { findByKeyword, makeItem, variantsFor } from '../furniture/catalog';
import { findFreeSpot } from '../objects/placement';
import { fromHex, hsl, mix, roleColors, type Swatch } from './palette';

export interface StyleReading {
  style: string;
  woods: string[]; fabrics: string[]; metals: string[];
  shapes: 'rounded' | 'straight' | 'mixed';
  /** 0 minimal to 1 full. */
  density: number;
  lighting: 'warm' | 'cool' | 'bright' | 'moody';
  pieces: Array<{ type: string; color: string }>;
  decor: string[];
}

export const STYLE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    style: { type: 'STRING' },
    woods: { type: 'ARRAY', items: { type: 'STRING' } }, fabrics: { type: 'ARRAY', items: { type: 'STRING' } }, metals: { type: 'ARRAY', items: { type: 'STRING' } },
    shapes: { type: 'STRING', enum: ['rounded', 'straight', 'mixed'] },
    density: { type: 'NUMBER' },
    lighting: { type: 'STRING', enum: ['warm', 'cool', 'bright', 'moody'] },
    pieces: { type: 'ARRAY', items: { type: 'OBJECT', properties: { type: { type: 'STRING' }, color: { type: 'STRING' } }, required: ['type', 'color'] } },
    decor: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['style', 'woods', 'fabrics', 'metals', 'shapes', 'density', 'lighting', 'pieces', 'decor'],
};

export const STYLE_PROMPT = 'Read the interior style of this picture. style: one or two words. woods, fabrics, metals: materials seen. shapes: rounded, straight or mixed. density: 0 (minimal) to 1 (full). lighting: warm, cool, bright or moody. pieces: exactly 6 signature furniture pieces as generic types (sofa, armchair, coffee table, bookshelf, floor lamp, rug, plant, desk, bed) each with a hex colour #rrggbb. decor: 3 short wall or shelf decor ideas.';

/** Clean a model reply so every field is usable. */
export function cleanReading(r: Partial<StyleReading>): StyleReading {
  const arr = (a: unknown) => (Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : []);
  return {
    style: String(r.style ?? 'Mixed').split(/\s+/).slice(0, 2).join(' '),
    woods: arr(r.woods), fabrics: arr(r.fabrics), metals: arr(r.metals),
    shapes: r.shapes === 'rounded' || r.shapes === 'straight' ? r.shapes : 'mixed',
    density: Math.max(0, Math.min(1, Number(r.density) || 0.5)),
    lighting: r.lighting === 'cool' || r.lighting === 'bright' || r.lighting === 'moody' ? r.lighting : 'warm',
    pieces: (r.pieces ?? []).filter((p) => p && typeof p.type === 'string').map((p) => ({ type: p.type, color: /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : '' })).slice(0, 6),
    decor: arr(r.decor).slice(0, 3),
  };
}

/** Offline reading from the palette alone. */
export function styleFromPalette(sw: Swatch[]): StyleReading {
  const rc = roleColors(sw);
  const wall = hsl(fromHex(rc.wall)), acc = hsl(fromHex(rc.accent));
  const total = sw.reduce((s, x) => s + x.share, 0) || 1;
  const avgSat = sw.reduce((s, x) => s + x.sat * x.share, 0) / total;
  const dark = wall.l < 0.35;
  const warm = wall.h < 70 || wall.h > 330;
  const style = dark ? 'Moody' : avgSat < 0.12 ? (wall.l > 0.7 ? 'Minimal' : 'Industrial') : acc.s > 0.5 ? 'Eclectic' : warm ? 'Warm' : 'Nordic';
  return {
    style, woods: warm ? ['oak'] : ['birch'], fabrics: ['linen'], metals: dark ? ['steel'] : [],
    shapes: 'mixed', density: dark ? 0.6 : avgSat < 0.12 ? 0.2 : 0.5,
    lighting: dark ? 'moody' : warm ? 'warm' : wall.l > 0.7 ? 'bright' : 'cool',
    pieces: [], decor: [],
  };
}

const WOOD_CATS = new Set(['desk', 'table', 'dining-table', 'coffee-table', 'bookshelf', 'dresser', 'tv-unit', 'wardrobe', 'bench', 'nightstand', 'chair']);
const METAL_CATS = new Set(['filing-cabinet', 'treatment-bed', 'stool']);
const area = (f: FurnitureItem) => f.w * f.d;

export type ItemRole = 'wall' | 'floor' | 'furniture' | 'accent' | 'metal' | 'wood';
/** Which palette colour an item takes: rugs the floor tone, big upholstered pieces the furniture tone, small items the accent. */
export function roleOf(f: Pick<FurnitureItem, 'category' | 'w' | 'd' | 'mount'>): ItemRole {
  if (f.mount === 'wall') return 'accent';
  if (f.category === 'rug') return 'floor';
  if (METAL_CATS.has(f.category)) return 'metal';
  if (f.category === 'lamp' || f.category === 'plant' || f.w * f.d < 0.25) return 'accent';
  if (WOOD_CATS.has(f.category)) return 'wood';
  return 'furniture';
}

function overlapsAny(item: FurnitureItem, others: FurnitureItem[]): boolean {
  const a = itemCorners(item);
  return others.some((o) => o.category !== 'rug' && o.mount !== 'wall' && convexOverlap(a, itemCorners(o)) > 0.001);
}

/** Wall art in the accent colour on the longest walls without openings. */
function wallDecor(model: SpaceModel, color: string, count: number): FurnitureItem[] {
  const out: FurnitureItem[] = [];
  const cands: Array<{ len: number; spaceId: string; i: number }> = [];
  for (const sp of model.spaces) {
    for (let i = 0; i < sp.polygon.length; i++) {
      const [a, b] = wallSegment(sp, i);
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const busy = model.openings.some((o) => o.spaceId === sp.id && o.wallIndex === i);
      if (len >= 1 && !busy) cands.push({ len, spaceId: sp.id, i });
    }
  }
  cands.sort((p, q) => q.len - p.len);
  for (const c of cands) {
    if (out.length >= count) break;
    const sp = model.spaces.find((s) => s.id === c.spaceId)!;
    const [a, b] = wallSegment(sp, c.i), n = wallInwardNormal(sp, c.i);
    const p = add(add(a, mul(norm(sub(b, a)), c.len / 2)), mul(n, 0.03));
    out.push({
      id: uid('f'), catalogId: 'custom', name: 'Wall art', category: 'art', x: p.x, y: p.y, rotation: Math.atan2(-n.x, n.y),
      w: Math.min(0.9, c.len * 0.4), d: 0.04, h: 0.6, clearance: { front: 0, back: 0, left: 0, right: 0 }, locked: false, owned: false,
      priceSek: 490, priceStatus: 'estimated', color, material: 'print', sourceKind: 'catalog', mount: 'wall', elevationM: 1.3,
    });
  }
  return out;
}

export interface Plan { items: FurnitureItem[]; recoloured: number; swapped: number; added: number; decor: number; ops: Op[] }

/**
 * The whole change as one SET_FURNITURE op, so it is a single undo step.
 * strength 0..1 scales how many items are touched and how far colours move.
 */
export function planInspiration(model: SpaceModel, sw: Swatch[], reading: StyleReading | null, strength: number): Plan {
  const s = Math.max(0, Math.min(1, strength));
  const rc = roleColors(sw);
  const rd = reading ?? styleFromPalette(sw);
  let items = model.furniture.map((f) => ({ ...f }));
  // Recolour biggest first so the 60/30/10 split lands on the dominant pieces.
  const eligible = items.filter((f) => !f.locked && f.mount !== 'wall').sort((a, b) => area(b) - area(a));
  const n = Math.ceil(s * eligible.length - 1e-9);
  const t = 0.4 + 0.6 * s;
  const chosen = new Set(eligible.slice(0, n).map((f) => f.id));
  let recoloured = 0, swapped = 0;
  const mats = [...rd.woods, ...rd.fabrics, ...rd.metals].map((m) => m.toLowerCase());
  items = items.map((f) => {
    if (!chosen.has(f.id)) return f;
    const g = { ...f, color: mix(f.color, rc[roleOf(f)], t) };
    recoloured++;
    if (s >= 0.5 && mats.length) {
      const v = variantsFor(f).find((x) => x.material !== f.material && mats.some((m) => x.material.toLowerCase().includes(m) || m.includes(x.material.toLowerCase())));
      if (v) { g.material = v.material; swapped++; }
    }
    return g;
  });
  const addedItems: FurnitureItem[] = [];
  const maxPieces = Math.round(3 * s);
  for (const p of rd.pieces) {
    if (addedItems.length >= maxPieces) break;
    const e = findByKeyword(p.type);
    if (!e || [...items, ...addedItems].some((f) => f.category === e.category)) continue;
    const base = makeItem(e.id);
    const pose = findFreeSpot({ ...model, furniture: items }, base, [...items, ...addedItems]);
    const it = { ...base, ...pose, color: p.color || rc[roleOf(base)] };
    if (e.category !== 'rug' && overlapsAny(it, [...items, ...addedItems])) continue;
    addedItems.push(it);
  }
  const decor = wallDecor({ ...model, furniture: items }, rc.accent, s > 0.66 ? 2 : s > 0.2 ? 1 : 0);
  const all = [...items, ...addedItems, ...decor];
  const changed = recoloured + addedItems.length + decor.length > 0;
  return {
    items: all, recoloured, swapped, added: addedItems.length, decor: decor.length,
    ops: changed ? [{ type: 'SET_FURNITURE', items: all, label: 'Applied inspiration' }] : [],
  };
}
