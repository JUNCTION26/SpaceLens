import type { DrawingDoc, TextItem } from './drawingIndex';

export interface Region { page: number; x: number; y: number; w: number; h: number }

export interface Answer {
  id: string;
  question: string;
  answer: string;
  value?: number;
  unit?: string;
  kind: 'printed' | 'calculated' | 'inferred';
  method: 'index' | 'gemini' | 'none';
  regions: Region[];
}

const reg = (i: TextItem): Region => ({ page: i.page, x: i.x, y: i.y, w: i.w, h: i.h });
const cx = (i: TextItem) => i.x + i.w / 2;
const cy = (i: TextItem) => i.y + i.h / 2;
const near = (a: TextItem, b: TextItem) => Math.hypot(cx(a) - cx(b), cy(a) - cy(b));
let seq = 0;
const mk = (question: string, a: Omit<Answer, 'id' | 'question'>): Answer => ({ id: `a${seq++}`, question, ...a });

function nearest(from: TextItem, pool: TextItem[], maxD = 0.08): TextItem | null {
  let best: TextItem | null = null, bd = maxD;
  for (const p of pool) if (p.page === from.page && p !== from) { const d = near(from, p); if (d < bd) { bd = d; best = p; } }
  return best;
}

const fmt = (v: number, d = 2) => v.toFixed(d).replace(/\.?0+$/, '') || '0';

/** Answers from the text index only. Returns null when nothing in the index fits. */
export function answerFromIndex(doc: DrawingDoc, question: string, page: number): Answer | null {
  const q = question.toLowerCase().trim();
  const items = doc.items;
  const of = (k: TextItem['kind']) => items.filter((i) => i.kind === k);
  const onPage = (arr: TextItem[]) => { const p = arr.filter((i) => i.page === page); return p.length ? p : arr; };

  if (/\bscale\b|skala|mittakaava/.test(q)) {
    const s = onPage(of('scale'));
    if (!s.length) return null;
    const uniq = [...new Set(s.map((i) => `1:${i.value}`))];
    return mk(question, { answer: `Scale ${uniq.join(', ')}`, value: s[0].value, kind: 'printed', method: 'index', regions: s.slice(0, 4).map(reg) });
  }

  if (/sheet|drawing number|ritningsnummer|blad/.test(q)) {
    const s = onPage(of('sheet'));
    if (!s.length) return null;
    const best = s.reduce((a, b) => (cx(b) + cy(b) > cx(a) + cy(a) ? b : a)); // title blocks sit bottom-right
    return mk(question, { answer: `Sheet ${best.str}`, kind: 'printed', method: 'index', regions: [reg(best)] });
  }

  const rooms = of('room');
  const areas = of('area');
  const findRoom = () => {
    const words = q.split(/[^a-zåäöü0-9²]+/).filter((w) => w.length >= 2);
    return rooms.filter((r) => { const rl = r.str.toLowerCase(); return words.some((w) => rl.split(/[^a-zåäöü0-9]+/).includes(w)); });
  };

  if (/list|which rooms|what rooms|how many rooms|rooms are/.test(q) && /room|rum|huone/.test(q)) {
    if (!rooms.length) return null;
    const names = [...new Set(rooms.map((r) => r.str))];
    return mk(question, { answer: `${names.length} room labels: ${names.join(', ')}`, value: names.length, kind: 'printed', method: 'index', regions: rooms.slice(0, 12).map(reg) });
  }

  if (/area|size|m²|m2|kvm|how big|yta|pinta/.test(q)) {
    const hits = findRoom();
    if (hits.length) {
      const pairs = hits.map((r) => ({ r, a: nearest(r, areas) })).filter((p) => p.a);
      if (pairs.length) {
        const { r, a } = pairs[0];
        return mk(question, { answer: `${r.str}: ${fmt(a!.value!, 1)} m²`, value: a!.value, unit: 'm²', kind: 'printed', method: 'index', regions: [reg(r), reg(a!)] });
      }
    }
    if (/total|all|sum/.test(q) && areas.length) {
      const sum = areas.reduce((s, a) => s + (a.value ?? 0), 0);
      return mk(question, { answer: `Sum of ${areas.length} printed areas: ${fmt(sum, 1)} m²`, value: sum, unit: 'm²', kind: 'calculated', method: 'index', regions: areas.slice(0, 12).map(reg) });
    }
  }

  const tagQ = q.match(/\b(d|w|f|dr|win|dö)[-\s]?(\d{1,3}[a-z]?)\b/i);
  if (tagQ) {
    const want = (tagQ[1] + tagQ[2]).toUpperCase();
    const tag = of('tag').find((t) => t.str.toUpperCase().replace(/[-\s]/g, '') === want);
    if (tag) {
      const dim = nearest(tag, of('dimension'), 0.05);
      if (dim) return mk(question, { answer: `${tag.str}: ${fmt(dim.value!)} m (nearest printed dimension "${dim.str}")`, value: dim.value, unit: 'm', kind: 'inferred', method: 'index', regions: [reg(tag), reg(dim)] });
      return mk(question, { answer: `Found ${tag.str} on page ${tag.page + 1}, no dimension printed next to it.`, kind: 'printed', method: 'index', regions: [reg(tag)] });
    }
  }

  if (/dimension|measure|mått|mitat/.test(q)) {
    const d = onPage(of('dimension'));
    if (!d.length) return null;
    const list = d.slice(0, 20).map((i) => `${i.str} (${fmt(i.value!)} m)`).join(', ');
    return mk(question, { answer: `${d.length} dimensions on this sheet: ${list}${d.length > 20 ? ', ...' : ''}`, value: d.length, kind: 'printed', method: 'index', regions: d.slice(0, 20).map(reg) });
  }

  if (/door|window|dörr|fönster|ovi|ikkuna/.test(q) && /how many|count|list|antal/.test(q)) {
    const isDoor = /door|dörr|ovi/.test(q);
    const t = of('tag').filter((i) => (isDoor ? /^d/i : /^(w|f)/i).test(i.str));
    if (!t.length) return null;
    const names = [...new Set(t.map((i) => i.str))];
    return mk(question, { answer: `${names.length} ${isDoor ? 'door' : 'window'} tags: ${names.join(', ')}`, value: names.length, kind: 'printed', method: 'index', regions: t.slice(0, 12).map(reg) });
  }

  // Plain room lookup: "where is the kitchen"
  const hits = findRoom();
  if (hits.length && /where|find|show|var |missä/.test(q)) {
    return mk(question, { answer: `${hits.map((h) => h.str).join(', ')} on page ${hits[0].page + 1}`, kind: 'printed', method: 'index', regions: hits.slice(0, 6).map(reg) });
  }
  return null;
}
