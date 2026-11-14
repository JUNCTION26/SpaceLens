// Deterministic reading of an object request ("walnut desk 160 by 80 with drawers on the right").
// Numbers the person said always win over anything a model proposes, so they are pulled out here
// without any model involved. English plus basic Swedish.

import type { MaterialId } from '../../core/types';
import { COLORS } from '../voice/parse';

export type TemplateId = 'desk' | 'table' | 'sofa' | 'chair' | 'bed' | 'shelf' | 'cabinet' | 'bench' | 'lamp' | 'rug';

export interface Kind {
  id: string;
  /** Category written to FurnitureItem / semantics (matches catalogue categories where one exists). */
  category: string;
  label: string;
  template: TemplateId;
  /** Default size in metres: w, d, h. */
  size: [number, number, number];
  en: string[];
  /** Swedish stems; matched inside compounds ("ekskrivbord"). */
  sv: string[];
}

// Most specific first: "coffee table" must win over "table", "skrivbord" over "bord".
export const KINDS: Kind[] = [
  { id: 'coffee-table', category: 'coffee-table', label: 'Coffee table', template: 'table', size: [1.1, 0.6, 0.42], en: ['coffee table', 'sofa table', 'lounge table'], sv: ['soffbord'] },
  { id: 'side-table', category: 'side-table', label: 'Side table', template: 'table', size: [0.5, 0.5, 0.55], en: ['side table', 'end table'], sv: ['sidobord', 'avlastningsbord'] },
  { id: 'nightstand', category: 'nightstand', label: 'Nightstand', template: 'cabinet', size: [0.45, 0.4, 0.55], en: ['nightstand', 'bedside table', 'bedside', 'night table'], sv: ['sängbord', 'nattduksbord'] },
  { id: 'tv-unit', category: 'tv-unit', label: 'TV bench', template: 'cabinet', size: [1.6, 0.4, 0.45], en: ['tv bench', 'tv unit', 'tv stand', 'media console', 'tv cabinet', 'media unit'], sv: ['tv-bänk', 'tvbänk', 'tv bänk', 'mediabänk'] },
  { id: 'desk-chair', category: 'office-chair', label: 'Desk chair', template: 'chair', size: [0.6, 0.6, 1.05], en: ['desk chair', 'office chair', 'task chair', 'gaming chair'], sv: ['kontorsstol', 'skrivbordsstol'] },
  { id: 'desk', category: 'desk', label: 'Desk', template: 'desk', size: [1.4, 0.7, 0.74], en: ['desk', 'workstation', 'writing table'], sv: ['skrivbord'] },
  { id: 'dining-table', category: 'table', label: 'Dining table', template: 'table', size: [1.6, 0.9, 0.75], en: ['dining table', 'kitchen table'], sv: ['matbord', 'köksbord'] },
  { id: 'bookshelf', category: 'bookshelf', label: 'Bookshelf', template: 'shelf', size: [0.8, 0.3, 1.8], en: ['bookshelf', 'bookcase', 'shelving unit', 'shelving', 'shelf', 'shelves', 'etagere'], sv: ['bokhylla', 'hylla'] },
  { id: 'wardrobe', category: 'wardrobe', label: 'Wardrobe', template: 'cabinet', size: [1.0, 0.6, 2.0], en: ['wardrobe', 'closet', 'armoire'], sv: ['garderob', 'klädskåp'] },
  { id: 'dresser', category: 'dresser', label: 'Chest of drawers', template: 'cabinet', size: [0.8, 0.48, 0.8], en: ['chest of drawers', 'dresser', 'commode', 'drawer unit'], sv: ['byrå'] },
  { id: 'sideboard', category: 'dresser', label: 'Sideboard', template: 'cabinet', size: [1.6, 0.45, 0.8], en: ['sideboard', 'credenza', 'buffet'], sv: ['skänk', 'sideboard'] },
  { id: 'cabinet', category: 'storage-cabinet', label: 'Cabinet', template: 'cabinet', size: [0.8, 0.45, 1.2], en: ['cabinet', 'cupboard', 'storage unit', 'locker'], sv: ['skåp', 'förvaring'] },
  { id: 'sofa', category: 'sofa', label: 'Sofa', template: 'sofa', size: [2.1, 0.92, 0.82], en: ['sofa', 'couch', 'settee', 'loveseat'], sv: ['soffa'] },
  { id: 'armchair', category: 'armchair', label: 'Armchair', template: 'sofa', size: [0.82, 0.84, 0.85], en: ['armchair', 'lounge chair', 'easy chair', 'reading chair'], sv: ['fåtölj'] },
  { id: 'stool', category: 'stool', label: 'Stool', template: 'chair', size: [0.4, 0.4, 0.65], en: ['bar stool', 'stool'], sv: ['barstol', 'pall'] },
  { id: 'chair', category: 'chair', label: 'Chair', template: 'chair', size: [0.46, 0.52, 0.82], en: ['dining chair', 'chair'], sv: ['stol'] },
  { id: 'wall-bed', category: 'bed', label: 'Wall bed', template: 'bed', size: [1.56, 0.45, 2.2], en: ['wall bed', 'murphy bed', 'fold-down bed', 'fold down bed', 'drop-down bed', 'drop down bed', 'pull-down bed', 'pull down bed', 'folding bed', 'cabinet bed'], sv: ['bäddskåp', 'väggsäng', 'fällsäng'] },
  { id: 'bed', category: 'bed', label: 'Bed', template: 'bed', size: [1.6, 2.1, 1.0], en: ['bed'], sv: ['säng'] },
  { id: 'bench', category: 'bench', label: 'Bench', template: 'bench', size: [1.2, 0.38, 0.45], en: ['bench'], sv: ['bänk'] },
  { id: 'lamp', category: 'lamp', label: 'Floor lamp', template: 'lamp', size: [0.4, 0.4, 1.6], en: ['floor lamp', 'standing lamp', 'reading lamp', 'lamp'], sv: ['golvlampa', 'lampa'] },
  { id: 'rug', category: 'rug', label: 'Rug', template: 'rug', size: [1.6, 2.3, 0.012], en: ['rug', 'carpet', 'mat'], sv: ['matta'] },
  { id: 'table', category: 'table', label: 'Table', template: 'table', size: [1.4, 0.8, 0.75], en: ['table'], sv: ['bord'] },
];

export const kindById = (id: string) => KINDS.find((k) => k.id === id);

const MATERIAL_WORDS: Array<[RegExp, MaterialId]> = [
  [/\b(black|matte black|svart|svarta) (metal|steel|iron|metall|stål)\b/, 'black-metal'],
  [/\b(white|vit|vita) (laminate|laminat|lacquer|lack)\b/, 'white-laminate'],
  [/\b(black|svart|svarta) (laminate|laminat|lacquer|lack)\b/, 'black-laminate'],
  [/\b(walnut|valnöt|valnöts)/, 'walnut'], [/\b(oak|oaken|ek|eke|ekfanér)\b|\bek(?=[a-zåäö]{3,})/, 'oak'], [/\b(pine|furu)/, 'pine'],
  [/\b(birch|björk)/, 'birch'], [/\b(marble|marmor)/, 'marble'], [/\b(glass|glas)\b/, 'glass'], [/\b(brass|mässing)/, 'brass'],
  [/\b(chrome|krom)/, 'chrome'], [/\b(steel|stål|stainless)/, 'steel'], [/\b(iron|metal|metall)\b/, 'black-metal'],
  [/\b(leather|läder|skinn)/, 'leather'], [/\b(velvet|sammet)/, 'velvet'], [/\b(linen|linne)\b/, 'linen'],
  [/\b(wool|ull|ylle)/, 'wool'], [/\b(fabric|textile|tyg|bouclé|boucle)/, 'fabric'], [/\b(concrete|betong)/, 'concrete'],
  [/\b(rattan|wicker|korg)/, 'rattan'], [/\b(ceramic|keramik)/, 'ceramic'], [/\b(plastic|plast)\b/, 'plastic'],
  [/\b(laminate|laminat)\b/, 'white-laminate'],
];

const FEATURE_WORDS: Array<[RegExp, string]> = [
  [/\b(drawers?|lådor|låda|lådan)\b/, 'drawers'], [/\b(shel(f|ves)|hyllplan|hyllor)\b/, 'shelf'], [/\b(doors?|dörrar|luckor|lucka)\b/, 'doors'],
  [/\b(arm ?rests?|armstöd|arms)\b/, 'armrests'], [/\b(headboard|sänggavel|huvudgavel)\b/, 'headboard'],
  [/\b(storage|förvaring)\b/, 'storage'], [/\b(hairpin)\b/, 'hairpin'], [/\b(pedestal|central leg|pelarfot)\b/, 'pedestal'],
  [/\b(open|öppen)\b/, 'open'], [/\b(cushions?|kuddar)\b/, 'cushions'], [/\b(back ?rest|ryggstöd|rygg)\b/, 'backrest'],
  [/\b(no back|backless|utan rygg)\b/, 'backless'], [/\b(chaise|divan|schäslong)\b/, 'chaise'], [/\b(glass doors?|glasdörrar)\b/, 'glass-doors'],
];

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  pair: 2, couple: 2,
  en: 1, ett: 1, två: 2, tre: 3, fyra: 4, fem: 5, sex: 6, sju: 7, åtta: 8, nio: 9, tio: 10, elva: 11, tolv: 12,
};
const NUM_WORD_RE = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|ett|två|tre|fyra|fem|sju|åtta|nio|tio|elva|tolv)\b/g;

export interface ParsedRequest {
  text: string;
  kind: Kind | null;
  /** Exact dimensions in metres, only what the person said. */
  w?: number; d?: number; h?: number;
  qty: number;
  /** "for six", "6-seater". */
  seats?: number;
  /** Colour words as said, plus hex. */
  colors: Array<{ word: string; hex: string }>;
  materials: MaterialId[];
  features: string[];
  side?: 'left' | 'right';
  round: boolean;
  low: boolean;
  tall: boolean;
}

/** Bare numbers: under 5 is metres, up to 500 centimetres, above that millimetres. */
function toM(v: number, unit?: string): number {
  if (unit) {
    if (/^mm|^millim/.test(unit)) return v / 1000;
    if (/^cm|^centim/.test(unit)) return v / 100;
    if (/^dm/.test(unit)) return v / 10;
    return v;
  }
  return v < 5 ? v : v <= 500 ? v / 100 : v / 1000;
}

const UNIT = '(mm|millimet(?:er|re)s?|cm|centimet(?:er|re)s?|dm|met(?:er|re)s?|m)';
const NUM = '(\\d+(?:\\.\\d+)?)';
const TAG_AFTER = '(wide|width|broad|long|length|deep|depth|high|height|tall|in diameter|diameter|across|bred|bredd|lång|längd|djup|hög|höjd|i diameter)';
const TAG_BEFORE = '(width|length|depth|height|diameter|ø|bredd|längd|djup|höjd|diameter)';

function tagOf(word: string | undefined, kind: Kind | null): 'w' | 'd' | 'h' | 'dia' | undefined {
  if (!word) return undefined;
  if (/^(deep|depth|djup)/.test(word)) return 'd';
  if (/^(high|height|tall|hög|höjd)/.test(word)) return 'h';
  if (/diameter|across|^ø/.test(word)) return 'dia';
  // "long" is the depth of a bed or rug, otherwise the width.
  if (/^(long|length|lång|längd)/.test(word)) return kind && (kind.template === 'bed' || kind.template === 'rug') ? 'd' : 'w';
  return 'w';
}

export function normalizeText(text: string): string {
  let t = ` ${text.toLowerCase()} `;
  t = t.replace(/(\d),(\d)/g, '$1.$2').replace(/[!?;,()"]/g, ' ').replace(/\.(\s|$)/g, ' ');
  t = t.replace(/(\d)\s*(?:[×x*]|times|gånger|by|på)\s*(?=\d)/g, '$1 by ');
  t = t.replace(/(\d)(mm|cm|dm|m)\b/g, '$1 $2').replace(/ø\s*(\d)/g, 'diameter $1');
  return t.replace(/\s+/g, ' ');
}

export function findKind(t: string): Kind | null {
  for (const k of KINDS) {
    for (const w of k.en) if (new RegExp(`(^|[^a-zåäö])${w}(s|es)?(?![a-zåäö])`).test(t)) return k; // ordered by specificity
  }
  // Swedish compounds: the longest stem found wins ("skrivbordsstol" over "skrivbord" over "bord").
  let best: { k: Kind; len: number } | null = null;
  for (const k of KINDS) for (const w of k.sv) if (t.includes(w) && (!best || w.length > best.len)) best = { k, len: w.length };
  return best?.k ?? null;
}

export function parseRequest(text: string): ParsedRequest {
  let t = normalizeText(text);
  const kind = findKind(t);
  const out: ParsedRequest = { text, kind, qty: 1, colors: [], materials: [], features: [], round: false, low: false, tall: false };

  // Seats: "for six", "6-seater", "seats 8", "för sex personer".
  const seatRe = /\b(?:for|seats|seating|för)\s+(\d+|[a-zåäö]+)(?:\s+(?:people|persons|personer|guests))?\b|\b(\d+|[a-zåäö]+)[- ]?(?:seater|seat|sits|sitsig)\b/;
  const sm = seatRe.exec(t);
  if (sm) {
    const raw = sm[1] ?? sm[2];
    const n = /^\d+$/.test(raw) ? parseInt(raw, 10) : NUMBER_WORDS[raw];
    if (n && n >= 1 && n <= 16) { out.seats = n; t = t.replace(sm[0], ' '); }
  }
  t = t.replace(NUM_WORD_RE, (w) => String(NUMBER_WORDS[w]));

  const dims: { w?: number; d?: number; h?: number; dia?: number } = {};
  const loose: number[] = [];
  const put = (tag: 'w' | 'd' | 'h' | 'dia' | undefined, v: number) => {
    if (!(v > 0.005 && v < 12)) return;
    if (tag && dims[tag] === undefined) dims[tag] = v; else loose.push(v);
  };

  // Chains: "160 by 80 by 75 cm" (one trailing unit applies to all).
  const chainRe = new RegExp(`${NUM}\\s*${UNIT}?((?:\\s+by\\s+${NUM}\\s*${UNIT}?)+)(?![a-zåäö])`, 'g');
  t = t.replace(chainRe, (all: string) => {
    const parts = [...all.matchAll(new RegExp(`${NUM}\\s*${UNIT}?(?![a-zåäö])`, 'g'))];
    const lastUnit = [...parts].reverse().find((p) => p[2])?.[2];
    const vals = parts.map((p) => toM(parseFloat(p[1]), p[2] ?? lastUnit));
    const order: Array<'w' | 'd' | 'h'> = ['w', 'd', 'h'];
    vals.slice(0, 3).forEach((v, i) => put(order[i], v));
    return ' ';
  });

  // Tagged before: "height 75 cm", "diameter 120".
  t = t.replace(new RegExp(`\\b${TAG_BEFORE}\\s*(?:of\\s+|på\\s+|:\\s*)?${NUM}\\s*${UNIT}?(?![a-zåäö])`, 'g'), (_a, tag: string, n: string, u?: string) => {
    put(tagOf(tag, kind), toM(parseFloat(n), u)); return ' ';
  });
  // Tagged after or bare: "2.4 m wide", "75 high", "180".
  const qtyEnd = kind ? Math.max(0, t.search(new RegExp(kind.en.concat(kind.sv).map((w) => w.replace(/[-]/g, '\\-')).join('|')))) : -1;
  const singleRe = new RegExp(`${NUM}\\s*${UNIT}?(?![a-zåäö\\d.])(?:\\s+${TAG_AFTER}(?![a-zåäö]))?`, 'g');
  for (let m: RegExpExecArray | null; (m = singleRe.exec(t)); ) {
    const v = parseFloat(m[1]);
    if (!m[2] && !m[3] && qtyEnd >= 0 && m.index < qtyEnd && Number.isInteger(v) && v >= 1 && v <= 20) { out.qty = v; continue; }
    put(tagOf(m[3], kind), toM(v, m[2]));
  }

  out.round = /\b(round|circular|rund|runda|runt|cirkel|oval)\b/.test(t) || dims.dia !== undefined;
  if (dims.dia !== undefined) { dims.w ??= dims.dia; dims.d ??= dims.dia; }
  const order: Array<'w' | 'd' | 'h'> = ['w', 'd', 'h'];
  for (const v of loose) { const k = order.find((o) => dims[o] === undefined); if (k) dims[k] = v; }
  // A single number on a round thing is its diameter.
  if (out.round && dims.w !== undefined && dims.d === undefined) dims.d = dims.w;
  if (dims.w !== undefined) out.w = round3(dims.w);
  if (dims.d !== undefined) out.d = round3(dims.d);
  if (dims.h !== undefined) out.h = round3(dims.h);

  const seen = new Set<string>();
  for (const [re, id] of MATERIAL_WORDS) {
    const m = re.exec(t);
    if (m && !out.materials.includes(id)) { out.materials.push(id); m[0].split(' ').forEach((w) => seen.add(w)); }
  }
  for (const word of Object.keys(COLORS)) {
    if (['oak', 'walnut', 'birch', 'björk'].includes(word)) continue; // materials, not colours
    if (new RegExp(`(^|[^a-zåäö])${word}(a|t)?(?![a-zåäö])`).test(t) && !out.colors.some((c) => c.hex === COLORS[word])) {
      // "black metal legs" names a material; still keep black as the colour hint only if not used up.
      if (seen.has(word) && out.materials.some((m) => m.startsWith('black') || m.startsWith('white'))) continue;
      out.colors.push({ word, hex: COLORS[word] });
    }
  }
  for (const [re, f] of FEATURE_WORDS) if (re.test(t)) out.features.push(f);
  if (/\b(right|höger|högra)\b/.test(t)) out.side = 'right';
  else if (/\b(left|vänster|vänstra)\b/.test(t)) out.side = 'left';
  out.low = /\b(low|lågt?|låga|squat)\b/.test(t);
  out.tall = /\b(tall|high|hög|höga|högt)\b/.test(t) && out.h === undefined;
  return out;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** Table size for a number of diners (about 60 cm of edge per person). */
export function tableSizeForSeats(seats: number, round: boolean): { w: number; d: number } {
  if (round) { const dia = seats <= 2 ? 0.7 : seats <= 4 ? 1.05 : seats <= 6 ? 1.3 : seats <= 8 ? 1.5 : 1.8; return { w: dia, d: dia }; }
  if (seats <= 2) return { w: 0.75, d: 0.75 };
  if (seats <= 4) return { w: 1.2, d: 0.8 };
  const perSide = Math.ceil((seats - 2) / 2);
  return { w: Math.round((perSide * 0.6 + 0.0) * 100) / 100 + (seats > 8 ? 0.2 : 0), d: seats >= 8 ? 1.0 : 0.9 };
}

/** Full target size: what the person said, then seats/shape rules, then the kind's defaults. */
export function resolveSize(p: ParsedRequest, fallback?: { w: number; d: number; h: number }): { w: number; d: number; h: number } {
  const k = p.kind;
  const base = fallback ?? (k ? { w: k.size[0], d: k.size[1], h: k.size[2] } : { w: 0.8, d: 0.5, h: 0.75 });
  let { w, d, h } = base;
  if (!fallback && p.seats && k && k.template === 'table') ({ w, d } = tableSizeForSeats(p.seats, p.round));
  if (!fallback && p.seats && k && k.template === 'sofa' && k.id === 'sofa') w = Math.max(1.4, p.seats * 0.65 + 0.3);
  if (!fallback && p.round && k && (k.template === 'table' || k.template === 'rug')) { const m = Math.max(w, d) > 1.6 && k.template === 'table' ? 1.2 : Math.min(w, d); w = d = m; }
  if (!fallback && p.low && k) h = round3(h * (k.template === 'cabinet' || k.template === 'shelf' ? 0.55 : 0.8));
  if (!fallback && p.tall && k && (k.template === 'shelf' || k.template === 'cabinet' || k.template === 'lamp')) h = round3(Math.max(h, k.template === 'lamp' ? 1.8 : 2.0));
  if (p.w !== undefined) w = p.w;
  if (p.d !== undefined) d = p.d;
  if (p.h !== undefined) h = p.h;
  if (p.round && p.w !== undefined && p.d === undefined) d = p.w;
  return { w, d, h };
}

const VERB = /^\s*(?:please\s+|can you\s+|could you\s+|kan du\s+)?(add|create|make|build|design|generate|forge|place|put|insert|i want|i need|i'd like|give me|lägg till|lägg in|skapa|gör|bygg|ställ|sätt in|jag vill ha)\b/i;

/** The command asks for a new object ("add/create/make a ..."), not a change to an existing one. */
export function isCreateCommand(text: string): boolean {
  const t = text.toLowerCase().trim();
  if (!VERB.test(t)) return false;
  // "make it wider", "make the sofa bigger" are edits.
  return !/^\s*(?:please\s+)?(make|gör)\s+(it|the|that|this|them|den|det|dem|soffan|bordet)\b/.test(t);
}

/** Detail a catalogue pick cannot honour: materials, features, shape, seats, or an object not in the catalogue. */
export function hasCustomDetail(p: ParsedRequest): boolean {
  return p.materials.length > 0 || p.features.length > 0 || p.round || !!p.seats || p.low || p.tall || !p.kind
    || (p.kind !== null && ['coffee-table', 'side-table', 'tv-unit', 'sideboard', 'dining-table', 'stool'].includes(p.kind.id) && (p.w !== undefined || p.h !== undefined));
}

/** Human title from the parsed words: "Walnut desk". */
export function titleFor(p: ParsedRequest): string {
  const mat = p.materials[0];
  const adj = mat ? mat.replace('-', ' ') : p.colors[0]?.word;
  const noun = p.kind?.label ?? 'Object';
  const shape = p.round && p.kind?.template === 'table' ? 'round ' : '';
  const s = `${adj ? `${adj} ` : ''}${shape}${noun.toLowerCase()}`;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Relative and absolute size changes in an edit: "20 cm wider", "10 cm lower", "160 wide". */
export function parseEdit(text: string, size: { w: number; d: number; h: number }): Partial<Record<'w' | 'd' | 'h', number>> {
  const t = text.toLowerCase().replace(/(\d),(\d)/g, '$1.$2');
  const out: Partial<Record<'w' | 'd' | 'h', number>> = {};
  const rel = /(\d+(?:\.\d+)?)\s*(mm|cm|m)?\s*(wider|narrower|longer|shorter|deeper|shallower|taller|higher|lower|bredare|smalare|längre|kortare|djupare|grundare|högre|lägre)/g;
  for (let m: RegExpExecArray | null; (m = rel.exec(t)); ) {
    const v = parseFloat(m[1]); const u = m[2];
    const dm = u === 'mm' ? v / 1000 : u === 'm' ? v : u === 'cm' ? v / 100 : v < 5 ? v : v / 100;
    const w = m[3];
    const sign = /narrower|shorter|shallower|lower|smalare|kortare|grundare|lägre/.test(w) ? -1 : 1;
    const axis: 'w' | 'd' | 'h' = /deep|shallow|djup|grund/.test(w) ? 'd' : /tall|high|low|hög|läg/.test(w) ? 'h' : 'w';
    out[axis] = Math.max(0.02, Math.round(((out[axis] ?? size[axis]) + sign * dm) * 1000) / 1000);
  }
  const abs = parseRequest(t.replace(rel, ' '));
  for (const k of ['w', 'd', 'h'] as const) if (abs[k] !== undefined && out[k] === undefined) out[k] = abs[k];
  return out;
}
