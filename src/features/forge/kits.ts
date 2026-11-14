// Kits: higher-level parts that expand into many real parts in code.
//
// A model (or a template) writes one item such as
//   { kit: "drawers", count: 3, size: [0.44, 0.66, 0.6], pos: [0.55, 0.36, 0.08], material: "walnut" }
// and gets three drawer fronts with gaps, boxes, handles, moving groups and slide motions. The item's
// size and pos are the kit's bounding box, so the model reasons about a few boxes while the code
// supplies the craft (joinery, profiles, bedding, casters) that a fast model rarely gets right.
// `mirror` duplicates any item across the centre plane; `count` + `step` repeats a plain part.

import * as THREE from 'three';
import type { MaterialId, ObjectMotion, ObjectPart, PartShape } from '../../core/types';
import { presetProfile } from './profiles';

export const KITS = [
  'legs', 'casters', 'pedestal', 'frame', 'carcass', 'drawers', 'doors', 'shelves', 'bookcase', 'books', 'cushions', 'bedding',
  'headboard', 'canopy', 'arc', 'plan', 'ladder', 'slide', 'slats', 'screen', 'keyboard', 'wallbed', 'plant',
] as const;
export type KitId = (typeof KITS)[number];

type V3 = [number, number, number];
type Pt = [number, number];

/** One item as the model wrote it, after unit conversion (metres). */
export interface KitItem {
  name: string;
  kit?: string;
  shape?: PartShape;
  size: V3;
  pos: V3;
  rot?: V3;
  radius?: number;
  material: MaterialId;
  color?: string;
  accent?: string;
  profile?: Pt[];
  style?: string;
  count?: number;
  mirror?: string;
  group?: string;
  inset?: number;
  step?: V3;
}

export interface Expanded { parts: ObjectPart[]; motions: ObjectMotion[] }

const r4 = (n: number) => Math.round(n * 10000) / 10000;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'part';

export function isKit(v: unknown): v is KitId {
  return typeof v === 'string' && (KITS as readonly string[]).includes(v);
}

/** Loose kit names ("drawer stack", "leg set", "star base") to a kit id. */
export function coerceKit(v: unknown): KitId | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (!t || t === 'part' || t === 'none') return undefined;
  if (isKit(t)) return t;
  const alias: Record<string, KitId> = {
    leg: 'legs', legset: 'legs', feet: 'legs', base: 'legs', caster: 'casters', starbase: 'casters', wheels: 'casters', fivestar: 'casters',
    column: 'pedestal', pillar: 'pedestal', apron: 'frame', rails: 'frame', cabinet: 'carcass', body: 'carcass', case: 'carcass', box: 'carcass',
    drawer: 'drawers', drawerstack: 'drawers', door: 'doors', shelf: 'shelves', shelfstack: 'shelves', bookshelf: 'bookcase', book: 'books',
    cushion: 'cushions', cushionrow: 'cushions', pillows: 'cushions', mattress: 'bedding', bed: 'bedding', canopyframe: 'canopy',
    curve: 'arc', curved: 'arc', outline: 'plan', planshape: 'plan', rungs: 'ladder', spindles: 'slats', bars: 'slats', rail: 'slats',
    monitor: 'screen', display: 'screen', tv: 'screen', keys: 'keyboard', piano: 'keyboard', murphybed: 'wallbed', foldbed: 'wallbed', pot: 'plant',
  };
  return alias[t];
}

// ---- small builders ------------------------------------------------------------------------

interface Ctx { item: KitItem; parts: ObjectPart[]; motions: ObjectMotion[]; key: string }

function P(name: string, shape: PartShape, size: V3, pos: V3, material: MaterialId, extra: Partial<ObjectPart> = {}): ObjectPart {
  const p: ObjectPart = { name, shape, size: size.map((v) => r4(Math.max(0.004, v))) as V3, pos: pos.map(r4) as V3, material };
  if (extra.rot && extra.rot.some((v) => Math.abs(v) > 1e-6)) p.rot = extra.rot.map(r4) as V3;
  if (extra.radius != null) p.radius = r4(extra.radius);
  if (extra.color) p.color = extra.color;
  if (extra.profile) p.profile = extra.profile.map(([a, b]) => [r4(a), r4(b)] as Pt);
  if (extra.group) p.group = extra.group;
  return p;
}

const WOODS: ReadonlySet<MaterialId> = new Set(['oak', 'walnut', 'pine', 'birch']);
const SOFT: ReadonlySet<MaterialId> = new Set(['fabric', 'linen', 'velvet', 'leather', 'wool']);
const METAL: ReadonlySet<MaterialId> = new Set(['black-metal', 'steel', 'brass', 'chrome']);

/** Handle metal that suits a body material. */
function handleMat(body: MaterialId, style = ''): MaterialId {
  if (/brass|gold/.test(style)) return 'brass';
  if (/black/.test(style)) return 'black-metal';
  if (/chrome|steel|silver/.test(style)) return 'steel';
  return body === 'walnut' || body === 'oak' || body === 'black-laminate' || SOFT.has(body) ? 'brass' : body === 'white-laminate' ? 'steel' : 'black-metal';
}

/** Lighter or darker shade of a hex colour. */
export function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => Math.round(k >= 0 ? c + (255 - c) * k : c * (1 + k)));
  return '#' + ch.map((c) => clamp(c, 0, 255).toString(16).padStart(2, '0')).join('');
}

// Kits are authored in a local frame: x in [-w/2, w/2], y in [0, h], z in [-d/2, d/2], front +z.

function legs(c: Ctx, w: number, h: number, d: number) {
  const { item } = c;
  const style = (item.style ?? '').toLowerCase();
  const n = clamp(Math.round(item.count ?? 4), 1, 8);
  const metal = METAL.has(item.material);
  let t = item.radius ? item.radius * 2 : clamp(Math.min(w, d) * 0.06, 0.028, 0.065);
  if (/hairpin/.test(style)) t = 0.012;
  t = Math.min(t, w / 2, d / 2);
  const mat = item.material, col = item.color;
  const spots: Array<[number, number]> = [];
  if (n === 1) spots.push([0, 0]);
  else if (n === 3) for (let i = 0; i < 3; i++) { const a = (i / 3) * Math.PI * 2 + Math.PI / 2; spots.push([Math.cos(a) * (w / 2 - t / 2), -Math.sin(a) * (d / 2 - t / 2)]); }
  else {
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) spots.push([sx * (w / 2 - t / 2), sz * (d / 2 - t / 2)]);
    if (n >= 6) for (const sz of [-1, 1]) spots.push([0, sz * (d / 2 - t / 2)]);
    if (n >= 8) for (const sx of [-1, 1]) spots.push([sx * (w / 2 - t / 2), 0]);
  }
  if (/panel|slab|waterfall/.test(style)) {
    const pt = item.radius ? item.radius * 2 : 0.04;
    for (const sx of [-1, 1]) c.parts.push(P(`${item.name} ${sx < 0 ? 'left' : 'right'}`, 'panel', [pt, h, d], [sx * (w / 2 - pt / 2), h / 2, 0], mat, { color: col }));
    return;
  }
  if (/sled|u-?frame/.test(style)) {
    for (const sx of [-1, 1]) {
      const x = sx * (w / 2 - t / 2);
      c.parts.push(P(`${item.name} ${sx < 0 ? 'left' : 'right'} front`, 'tube', [t, h, t], [x, h / 2, d / 2 - t / 2], mat, { color: col }));
      c.parts.push(P(`${item.name} ${sx < 0 ? 'left' : 'right'} back`, 'tube', [t, h, t], [x, h / 2, -d / 2 + t / 2], mat, { color: col }));
      c.parts.push(P(`${item.name} ${sx < 0 ? 'left' : 'right'} runner`, 'tube', [t, t, d], [x, t / 2, 0], mat, { color: col }));
    }
    return;
  }
  if (/trestle/.test(style)) {
    for (const sx of [-1, 1]) {
      const x = sx * (w / 2 - t);
      c.parts.push(P(`${item.name} ${sx < 0 ? 'left' : 'right'} post`, 'box', [t * 1.4, h - t, t * 2], [x, (h - t) / 2 + t, 0], mat, { color: col }));
      c.parts.push(P(`${item.name} ${sx < 0 ? 'left' : 'right'} foot`, 'rounded', [t * 1.6, t, d], [x, t / 2, 0], mat, { color: col, radius: t * 0.3 }));
    }
    c.parts.push(P(`${item.name} stretcher`, 'box', [w - 2 * t, t, t], [0, h * 0.35, 0], mat, { color: col }));
    return;
  }
  spots.forEach(([x, z], i) => {
    const nm = `${item.name} ${i + 1}`;
    if (/bun|ball/.test(style)) { c.parts.push(P(nm, 'sphere', [Math.max(t, h * 0.9), h, Math.max(t, h * 0.9)], [x, h / 2, z], mat, { color: col })); return; }
    if (/hairpin/.test(style)) {
      for (const s of [-1, 1]) c.parts.push(P(`${nm}${s < 0 ? 'a' : 'b'}`, 'tube', [t, h, t], [x, h / 2, z + s * Math.min(0.05, d / 8) * Math.sign(-z || 1)], 'black-metal', { color: col }));
      return;
    }
    if (/turned/.test(style)) {
      c.parts.push(P(nm, 'lathe', [t * 1.3, h, t * 1.3], [x, h / 2, z], mat, { color: col, profile: [[0.3, 0], [0.42, 0.05], [0.3, 0.15], [0.36, 0.55], [0.5, 0.62], [0.42, 0.7], [0.45, 0.92], [0.5, 1]] }));
      return;
    }
    if (/splay|tapered|mid-?century/.test(style)) {
      const tilt = Math.min(0.14, Math.atan2(Math.min(w, d) * 0.08, h));
      const sx = Math.sign(x) || 0, sz = Math.sign(z) || 0;
      const inX = sx * (h / 2) * Math.sin(tilt) * 0.95, inZ = sz * (h / 2) * Math.sin(tilt) * 0.95;
      c.parts.push(P(nm, 'leg', [t, h / Math.cos(tilt), t], [x - inX, h / 2, z - inZ], mat, { color: col, rot: [sz * tilt, 0, -sx * tilt] }));
      return;
    }
    const round = /round|tube|cylind/.test(style) || (metal && !/square|box/.test(style));
    c.parts.push(P(nm, round ? 'tube' : /square|box|block/.test(style) ? 'box' : 'leg', [t, h, t], [x, h / 2, z], mat, { color: col }));
  });
}

function casters(c: Ctx, w: number, h: number, d: number) {
  const { item } = c;
  const R = Math.min(w, d) / 2, wheel = clamp(R * 0.18, 0.04, 0.065), spokeY = wheel + 0.03;
  const mat = item.material, col = item.color;
  c.parts.push(P(`${item.name} hub`, 'cylinder', [0.09, 0.07, 0.09], [0, spokeY + 0.005, 0], mat, { color: col }));
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + Math.PI / 2, L = R - wheel * 0.45;
    const cx = Math.cos(a), cz = -Math.sin(a);
    c.parts.push(P(`${item.name} spoke ${i + 1}`, 'rounded', [L, 0.035, 0.045], [cx * L / 2, spokeY, cz * L / 2], mat, { color: col, rot: [0, a, 0], radius: 0.012 }));
    c.parts.push(P(`${item.name} caster ${i + 1}`, 'cylinder', [wheel, wheel * 0.55, wheel], [cx * (R - wheel / 2), wheel / 2, cz * (R - wheel / 2)], 'plastic', { color: '#1b1b1d', rot: [0, a, Math.PI / 2] }));
    c.parts.push(P(`${item.name} fork ${i + 1}`, 'box', [0.025, spokeY - wheel * 0.6, 0.025], [cx * (R - wheel / 2), wheel * 0.6 + (spokeY - wheel * 0.6) / 2, cz * (R - wheel / 2)], 'black-metal'));
  }
  const top = h, sleeveTop = spokeY + (top - spokeY) * 0.55;
  c.parts.push(P(`${item.name} column sleeve`, 'cylinder', [0.06, sleeveTop - spokeY, 0.06], [0, (sleeveTop + spokeY) / 2, 0], 'plastic', { color: '#222224' }));
  c.parts.push(P(`${item.name} gas lift`, 'cylinder', [0.032, top - sleeveTop + 0.02, 0.032], [0, (top + sleeveTop - 0.02) / 2, 0], 'chrome'));
}

function pedestal(c: Ctx, w: number, h: number, d: number) {
  const { item } = c;
  const style = (item.style ?? 'column').toLowerCase();
  const mat = item.material, col = item.color;
  const R = Math.min(w, d) / 2;
  if (/tulip|trumpet|flare/.test(style)) {
    c.parts.push(P(`${item.name}`, 'lathe', [w, h, d], [0, h / 2, 0], mat, { color: col, profile: [[0.5, 0], [0.42, 0.03], [0.2, 0.12], [0.1, 0.3], [0.085, 0.6], [0.11, 0.85], [0.2, 0.97], [0.22, 1]] }));
    return;
  }
  if (/drum|cylinder/.test(style)) { c.parts.push(P(`${item.name}`, 'cylinder', [w * 0.7, h, d * 0.7], [0, h / 2, 0], mat, { color: col })); return; }
  const colR = clamp(R * 0.16, 0.035, 0.09), base = Math.min(0.05, h * 0.08);
  if (/cross|star|x|four/.test(style)) {
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + (i * Math.PI) / 2;
      c.parts.push(P(`${item.name} foot ${i + 1}`, 'rounded', [R, base, 0.07], [Math.cos(a) * R / 2, base / 2, -Math.sin(a) * R / 2], mat, { color: col, rot: [0, a, 0], radius: 0.015 }));
    }
  } else {
    c.parts.push(P(`${item.name} base`, 'lathe', [w, base, d], [0, base / 2, 0], mat, { color: col, profile: [[0.5, 0], [0.5, 0.35], [0.42, 0.8], [0.15, 1]] }));
  }
  if (/turned|classic/.test(style)) {
    c.parts.push(P(`${item.name} column`, 'lathe', [colR * 2.4, h - base, colR * 2.4], [0, base + (h - base) / 2, 0], mat, { color: col, profile: [[0.5, 0], [0.32, 0.08], [0.42, 0.16], [0.24, 0.3], [0.2, 0.65], [0.3, 0.8], [0.22, 0.9], [0.4, 1]] }));
  } else {
    c.parts.push(P(`${item.name} column`, 'cylinder', [colR * 2, h - base - 0.02, colR * 2], [0, base + (h - base - 0.02) / 2, 0], mat, { color: col }));
    c.parts.push(P(`${item.name} top plate`, 'cylinder', [Math.min(w, 0.42) * 0.8, 0.02, Math.min(d, 0.42) * 0.8], [0, h - 0.01, 0], mat, { color: col }));
  }
}

function frame(c: Ctx, w: number, h: number, d: number) {
  const { item } = c;
  const style = (item.style ?? 'top').toLowerCase();
  const t = item.radius ? item.radius * 2 : clamp(Math.min(w, d, h) * 0.06, 0.02, 0.05);
  const shape: PartShape = /round|tube/.test(style) ? 'tube' : 'box';
  const mat = item.material, col = item.color;
  const add = (nm: string, size: V3, pos: V3) => c.parts.push(P(`${item.name} ${nm}`, shape, size, pos, mat, { color: col }));
  if (/apron/.test(style)) {
    const ah = Math.min(h, 0.1), at = 0.022;
    add('front', [w, ah, at], [0, h - ah / 2, d / 2 - at / 2]); add('back', [w, ah, at], [0, h - ah / 2, -d / 2 + at / 2]);
    add('left', [at, ah, d - 2 * at], [-w / 2 + at / 2, h - ah / 2, 0]); add('right', [at, ah, d - 2 * at], [w / 2 - at / 2, h - ah / 2, 0]);
    return;
  }
  const ring = (y: number, label: string) => {
    add(`${label} front`, [w, t, t], [0, y, d / 2 - t / 2]); add(`${label} back`, [w, t, t], [0, y, -d / 2 + t / 2]);
    add(`${label} left`, [t, t, d - 2 * t], [-w / 2 + t / 2, y, 0]); add(`${label} right`, [t, t, d - 2 * t], [w / 2 - t / 2, y, 0]);
  };
  const posts = () => { for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(`post ${sx < 0 ? 'L' : 'R'}${sz < 0 ? 'B' : 'F'}`, [t, h - (/full/.test(style) ? 2 * t : t), t], [sx * (w / 2 - t / 2), /full/.test(style) ? h / 2 : (h - t) / 2, sz * (d / 2 - t / 2)]); };
  if (/sides/.test(style)) {
    for (const sx of [-1, 1]) {
      const x = sx * (w / 2 - t / 2), s = sx < 0 ? 'left' : 'right';
      add(`${s} top`, [t, t, d], [x, h - t / 2, 0]); add(`${s} foot`, [t, t, d], [x, t / 2, 0]);
      add(`${s} front post`, [t, h - 2 * t, t], [x, h / 2, d / 2 - t / 2]); add(`${s} back post`, [t, h - 2 * t, t], [x, h / 2, -d / 2 + t / 2]);
    }
    add('stretcher', [w - 2 * t, t, t], [0, h - t * 1.5, -d / 2 + t / 2]);
    return;
  }
  if (/base|bottom/.test(style)) { ring(t / 2, 'bottom'); return; }
  ring(h - t / 2, 'top');
  if (/full|box|cage/.test(style)) { ring(t / 2, 'bottom'); posts(); }
}

function carcass(c: Ctx, w: number, h: number, d: number, opts: { plinth?: boolean } = {}) {
  const { item } = c;
  const style = (item.style ?? '').toLowerCase();
  const t = 0.018, mat = item.material, col = item.color;
  const plinth = opts.plinth ?? (/plinth/.test(style) || (!/legs|raised|none|float/.test(style) && h > 0.5));
  const ph = plinth ? Math.min(0.08, h * 0.1) : 0;
  c.parts.push(P(`${item.name} left side`, 'panel', [t, h, d], [-w / 2 + t / 2, h / 2, 0], mat, { color: col }));
  c.parts.push(P(`${item.name} right side`, 'panel', [t, h, d], [w / 2 - t / 2, h / 2, 0], mat, { color: col }));
  c.parts.push(P(`${item.name} top`, 'panel', [w - 2 * t, t, d], [0, h - t / 2, 0], mat, { color: col }));
  c.parts.push(P(`${item.name} bottom`, 'panel', [w - 2 * t, t, d - 0.01], [0, ph + t / 2, -0.005], mat, { color: col }));
  if (!/open|no back/.test(style)) c.parts.push(P(`${item.name} back`, 'panel', [w - 2 * t, h - ph - 2 * t, 0.008], [0, ph + t + (h - ph - 2 * t) / 2, -d / 2 + 0.004], mat, { color: col ? shade(col, -0.08) : undefined }));
  if (plinth) c.parts.push(P(`${item.name} plinth`, 'panel', [w - 2 * t, ph, t], [0, ph / 2, d / 2 - 0.03], mat, { color: col ? shade(col, -0.25) : undefined }));
  const bays = clamp(Math.round(item.count ?? 1), 1, 6);
  for (let i = 1; i < bays; i++) c.parts.push(P(`${item.name} divider ${i}`, 'panel', [t, h - ph - 2 * t, d - 0.01], [-w / 2 + (i * w) / bays, ph + t + (h - ph - 2 * t) / 2, -0.005], mat, { color: col }));
  return { t, ph };
}

function drawers(c: Ctx, w: number, h: number, d: number) {
  const { item } = c;
  const style = (item.style ?? 'bar').toLowerCase();
  const n = clamp(Math.round(item.count ?? Math.max(1, Math.round(h / 0.2))), 1, 10);
  const cols = /2 ?col|grid|two/.test(style) || (w > 1.1 && n >= 4 && n % 2 === 0) ? 2 : 1;
  const rows = Math.ceil(n / cols), gap = 0.004, ft = 0.019;
  const cw = w / cols, rh = h / rows;
  const hm = handleMat(item.material, style);
  let k = 0;
  for (let ci = 0; ci < cols; ci++) for (let ri = rows - 1; ri >= 0 && k < n; ri--, k++) {
    const x = -w / 2 + cw * (ci + 0.5), y = rh * (ri + 0.5);
    const g = `${c.key}-${k + 1}`;
    const nm = `${item.name} ${k + 1}`;
    c.parts.push(P(`${nm} front`, 'panel', [cw - gap, rh - gap, ft], [x, y, d / 2 - ft / 2], item.material, { color: item.color, group: g }));
    c.parts.push(P(`${nm} box`, 'box', [cw - 0.04, rh * 0.68, Math.max(0.05, d - ft - 0.02)], [x, y - rh * 0.08, -ft / 2 - 0.01 + 0.005], WOODS.has(item.material) ? 'birch' : 'white-laminate', { group: g }));
    const hy = rh > 0.3 ? y + rh * 0.3 : y;
    if (/knob/.test(style)) {
      for (const s of cw > 0.6 ? [-1, 1] : [0]) c.parts.push(P(`${nm} knob${s ? (s < 0 ? ' L' : ' R') : ''}`, 'sphere', [0.028, 0.028, 0.022], [x + s * cw * 0.25, hy, d / 2 + 0.011], hm, { group: g, color: item.accent }));
    } else if (/cut|groove|push|none|handleless/.test(style)) {
      if (!/none|push/.test(style)) c.parts.push(P(`${nm} grip`, 'box', [Math.min(0.14, cw * 0.4), 0.012, 0.004], [x, y + rh / 2 - gap - 0.012, d / 2 + 0.001], 'black-laminate', { group: g }));
    } else if (/cup/.test(style)) {
      c.parts.push(P(`${nm} cup pull`, 'rounded', [Math.min(0.09, cw * 0.3), 0.025, 0.02], [x, hy, d / 2 + 0.01], hm, { group: g, radius: 0.01, color: item.accent }));
    } else {
      c.parts.push(P(`${nm} handle`, 'tube', [Math.min(0.16, cw * 0.42), 0.012, 0.012], [x, hy, d / 2 + 0.012], hm, { group: g, color: item.accent }));
    }
    c.motions.push({ group: g, label: n > 1 ? `Open drawer ${k + 1}` : 'Open drawer', kind: 'slide', axis: [0, 0, 1], open: r4(clamp((d - ft) * 0.75, 0.1, 0.5)) });
  }
}

function doors(c: Ctx, w: number, h: number, d: number) {
  const { item } = c;
  const style = (item.style ?? 'hinged').toLowerCase();
  const n = clamp(Math.round(item.count ?? (w > 0.65 ? 2 : 1)), 1, 6);
  const gap = 0.004, t = clamp(d, 0.016, 0.03);
  const hm = handleMat(item.material, style);
  const dw = w / n;
  const sliding = /slid/.test(style);
  for (let i = 0; i < n; i++) {
    const g = `${c.key}-${i + 1}`;
    const nm = `${item.name} ${i + 1}`;
    const left = (i + 0.5) * dw < w / 2 || n === 1;
    const x = -w / 2 + dw * (i + 0.5);
    const z = sliding ? d / 2 - t / 2 - (i % 2) * t : d / 2 - t / 2;
    const pw = sliding ? dw + 0.02 : dw - gap;
    const glass = /glass|vitrine/.test(style), cane = /cane|rattan/.test(style), shaker = /shaker|frame|panel/.test(style), louvre = /louvre|slat|fluted/.test(style);
    if (glass || cane) {
      const f = 0.05;
      c.parts.push(P(`${nm} stile L`, 'box', [f, h - gap, t], [x - pw / 2 + f / 2, h / 2, z], item.material, { color: item.color, group: g }));
      c.parts.push(P(`${nm} stile R`, 'box', [f, h - gap, t], [x + pw / 2 - f / 2, h / 2, z], item.material, { color: item.color, group: g }));
      c.parts.push(P(`${nm} rail top`, 'box', [pw - 2 * f, f, t], [x, h - gap / 2 - f / 2, z], item.material, { color: item.color, group: g }));
      c.parts.push(P(`${nm} rail bottom`, 'box', [pw - 2 * f, f, t], [x, gap / 2 + f / 2, z], item.material, { color: item.color, group: g }));
      c.parts.push(P(`${nm} ${glass ? 'glass' : 'cane'}`, 'panel', [pw - 2 * f, h - gap - 2 * f, 0.006], [x, h / 2, z], glass ? 'glass' : 'rattan', { group: g }));
    } else {
      c.parts.push(P(`${nm}`, 'panel', [pw, h - gap, t], [x, h / 2, z], item.material, { color: item.color, group: g }));
      if (shaker) {
        const f = Math.min(0.06, pw * 0.14), ft = 0.006, zz = z + t / 2 + ft / 2;
        c.parts.push(P(`${nm} frame L`, 'box', [f, h - gap, ft], [x - pw / 2 + f / 2, h / 2, zz], item.material, { color: item.color, group: g }));
        c.parts.push(P(`${nm} frame R`, 'box', [f, h - gap, ft], [x + pw / 2 - f / 2, h / 2, zz], item.material, { color: item.color, group: g }));
        c.parts.push(P(`${nm} frame top`, 'box', [pw - 2 * f, f, ft], [x, h - gap / 2 - f / 2, zz], item.material, { color: item.color, group: g }));
        c.parts.push(P(`${nm} frame bottom`, 'box', [pw - 2 * f, f, ft], [x, gap / 2 + f / 2, zz], item.material, { color: item.color, group: g }));
      }
      if (louvre) {
        const k = clamp(Math.round(pw / 0.04), 4, 14);
        for (let j = 0; j < Math.min(k, 8); j++) c.parts.push(P(`${nm} flute ${j + 1}`, 'tube', [0.018, h - gap - 0.04, 0.012], [x - pw / 2 + (pw / Math.min(k, 8)) * (j + 0.5), h / 2, z + t / 2 + 0.003], item.material, { color: item.color, group: g }));
      }
    }
    // Handle near the opening edge.
    if (!/push|none|handleless/.test(style)) {
      const hx = sliding ? x + (left ? pw / 2 - 0.05 : -pw / 2 + 0.05) : n === 1 ? x + pw / 2 - 0.05 : x + (left ? pw / 2 - 0.04 : -pw / 2 + 0.04);
      const flip = /flip|drop|fall/.test(style), lift = /lift|up/.test(style);
      const hl = Math.min(0.18, h * 0.35);
      if (flip || lift) c.parts.push(P(`${nm} handle`, 'tube', [Math.min(0.16, pw * 0.4), 0.012, 0.012], [x, flip ? h - 0.05 : 0.05, z + t / 2 + 0.012], hm, { group: g, color: item.accent }));
      else c.parts.push(P(`${nm} handle`, 'tube', [0.012, hl, 0.012], [hx, h > 1.2 ? Math.min(h * 0.5, 1.05) : h * 0.62, z + t / 2 + 0.012], hm, { group: g, color: item.accent }));
    }
    const label = n > 1 ? `Open door ${i + 1}` : 'Open door';
    if (sliding) c.motions.push({ group: g, label: n > 1 ? `Slide door ${i + 1}` : 'Slide door', kind: 'slide', axis: [left ? 1 : -1, 0, 0], open: r4(dw * 0.9) });
    else if (/flip|drop|fall/.test(style)) c.motions.push({ group: g, label, kind: 'hinge', pivot: [x, 0, d / 2], axis: [1, 0, 0], open: r4(Math.PI / 2) });
    else if (/lift|up/.test(style)) c.motions.push({ group: g, label, kind: 'hinge', pivot: [x, h, d / 2], axis: [1, 0, 0], open: -1.3 });
    else {
      const hingeLeft = n === 1 ? true : left;
      c.motions.push({ group: g, label, kind: 'hinge', pivot: [hingeLeft ? x - pw / 2 : x + pw / 2, h / 2, d / 2], axis: [0, 1, 0], open: hingeLeft ? -1.75 : 1.75 });
    }
  }
}

const BOOK_COLORS = ['#7a2e2e', '#2f4f6f', '#c9a227', '#3e5f46', '#d9d2c3', '#5b4a6b', '#a8562f', '#1f2a36', '#b8445a', '#4f7a8a'];

function books(c: Ctx, w: number, h: number, d: number, y0 = 0, x0 = -w / 2, seed0 = 1) {
  const { item } = c;
  let seed = seed0 * 7919 + 13;
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  const maxN = clamp(Math.round(item.count ?? 24), 1, 30);
  let x = x0 + w * 0.04 * rnd();
  const end = x0 + w * (0.55 + 0.4 * rnd());
  for (let i = 0; i < maxN && x < end; i++) {
    const bw = 0.022 + rnd() * 0.022, bh = h * (0.72 + rnd() * 0.26), bd = Math.min(d, 0.16 + rnd() * 0.08);
    if (x + bw > x0 + w) break;
    c.parts.push(P(`Book ${c.parts.length}`, 'box', [bw, bh, bd], [x + bw / 2, y0 + bh / 2, d / 2 - bd / 2 - 0.01], 'linen', { color: item.accent && i % 3 === 0 ? item.accent : BOOK_COLORS[(i * 3 + seed0) % BOOK_COLORS.length] }));
    x += bw + 0.0015;
  }
}

function shelves(c: Ctx, w: number, h: number, d: number, withCarcass: boolean) {
  const { item } = c;
  const style = (item.style ?? '').toLowerCase();
  const t = 0.018;
  let innerW = w, x0 = -w / 2, yb = 0, yt = h;
  if (withCarcass) { const k = carcass(c, w, h, d, { plinth: !/legs|open frame/.test(style) }); innerW = w - 2 * k.t; x0 = -innerW / 2; yb = k.ph + k.t; yt = h - k.t; }
  const n = clamp(Math.round(item.count ?? Math.max(2, Math.round((yt - yb) / 0.36))), withCarcass ? 1 : 2, 10);
  const ys: number[] = [];
  if (withCarcass) for (let i = 1; i <= n; i++) ys.push(yb + ((yt - yb) * i) / (n + 1));
  else for (let i = 0; i < n; i++) ys.push(t / 2 + ((h - t) * i) / (n - 1));
  ys.forEach((y, i) => c.parts.push(P(`${item.name} shelf ${i + 1}`, 'panel', [innerW - 0.002, t, d - (withCarcass ? 0.012 : 0)], [x0 + innerW / 2, y, withCarcass ? 0.006 : 0], /glass/.test(style) ? 'glass' : item.material, { color: /glass/.test(style) ? undefined : item.color })));
  if (/book|decor|styled|full/.test(style)) {
    const levels = withCarcass ? [yb, ...ys] : ys;
    const tops = withCarcass ? [...ys, yt] : ys.slice(1);
    levels.forEach((y, i) => {
      const top = tops[i];
      if (top === undefined) return;
      const gapH = top - y - t;
      if (gapH < 0.12) return;
      books(c, innerW * 0.96, Math.min(gapH - 0.02, 0.3), d, y + (withCarcass && i === 0 ? t / 2 : t / 2), x0 + innerW * 0.02 + (i % 2 ? innerW * 0.25 : 0), i + 1);
      if (/decor|styled/.test(style) && i % 2 === 0 && innerW > 0.5) {
        const vh = Math.min(gapH * 0.7, 0.24);
        c.parts.push(P(`Vase ${i + 1}`, 'lathe', [0.11, vh, 0.11], [x0 + innerW * 0.85, y + t / 2 + vh / 2, 0], 'ceramic', { color: item.accent ?? '#e9e2d6', profile: [[0.3, 0], [0.45, 0.15], [0.5, 0.45], [0.3, 0.85], [0.33, 1]] }));
      }
    });
  }
}

function cushions(c: Ctx, w: number, h: number, d: number) {
  const { item } = c;
  const style = (item.style ?? '').toLowerCase();
  const n = clamp(Math.round(item.count ?? Math.max(1, Math.round(w / 0.62))), 1, 8);
  const gap = n > 1 ? 0.008 : 0, cw = (w - gap * (n - 1)) / n;
  const back = /back/.test(style) || (h > d * 1.4 && !/seat/.test(style));
  for (let i = 0; i < n; i++) {
    const x = -w / 2 + cw / 2 + i * (cw + gap);
    const nm = n > 1 ? `${item.name} ${i + 1}` : item.name;
    const col = /pillow|throw|accent/.test(style) && item.accent && i % 2 ? item.accent : item.color;
    if (/bolster|roll/.test(style)) { c.parts.push(P(nm, 'tube', [cw, Math.min(h, d), Math.min(h, d)], [x, h / 2, 0], item.material, { color: col })); continue; }
    if (/pillow|throw|accent/.test(style)) {
      const s = Math.min(cw * 0.9, h);
      c.parts.push(P(nm, 'cushion', [s, s, Math.min(d, 0.14)], [x, s / 2 + (h - s) / 2, 0], item.material, { color: col, rot: [-0.25, (i % 2 ? -1 : 1) * 0.12, 0] }));
      continue;
    }
    if (back) {
      const tilt = -0.12, th = Math.min(d, 0.22);
      c.parts.push(P(nm, 'cushion', [cw, h * 0.98, th], [x, h / 2, d / 2 - th / 2 - Math.abs(Math.sin(tilt)) * h * 0.25], item.material, { color: col, rot: [tilt, 0, 0] }));
    } else {
      c.parts.push(P(nm, 'cushion', [cw, h, d], [x, h / 2, 0], item.material, { color: col }));
    }
    if (/tuft|button|chesterfield/.test(style)) {
      const rows = back ? 2 : 1, colsN = Math.max(1, Math.round(cw / 0.2));
      for (let r = 0; r < rows; r++) for (let k = 0; k < Math.min(colsN, 3); k++) {
        const bx = x - cw / 2 + (cw / Math.min(colsN, 3)) * (k + 0.5);
        if (back) c.parts.push(P(`${nm} button ${r}${k}`, 'sphere', [0.022, 0.022, 0.014], [bx, h * (0.35 + r * 0.35), d / 2 - 0.004], item.material, { color: item.accent ?? (item.color ? shade(item.color, -0.25) : undefined) }));
        else c.parts.push(P(`${nm} button ${r}${k}`, 'sphere', [0.022, 0.014, 0.022], [bx, h - 0.004, 0], item.material, { color: item.accent ?? (item.color ? shade(item.color, -0.25) : undefined) }));
      }
    }
    if (/channel/.test(style)) {
      const k = Math.max(2, Math.round(cw / 0.16));
      for (let j = 1; j < k; j++) c.parts.push(P(`${nm} channel ${j}`, 'tube', [0.012, back ? h * 0.9 : 0.012, back ? 0.012 : d * 0.9], [x - cw / 2 + (cw * j) / k, back ? h / 2 : h - 0.003, back ? d / 2 - 0.002 : 0], item.material, { color: item.color ? shade(item.color, -0.18) : undefined }));
    }
  }
}

function bedding(c: Ctx, w: number, h: number, d: number) {
  const { item } = c;
  const style = (item.style ?? '').toLowerCase();
  const mt = clamp(h * 0.62, 0.12, 0.26);
  const duvetCol = item.color ?? '#ece7dd';
  c.parts.push(P(`Mattress`, 'rounded', [w, mt, d], [0, mt / 2, 0], 'mattress', { radius: 0.045 }));
  if (/bare|none|mattress only/.test(style)) return;
  const dl = d * 0.72;
  c.parts.push(P(`Duvet`, 'cushion', [w + 0.04, 0.07, dl], [0, mt + 0.035, d / 2 - dl / 2 + 0.02], /velvet|satin/.test(style) ? 'velvet' : 'linen', { color: duvetCol }));
  c.parts.push(P(`Duvet fold`, 'cushion', [w + 0.04, 0.05, 0.26], [0, mt + 0.085, d / 2 - dl + 0.15], 'linen', { color: shade(duvetCol, 0.25) }));
  const n = clamp(Math.round(item.count ?? (w >= 1.2 ? 2 : 1)), 1, 4);
  const pw = Math.min(0.62, (w - 0.08) / n - 0.02);
  for (let i = 0; i < n; i++) {
    const x = -w / 2 + (w / n) * (i + 0.5);
    c.parts.push(P(n > 1 ? `Pillow ${i + 1}` : 'Pillow', 'cushion', [pw, 0.15, 0.4], [x, mt + 0.08, -d / 2 + 0.24], 'linen', { color: /satin|theme/.test(style) && item.accent ? shade(item.accent, 0.75) : '#f6f3ee', rot: [-0.25, 0, 0] }));
  }
  if (!/plain|simple/.test(style)) {
    const acc = item.accent ?? shade(duvetCol, -0.35);
    if (/heart/.test(style)) {
      c.parts.push(P('Heart cushion', 'extrude', [0.36, 0.32, 0.1], [0, mt + 0.2, -d / 2 + 0.47], 'velvet', { color: acc, profile: presetProfile('heart'), rot: [-0.3, 0, 0] }));
    } else if (w >= 1.0) {
      for (const s of [-1, 1]) c.parts.push(P(`Accent cushion ${s < 0 ? 'L' : 'R'}`, 'cushion', [0.42, 0.36, 0.12], [s * Math.min(0.26, w / 5), mt + 0.2, -d / 2 + 0.44], 'velvet', { color: acc, rot: [-0.3, 0, 0] }));
    }
    c.parts.push(P(`Throw`, 'cushion', [w + 0.06, 0.03, 0.45], [0, mt + 0.085, d / 2 - 0.4], 'wool', { color: acc }));
  }
}

function headboard(c: Ctx, w: number, h: number, d: number) {
  const { item } = c;
  const style = (item.style ?? 'rect').toLowerCase();
  const mat = item.material, col = item.color;
  if (/channel|tuft|button|upholster/.test(style)) {
    const t = Math.min(0.04, d * 0.5);
    c.parts.push(P(`${item.name} back`, 'rounded', [w, h, t], [0, h / 2, -d / 2 + t / 2], WOODS.has(mat) ? mat : 'white-laminate', { color: WOODS.has(mat) ? undefined : col, radius: 0.01 }));
    const n = /channel/.test(style) ? clamp(Math.round(item.count ?? w / 0.26), 3, 10) : 1;
    const cw = (w - 0.04) / n, ch = h * 0.55;
    for (let i = 0; i < n; i++) c.parts.push(P(n > 1 ? `${item.name} channel ${i + 1}` : `${item.name} pad`, 'cushion', [cw, ch, d - t], [-w / 2 + 0.02 + cw * (i + 0.5), h - ch / 2 - 0.02, d / 2 - (d - t) / 2], SOFT.has(mat) ? mat : 'velvet', { color: col }));
    if (!/channel/.test(style)) for (let r = 0; r < 2; r++) for (let k = 0; k < 5; k++) c.parts.push(P(`${item.name} button ${r}${k}`, 'sphere', [0.022, 0.022, 0.014], [-w / 2 + (w / 5) * (k + 0.5) + (r ? w / 10 : 0) - (r && k === 4 ? w / 5 : 0), h - ch * (0.33 + r * 0.33) - 0.02, d / 2 - 0.004], SOFT.has(mat) ? mat : 'velvet', { color: item.accent ?? (col ? shade(col, -0.3) : undefined) }));
    return;
  }
  if (/wing/.test(style)) {
    c.parts.push(P(`${item.name}`, 'cushion', [w * 0.8, h, d], [0, h / 2, 0], SOFT.has(mat) ? mat : 'velvet', { color: col }));
    for (const s of [-1, 1]) c.parts.push(P(`${item.name} wing ${s < 0 ? 'L' : 'R'}`, 'cushion', [w * 0.12, h * 0.9, d * 2], [s * (w / 2 - w * 0.06), h * 0.45, d / 2], SOFT.has(mat) ? mat : 'velvet', { color: col }));
    return;
  }
  const prof = presetProfile(style) ?? presetProfile('rect')!;
  c.parts.push(P(`${item.name}`, 'extrude', [w, h, d], [0, h / 2, 0], mat, { color: col, profile: prof, radius: SOFT.has(mat) ? Math.min(0.02, d * 0.3) : undefined }));
  if (item.accent && !/heart/.test(style) && /heart|inlay|motif/.test(item.name.toLowerCase() + style)) {
    c.parts.push(P(`${item.name} heart`, 'extrude', [w * 0.3, w * 0.27, 0.02], [0, h * 0.7, d / 2 + 0.01], mat, { color: item.accent, profile: presetProfile('heart') }));
  }
}

function canopy(c: Ctx, w: number, h: number, d: number) {
  const { item } = c;
  const style = (item.style ?? 'drapes').toLowerCase();
  const t = item.radius ? item.radius * 2 : 0.045;
  const col = item.color, fab = item.accent ?? '#f4ede4';
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    c.parts.push(P(`${item.name} post ${sx < 0 ? 'L' : 'R'}${sz < 0 ? 'B' : 'F'}`, 'tube', [t, h - t, t], [sx * (w / 2 - t / 2), (h - t) / 2, sz * (d / 2 - t / 2)], item.material, { color: col }));
    if (!/plain|modern/.test(style)) c.parts.push(P(`${item.name} finial ${sx < 0 ? 'L' : 'R'}${sz < 0 ? 'B' : 'F'}`, 'sphere', [t * 1.6, t * 1.6, t * 1.6], [sx * (w / 2 - t / 2), h - t * 0.8, sz * (d / 2 - t / 2)], 'brass'));
  }
  const ry = h - t * 1.6 - t * 0.4;
  c.parts.push(P(`${item.name} rail L`, 'tube', [t * 0.8, t * 0.8, d - 2 * t], [-(w / 2 - t / 2), ry, 0], item.material, { color: col }));
  c.parts.push(P(`${item.name} rail R`, 'tube', [t * 0.8, t * 0.8, d - 2 * t], [w / 2 - t / 2, ry, 0], item.material, { color: col }));
  c.parts.push(P(`${item.name} rail front`, 'tube', [w - 2 * t, t * 0.8, t * 0.8], [0, ry, d / 2 - t / 2], item.material, { color: col }));
  c.parts.push(P(`${item.name} rail back`, 'tube', [w - 2 * t, t * 0.8, t * 0.8], [0, ry, -(d / 2 - t / 2)], item.material, { color: col }));
  if (/frame|plain|modern/.test(style)) return;
  c.parts.push(P(`${item.name} top`, 'panel', [w - 2 * t, 0.008, d - 2 * t], [0, ry + t * 0.4 + 0.004, 0], 'linen', { color: fab }));
  const dropH = (h - t * 2) * 0.78;
  const drapes: Array<[number, number, number]> = /curtain|full/.test(style)
    ? [[-1, -1, 0], [1, -1, 0], [-1, 1, 0], [1, 1, 0]]
    : [[-1, -1, 0], [1, -1, 0], [-1, 1, 0], [1, 1, 0]];
  const dw = /curtain|full/.test(style) ? Math.min(0.5, w * 0.3) : Math.min(0.32, w * 0.22);
  for (const [sx, sz] of drapes) {
    c.parts.push(P(`${item.name} drape ${sx < 0 ? 'L' : 'R'}${sz < 0 ? 'B' : 'F'}`, 'panel', [0.014, dropH, dw], [sx * (w / 2 - t / 2), ry - t * 0.4 - dropH / 2, sz * (d / 2 - t - dw / 2)], 'linen', { color: fab }));
  }
  if (/valance|scallop|princess|crown/.test(style)) {
    c.parts.push(P(`${item.name} valance`, 'extrude', [w - 2 * t, 0.12, 0.012], [0, ry - 0.06, d / 2 - t / 2 + 0.01], 'linen', { color: fab, profile: presetProfile('scallop')!.map(([x, y]) => [x, 1 - y] as Pt) }));
  }
}

/**
 * A curved band seen from above, optionally cut into `count` segments (cushions, desk panels).
 * size = [chord width of the outer edge, height, curve depth: how far the middle of the outer edge
 * sits behind its ends]. radius = band thickness (seat depth), inset moves the band inward. Items
 * with the same width and curve depth share one circle, so a base, a back and cushions line up.
 */
function arc(c: Ctx, w: number, h: number, d: number) {
  const { item } = c;
  const style = (item.style ?? 'concave').toLowerCase();
  const convex = /convex|out|reception|bulge/.test(style);
  const s = clamp(d, 0.01, w / 2);
  const R = (w * w / 4 + s * s) / (2 * s);
  const phi = Math.asin(clamp(w / (2 * R), 0, 1));
  const t = clamp(item.radius && item.radius > 0 ? item.radius : Math.min(0.6, R * 0.5), 0.02, R * 0.95);
  const inset = clamp(item.inset ?? 0, 0, R * 0.9);
  const zc = -s / 2 + R; // circle centre in front of the outer edge's middle (concave)
  const ro = R - inset, ri = Math.max(0.01, ro - t);
  const n = clamp(Math.round(item.count ?? 1), 1, 8);
  const gapA = n > 1 ? Math.min(0.012 / ro, 0.02) : 0;
  const soft = SOFT.has(item.material);
  for (let k = 0; k < n; k++) {
    const a0 = -phi + (2 * phi * k) / n + gapA / 2, a1 = -phi + (2 * phi * (k + 1)) / n - gapA / 2;
    const steps = Math.max(6, Math.round(((a1 - a0) / (2 * phi)) * 48));
    const pts: Pt[] = [];
    for (let i = 0; i <= steps; i++) { const a = a0 + ((a1 - a0) * i) / steps; pts.push([ro * Math.sin(a), zc - ro * Math.cos(a)]); }
    for (let i = steps; i >= 0; i--) { const a = a0 + ((a1 - a0) * i) / steps; pts.push([ri * Math.sin(a), zc - ri * Math.cos(a)]); }
    const world = convex ? pts.map(([x, z]) => [x, -z] as Pt) : pts;
    const xs = world.map((p) => p[0]), zs = world.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
    // Extruded upward: the outline is in (x, -z), rotated so the extrusion runs along +y.
    c.parts.push(P(n > 1 ? `${item.name} ${k + 1}` : item.name, 'extrude', [x1 - x0, z1 - z0, h], [(x0 + x1) / 2, h / 2, (z0 + z1) / 2], item.material,
      { color: item.color, profile: world.map(([x, z]) => [x, -z] as Pt), rot: [-Math.PI / 2, 0, 0], radius: soft ? Math.min(0.03, h * 0.2, t * 0.2) : undefined }));
  }
}

function plan(c: Ctx, w: number, h: number, d: number) {
  const { item } = c;
  const prof = item.profile && item.profile.length >= 3 ? item.profile.map(([x, z]) => [x, -z] as Pt) : (presetProfile(item.style) ?? presetProfile('rounded')!).map(([x, y]) => [x, y] as Pt);
  // Presets have y = 1 at the front: in plan that is +z, so the outline's y runs along -z after rotation.
  c.parts.push(P(item.name, 'extrude', [w, d, h], [0, h / 2, 0], item.material, { color: item.color, profile: prof, rot: [-Math.PI / 2, 0, 0], radius: SOFT.has(item.material) ? Math.min(0.03, h * 0.2) : undefined }));
}

function ladder(c: Ctx, w: number, h: number, d: number) {
  const { item } = c;
  const t = item.radius ? item.radius * 2 : clamp(d, 0.025, 0.05);
  const n = clamp(Math.round(item.count ?? Math.round(h / 0.28)), 2, 12);
  for (const s of [-1, 1]) c.parts.push(P(`${item.name} rail ${s < 0 ? 'L' : 'R'}`, 'box', [t, h, d], [s * (w / 2 - t / 2), h / 2, 0], item.material, { color: item.color }));
  for (let i = 0; i < n; i++) c.parts.push(P(`${item.name} rung ${i + 1}`, 'tube', [w - 2 * t, 0.028, 0.028], [0, (h * (i + 0.6)) / (n + 0.2), 0], item.material, { color: item.accent ?? item.color }));
}

function slide(c: Ctx, w: number, h: number, d: number) {
  const { item } = c;
  // Authored descending toward +z; the caller rotates it for left / right.
  const lip = 0.08, L = Math.hypot(d, h - lip), a = Math.atan2(h - lip, d);
  const yc = lip + (h - lip) / 2;
  c.parts.push(P(`${item.name} chute`, 'panel', [w - 0.04, 0.02, L], [0, yc, 0], item.material, { color: item.color, rot: [a, 0, 0] }));
  for (const s of [-1, 1]) c.parts.push(P(`${item.name} wall ${s < 0 ? 'L' : 'R'}`, 'rounded', [0.025, 0.12, L], [s * (w / 2 - 0.0125), yc + 0.05, 0], item.material, { color: item.accent ?? (item.color ? shade(item.color, -0.2) : undefined), rot: [a, 0, 0], radius: 0.01 }));
  c.parts.push(P(`${item.name} foot`, 'rounded', [w, lip, 0.12], [0, lip / 2, d / 2 - 0.06], item.material, { color: item.accent ?? item.color, radius: 0.02 }));
}

function slats(c: Ctx, w: number, h: number, d: number) {
  const { item } = c;
  const style = (item.style ?? 'vertical').toLowerCase();
  const horizontal = /horiz/.test(style);
  const n = clamp(Math.round(item.count ?? (horizontal ? h / 0.12 : w / 0.09)), 2, 24);
  const rails = !/bars|only|no rail/.test(style);
  const rt = Math.min(0.04, (horizontal ? w : h) * 0.08);
  const span = horizontal ? h : w;
  const bt = item.radius ? item.radius * 2 : clamp((span / n) * 0.35, 0.012, 0.035);
  if (rails && !horizontal) {
    c.parts.push(P(`${item.name} top rail`, 'box', [w, rt, d], [0, h - rt / 2, 0], item.material, { color: item.color }));
    c.parts.push(P(`${item.name} bottom rail`, 'box', [w, rt, d], [0, rt / 2, 0], item.material, { color: item.color }));
  }
  if (rails && horizontal) for (const s of [-1, 1]) c.parts.push(P(`${item.name} post ${s < 0 ? 'L' : 'R'}`, 'box', [rt, h, d], [s * (w / 2 - rt / 2), h / 2, 0], item.material, { color: item.color }));
  for (let i = 0; i < n; i++) {
    if (horizontal) {
      const y = bt / 2 + ((h - bt) * i) / (n - 1);
      c.parts.push(P(`${item.name} ${i + 1}`, 'box', [w - (rails ? 2 * rt : 0), bt, Math.min(d, bt)], [0, y, 0], item.material, { color: item.color }));
    } else {
      const inner = w - (rails ? 0 : 0), x = -inner / 2 + bt / 2 + ((inner - bt) * i) / (n - 1);
      c.parts.push(P(`${item.name} ${i + 1}`, 'tube', [bt, h - (rails ? 2 * rt : 0), bt], [x, h / 2, 0], item.material, { color: item.color }));
    }
  }
}

function screen(c: Ctx, w: number, h: number, d: number) {
  const { item } = c;
  const style = (item.style ?? '').toLowerCase();
  c.parts.push(P(`${item.name} bezel`, 'rounded', [w, h, d], [0, h / 2, 0], item.material, { color: item.color ?? '#151517', radius: Math.min(0.01, d / 2) }));
  const glow = item.accent ?? (/arcade|game/.test(style) ? '#2e6bff' : '#0d1626');
  c.parts.push(P(`${item.name} display`, 'panel', [w * 0.93, h * 0.88, 0.004], [0, h / 2, d / 2 + 0.002], 'glass', {}));
  c.parts.push(P(`${item.name} image`, 'panel', [w * 0.92, h * 0.87, 0.003], [0, h / 2, d / 2 - 0.001], 'plastic', { color: glow }));
}

function keyboard(c: Ctx, w: number, h: number, d: number) {
  const { item } = c;
  const whiteH = h * 0.55;
  c.parts.push(P(`${item.name} white keys`, 'box', [w, whiteH, d], [0, whiteH / 2, 0], 'plastic', { color: '#f7f5ef' }));
  const whites = clamp(Math.round(w / 0.0235), 7, 52), kw = w / whites;
  const maxBlack = clamp(Math.round(item.count ?? 36), 5, 36);
  let made = 0;
  for (let i = 0; i < whites - 1 && made < maxBlack; i++) {
    const inOct = i % 7;
    if (inOct === 2 || inOct === 6) continue;
    c.parts.push(P(`${item.name} black key ${made + 1}`, 'box', [kw * 0.55, h - whiteH + 0.006, d * 0.6], [-w / 2 + kw * (i + 1), whiteH + (h - whiteH) / 2 - 0.003, -d / 2 + d * 0.3], 'plastic', { color: '#141414' }));
    made++;
  }
  c.parts.push(P(`${item.name} key slip`, 'box', [w, h * 0.4, 0.012], [0, h * 0.2, d / 2 + 0.006], item.material, { color: item.color }));
}

function wallbed(c: Ctx, w: number, h: number, d: number) {
  const { item } = c;
  const g = c.key;
  const cabMat: MaterialId = item.accent ? 'white-laminate' : item.material;
  const cabCol = item.accent ?? item.color;
  const t = 0.025, ph = 0.1;
  c.parts.push(P('Cabinet left side', 'panel', [t, h, d], [-w / 2 + t / 2, h / 2, 0], cabMat, { color: cabCol }));
  c.parts.push(P('Cabinet right side', 'panel', [t, h, d], [w / 2 - t / 2, h / 2, 0], cabMat, { color: cabCol }));
  c.parts.push(P('Cabinet top', 'panel', [w - 2 * t, t, d], [0, h - t / 2, 0], cabMat, { color: cabCol }));
  c.parts.push(P('Plinth', 'panel', [w - 2 * t, ph, d - 0.05], [0, ph / 2, -0.025], cabMat, { color: cabCol ? shade(cabCol, -0.15) : undefined }));
  c.parts.push(P('Back panel', 'panel', [w - 2 * t, h - ph - t, 0.012], [0, ph + (h - ph - t) / 2, -d / 2 + 0.006], cabMat, { color: cabCol }));
  const fw = w - 2 * t - 0.006, fh = h - ph - t - 0.02, fy = ph + fh / 2 + 0.006, fz = d / 2 - 0.0125;
  c.parts.push(P('Bed front', 'panel', [fw, fh, 0.025], [0, fy, fz], item.material, { color: item.color, group: g }));
  // Shaker-style raised frame so the closed front reads as furniture, not a blank wall.
  const f = 0.07, zz = fz + 0.0125 + 0.004;
  c.parts.push(P('Front frame left', 'box', [f, fh, 0.008], [-fw / 2 + f / 2, fy, zz], item.material, { color: item.color, group: g }));
  c.parts.push(P('Front frame right', 'box', [f, fh, 0.008], [fw / 2 - f / 2, fy, zz], item.material, { color: item.color, group: g }));
  c.parts.push(P('Front frame top', 'box', [fw - 2 * f, f, 0.008], [0, fy + fh / 2 - f / 2, zz], item.material, { color: item.color, group: g }));
  c.parts.push(P('Front frame bottom', 'box', [fw - 2 * f, f, 0.008], [0, fy - fh / 2 + f / 2, zz], item.material, { color: item.color, group: g }));
  c.parts.push(P('Front frame middle', 'box', [fw - 2 * f, f * 0.7, 0.008], [0, fy, zz], item.material, { color: item.color, group: g }));
  for (const s of [-1, 1]) c.parts.push(P(`Pull ${s < 0 ? 'left' : 'right'}`, 'tube', [0.16, 0.014, 0.014], [s * fw * 0.3, fy + fh / 2 - f - 0.06, zz + 0.012], handleMat(item.material, item.style ?? ''), { group: g }));
  // Bed platform, stored upright behind the front: the head end is at the bottom (near the hinge).
  const mL = fh - 0.04, mT = Math.min(0.2, d - 0.12), mz = fz - 0.0125 - mT / 2 - 0.01;
  c.parts.push(P('Side rail left', 'panel', [0.03, fh, mT + 0.04], [-fw / 2 + 0.015, fy, mz + 0.01], cabMat, { color: cabCol, group: g }));
  c.parts.push(P('Side rail right', 'panel', [0.03, fh, mT + 0.04], [fw / 2 - 0.015, fy, mz + 0.01], cabMat, { color: cabCol, group: g }));
  c.parts.push(P('Mattress', 'rounded', [fw - 0.07, mL, mT], [0, fy, mz], 'mattress', { radius: 0.05, group: g }));
  const duvetCol = '#d9dee2';
  c.parts.push(P('Duvet', 'cushion', [fw - 0.05, mL * 0.68, 0.05], [0, fy + mL * 0.15, mz - mT / 2 - 0.02], 'linen', { color: duvetCol, group: g }));
  for (const s of fw > 1.1 ? [-1, 1] : [0]) c.parts.push(P(`Pillow${s ? (s < 0 ? ' left' : ' right') : ''}`, 'cushion', [Math.min(0.6, fw / 2 - 0.06), 0.4, 0.12], [s * fw * 0.25, ph + 0.3, mz - mT / 2 - 0.05], 'linen', { color: '#f6f3ee', group: g }));
  c.parts.push(P('Fold-out leg', 'rounded', [fw * 0.85, 0.05, 0.1], [0, fy + fh / 2 - 0.03, fz - 0.0125 - 0.05], item.material, { color: item.color, group: g, radius: 0.012 }));
  c.motions.push({ group: g, label: 'Fold down', kind: 'hinge', pivot: [0, ph, d / 2], axis: [1, 0, 0], open: r4(Math.PI / 2) });
}

function plant(c: Ctx, w: number, h: number, d: number) {
  const { item } = c;
  const potH = Math.min(h * 0.35, 0.4), potW = Math.min(w, d) * 0.6;
  c.parts.push(P(`${item.name} pot`, 'lathe', [potW, potH, potW], [0, potH / 2, 0], item.material === 'plant' ? 'ceramic' : item.material, { color: item.color, profile: [[0.38, 0], [0.42, 0.1], [0.5, 0.9], [0.5, 1]] }));
  const fh = h - potH;
  c.parts.push(P(`${item.name} stem`, 'tube', [0.02, fh * 0.5, 0.02], [0, potH + fh * 0.25, 0], 'walnut'));
  const blobs: Array<[number, number, number, number]> = [[0, 0.62, 0, 0.9], [-0.22, 0.45, 0.1, 0.65], [0.22, 0.5, -0.08, 0.7], [0.05, 0.85, 0.05, 0.55]];
  for (const [bx, by, bz, s] of blobs) c.parts.push(P(`${item.name} foliage`, 'sphere', [w * s, fh * s * 0.6, d * s], [bx * w, potH + fh * by - fh * s * 0.1, bz * d], 'plant', { color: item.accent }));
}

// ---- transform + public API ---------------------------------------------------------------

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3();

/** Rotate parts and motions about `origin` by Euler `rot` (XYZ). */
export function rotateAll(parts: ObjectPart[], motions: ObjectMotion[], rot: V3, origin: V3): void {
  _q.setFromEuler(_e.set(rot[0], rot[1], rot[2], 'XYZ'));
  for (const p of parts) {
    _v.set(p.pos[0] - origin[0], p.pos[1] - origin[1], p.pos[2] - origin[2]).applyQuaternion(_q);
    p.pos = [r4(_v.x + origin[0]), r4(_v.y + origin[1]), r4(_v.z + origin[2])];
    _q2.setFromEuler(_e.set(...(p.rot ?? [0, 0, 0]), 'XYZ')).premultiply(_q);
    _e.setFromQuaternion(_q2, 'XYZ');
    const r: V3 = [r4(_e.x), r4(_e.y), r4(_e.z)];
    if (r.some((v) => Math.abs(v) > 1e-5)) p.rot = r; else delete p.rot;
  }
  for (const m of motions) {
    _v.set(...m.axis).applyQuaternion(_q);
    m.axis = [r4(_v.x), r4(_v.y), r4(_v.z)];
    if (m.pivot) { _v.set(m.pivot[0] - origin[0], m.pivot[1] - origin[1], m.pivot[2] - origin[2]).applyQuaternion(_q); m.pivot = [r4(_v.x + origin[0]), r4(_v.y + origin[1]), r4(_v.z + origin[2])]; }
  }
}

/** Reflect parts across x = 0 (axis 0) or z = 0 (axis 2). Hinge axes are pseudo-vectors: a = -(M a). */
function mirrorParts(parts: ObjectPart[], motions: ObjectMotion[], axis: 0 | 2, suffix: string): Expanded {
  const groups = new Map<string, string>();
  const flipRot = (r: V3): V3 => (axis === 0 ? [r[0], -r[1], -r[2]] : [-r[0], -r[1], r[2]]);
  const mp = parts.map((p) => {
    const q: ObjectPart = { ...p, name: `${p.name} ${suffix}`.slice(0, 60), pos: [...p.pos] as V3 };
    q.pos[axis] = r4(-q.pos[axis]);
    if (p.rot) q.rot = flipRot(p.rot).map(r4) as V3;
    if (p.profile && p.shape === 'extrude' && axis === 0) q.profile = p.profile.map(([x, y]) => [-x, y] as Pt);
    if (p.group) { const ng = groups.get(p.group) ?? `${p.group}-${suffix}`; groups.set(p.group, ng); q.group = ng; }
    return q;
  });
  const mm = motions.filter((m) => groups.has(m.group)).map((m) => {
    const ax = [...m.axis] as V3; ax[axis] = -ax[axis];
    const out: ObjectMotion = { ...m, group: groups.get(m.group)!, axis: (m.kind === 'hinge' ? ax.map((v) => -v) : ax).map((v) => r4(v) || 0) as V3 };
    if (m.pivot) { const pv = [...m.pivot] as V3; pv[axis] = r4(-pv[axis]); out.pivot = pv; }
    return out;
  });
  return { parts: mp, motions: mm };
}

/**
 * Expand one item into real parts. Plain items (no kit) pass through as a single part, repeated
 * when `count` and `step` are set. The result is in object space, ready for coercion.
 */
export function expandItem(item: KitItem, index: number): Expanded {
  const kit = coerceKit(item.kit);
  const parts: ObjectPart[] = [];
  const motions: ObjectMotion[] = [];
  const [w, h, d] = item.size;
  const ctx: Ctx = { item, parts, motions, key: `${slug(item.name)}-${index}` };
  if (!kit) {
    const n = clamp(Math.round(item.count ?? 1), 1, 24);
    const step = item.step ?? [0, 0, 0];
    let profile = item.profile;
    if ((item.shape === 'extrude' || item.shape === 'lathe') && !profile && item.shape === 'extrude') profile = presetProfile(item.style);
    for (let i = 0; i < n; i++) {
      const p = P(n > 1 ? `${item.name} ${i + 1}` : item.name, item.shape ?? 'box', item.size, [item.pos[0] + step[0] * i, item.pos[1] + step[1] * i, item.pos[2] + step[2] * i], item.material,
        { rot: item.rot, radius: item.radius, color: item.color, profile, group: item.group });
      if (!profile && item.shape === 'extrude' && !p.profile) p.shape = 'rounded';
      parts.push(p);
    }
  } else {
    const style = (item.style ?? '').toLowerCase();
    // Slides that run sideways are built facing +z with swapped width and depth, then turned.
    const turn = kit === 'slide' && /left|right|side|\+x|-x/.test(style) ? (/left|-x/.test(style) ? -Math.PI / 2 : Math.PI / 2) : 0;
    const [lw, ld] = turn ? [d, w] : [w, d];
    switch (kit) {
      case 'legs': legs(ctx, lw, h, ld); break;
      case 'casters': casters(ctx, lw, h, ld); break;
      case 'pedestal': pedestal(ctx, lw, h, ld); break;
      case 'frame': frame(ctx, lw, h, ld); break;
      case 'carcass': carcass(ctx, lw, h, ld); break;
      case 'drawers': drawers(ctx, lw, h, ld); break;
      case 'doors': doors(ctx, lw, h, ld); break;
      case 'shelves': shelves(ctx, lw, h, ld, false); break;
      case 'bookcase': shelves(ctx, lw, h, ld, true); break;
      case 'books': books(ctx, lw, h, ld); break;
      case 'cushions': cushions(ctx, lw, h, ld); break;
      case 'bedding': bedding(ctx, lw, h, ld); break;
      case 'headboard': headboard(ctx, lw, h, ld); break;
      case 'canopy': canopy(ctx, lw, h, ld); break;
      case 'arc': arc(ctx, lw, h, ld); break;
      case 'plan': plan(ctx, lw, h, ld); break;
      case 'ladder': ladder(ctx, lw, h, ld); break;
      case 'slide': slide(ctx, lw, h, ld); break;
      case 'slats': slats(ctx, lw, h, ld); break;
      case 'screen': screen(ctx, lw, h, ld); break;
      case 'keyboard': keyboard(ctx, lw, h, ld); break;
      case 'wallbed': wallbed(ctx, lw, h, ld); break;
      case 'plant': plant(ctx, lw, h, ld); break;
    }
    if (turn) rotateAll(parts, motions, [0, turn, 0], [0, 0, 0]);
    if (item.rot && item.rot.some((v) => Math.abs(v) > 1e-6)) rotateAll(parts, motions, item.rot, [0, h / 2, 0]);
    // Local frame (floor of the box at y = 0) to object space.
    const [px, py, pz] = item.pos;
    for (const p of parts) p.pos = [r4(p.pos[0] + px), r4(p.pos[1] + py - h / 2), r4(p.pos[2] + pz)];
    for (const m of motions) if (m.pivot) m.pivot = [r4(m.pivot[0] + px), r4(m.pivot[1] + py - h / 2), r4(m.pivot[2] + pz)];
    if (item.group) for (const p of parts) if (!p.group) p.group = item.group;
  }
  const mir = (item.mirror ?? '').toLowerCase();
  const out: Expanded = { parts, motions };
  if (/x/.test(mir)) { const m = mirrorParts(out.parts, out.motions, 0, 'mirrored'); out.parts.push(...m.parts); out.motions.push(...m.motions); }
  if (/z/.test(mir)) { const m = mirrorParts(out.parts, out.motions, 2, 'back'); out.parts.push(...m.parts); out.motions.push(...m.motions); }
  return out;
}

/** True when the item is a kit or uses mirror / repeat (anything that expands). */
export const expands = (o: Record<string, unknown>) => !!coerceKit(o.kit) || typeof o.mirror === 'string' || (typeof o.count === 'number' && o.count > 1)
  || (o.shape === 'extrude' && !Array.isArray(o.profile) && typeof o.style === 'string');
