// Colour words and design themes, read deterministically from the request so the object comes out
// in the colours the person named (and a themed request gets its whole look), whatever the model does.

import type { MaterialId } from '../../core/types';

/** Colour words to clear, true hex values. Longest phrases are matched first. */
export const COLOR_WORDS: Record<string, string> = {
  'hot pink': '#e0218a', 'barbie pink': '#e0218a', magenta: '#d81b7a', fuchsia: '#d81b7a', 'bubblegum pink': '#ff7eb9', 'baby pink': '#f8c8dc',
  'pastel pink': '#f6c6d6', 'light pink': '#ffb6d5', 'dusty pink': '#d8a1a8', 'dusty rose': '#c98b8f', blush: '#f4c2c9', rose: '#e8879c', pink: '#f27cb0',
  red: '#c62828', crimson: '#b0122b', scarlet: '#d0241d', burgundy: '#7a1f2b', wine: '#6e1f2e', 'racing red': '#d0021b',
  orange: '#e8742a', terracotta: '#c4633f', rust: '#a8482a', coral: '#f27c6a', peach: '#f6b38f', amber: '#e6a020',
  yellow: '#f2c230', mustard: '#d4a017', ochre: '#c88a1c', lemon: '#f5e050', gold: '#c9a24c', golden: '#c9a24c',
  'forest green': '#2f5233', 'emerald green': '#1f6f50', emerald: '#1f6f50', 'bottle green': '#1e4d36', 'dark green': '#2d4a34', 'olive green': '#6b7a3a',
  olive: '#6b7a3a', sage: '#9caf88', 'sage green': '#9caf88', mint: '#a8e0c8', 'lime green': '#8bc34a', lime: '#8bc34a', teal: '#1f7a7a', green: '#3f7d4e',
  turquoise: '#2bb3b1', aqua: '#4fc3c8', 'sky blue': '#8ec5ea', 'baby blue': '#a9d4f0', 'light blue': '#a9cbe8', 'powder blue': '#b5cfe3',
  'royal blue': '#2848a8', 'cobalt blue': '#1f4fb4', cobalt: '#1f4fb4', navy: '#1f2d4d', 'navy blue': '#1f2d4d', 'dark blue': '#1f3460', blue: '#2f5fa7',
  purple: '#6b3fa0', violet: '#7d4fb3', plum: '#6a2e5a', lilac: '#c4a8db', lavender: '#b9a3d6', mauve: '#b08aa6',
  brown: '#6e4a32', chocolate: '#4e3021', cognac: '#9a5b34', caramel: '#b9783f', tan: '#c8a27a', camel: '#c19a6b', taupe: '#8b7d6b',
  beige: '#d9c8a9', sand: '#d8c7a4', cream: '#f1e8d3', ivory: '#f6f1e3', 'off-white': '#f1eee6', 'off white': '#f1eee6',
  white: '#f4f2ee', black: '#1e1e1e', 'matte black': '#222222', charcoal: '#3a3d42', 'dark grey': '#4a4e54', 'dark gray': '#4a4e54',
  'light grey': '#c9cbcd', 'light gray': '#c9cbcd', grey: '#8a8f96', gray: '#8a8f96', silver: '#c0c4c9', graphite: '#40444b',
  // Swedish
  rosa: '#f27cb0', röd: '#c62828', röda: '#c62828', rött: '#c62828', svart: '#1e1e1e', svarta: '#1e1e1e', vit: '#f4f2ee', vita: '#f4f2ee', vitt: '#f4f2ee',
  grön: '#3f7d4e', gröna: '#3f7d4e', blå: '#2f5fa7', blåa: '#2f5fa7', gul: '#f2c230', gula: '#f2c230', grå: '#8a8f96', grått: '#8a8f96',
  brun: '#6e4a32', bruna: '#6e4a32', lila: '#6b3fa0',
};

const COLOR_KEYS = Object.keys(COLOR_WORDS).sort((a, b) => b.length - a.length);

export interface ColorHit { word: string; hex: string }

/** Colour phrases in order of appearance (each colour once). Words used up by a longer phrase are skipped. */
export function findColors(text: string): ColorHit[] {
  let t = ` ${text.toLowerCase()} `;
  const hits: Array<ColorHit & { at: number }> = [];
  for (const k of COLOR_KEYS) {
    const re = new RegExp(`(^|[^a-zåäö])${k.replace(/[-]/g, '[- ]')}(?![a-zåäö])`);
    const m = re.exec(t);
    if (!m) continue;
    const hex = COLOR_WORDS[k];
    if (!hits.some((h) => h.hex === hex)) hits.push({ word: k, hex, at: m.index });
    t = t.slice(0, m.index + 1) + ' '.repeat(m[0].length - 1) + t.slice(m.index + m[0].length);
  }
  return hits.sort((a, b) => a.at - b.at).map(({ word, hex }) => ({ word, hex }));
}

export interface Theme {
  id: string;
  /** What the model is told: palette, materials and signature details. */
  brief: string;
  /** Main colours, most dominant first. */
  palette: string[];
  /** Materials that carry the theme. */
  materials?: MaterialId[];
}

export const THEMES: Array<[RegExp, Theme]> = [
  [/\bbarbie|dream ?house|doll ?house\b/, { id: 'barbie', palette: ['#e0218a', '#ffffff', '#ff8fc7'], materials: ['plastic', 'velvet'], brief: 'Barbie: hot pink #e0218a dominant (frame, headboard, body), crisp white #ffffff trim, light pink #ff8fc7 accents, glossy lacquer (plastic material with the colour), hearts, scallops and gold details; a bed gets a white canopy with pink drapes and a heart headboard. Fun, bold, toy-like proportions, nothing beige.' }],
  [/\bprincess|fairy ?tale|royal\b/, { id: 'princess', palette: ['#f4a6c6', '#fff4f8', '#c9a24c'], materials: ['velvet', 'linen', 'brass'], brief: 'Princess: blush pink #f4a6c6 and white #fff4f8 with gold, a canopy with drapes, arched or crown headboard, scallops and finials.' }],
  [/\bindustrial|loft|factory\b/, { id: 'industrial', palette: ['#1c1c1e', '#a0703f'], materials: ['black-metal', 'oak'], brief: 'Industrial: black metal #1c1c1e frame (square tube, visible joints) with warm oak or reclaimed wood, no ornament.' }],
  [/\bscandi|scandinavian|nordic|ikea\b/, { id: 'scandi', palette: ['#e3cfae', '#f4f2ee', '#b8bcc0'], materials: ['birch', 'oak', 'white-laminate', 'wool'], brief: 'Scandinavian: light birch or oak, white, light grey wool, slim tapered legs, soft rounded edges, calm and simple.' }],
  [/\bmid-?century|retro|60s|sixties|eames\b/, { id: 'midcentury', palette: ['#6e4a32', '#d4a017', '#1f7a7a'], materials: ['walnut', 'leather', 'velvet'], brief: 'Mid-century: walnut with mustard #d4a017 or teal #1f7a7a upholstery, splayed tapered legs, low and long, rounded corners.' }],
  [/\bjapandi|japanese|zen|wabi\b/, { id: 'japandi', palette: ['#c8a27a', '#1e1e1e', '#e9e2d3'], materials: ['oak', 'linen', 'black-metal'], brief: 'Japandi: low, light oak, black accents, linen, clean slats, very little ornament.' }],
  [/\bboho|bohemian|rattan|wicker\b/, { id: 'boho', palette: ['#c7a06a', '#f1e8d3', '#c4633f'], materials: ['rattan', 'linen', 'pine'], brief: 'Boho: rattan and cane, cream linen, terracotta accents, rounded organic shapes.' }],
  [/\bart ?deco|gatsby|deco\b/, { id: 'deco', palette: ['#1f6f50', '#c9a24c', '#1e1e1e'], materials: ['velvet', 'brass', 'marble'], brief: 'Art deco: emerald #1f6f50 or navy velvet, brass trim, black lacquer, fluting, curves and fan or shell shapes.' }],
  [/\bfarmhouse|rustic|cottage|country\b/, { id: 'farmhouse', palette: ['#d8b47f', '#f4f2ee', '#6e4a32'], materials: ['pine', 'oak', 'white-laminate'], brief: 'Farmhouse: chunky pine or oak, painted white parts, turned legs, plank tops, iron cup pulls.' }],
  [/\bcoastal|beach|nautical|hampton\b/, { id: 'coastal', palette: ['#f4f2ee', '#a9cbe8', '#d8c7a4'], materials: ['white-laminate', 'linen', 'rattan'], brief: 'Coastal: white, sand and soft blue, light woods, rattan, relaxed linen.' }],
  [/\bgaming|gamer|esports|racing\b/, { id: 'gaming', palette: ['#1e1e1e', '#d0021b'], materials: ['leather', 'plastic', 'black-metal'], brief: 'Gaming: black with one bold accent colour in stripes and side panels, racing-seat bolsters, aggressive angular shapes, an LED strip in the accent colour.' }],
  [/\bkids?|children|child|toddler|nursery|playroom\b/, { id: 'kids', palette: ['#f2c230', '#2f5fa7', '#e8742a'], materials: ['plastic', 'birch'], brief: 'Kids: rounded safe edges, cheerful bright colours, chunky friendly proportions, playful details.' }],
  [/\bluxury|luxurious|hotel|glam|opulent\b/, { id: 'luxury', palette: ['#ebe8e3', '#c9a24c', '#2f2f2f'], materials: ['marble', 'brass', 'velvet'], brief: 'Luxury: marble, brass trim, deep velvet, generous proportions, refined details.' }],
  [/\bvictorian|antique|baroque|classic|chesterfield\b/, { id: 'classic', palette: ['#4e3021', '#7a1f2b', '#c9a24c'], materials: ['walnut', 'leather', 'velvet', 'brass'], brief: 'Classic: dark carved wood, button tufting, turned or cabriole legs, oxblood or burgundy leather or velvet, brass studs.' }],
  [/\bhospital|medical|clinic|care\b/, { id: 'medical', palette: ['#f4f2ee', '#c9cbcd', '#4fa3c8'], materials: ['white-laminate', 'steel', 'plastic'], brief: 'Medical: white and light grey, steel side rails, castors, controls, wipe-clean surfaces.' }],
  [/\barcade|retro game|pinball|jukebox\b/, { id: 'arcade', palette: ['#1e1e1e', '#7d4fb3', '#2bb3b1'], materials: ['black-laminate', 'plastic'], brief: 'Arcade: black cabinet with neon purple and cyan side art stripes, glowing screen and marquee, joystick and buttons.' }],
  [/\bminimal|minimalist|modern\b/, { id: 'minimal', palette: ['#f4f2ee', '#1e1e1e', '#c8a27a'], materials: ['white-laminate', 'oak', 'black-metal'], brief: 'Modern minimal: clean planes, thin profiles, few materials, hidden handles.' }],
];

export function findTheme(text: string): Theme | undefined {
  const t = text.toLowerCase();
  for (const [re, th] of THEMES) if (re.test(t)) return th;
  return undefined;
}

// ---- colour math ---------------------------------------------------------------------------

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', '').padEnd(6, '0').slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** CIE76 distance in Lab space (0 identical, ~2 just noticeable, >25 clearly different colours). */
export function colorDistance(a: string, b: string): number {
  const lab = (hex: string) => {
    const [r, g, bl] = hexToRgb(hex).map((c) => { const v = c / 255; return v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92; });
    const x = (r * 0.4124 + g * 0.3576 + bl * 0.1805) / 0.95047, y = r * 0.2126 + g * 0.7152 + bl * 0.0722, z = (r * 0.0193 + g * 0.1192 + bl * 0.9505) / 1.08883;
    const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
  };
  const p = lab(a), q = lab(b);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}
