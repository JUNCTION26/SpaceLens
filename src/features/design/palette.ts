// Eight agreed room styles. A furnished room takes one of them, so every piece shares one wood
// tone, a matched fabric family, one accent, one metal finish and one rug tone.
import type { FurnitureItem, MaterialId } from '../../core/types';

export type StyleId = 'scandinavian' | 'japandi' | 'walnut' | 'white' | 'sage' | 'industrial' | 'kids' | 'cabin';

export interface Tone { color: string; material: MaterialId }
export interface RoomStyle {
  id: StyleId;
  name: string;
  wood: Tone;
  fabric: Tone;
  accent: Tone;
  metal: Tone;
  rug: Tone;
  /** Shelving is made of the metal finish (black metal frames with oak). */
  metalShelving?: boolean;
  /** Words in a request that choose this style. */
  words: RegExp;
}

export const STYLES: Record<StyleId, RoomStyle> = {
  scandinavian: {
    id: 'scandinavian', name: 'Scandinavian light oak', words: /scandi|nordic|light oak/,
    wood: { color: '#cfae80', material: 'oak' }, fabric: { color: '#dcd6ca', material: 'linen' }, accent: { color: '#7d93a3', material: 'fabric' },
    metal: { color: '#c9ccd0', material: 'steel' }, rug: { color: '#e4ded2', material: 'wool' },
  },
  japandi: {
    id: 'japandi', name: 'Japandi', words: /japandi|japanese|zen|wabi/,
    wood: { color: '#b89a74', material: 'oak' }, fabric: { color: '#d3c9b8', material: 'linen' }, accent: { color: '#5d6657', material: 'linen' },
    metal: { color: '#2a2a2c', material: 'black-metal' }, rug: { color: '#cfc5b3', material: 'wool' },
  },
  walnut: {
    id: 'walnut', name: 'Warm modern walnut', words: /walnut|warm modern|mid[- ]?century|modern warm/,
    wood: { color: '#7a5a43', material: 'walnut' }, fabric: { color: '#c9bba6', material: 'fabric' }, accent: { color: '#7f8f6e', material: 'velvet' },
    metal: { color: '#c9a24c', material: 'brass' }, rug: { color: '#d6c9b3', material: 'wool' },
  },
  white: {
    id: 'white', name: 'Soft minimal white', words: /minimal|white|clean|bright/,
    wood: { color: '#e6d9c3', material: 'birch' }, fabric: { color: '#ece8e0', material: 'linen' }, accent: { color: '#b9c3c8', material: 'linen' },
    metal: { color: '#eceef1', material: 'chrome' }, rug: { color: '#efeae0', material: 'wool' },
  },
  sage: {
    id: 'sage', name: 'Sage and natural', words: /sage|natural|botanic|green|earthy|organic/,
    wood: { color: '#c4a77c', material: 'oak' }, fabric: { color: '#a9b49a', material: 'linen' }, accent: { color: '#6f8a66', material: 'velvet' },
    metal: { color: '#b9bdc3', material: 'steel' }, rug: { color: '#d9d1bd', material: 'wool' },
  },
  industrial: {
    id: 'industrial', name: 'Industrial light', words: /industrial|loft|factory|urban/,
    wood: { color: '#c39a6b', material: 'oak' }, fabric: { color: '#8f949a', material: 'fabric' }, accent: { color: '#3b3f46', material: 'fabric' },
    metal: { color: '#1c1c1e', material: 'black-metal' }, rug: { color: '#c9c6bf', material: 'wool' }, metalShelving: true,
  },
  kids: {
    id: 'kids', name: 'Kids playful pastel', words: /kid|child|nursery|baby|toddler|playful|pastel|playroom/,
    wood: { color: '#e3cfae', material: 'birch' }, fabric: { color: '#cfe0e8', material: 'fabric' }, accent: { color: '#f2c6cf', material: 'fabric' },
    metal: { color: '#eceef1', material: 'chrome' }, rug: { color: '#f3e6b8', material: 'wool' },
  },
  cabin: {
    id: 'cabin', name: 'Cosy cabin', words: /cabin|cosy|cozy|cottage|chalet|rustic|lodge/,
    wood: { color: '#c79a62', material: 'pine' }, fabric: { color: '#b9ab94', material: 'wool' }, accent: { color: '#7a4f4a', material: 'wool' },
    metal: { color: '#2a2a2c', material: 'black-metal' }, rug: { color: '#cbbba0', material: 'wool' },
  },
};

export const STYLE_IDS = Object.keys(STYLES) as StyleId[];

/** What a room is for decides its style when the request names none. */
const USE: Array<[RegExp, StyleId]> = [
  [/nurser|kid|child|baby|toddler|playroom/, 'kids'],
  [/office|study|work|studio|desk/, 'industrial'],
  [/bed|sleep|guest/, 'japandi'],
  [/dining|kitchen|eat/, 'walnut'],
  [/hall|entry|bath|laundry/, 'white'],
  [/living|lounge|family/, 'scandinavian'],
];

/** Style for a request: the words and theme first, then the room use, else Scandinavian. */
export function pickStyle(request = '', theme = '', use = ''): RoomStyle {
  const asked = `${request} ${theme}`.toLowerCase();
  for (const id of STYLE_IDS) if (STYLES[id].words.test(asked)) return STYLES[id];
  const u = `${use} ${request}`.toLowerCase();
  for (const [re, id] of USE) if (re.test(u)) return STYLES[id];
  return STYLES.scandinavian;
}

// ---- Guard: no rust, orange-brown metal or aged finishes ---------------------------------

function hsl(hex: string): { h: number; s: number; l: number } {
  const n = parseInt(hex.slice(1), 16), r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (!d) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s, l };
}

/** True for rust-like colours: saturated orange to red-brown, mid to dark. */
export function isRust(hex: string): boolean {
  const { h, s, l } = hsl(hex);
  return h >= 5 && h <= 38 && s >= 0.5 && l <= 0.55 && l >= 0.1;
}
export const FORBIDDEN_FINISH = /rust|corten|patina|aged|weathered|oxid|copper|bronze|distress/i;

// ---- Roles --------------------------------------------------------------------------------

export type Role = 'wood' | 'fabric' | 'accent' | 'metal' | 'rug' | 'shelving' | 'none';

const ROLE: Record<string, Role> = {
  bed: 'wood', 'bunk-bed': 'wood', crib: 'wood', desk: 'wood', table: 'wood', 'cafe-table': 'wood', 'coffee-table': 'wood', 'side-table': 'wood',
  dresser: 'wood', wardrobe: 'wood', nightstand: 'wood', 'tv-unit': 'wood', 'storage-cabinet': 'wood', chair: 'wood', stool: 'wood', bench: 'wood',
  counter: 'wood', 'kitchen-island': 'wood', 'reception-desk': 'wood', 'toy-storage': 'wood', bookshelf: 'shelving',
  sofa: 'fabric', 'sofa-bed': 'fabric', 'office-chair': 'fabric', 'room-divider': 'fabric',
  armchair: 'accent', 'toy-basket': 'accent',
  rug: 'rug', lamp: 'metal', 'filing-cabinet': 'metal',
};
const WOODISH = /oak|walnut|pine|birch|beech|ash|veneer|wood|laminate|mdf|plywood|^$/;
const WET_OR_APPLIANCE = /toilet|washbasin|basin|sink|shower|bath|fridge|dishwasher|stove|cooker|washing|dryer|mirror|vanity/;

export function roleOf(f: FurnitureItem): Role {
  if (f.owned || f.locked || f.custom || f.listing) return 'none';
  if (WET_OR_APPLIANCE.test(f.catalogId)) return 'none';
  const role = ROLE[f.category] ?? 'none';
  if ((role === 'wood' || role === 'shelving') && !WOODISH.test((f.material ?? '').toLowerCase())) return 'none';
  return role;
}

function tone(style: RoomStyle, role: Role): Tone | null {
  switch (role) {
    case 'wood': return style.wood;
    case 'shelving': return style.metalShelving ? style.metal : style.wood;
    case 'fabric': return style.fabric;
    case 'accent': return style.accent;
    case 'metal': return style.metal;
    case 'rug': return style.rug;
    default: return null;
  }
}

/** Colour and material for every placed piece, from one style. Pieces with no role are untouched. */
export function applyPalette<T extends FurnitureItem>(items: T[], style: RoomStyle): T[] {
  return items.map((f) => {
    const t = tone(style, roleOf(f));
    if (!t || isRust(t.color) || FORBIDDEN_FINISH.test(t.material)) return f;
    return { ...f, color: t.color, material: t.material };
  });
}

/** Pick the style from the request and room use, then apply it. */
export function styleRoom<T extends FurnitureItem>(items: T[], request = '', theme = '', use = ''): T[] {
  return applyPalette(items, pickStyle(request, theme, use));
}
