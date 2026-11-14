// Themed objects built in code from kits and plain parts: wall decor with exact words, pet
// furniture and a vanity. Instant, exact size, used as-is for decor and as the fallback (and the
// first look while the model works) for everything else.
import type { ObjectRole, ObjectSpec } from '../../core/types';
import { forgeSpec } from '../forge/validate';
import type { Recipe, ThemeObject } from './brief';

type V3 = [number, number, number];
type Raw = Record<string, unknown>;

export const RECIPE_SIZE_CM: Record<Recipe, V3> = {
  poster: [50, 3, 70], sign: [70, 2.5, 22], banner: [90, 2, 50], wallshelf: [80, 22, 30], clock: [35, 5, 35], neon: [70, 4, 30], statue: [35, 35, 90],
  'cat-tree': [60, 60, 150], 'pet-bed': [55, 45, 20], 'scratching-post': [40, 40, 80], 'litter-box': [55, 45, 42], 'pet-bowls': [50, 30, 8],
  'toy-basket': [40, 30, 28], 'window-perch': [60, 35, 50], vanity: [100, 45, 150],
};

const SEM: Record<Recipe, { category: string; role: ObjectRole; wallBacked: boolean; front: number; side: number }> = {
  poster: { category: 'poster', role: 'decor', wallBacked: true, front: 0, side: 0 },
  sign: { category: 'sign', role: 'decor', wallBacked: true, front: 0, side: 0 },
  banner: { category: 'banner', role: 'decor', wallBacked: true, front: 0, side: 0 },
  wallshelf: { category: 'wall-shelf', role: 'storage', wallBacked: true, front: 0, side: 0 },
  clock: { category: 'clock', role: 'decor', wallBacked: true, front: 0, side: 0 },
  neon: { category: 'neon-sign', role: 'lighting', wallBacked: true, front: 0, side: 0 },
  statue: { category: 'statue', role: 'decor', wallBacked: false, front: 0.2, side: 0.05 },
  'cat-tree': { category: 'cat-tree', role: 'decor', wallBacked: true, front: 0.3, side: 0.1 },
  'pet-bed': { category: 'pet-bed', role: 'decor', wallBacked: true, front: 0.15, side: 0.05 },
  'scratching-post': { category: 'scratching-post', role: 'decor', wallBacked: false, front: 0.15, side: 0.05 },
  'litter-box': { category: 'litter-box', role: 'appliance', wallBacked: true, front: 0.3, side: 0.05 },
  'pet-bowls': { category: 'pet-bowls', role: 'decor', wallBacked: true, front: 0.15, side: 0.05 },
  'toy-basket': { category: 'toy-basket', role: 'storage', wallBacked: true, front: 0.1, side: 0.05 },
  'window-perch': { category: 'window-perch', role: 'decor', wallBacked: true, front: 0.15, side: 0.05 },
  vanity: { category: 'vanity', role: 'surface', wallBacked: true, front: 0.7, side: 0.1 },
};

const bowl = (inner: number, floor: number) => [[0.5, 0], [0.5, 0.75], [0.45, 1], [inner, 0.85], [inner, floor]];

/** Parts for a pet or furniture recipe, in metres (the decor recipes are single kits). */
function parts(r: Recipe, w: number, d: number, h: number, c: string, a: string, o: ThemeObject): Raw[] {
  switch (r) {
    case 'cat-tree': {
      const y1 = 0.05 + h * 0.35, y2 = 0.05 + h * 0.62, yb = h - 0.12;
      return [
        { name: 'Base', shape: 'rounded', size: [w, 0.05, d], pos: [0, 0.025, 0], material: 'wool', color: c, radius: 0.01 },
        { name: 'Tall sisal post', shape: 'cylinder', size: [0.11, y2 - 0.05, 0.11], pos: [-w * 0.2, 0.05 + (y2 - 0.05) / 2, -d * 0.15], material: 'rattan' },
        { name: 'Short sisal post', shape: 'cylinder', size: [0.11, y1 - 0.05, 0.11], pos: [w * 0.15, 0.05 + (y1 - 0.05) / 2, d * 0.12], material: 'rattan' },
        { name: 'Low platform', shape: 'rounded', size: [w * 0.6, 0.03, d * 0.55], pos: [w * 0.15, y1 + 0.015, d * 0.12], material: 'wool', color: c, radius: 0.01 },
        { name: 'Middle platform', shape: 'rounded', size: [w * 0.55, 0.03, d * 0.5], pos: [-w * 0.2, y2 + 0.015, -d * 0.15], material: 'wool', color: c, radius: 0.01 },
        { name: 'Top post', shape: 'cylinder', size: [0.1, yb - y2 - 0.03, 0.1], pos: [-w * 0.2, y2 + 0.03 + (yb - y2 - 0.03) / 2, -d * 0.15], material: 'rattan' },
        { name: 'Top bed', shape: 'lathe', size: [w * 0.5, 0.12, d * 0.5], pos: [-w * 0.2, yb + 0.06, -d * 0.15], material: 'wool', color: a, profile: bowl(0.36, 0.25) },
        { name: 'Toy string', shape: 'tube', size: [0.006, 0.14, 0.006], pos: [w * 0.32, y1 - 0.07, d * 0.34], material: 'linen' },
        { name: 'Toy ball', shape: 'sphere', size: [0.06, 0.06, 0.06], pos: [w * 0.32, y1 - 0.17, d * 0.34], material: 'wool', color: a },
      ];
    }
    case 'pet-bed':
      return [
        { name: 'Bed', shape: 'lathe', size: [w, h, d], pos: [0, h / 2, 0], material: 'wool', color: c, profile: bowl(0.38, 0.18) },
        { name: 'Cushion', shape: 'cushion', size: [w * 0.72, h * 0.28, d * 0.72], pos: [0, h * 0.18 + h * 0.14, 0], material: 'fabric', color: a },
      ];
    case 'scratching-post':
      return [
        { name: 'Base', shape: 'rounded', size: [w, 0.04, d], pos: [0, 0.02, 0], material: 'wool', color: c, radius: 0.01 },
        { name: 'Sisal post', shape: 'cylinder', size: [0.1, h - 0.07, 0.1], pos: [0, 0.04 + (h - 0.07) / 2, 0], material: 'rattan' },
        { name: 'Top', shape: 'cylinder', size: [w * 0.75, 0.03, d * 0.75], pos: [0, h - 0.015, 0], material: 'wool', color: c },
        { name: 'Spring', shape: 'tube', size: [0.006, 0.16, 0.006], pos: [w * 0.3, h - 0.03 - 0.08, 0], material: 'steel' },
        { name: 'Pompom', shape: 'sphere', size: [0.05, 0.05, 0.05], pos: [w * 0.3, h - 0.03 - 0.18, 0], material: 'wool', color: a },
      ];
    case 'litter-box': {
      const th = 0.14, hh = h - th;
      return [
        { name: 'Tray', shape: 'rounded', size: [w, th, d], pos: [0, th / 2, 0], material: 'plastic', color: '#9aa0a6', radius: 0.03 },
        { name: 'Hood', shape: 'extrude', style: 'arch', size: [w * 0.98, hh, d * 0.96], pos: [0, th + hh / 2, 0], material: 'plastic', color: c, radius: 0.02 },
        { name: 'Door', shape: 'extrude', style: 'arch', size: [w * 0.45, hh * 0.7, 0.008], pos: [0, th + hh * 0.35, d * 0.48 + 0.004], material: 'plastic', color: '#3a3a3a' },
        { name: 'Handle', shape: 'tube', size: [w * 0.3, 0.025, 0.025], pos: [0, h - 0.0125 - 0.01, 0], material: 'plastic', color: '#9aa0a6' },
      ];
    }
    case 'pet-bowls': {
      const bh = h - 0.01, bw = Math.min(d * 0.7, w * 0.42);
      return [
        { name: 'Mat', shape: 'rounded', size: [w, 0.01, d], pos: [0, 0.005, 0], material: 'plastic', color: a, radius: 0.004 },
        { name: 'Food bowl', shape: 'lathe', size: [bw, bh, bw], pos: [-w * 0.24, 0.01 + bh / 2, 0], material: 'ceramic', color: c, profile: [[0.36, 0], [0.5, 1], [0.44, 1], [0.3, 0.2]] },
        { name: 'Water bowl', shape: 'lathe', size: [bw, bh, bw], pos: [w * 0.24, 0.01 + bh / 2, 0], material: 'ceramic', color: c, profile: [[0.36, 0], [0.5, 1], [0.44, 1], [0.3, 0.2]] },
        { name: 'Food', shape: 'cylinder', size: [bw * 0.62, 0.012, bw * 0.62], pos: [-w * 0.24, 0.01 + bh * 0.62, 0], material: 'wool', color: '#8a5a32' },
        { name: 'Water', shape: 'cylinder', size: [bw * 0.66, 0.006, bw * 0.66], pos: [w * 0.24, 0.01 + bh * 0.66, 0], material: 'glass' },
      ];
    }
    case 'toy-basket':
      return [
        { name: 'Basket', shape: 'lathe', size: [w, h * 0.8, d], pos: [0, h * 0.4, 0], material: 'rattan', color: c, profile: [[0.42, 0], [0.5, 1], [0.46, 1], [0.38, 0.08]] },
        { name: 'Ball', shape: 'sphere', size: [0.09, 0.09, 0.09], pos: [-w * 0.15, h * 0.8 - 0.01, 0], material: 'wool', color: '#e85d5d' },
        { name: 'Ball', shape: 'sphere', size: [0.08, 0.08, 0.08], pos: [w * 0.12, h * 0.8 - 0.02, d * 0.05], material: 'wool', color: '#4f86c6' },
        { name: 'Toy mouse', shape: 'sphere', size: [0.1, 0.06, 0.06], pos: [0, h - 0.03, -d * 0.1], material: 'wool', color: '#9aa0a6' },
      ];
    case 'window-perch':
      return [
        { name: 'Legs', kit: 'legs', count: 4, style: 'tapered', size: [w, h - 0.1, d], pos: [0, (h - 0.1) / 2, 0], material: 'oak' },
        { name: 'Board', shape: 'box', size: [w, 0.03, d], pos: [0, h - 0.1 + 0.015, 0], material: 'oak' },
        { name: 'Cushion', shape: 'cushion', size: [w * 0.96, 0.07, d * 0.94], pos: [0, h - 0.035, 0], material: 'wool', color: c },
      ];
    case 'vanity': {
      const top = 0.75, gold = a;
      return [
        { name: 'Legs', kit: 'legs', count: 4, style: 'tapered', size: [w, top - 0.03, d], pos: [0, (top - 0.03) / 2, 0], material: 'white-laminate', color: c },
        { name: 'Drawer', kit: 'drawers', count: 1, style: 'knob brass', size: [w * 0.5, 0.11, d * 0.9], pos: [0, top - 0.03 - 0.055, 0], material: 'white-laminate', color: c },
        { name: 'Top', shape: 'rounded', size: [w, 0.03, d], pos: [0, top - 0.015, 0], material: 'white-laminate', color: c, radius: 0.008 },
        { name: 'Mirror frame', shape: 'extrude', style: 'arch', size: [w * 0.62, h - top, 0.03], pos: [0, top + (h - top) / 2, -d / 2 + 0.05], material: 'brass', color: gold },
        { name: 'Mirror', shape: 'extrude', style: 'arch', size: [w * 0.54, (h - top) * 0.88, 0.006], pos: [0, top + (h - top) * 0.47, -d / 2 + 0.068], material: 'chrome' },
        { name: 'Perfume', shape: 'lathe', size: [0.06, 0.12, 0.06], pos: [w * 0.36, top + 0.06, 0], material: 'glass', profile: [[0.5, 0], [0.5, 0.6], [0.2, 0.75], [0.2, 1]] },
        { name: 'Jewellery box', shape: 'rounded', size: [0.16, 0.08, 0.1], pos: [-w * 0.36, top + 0.04, 0], material: 'velvet', color: o.color && o.color !== c ? o.color : '#ff4fa3', radius: 0.01 },
      ];
    }
    default:
      return [];
  }
}

/**
 * Build a themed object in code. Size comes from the object (cm) or the recipe default; words,
 * motif and colours from the object. Null when the object has no recipe.
 */
export function recipeSpec(o: ThemeObject, palette: string[] = []): ObjectSpec | null {
  const r = o.recipe;
  if (!r || !RECIPE_SIZE_CM[r]) return null;
  const [wc, dc, hc] = o.sizeCm ?? RECIPE_SIZE_CM[r];
  const w = wc / 100, d = dc / 100, h = hc / 100;
  const c = o.color ?? palette[0] ?? '#d9c7a8', a = o.accent ?? palette[1] ?? '#c46b4b';
  const decor = ['poster', 'sign', 'banner', 'wallshelf', 'clock', 'neon', 'statue'].includes(r);
  const text = o.text ? { value: o.text, ...(r === 'poster' || r === 'banner' ? { style: 'display' as const } : r === 'sign' ? { style: 'serif' as const } : {}) } : undefined;
  const material = r === 'statue' ? (/bat|night|dark/.test(o.style ?? '') ? 'black-metal' : 'brass') : r === 'wallshelf' ? 'oak' : r === 'clock' ? 'plastic' : r === 'sign' ? 'oak' : 'oak';
  const items: Raw[] = decor
    ? [{ name: o.name, kit: r, style: o.style, size: [w, h, d], pos: [0, h / 2, 0], material, color: r === 'statue' && material === 'brass' ? undefined : c, accent: a, text }]
    : parts(r, w, d, h, c, a, o);
  const s = SEM[r];
  const generic = r === 'statue' ? ' A generic stylised figure, not any particular character.' : '';
  const raw = {
    name: o.name, category: s.category, parts: items,
    semantics: { category: s.category, role: s.role, wallBacked: s.wallBacked, frontClearanceM: s.front, sideClearanceM: s.side, pairsWith: [], faces: 'room', description: `${o.name}${o.text ? ` reading "${o.text}"` : ''}.${generic}` },
  };
  const v = forgeSpec(raw, { w, d, h, name: o.name, prompt: o.prompt ?? o.name });
  // Keep the recipe's own category: "cat tree" is not a plant, a pet bed is not a bed.
  const semantics = { ...v.fixed.semantics, category: s.category, role: s.role, wallBacked: s.wallBacked, frontClearanceM: s.front, sideClearanceM: s.side, pairsWith: [] };
  return { ...v.fixed, semantics, model: 'rules', latencyMs: 0 };
}
