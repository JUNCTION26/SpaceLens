// Decor kits: posters, name signs, banners, wall shelves, clocks, neon signs and statues.
// Each one expands into real parts inside its box, in the same local frame as the other kits
// (x in [-w/2, w/2], y in [0, h], z in [-d/2, d/2], front +z). Words go on a part's `text`, so the
// renderer prints them crisply on that part's front face.
import type { MaterialId, ObjectPart, PartShape } from '../../core/types';
import { presetProfile } from './profiles';

type V3 = [number, number, number];
type Pt = [number, number];
type Text = NonNullable<ObjectPart['text']>;

export interface DecorItem {
  name: string;
  material: MaterialId;
  color?: string;
  accent?: string;
  style?: string;
  count?: number;
  text?: Text;
}

const r4 = (n: number) => Math.round(n * 10000) / 10000;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function P(name: string, shape: PartShape, size: V3, pos: V3, material: MaterialId, extra: Partial<ObjectPart> = {}): ObjectPart {
  const p: ObjectPart = { name, shape, size: size.map((v) => r4(Math.max(0.004, v))) as V3, pos: pos.map(r4) as V3, material };
  if (extra.rot && extra.rot.some((v) => Math.abs(v) > 1e-6)) p.rot = extra.rot.map(r4) as V3;
  if (extra.radius != null) p.radius = r4(extra.radius);
  if (extra.color) p.color = extra.color;
  if (extra.profile) p.profile = extra.profile.map(([a, b]) => [r4(a), r4(b)] as Pt);
  if (extra.text) p.text = extra.text;
  return p;
}

// ---- motifs ----------------------------------------------------------------------------------

export const MOTIFS = ['paw', 'heart', 'star', 'crown', 'bat', 'flower', 'moon', 'controller', 'book', 'leaf'] as const;
export type Motif = (typeof MOTIFS)[number];

const BAT: Pt[] = [[-0.5, 0.78], [-0.36, 0.9], [-0.2, 0.84], [-0.1, 0.74], [-0.07, 0.96], [-0.03, 0.8], [0.03, 0.8], [0.07, 0.96], [0.1, 0.74], [0.2, 0.84], [0.36, 0.9], [0.5, 0.78],
  [0.42, 0.56], [0.31, 0.62], [0.23, 0.44], [0.13, 0.5], [0.05, 0.28], [0, 0.12], [-0.05, 0.28], [-0.13, 0.5], [-0.23, 0.44], [-0.31, 0.62], [-0.42, 0.56]];
const FLOWER = (): Pt[] => Array.from({ length: 80 }, (_, i) => { const t = (i / 80) * Math.PI * 2, r = 0.5 * (0.5 + 0.5 * Math.abs(Math.cos(2.5 * t))); return [r * Math.sin(t), 0.5 + r * Math.cos(t)] as Pt; });
const MOON = (): Pt[] => {
  const pts: Pt[] = [];
  for (let i = 0; i <= 32; i++) { const a = -Math.PI / 2 + (i / 32) * Math.PI * 1.6 - 0.3; pts.push([0.5 * Math.cos(a + Math.PI / 2), 0.5 + 0.5 * Math.sin(a + Math.PI / 2)]); }
  for (let i = 32; i >= 0; i--) { const a = -Math.PI / 2 + (i / 32) * Math.PI * 1.6 - 0.3; pts.push([0.16 + 0.38 * Math.cos(a + Math.PI / 2), 0.56 + 0.38 * Math.sin(a + Math.PI / 2)]); }
  return pts;
};
const LEAF = (): Pt[] => Array.from({ length: 48 }, (_, i) => { const t = (i / 48) * Math.PI * 2; return [0.32 * Math.sin(t) * Math.abs(Math.sin(t / 2)) ** 0.2, 0.5 - 0.5 * Math.cos(t)] as Pt; });

/** Profile for a single-outline motif, or undefined when the motif is built from several parts. */
export function motifProfile(m: string): Pt[] | undefined {
  if (m === 'bat') return BAT;
  if (m === 'flower') return FLOWER();
  if (m === 'moon') return MOON();
  if (m === 'leaf') return LEAF();
  return presetProfile(m);
}

/** The motif named in a style string, if any. */
export function motifOf(style = ''): Motif | undefined {
  const s = style.toLowerCase();
  if (/paw|cat|dog|kitten|puppy/.test(s)) return 'paw';
  if (/heart|love/.test(s)) return 'heart';
  if (/crown|tiara|princess|queen|king/.test(s)) return 'crown';
  if (/bat|night|gotham/.test(s)) return 'bat';
  if (/flower|daisy|blossom|floral/.test(s)) return 'flower';
  if (/moon|sleep|dream/.test(s)) return 'moon';
  if (/game|gamer|controller|joystick/.test(s)) return 'controller';
  if (/book|read|library/.test(s)) return 'book';
  if (/leaf|plant|calm|nature/.test(s)) return 'leaf';
  if (/star|hero|sparkle/.test(s)) return 'star';
  return undefined;
}

/** Flat motif parts centred at (cx, cy), `s` tall, front face at z0. */
export function motifParts(name: string, m: string, cx: number, cy: number, s: number, z0: number, color: string, mat: MaterialId = 'plastic', t = 0.008): ObjectPart[] {
  const out: ObjectPart[] = [];
  const z = z0 + t / 2;
  if (m === 'paw') {
    out.push(P(`${name} pad`, 'extrude', [s * 0.56, s * 0.46, t], [cx, cy - s * 0.24, z], mat, { color, profile: presetProfile('heart')!.map(([x, y]) => [x, 1 - y] as Pt) }));
    const toes: Array<[number, number]> = [[-0.36, 0.08], [-0.13, 0.3], [0.13, 0.3], [0.36, 0.08]];
    for (const [tx, ty] of toes) out.push(P(`${name} toe`, 'extrude', [s * 0.2, s * 0.26, t], [cx + tx * s, cy + ty * s, z], mat, { color, profile: presetProfile('oval') }));
    return out;
  }
  if (m === 'controller') {
    out.push(P(`${name} body`, 'extrude', [s * 1.1, s * 0.56, t], [cx, cy, z], mat, { color, profile: presetProfile('kidney')!.map(([x, y]) => [x, 1 - y] as Pt) }));
    const k = '#f4f1ea';
    out.push(P(`${name} pad h`, 'box', [s * 0.2, s * 0.06, t], [cx - s * 0.28, cy + s * 0.04, z + t * 0.6], mat, { color: k }));
    out.push(P(`${name} pad v`, 'box', [s * 0.06, s * 0.2, t], [cx - s * 0.28, cy + s * 0.04, z + t * 0.6], mat, { color: k }));
    for (const [bx, by] of [[0.24, 0.1], [0.34, 0.02], [0.24, -0.06], [0.14, 0.02]]) out.push(P(`${name} button`, 'extrude', [s * 0.07, s * 0.07, t], [cx + bx * s, cy + by * s, z + t * 0.6], mat, { color: k, profile: presetProfile('round') }));
    return out;
  }
  if (m === 'book') {
    for (const sx of [-1, 1]) out.push(P(`${name} page ${sx < 0 ? 'L' : 'R'}`, 'panel', [s * 0.48, s * 0.66, t], [cx + sx * s * 0.25, cy, z], mat, { color, rot: [0, 0, sx * 0.08] }));
    out.push(P(`${name} spine`, 'box', [s * 0.04, s * 0.7, t * 1.4], [cx, cy, z], mat, { color: '#2b2b2b' }));
    return out;
  }
  const prof = motifProfile(m) ?? presetProfile('star')!;
  const aspect = m === 'bat' ? 0.55 : m === 'crown' ? 0.7 : m === 'leaf' ? 1.4 : 1;
  out.push(P(`${name} ${m}`, 'extrude', [aspect >= 1 ? s / aspect : s, aspect >= 1 ? s : s * aspect, t], [cx, cy, z], mat, { color, profile: prof }));
  if (m === 'flower') out.push(P(`${name} centre`, 'extrude', [s * 0.26, s * 0.26, t], [cx, cy, z + t * 0.6], mat, { color: '#f2c94c', profile: presetProfile('round') }));
  return out;
}

// ---- kits --------------------------------------------------------------------------------------

const ink = (bg: string | undefined) => {
  if (!bg) return '#1d1d1f';
  const n = parseInt(bg.slice(1), 16), l = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return l > 150 ? '#1d1d1f' : '#fbf8f2';
};

/** Framed poster or picture: frame, print, a drawn motif and an optional title. */
export function poster(it: DecorItem, w: number, h: number, d: number): ObjectPart[] {
  const parts: ObjectPart[] = [];
  const style = (it.style ?? '').toLowerCase();
  const framed = !/noframe|unframed|canvas/.test(style);
  const f = framed ? clamp(Math.min(w, h) * 0.06, 0.012, 0.04) : 0;
  const print = it.color ?? '#f4efe6', fg = it.accent ?? it.text?.color ?? ink(print);
  const frameMat: MaterialId = it.material === 'plastic' ? 'white-laminate' : it.material;
  if (framed) {
    parts.push(P(`${it.name} frame top`, 'box', [w, f, d], [0, h - f / 2, 0], frameMat));
    parts.push(P(`${it.name} frame bottom`, 'box', [w, f, d], [0, f / 2, 0], frameMat));
    for (const s of [-1, 1]) parts.push(P(`${it.name} frame ${s < 0 ? 'left' : 'right'}`, 'box', [f, h - 2 * f, d], [s * (w / 2 - f / 2), h / 2, 0], frameMat));
  }
  const iw = w - 2 * f, ih = h - 2 * f, pd = Math.max(0.006, d * 0.5);
  parts.push(P(`${it.name} print`, 'panel', [iw, ih, pd], [0, h / 2, -d / 2 + pd / 2], 'plastic', { color: print }));
  const zf = -d / 2 + pd;
  const motif = motifOf(style) ?? (it.text ? undefined : 'star');
  const hasText = !!it.text?.value;
  if (motif) {
    const ms = Math.min(iw * 0.7, ih * (hasText ? 0.5 : 0.72));
    parts.push(...motifParts(it.name, motif, 0, f + ih * (hasText ? 0.64 : 0.5), ms, zf, fg));
  }
  if (hasText) {
    const th = ih * (motif ? 0.24 : 0.6);
    parts.push(P(`${it.name} title`, 'panel', [iw * 0.9, th, 0.002], [0, f + ih * (motif ? 0.2 : 0.5), zf + 0.001], 'plastic', { color: print, text: { ...it.text!, color: it.text!.color ?? fg } }));
  }
  return parts;
}

/** Name sign: a board with the words across it, optional motif at each end. */
export function sign(it: DecorItem, w: number, h: number, d: number): ObjectPart[] {
  const style = (it.style ?? '').toLowerCase();
  const board = it.color ?? '#c79a63';
  const parts = [P(`${it.name} board`, /arch/.test(style) ? 'extrude' : 'rounded', [w, h, d], [0, h / 2, 0], it.material, { color: board, radius: Math.min(0.02, h * 0.2, d * 0.45), profile: /arch/.test(style) ? presetProfile('arch') : undefined })];
  const motif = motifOf(style);
  const fg = it.accent ?? it.text?.color ?? ink(board);
  const end = motif ? Math.min(h * 0.62, w * 0.16) : 0;
  if (motif) for (const s of [-1, 1]) parts.push(...motifParts(`${it.name} ${s < 0 ? 'left' : 'right'}`, motif, s * (w / 2 - end * 0.8), h / 2, end, d / 2, fg, 'plastic', 0.006));
  if (it.text?.value) parts.push(P(`${it.name} lettering`, 'panel', [w - 2 * end * 1.4 - 0.02, h * 0.8, 0.002], [0, h / 2, d / 2 + 0.001], 'plastic', { color: board, text: { ...it.text, color: it.text.color ?? fg } }));
  return parts;
}

/** Banner: a rod with a fabric panel whose bottom edge is scalloped or pointed. */
export function banner(it: DecorItem, w: number, h: number, d: number): ObjectPart[] {
  const style = (it.style ?? '').toLowerCase();
  const rod = Math.min(0.025, h * 0.08), cloth = it.color ?? '#e85d9b';
  const parts: ObjectPart[] = [P(`${it.name} rod`, 'tube', [w, rod, rod], [0, h - rod / 2, 0], 'brass')];
  for (const s of [-1, 1]) parts.push(P(`${it.name} finial ${s < 0 ? 'L' : 'R'}`, 'sphere', [rod * 1.6, rod * 1.6, rod * 1.6], [s * (w / 2 - rod * 0.8), h - rod / 2, 0], 'brass'));
  const ph = h - rod, pw = w - rod * 3;
  const prof: Pt[] = /pennant|point/.test(style) ? [[-0.5, 1], [-0.5, 0.3], [0, 0], [0.5, 0.3], [0.5, 1]] : presetProfile('scallop')!.map(([x, y]) => [x, 1 - y] as Pt);
  parts.push(P(`${it.name} cloth`, 'extrude', [pw, ph, 0.006], [0, ph / 2, 0], 'linen', { color: cloth, profile: prof, radius: 0.001 }));
  const fg = it.accent ?? it.text?.color ?? ink(cloth);
  if (it.text?.value) parts.push(P(`${it.name} lettering`, 'panel', [pw * 0.86, ph * 0.42, 0.002], [0, ph * 0.62, 0.004], 'linen', { color: cloth, text: { ...it.text, color: it.text.color ?? fg } }));
  const motif = motifOf(style);
  if (motif) parts.push(...motifParts(it.name, motif, 0, ph * 0.28, Math.min(ph * 0.26, pw * 0.3), 0.003, fg, 'linen', 0.004));
  return parts;
}

/** Wall shelf: board on two brackets with a few books and a small pot. */
export function wallShelf(it: DecorItem, w: number, h: number, d: number): ObjectPart[] {
  const parts: ObjectPart[] = [];
  const col = it.color, t = 0.025, hb = Math.min(0.14, h * 0.45);
  parts.push(P(`${it.name} board`, 'box', [w, t, d], [0, hb + t / 2, 0], it.material, { color: col }));
  for (const s of [-1, 1]) {
    parts.push(P(`${it.name} bracket ${s < 0 ? 'L' : 'R'}`, 'box', [0.02, hb, 0.02], [s * w * 0.34, hb / 2, -d / 2 + 0.01], 'black-metal'));
    parts.push(P(`${it.name} bracket arm ${s < 0 ? 'L' : 'R'}`, 'box', [0.02, 0.02, d * 0.85], [s * w * 0.34, hb - 0.01, -d / 2 + d * 0.425], 'black-metal'));
  }
  const top = hb + t, room = h - top;
  if (room > 0.06) {
    const palette = [it.accent ?? '#b8445a', '#2f4f6f', '#d9d2c3', '#c9a227', '#3e5f46'];
    let x = -w / 2 + 0.03;
    const n = clamp(Math.round(it.count ?? 6), 0, 10);
    for (let i = 0; i < n && x < -w * 0.05; i++) {
      const bw = 0.025 + (i % 3) * 0.006, bh = room * (0.78 + ((i * 37) % 20) / 100);
      parts.push(P(`${it.name} book ${i + 1}`, 'box', [bw, bh, Math.min(d - 0.02, 0.15)], [x + bw / 2, top + bh / 2, 0], 'linen', { color: palette[i % palette.length] }));
      x += bw + 0.002;
    }
    const pw = Math.min(0.12, room * 0.6, d * 0.8);
    parts.push(P(`${it.name} pot`, 'lathe', [pw, room * 0.45, pw], [w * 0.3, top + room * 0.225, 0], 'ceramic', { color: '#e9e4dc', profile: [[0.38, 0], [0.42, 0.1], [0.5, 0.9], [0.5, 1]] }));
    parts.push(P(`${it.name} leaves`, 'sphere', [pw * 1.2, room * 0.5, pw * 1.1], [w * 0.3, top + room * 0.72, 0], 'plant'));
  }
  return parts;
}

/** Wall clock: round body, face, twelve marks, two hands. */
export function clock(it: DecorItem, w: number, h: number, d: number): ObjectPart[] {
  const parts: ObjectPart[] = [];
  const R = Math.min(w, h) / 2, cy = h / 2, rim = it.color ?? '#2b2b2b', face = '#f7f4ee', hand = it.accent ?? '#1d1d1f';
  const flat: V3 = [Math.PI / 2, 0, 0];
  parts.push(P(`${it.name} body`, 'cylinder', [R * 2, d * 0.8, R * 2], [0, cy, -d * 0.1], it.material, { color: rim, rot: flat }));
  parts.push(P(`${it.name} face`, 'cylinder', [R * 1.76, 0.004, R * 1.76], [0, cy, d * 0.3 + 0.002], 'plastic', { color: face, rot: flat }));
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2, big = k % 3 === 0;
    parts.push(P(`${it.name} mark ${k + 1}`, 'box', [big ? R * 0.05 : R * 0.03, R * (big ? 0.16 : 0.1), 0.003], [Math.sin(a) * R * 0.74, cy + Math.cos(a) * R * 0.74, d * 0.3 + 0.0055], 'plastic', { color: hand, rot: [0, 0, -a] }));
  }
  const hands: Array<[string, number, number, number]> = [['hour hand', 5.25, 0.45, 0.06], ['minute hand', 0.95, 0.66, 0.04]];
  hands.forEach(([n, a, L, t], i) => parts.push(P(`${it.name} ${n}`, 'box', [R * t, R * L, 0.003], [Math.sin(a) * R * L * 0.4, cy + Math.cos(a) * R * L * 0.4, d * 0.3 + 0.007 + i * 0.0025], 'plastic', { color: hand, rot: [0, 0, -a] })));
  parts.push(P(`${it.name} cap`, 'cylinder', [R * 0.1, 0.006, R * 0.1], [0, cy, d * 0.3 + 0.011], 'brass', { rot: flat }));
  if (it.text?.value) parts.push(P(`${it.name} label`, 'panel', [R * 0.9, R * 0.22, 0.002], [0, cy - R * 0.38, d * 0.3 + 0.0045], 'plastic', { color: face, text: { ...it.text, color: it.text.color ?? hand } }));
  return parts;
}

/** Neon-style sign: clear backing panel with glowing words (and a motif when asked). */
export function neon(it: DecorItem, w: number, h: number, d: number): ObjectPart[] {
  const glow = it.color ?? '#ff4fa3';
  const parts = [P(`${it.name} backing`, 'rounded', [w, h, Math.min(0.012, d)], [0, h / 2, -d / 2 + Math.min(0.006, d / 2)], 'glass', { radius: 0.004 })];
  const motif = motifOf(it.style);
  const words = it.text?.value;
  if (motif) parts.push(...motifParts(`${it.name} neon`, motif, words ? -w / 2 + h * 0.45 : 0, h / 2, h * 0.7, -d / 2 + 0.012, glow, 'plastic', 0.01));
  if (words) parts.push(P(`${it.name} neon lettering`, 'panel', [w * (motif ? 0.68 : 0.92), h * 0.8, 0.003], [motif ? h * 0.35 : 0, h / 2, -d / 2 + 0.0135], 'glass', { text: { style: 'script', ...it.text!, color: it.text!.color ?? glow } }));
  return parts;
}

/**
 * Decor statue: a stylised figure on a plinth from lathe and extrude primitives. Themes are generic
 * (cat, dog, bat-winged figure, caped hero, princess, star, abstract); no characters or logos.
 */
export function statue(it: DecorItem, w: number, h: number, d: number): ObjectPart[] {
  const parts: ObjectPart[] = [];
  const style = (it.style ?? 'figure').toLowerCase();
  const ph = clamp(h * 0.22, 0.05, 0.35), body = it.material, col = it.color, acc = it.accent ?? col;
  parts.push(P(`${it.name} plinth`, 'box', [w, ph, d], [0, ph / 2, 0], /marble|concrete|walnut|oak|black/.test(body) ? body : 'marble', { color: /marble|concrete/.test(body) ? col : undefined }));
  parts.push(P(`${it.name} plinth cap`, 'box', [w * 0.92, 0.015, d * 0.92], [0, ph + 0.0075, 0], 'marble'));
  const y0 = ph + 0.015, H = h - y0, S = Math.min(w, d) * 0.8;
  const add = (name: string, shape: PartShape, size: V3, pos: V3, extra: Partial<ObjectPart> = {}, mat: MaterialId = body) => parts.push(P(`${it.name} ${name}`, shape, size, [pos[0], y0 + pos[1], pos[2]], mat, { color: col, ...extra }));
  if (/cat|kitten|dog|puppy|bear/.test(style)) {
    const dog = /dog|puppy/.test(style), bear = /bear/.test(style);
    add('body', 'lathe', [S * 0.7, H * 0.58, S * 0.62], [0, H * 0.29, -S * 0.04], { profile: [[0.42, 0], [0.5, 0.18], [0.44, 0.55], [0.3, 0.85], [0.22, 1]] });
    add('head', 'sphere', [S * 0.46, H * 0.32, S * 0.4], [0, H * 0.72, S * 0.04]);
    if (bear) for (const s of [-1, 1]) add(`ear ${s}`, 'sphere', [S * 0.14, S * 0.14, S * 0.08], [s * S * 0.16, H * 0.87, S * 0.02]);
    else if (dog) for (const s of [-1, 1]) add(`ear ${s}`, 'rounded', [S * 0.1, H * 0.2, S * 0.06], [s * S * 0.24, H * 0.7, 0], { rot: [0, 0, s * 0.25], radius: 0.02 });
    else for (const s of [-1, 1]) add(`ear ${s}`, 'cone', [S * 0.14, H * 0.13, S * 0.08], [s * S * 0.13, H * 0.9, S * 0.02], { radius: 0.002 });
    if (dog || bear) add('snout', 'sphere', [S * 0.18, S * 0.14, S * 0.16], [0, H * 0.68, S * 0.24]);
    for (const s of [-1, 1]) add(`paw ${s}`, 'sphere', [S * 0.14, S * 0.1, S * 0.2], [s * S * 0.12, S * 0.05, S * 0.26]);
    if (!bear) add('tail', 'tube', [S * 0.08, S * 0.08, S * 0.5], [S * 0.28, S * 0.05, S * 0.02], { rot: [0, 0.9, 0] });
  } else if (/abstract|modern|swirl|vase/.test(style)) {
    add('form', 'lathe', [S * 0.7, H, S * 0.7], [0, H / 2, 0], { profile: [[0.3, 0], [0.5, 0.2], [0.18, 0.5], [0.42, 0.8], [0.12, 1]] });
  } else if (/star|sparkle/.test(style)) {
    add('rod', 'tube', [0.02, H * 0.45, 0.02], [0, H * 0.225, 0], {}, 'brass');
    add('star', 'extrude', [S, Math.min(S, H * 0.55), Math.min(0.06, d * 0.3)], [0, H - Math.min(S, H * 0.55) / 2, 0], { profile: presetProfile('star'), color: acc });
  } else {
    // A standing figure: legs, torso, head, arms; themed extras on top.
    const princess = /princess|queen|dress|gown|ballerina/.test(style);
    if (princess) add('gown', 'lathe', [S * 0.75, H * 0.52, S * 0.62], [0, H * 0.26, 0], { profile: [[0.5, 0], [0.44, 0.2], [0.26, 0.7], [0.18, 1]], color: acc });
    else for (const s of [-1, 1]) add(`leg ${s}`, 'tube', [S * 0.1, H * 0.46, S * 0.11], [s * S * 0.07, H * 0.23, 0]);
    add('torso', 'lathe', [S * 0.36, H * 0.3, S * 0.24], [0, H * 0.6, 0], { profile: [[0.36, 0], [0.32, 0.4], [0.5, 0.88], [0.28, 1]] });
    add('head', 'sphere', [S * 0.2, H * 0.14, S * 0.2], [0, H * 0.82, 0]);
    for (const s of [-1, 1]) add(`arm ${s}`, 'tube', [S * 0.07, H * 0.3, S * 0.07], [s * S * 0.21, H * 0.6, 0], { rot: [0, 0, s * (/hero|flying|power/.test(style) ? 0.5 : 0.12)] });
    if (/bat|night|vampire/.test(style)) {
      add('wings', 'extrude', [S * 1.1, H * 0.4, 0.02], [0, H * 0.6, -S * 0.14], { profile: BAT, color: acc });
      for (const s of [-1, 1]) add(`ear ${s}`, 'cone', [S * 0.05, H * 0.06, S * 0.05], [s * S * 0.06, H * 0.91, 0], { radius: 0.001 });
    } else if (/hero|cape|super/.test(style)) {
      add('cape', 'extrude', [S * 0.48, H * 0.62, 0.015], [0, H * 0.5, -S * 0.14], { profile: [[-0.36, 1], [0.36, 1], [0.5, 0], [-0.5, 0]], color: acc });
      add('emblem', 'extrude', [S * 0.12, S * 0.12, 0.01], [0, H * 0.64, S * 0.13], { profile: presetProfile('star'), color: '#f2c94c' }, 'plastic');
    }
    if (princess || /crown|king|queen/.test(style)) add('crown', 'extrude', [S * 0.18, H * 0.06, S * 0.18], [0, H * 0.92, 0], { profile: presetProfile('crown'), color: '#d4af37' }, 'brass');
  }
  return parts;
}

export const DECOR_KITS = { poster, sign, banner, wallshelf: wallShelf, clock, neon, statue } as const;
export type DecorKit = keyof typeof DECOR_KITS;
