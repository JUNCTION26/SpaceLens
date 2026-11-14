import { findByKeyword } from '../furniture/catalog';

export type VoiceAction = 'add' | 'resize' | 'move' | 'rotate' | 'delete' | 'undo';
export type VoiceWall = 'north' | 'south' | 'east' | 'west' | 'window' | 'door';

export interface SpokenCommand {
  action: VoiceAction;
  category: string;
  qty: number;
  catalogId?: string;
  /** Dimensions in metres. */
  w?: number; d?: number; h?: number;
  color?: string;
  wall?: VoiceWall;
}

const NUMS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20,
  ett: 1, två: 2, tre: 3, fyra: 4, fem: 5, sju: 7, åtta: 8, nio: 9, tio: 10, tjugo: 20,
};

const SWEDISH: Array<[RegExp, string]> = [
  [/skrivbord[a-zåäö]*/g, 'desk'], [/soffa[a-zåäö]*/g, 'sofa'], [/fåtölj[a-zåäö]*/g, 'armchair'], [/säng[a-zåäö]*/g, 'bed'],
  [/(^|\s)stol(ar|en|arna)?(?=\s)/g, '$1chair'], [/(^|\s)bord(et|en)?(?=\s)/g, '$1table'], [/matta[a-zåäö]*/g, 'rug'],
  [/bokhylla[a-zåäö]*/g, 'bookshelf'], [/garderob[a-zåäö]*/g, 'wardrobe'], [/lampa[a-zåäö]*/g, 'lamp'], [/växt[a-zåäö]*/g, 'plant'],
];

export const COLORS: Record<string, string> = {
  grey: '#8a8f96', gray: '#8a8f96', grå: '#8a8f96', black: '#2f2f2f', svart: '#2f2f2f', white: '#f2efe9', vit: '#f2efe9',
  beige: '#d6c7ad', brown: '#6e4f36', brun: '#6e4f36', blue: '#4a6a8f', blå: '#4a6a8f', green: '#4f6b55', grön: '#4f6b55',
  red: '#8c3b3b', röd: '#8c3b3b', yellow: '#d9b84a', gul: '#d9b84a', oak: '#b08a5a', walnut: '#6e4f36',
  birch: '#d8c7a8', björk: '#d8c7a8', pink: '#d9a0a8', rosa: '#d9a0a8', navy: '#2f3f5f',
};

/** Hex for a colour word, or the value itself if it already looks like a colour. */
export const colorHex = (c: string) => COLORS[c.toLowerCase()] ?? (/^#[0-9a-f]{3,8}$/i.test(c) ? c : undefined);

export const dimOk = (m: number | undefined): m is number => typeof m === 'number' && Number.isFinite(m) && m >= 0.2 && m <= 4;

const ACTIONS: VoiceAction[] = ['add', 'resize', 'move', 'rotate', 'delete', 'undo'];
const WALLS: VoiceWall[] = ['north', 'south', 'east', 'west', 'window', 'door'];

/** Keep only fields that make sense; dims outside 0.2..4 m are dropped. */
export function validate(c: Partial<SpokenCommand> | null | undefined): SpokenCommand | null {
  if (!c || typeof c !== 'object' || !c.action || !ACTIONS.includes(c.action)) return null;
  if (c.action === 'undo') return { action: 'undo', category: '', qty: 1 };
  const out: SpokenCommand = {
    action: c.action, category: typeof c.category === 'string' ? c.category.toLowerCase().trim() : '',
    qty: Math.min(20, Math.max(1, Math.round(Number(c.qty) || 1))),
  };
  if (typeof c.catalogId === 'string' && c.catalogId) out.catalogId = c.catalogId;
  for (const k of ['w', 'd', 'h'] as const) { const v = c[k]; if (dimOk(v)) out[k] = Math.round(v * 1000) / 1000; }
  if (typeof c.color === 'string' && c.color) out.color = c.color.toLowerCase();
  if (c.wall && WALLS.includes(c.wall)) out.wall = c.wall;
  return out.category ? out : null;
}

export function fieldCount(c: SpokenCommand | null): number {
  if (!c) return 0;
  return (['category', 'w', 'd', 'h', 'color', 'wall'] as const).filter((k) => c[k] !== undefined && c[k] !== '').length + (c.qty > 1 ? 1 : 0);
}

function toMetres(v: number, unit: string | undefined): number {
  if (unit) {
    if (/^(mm|millimet)/.test(unit)) return v / 1000;
    if (/^(cm|centimet)/.test(unit)) return v / 100;
    return v;
  }
  return v >= 5 ? v / 100 : v; // bare numbers: 210 -> cm, 1.6 -> m
}

/** Deterministic rule-based parser for spoken furniture commands (English + basic Swedish). */
export function parseSpoken(text: string): SpokenCommand | null {
  let t = ` ${text.toLowerCase().replace(/[!?;,](\s|$)/g, ' ').replace(/\.(\s|$)/g, ' ').replace(/(\d),(\d)/g, '$1.$2')} `;
  t = t.replace(/(\d)\s*[×x*]\s*(?=\d)/g, '$1 by ').replace(/(\d)(cm|mm|m)(?=\s)/g, '$1 $2');
  for (const [re, en] of SWEDISH) t = t.replace(re, en);
  t = t.replace(/[a-zåäö]+/g, (w) => (w in NUMS ? String(NUMS[w]) : w)).replace(/\s+/g, ' ');

  if (/\b(undo|ångra)\b/.test(t)) return { action: 'undo', category: '', qty: 1 };
  let action: VoiceAction = 'add';
  if (/\b(delete|remove|ta bort|radera|get rid of)\b/.test(t)) action = 'delete';
  else if (/\b(rotate|turn|spin|vrid|rotera|snurra)\b/.test(t)) action = 'rotate';
  else if (/\b(move|shift|slide|flytta)\b/.test(t)) action = 'move';
  else if (/\b(make|resize|change|set|gör|ändra)\b/.test(t)) action = 'resize';

  const entry = findByKeyword(t);
  if (!entry) return null;
  // The furniture word splits quantity (before) from dimensions (after).
  const kw = t.search(/\b(chair|sofa|couch|desk|bed|table|rug|carpet|lamp|plant|shel|book|wardrobe|closet|armchair|stool|bench|dresser|cabinet|sideboard|nightstand|crib|tv)/);
  const kwPos = kw < 0 ? t.length : kw;

  let qty = 1;
  const dims: Array<{ v: number; tag?: 'w' | 'd' | 'h' }> = [];
  const re = /(\d+(?:\.\d+)?)\s*(mm|millimet[a-z]*|cm|centimet[a-z]*|met(?:re|er)s?|m)?(?![a-z0-9.])(?:\s+(wide|width|bred|broad|long|deep|depth|djup|high|tall|height|hög))?/g;
  for (let m: RegExpExecArray | null; (m = re.exec(t)); ) {
    const v = parseFloat(m[1]);
    if (m.index < kwPos && !m[2] && !m[3] && Number.isInteger(v) && v >= 1 && v <= 20) { qty = v; continue; }
    const tag = m[3] ? (/^(deep|depth|djup)/.test(m[3]) ? 'd' : /^(high|tall|height|hög)/.test(m[3]) ? 'h' : 'w') : undefined;
    dims.push({ v: toMetres(v, m[2]), tag });
  }
  const out: Partial<SpokenCommand> = { action, category: entry.category, catalogId: entry.id, qty };
  const order = ['w', 'd', 'h'] as const;
  for (const dm of dims) if (dm.tag && out[dm.tag] === undefined) out[dm.tag] = dm.v;
  for (const dm of dims) if (!dm.tag) { const k = order.find((o) => out[o] === undefined); if (k) out[k] = dm.v; }

  const color = Object.keys(COLORS).find((c) => new RegExp(`(^|\\s)${c}(?=\\s)`).test(t));
  if (color) out.color = color;

  if (/(window|fönster)/.test(t)) out.wall = 'window';
  else if (/(door|dörr)/.test(t)) out.wall = 'door';
  else if (/\b(north|norr|back|far|top)\b/.test(t)) out.wall = 'north';
  else if (/\b(south|söder|front|bottom)\b/.test(t)) out.wall = 'south';
  else if (/\b(east|öster|right|höger)\b/.test(t)) out.wall = 'east';
  else if (/\b(west|väster|left|vänster)\b/.test(t)) out.wall = 'west';
  if (out.wall && action === 'resize') out.action = 'move';
  return validate(out);
}
