/** Pure text classification shared by the browser index and the Node benchmark (no DOM, no pdf.js). */

export type TextKind = 'dimension' | 'room' | 'area' | 'tag' | 'scale' | 'sheet' | 'text';

export interface TextItem {
  id: number;
  page: number;
  str: string;
  /** Normalised 0..1 box on the page. */
  x: number; y: number; w: number; h: number;
  kind: TextKind;
  /** Parsed value: metres for dimensions, m² for areas, N for scale 1:N. */
  value?: number;
}


const ROOM_WORDS = [
  'room', 'kitchen', 'bedroom', 'bathroom', 'bath', 'living', 'dining', 'hall', 'hallway', 'corridor', 'office', 'study',
  'wc', 'toilet', 'storage', 'closet', 'laundry', 'garage', 'balcony', 'terrace', 'entrance', 'lobby', 'utility', 'stair', 'stairs',
  'kök', 'sovrum', 'vardagsrum', 'bad', 'badrum', 'tvätt', 'förråd', 'klk', 'entré', 'allrum', 'matrum', 'arbetsrum', 'groventré', 'kontor',
  'keittiö', 'makuuhuone', 'olohuone', 'kylpyhuone', 'eteinen', 'sauna', 'vaatehuone', 'työhuone', 'parveke', 'pesuhuone', 'ruokailu', 'khh', 'mh', 'oh', 'kph',
  // German / Italian / French (Swiss plans)
  'zimmer','schlafzimmer','wohnen','wohnzimmer','küche','bad','korridor','gang','flur','reduit','réduit','balkon','terrasse','loggia','treppenhaus','eingangshalle','büro','bürofläche','abstellraum','keller','essen','waschküche','gewerbe',
  'stanza','soggiorno','cucina','bagno','corridoio','ripostiglio','balcone','terrazza','ufficio','ingresso','disimpegno','camera',
  'chambre','séjour','cuisine','salle','couloir','balcon','escalier','bureau','dégagement','hall','cave',
];

const reArea = /^(\d{1,4}(?:[.,]\d{1,2})?)\s*(m²|m2|kvm)$/i;
const reScale = /\b1\s*:\s*(\d{1,5})\b/;
const reTag = /^(D|W|F|DR|WIN|DÖ|DÖRR)[-\s]?\d{1,3}[A-Z]?$/i;
const reSheet = /^([A-Z]{1,3}[-.]?\d{1,4}(?:[.-]\d{1,3})?)$/;

/** Parses a printed dimension into metres, or null. */
export function parseDimension(raw: string): number | null {
  const s = raw.trim().replace(/ /g, ' ');
  let m = s.match(/^(\d{1,3}(?:[.,]\d{1,3})?)\s*m$/i);
  if (m) return num(m[1]);
  m = s.match(/^(\d{2,4}(?:[.,]\d)?)\s*cm$/i);
  if (m) return num(m[1]) / 100;
  m = s.match(/^(\d{3,5})\s*mm$/i);
  if (m) return num(m[1]) / 1000;
  m = s.match(/^(\d{1,2}) (\d{3})$/);
  if (m) return Number(m[1] + m[2]) / 1000;
  m = s.match(/^\d{3,5}$/);
  if (m) { const v = Number(s); return v >= 300 && v <= 40000 ? v / 1000 : null; }
  m = s.match(/^(\d{1,2})[.,](\d{2,3})$/);
  if (m) return num(s);
  return null;
}
const num = (s: string) => Number(s.replace(',', '.'));

export function classify(str: string): { kind: TextKind; value?: number } {
  const s = str.trim();
  const a = s.match(reArea);
  if (a) return { kind: 'area', value: num(a[1]) };
  const sc = s.match(reScale);
  if (sc && s.length < 30) return { kind: 'scale', value: Number(sc[1]) };
  if (reTag.test(s)) return { kind: 'tag' };
  const d = parseDimension(s);
  if (d != null) return { kind: 'dimension', value: d };
  const words = s.toLowerCase().split(/[\s/.,()-]+/).filter(Boolean);
  if (s.length <= 30 && words.some((w) => ROOM_WORDS.includes(w))) return { kind: 'room' };
  if (reSheet.test(s) && /\d/.test(s) && s.length <= 10) return { kind: 'sheet' };
  return { kind: 'text' };
}

/** pdf.js often splits "12,5" and "m²" into separate items; join them when adjacent. */
export function mergeSplitAreas(items: TextItem[]): TextItem[] {
  const out: TextItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const a = items[i], b = items[i + 1];
    if (b && a.page === b.page && /^\d{1,4}([.,]\d{1,2})?$/.test(a.str) && /^(m²|m2|kvm)$/i.test(b.str) && Math.abs(a.y - b.y) < a.h) {
      const str = `${a.str} ${b.str}`;
      const x2 = Math.max(a.x + a.w, b.x + b.w);
      out.push({ ...a, str, w: x2 - a.x, ...classify(str) });
      i++;
    } else out.push(a);
  }
  return out;
}


/** pdf.js splits words at ligatures ("Büro" + "fl" + "äche"); join fragments that touch on the same line. */
export function joinLineFragments(items: TextItem[]): TextItem[] {
  const out: TextItem[] = [];
  for (const it of items) {
    const p = out[out.length - 1];
    if (p && p.page === it.page && Math.abs(p.y - it.y) < p.h * 0.3 && Math.abs(p.h - it.h) < p.h * 0.2
      && it.x - (p.x + p.w) < p.h * 0.25 && it.x - (p.x + p.w) > -p.h * 0.5 && /[a-zà-ÿ]$/i.test(p.str) && /^[a-zà-ÿ]/i.test(it.str)) {
      const str = p.str + it.str;
      out[out.length - 1] = { ...p, str, w: Math.max(p.x + p.w, it.x + it.w) - p.x, ...classify(str) };
    } else out.push(it);
  }
  return out;
}
