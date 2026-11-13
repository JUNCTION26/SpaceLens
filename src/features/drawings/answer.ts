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

/** A numbered room as printed on Swiss-style plans: label above, number, net area below. */
export interface RoomRecord { no: string; label: string; area?: number; items: TextItem[]; apt?: string }

const reRoomNo = /^[A-Z]{0,2}\d{1,2}\.\d{2,3}$/;
const reApt = /^(?:app\.?|appt\.?|apt\.?|whg\.?|wohnung|logement|appartement|appartamento|unit)\s*([a-z0-9]{1,3})$/i;
const OUTDOOR = /^(balkon|balcone|balcon|balcony|terrasse|terrazza|terrace|loggia|veranda|sitzplatz|patio|dachterrasse|gartensitzplatz)$/i;

export function extractRooms(items: TextItem[]): { rooms: RoomRecord[]; apts: TextItem[] } {
  const rooms: RoomRecord[] = [];
  const nos = items.filter((i) => reRoomNo.test(i.str));
  const textish = items.filter((i) => /[a-zà-ÿ]{2,}/i.test(i.str) && !reApt.test(i.str) && i.kind !== 'area');
  const areas = items.filter((i) => i.kind === 'area');
  for (const n of nos) {
    const h = n.h || 0.01;
    const pick = (pool: TextItem[], dir: 1 | -1) => {
      let best: TextItem | null = null, bd = Infinity;
      for (const p of pool) {
        if (p.page !== n.page) continue;
        const dy = (cy(p) - cy(n)) * dir; // dir=-1: above, dir=1: below
        const dx = Math.abs(cx(p) - cx(n));
        if (dy <= h * 0.3 || dy > h * 2.6 || dx > h * 6) continue;
        const d = dy + dx * 0.5;
        if (d < bd) { bd = d; best = p; }
      }
      return best;
    };
    const lab = pick(textish, -1);
    if (!lab) continue;
    const ar = pick(areas, 1);
    // A label belongs to one number only: keep the closest claimant.
    const prev = rooms.findIndex((r) => r.items[0] === lab);
    if (prev >= 0) { if (near(rooms[prev].items[1], lab) <= near(n, lab)) continue; rooms.splice(prev, 1); }
    rooms.push({ no: n.str, label: lab.str, area: ar?.value, items: ar ? [lab, n, ar] : [lab, n] });
  }
  const apts = items.filter((i) => reApt.test(i.str));
  return { rooms, apts };
}

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
const COUNT_Q = /how many|count|number of|wie viele|anzahl|quant[ie]|combien|nombre|kuinka monta|hur många/;
const AREA_Q = /area|m²|m2|fläche|flache|superficie|surface|pinta-ala|yta/;

/** Swiss-dwellings style plans: answer counts and net areas from numbered room labels. */
function answerRooms(items: TextItem[], question: string): Answer | 'abstain' | null {
  const q = question.toLowerCase();
  const { rooms, apts } = extractRooms(items);
  if (!rooms.length) return null;
  const quoted = (question.match(/[«“"‘]([^»”"’]{2,40})[»”"’]/) ?? question.match(/'(.{2,40}?)'(?=[\s?,.)]|$)/))?.[1];
  const noM = question.match(/\b([A-Z]{0,2}\d{1,2}\.\d{2,3})\b/);
  const isArea = AREA_Q.test(q) && !COUNT_Q.test(q);
  const sumAns = (rs: RoomRecord[], label: string): Answer | null => {
    if (!rs.length || rs.some((r) => r.area == null)) return null;
    const v = Math.round(rs.reduce((s, r) => s + r.area!, 0) * 100) / 100;
    return mk(question, { answer: `${label}: ${fmt(v)} m² (sum of ${rs.length} printed room areas)`, value: v, unit: 'm²', kind: rs.length > 1 ? 'calculated' : 'printed', method: 'index', regions: rs.flatMap((r) => r.items).slice(0, 40).map(reg) });
  };

  if (isArea && noM) {
    const r = rooms.find((x) => x.no === noM[1]);
    if (!r || r.area == null) return null;
    if (quoted && norm(quoted) !== norm(r.label)) return null; // label disagrees: do not guess
    return sumAns([r], `Room ${r.no} (${r.label})`);
  }
  if (quoted) {
    const rs = rooms.filter((r) => norm(r.label) === norm(quoted));
    if (COUNT_Q.test(q)) {
      if (!rs.length) return 'abstain';
      return mk(question, { answer: `${rs.length} rooms labelled "${quoted}": ${rs.map((r) => r.no).join(', ')}`, value: rs.length, kind: 'printed', method: 'index', regions: rs.flatMap((r) => r.items.slice(0, 2)).map(reg) });
    }
    if (isArea) return sumAns(rs, `All "${quoted}" rooms`) ?? 'abstain';
    return 'abstain';
  }
  if (COUNT_Q.test(q) && /apartment|residential unit|appartament|unità abitativ|wohnung|logement|appartement|asunto|lägenhet/.test(q)) {
    if (!apts.length) return null;
    const names = [...new Set(apts.map((a) => a.str))];
    return mk(question, { answer: `${names.length} apartments: ${names.join(', ')}`, value: names.length, kind: 'printed', method: 'index', regions: apts.map(reg) });
  }
  const aptQ = /apartment|appartament|wohnung|logement|appartement/.test(q);
  if (isArea && aptQ) {
    const letter = question.match(/(?:apartment|appartamento|wohnung|logement|appartement)\s+([A-Z0-9]{1,3})/i)?.[1];
    const target = letter && apts.find((a) => a.str.match(reApt)?.[1].toUpperCase() === letter.toUpperCase());
    if (!target) return 'abstain';
    // Each room joins the apartment whose printed label is closest; outdoor rooms are excluded.
    const mine = rooms.filter((r) => {
      let best: TextItem | null = null, bd = Infinity;
      for (const a of apts) { if (a.page !== r.items[1].page) continue; const d = near(a, r.items[1]); if (d < bd) { bd = d; best = a; } }
      return best === target && !OUTDOOR.test(norm(r.label)) && r.area != null;
    });
    return sumAns(mine, `Apartment ${letter} (rooms nearest its label)`) ?? 'abstain';
  }
  if (isArea && /numbered|numerat|nummeriert|numérot|indoor|interni|innen|intérieur/.test(q) && !/apartment|appartament|wohnung|logement|appartement/.test(q)) {
    const indoor = rooms.filter((r) => !OUTDOOR.test(norm(r.label)) && r.area != null);
    return indoor.length ? sumAns(indoor, 'All numbered indoor rooms') : 'abstain';
  }
  // A numbered-room plan, but nothing printed answers this (doors, fixtures...): abstain rather than guess.
  return rooms.length >= 3 ? 'abstain' : null;
}

/** Answers from the text index only. Returns null when nothing in the index fits. */
export function answerFromIndex(doc: DrawingDoc, question: string, page: number): Answer | null {
  const q = question.toLowerCase().trim();
  const items = doc.items;
  const swiss = answerRooms(items, question);
  if (swiss === 'abstain') return null;
  if (swiss) return swiss;
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
