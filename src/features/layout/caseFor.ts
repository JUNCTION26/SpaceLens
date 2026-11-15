// The case for a layout: what makes it different from its siblings, at a glance. Pure; numbers only.
import type { DesignReport, FurnitureItem, LayoutCandidate, SpaceModel } from '../../core/types';
import { area, bounds, distPointPolygonEdges, itemCorners, openingSegment } from '../../core/geometry';

export interface Case { title: string; chips: string[]; tradeoff?: string; leftOut: string[]; passed: number; total: number }

const STORAGE = /bookshelf|wardrobe|dresser|storage|shelf|cabinet|counter/;
const FLAT = /rug|poster|sign|decor|lamp/;

export const leftOutOf = (c: LayoutCandidate): string[] => {
  const out: string[] = [];
  for (const a of c.assumptions) {
    const m = /^Left out (?:the )?(.+?)(?::|$)/i.exec(a);
    if (m) out.push(...m[1].split(/,\s*/));
  }
  return [...new Set(out)];
};
const d2 = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

interface Feat {
  free: number; cost: number; walk: number | null; storage: number; leftOut: number;
  deskWin: number | null; bedDoor: number | null; sofaTarget: 'tv' | 'window' | null; sym: number; hug: number; centre: number;
}

function featuresOf(c: LayoutCandidate, model: SpaceModel): Feat {
  const sp = model.spaces[0];
  const poly = sp?.polygon ?? [];
  const bb = poly.length ? bounds(poly) : { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  const roomA = Math.max(0.1, poly.length ? area(poly) : 1);
  const pts = (kind: string) => (sp ? model.openings.filter((o) => o.kind === kind).map((o) => openingSegment(sp, o).c) : []);
  const wins = pts('window'), doors = pts('door');
  const items = c.furniture;
  const by = (re: RegExp) => items.filter((f) => re.test(f.category));
  const nearest = (p: { x: number; y: number }, ps: { x: number; y: number }[]) => (ps.length ? Math.min(...ps.map((q) => d2(p, q))) : null);
  const desk = by(/^desk$/)[0], bed = by(/bed/)[0], sofa = by(/sofa|seating/)[0], tv = by(/tv/)[0];
  let sofaTarget: Feat['sofaTarget'] = null;
  if (sofa) {
    const fwd = { x: -Math.sin(sofa.rotation), y: Math.cos(sofa.rotation) };
    const aim = (t: { x: number; y: number }) => { const dx = t.x - sofa.x, dy = t.y - sofa.y; const l = Math.hypot(dx, dy) || 1; return (dx * fwd.x + dy * fwd.y) / l; };
    const tvA = tv ? aim(tv) : -1, winA = wins.length ? Math.max(...wins.map(aim)) : -1;
    if (tvA > 0.9 && tvA >= winA) sofaTarget = 'tv'; else if (winA > 0.9) sofaTarget = 'window';
  }
  const w = bb.maxX - bb.minX, h = bb.maxY - bb.minY, cx = bb.minX + w / 2, cy = bb.minY + h / 2;
  const major = items.filter((f) => !FLAT.test(f.category));
  const mass = major.reduce((s, f) => s + f.w * f.d, 0);
  const sym = mass ? 1 - Math.min(1, Math.hypot(major.reduce((s, f) => s + (f.x - cx) * f.w * f.d, 0), major.reduce((s, f) => s + (f.y - cy) * f.w * f.d, 0)) / (mass * Math.max(w, h) / 2)) : 0;
  const edge = (f: FurnitureItem) => Math.min(...itemCorners(f).map((p) => distPointPolygonEdges(p, poly)));
  const hug = major.length && poly.length ? major.filter((f) => edge(f) < 0.12).length / major.length : 0;
  const centre = major.filter((f) => Math.hypot(f.x - cx, f.y - cy) < Math.min(w, h) * 0.22).length;
  return {
    free: c.metrics.openAreaM2 / roomA, cost: c.metrics.costSek, walk: c.metrics.minClearanceM,
    storage: items.filter((f) => STORAGE.test(f.category)).length, leftOut: leftOutOf(c).length,
    deskWin: desk ? nearest(desk, wins) : null, bedDoor: bed ? nearest(bed, doors) : null, sofaTarget, sym, hug, centre,
  };
}

interface Idea { key: string; title: string; chip: string; strength: number }
const kr = (n: number) => `+${Math.round(n).toLocaleString('sv-SE').replace(/\s/g, ' ')} kr`;

function ideasFor(f: Feat, others: Feat[]): Idea[] {
  const ideas: Idea[] = [];
  const o = others.length ? others : [f];
  const mean = (g: (x: Feat) => number | null) => { const v = o.map(g).filter((x): x is number => x !== null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
  const add = (key: string, title: string, chip: string, strength: number) => { if (strength > 0.02) ideas.push({ key, title, chip, strength }); };
  const fm = mean((x) => x.free); if (fm !== null) add('free', 'Open centre', `${Math.round(f.free * 100)}% free`, f.free - fm);
  if (f.deskWin !== null && f.deskWin < 1.6) { const d = mean((x) => x.deskWin); add('desk', 'Window desk', 'Desk by window', d === null ? 0.1 : (d - f.deskWin) / 3 + 0.03); }
  if (f.bedDoor !== null) { const d = mean((x) => x.bedDoor); if (d !== null) add('bed', 'Quiet bed', 'Bed away from door', (f.bedDoor - d) / 4); }
  if (f.sofaTarget) add('sofa', f.sofaTarget === 'tv' ? 'Cinema corner' : 'View seat', f.sofaTarget === 'tv' ? 'Sofa faces TV' : 'Sofa faces window', others.some((x) => x.sofaTarget !== f.sofaTarget) ? 0.2 : 0.03);
  if (f.walk !== null) { const w = mean((x) => x.walk); if (w !== null) add('walk', 'Wide walkway', `${Math.round(f.walk * 100)} cm routes`, (f.walk - w) / 1.2); }
  const cm = mean((x) => x.cost); if (cm !== null && cm > 0) add('price', 'Best value', 'Lowest price', (cm - f.cost) / cm);
  const sm = mean((x) => x.sym); if (sm !== null) add('sym', 'Balanced pairs', 'Balanced', f.sym - sm);
  const hm = mean((x) => x.hug); if (hm !== null) add('hug', 'Cosy corner', 'Wall-hugging', f.hug - hm);
  const km = mean((x) => x.centre); if (km !== null && f.centre === 0 && km > 0) add('clear', 'Clear centre', 'Clear centre', 0.1);
  const sto = mean((x) => x.storage); if (sto !== null) add('store', 'Storage wall', 'More storage', (f.storage - sto) / 5);
  if (f.leftOut === 0) { const lm = mean((x) => x.leftOut); if (lm) add('all', 'Full set', 'Everything fits', 0.2); }
  return ideas.sort((a, b) => b.strength - a.strength || a.key.localeCompare(b.key));
}

function tradeoffOf(f: Feat, others: Feat[]): string | undefined {
  if (!others.length) return undefined;
  const avg = (g: (x: Feat) => number | null) => { const v = others.map(g).filter((x): x is number => x !== null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
  const c: Array<[number, string]> = [];
  const cm = avg((x) => x.cost); if (cm !== null && f.cost - cm > 50) c.push([((f.cost - cm) / Math.max(cm, 1)) * 2, kr(f.cost - Math.min(...others.map((x) => x.cost)))]);
  const w = avg((x) => x.walk); if (w !== null && f.walk !== null && w - f.walk > 0.05) c.push([(w - f.walk) / 0.6, 'Tighter walkway']);
  const s = avg((x) => x.storage); if (s !== null && s - f.storage >= 1) c.push([(s - f.storage) / 3, 'Less storage']);
  const fr = avg((x) => x.free); if (fr !== null && fr - f.free > 0.03) c.push([(fr - f.free) * 3, 'Less open floor']);
  const dw = avg((x) => x.deskWin); if (dw !== null && f.deskWin !== null && f.deskWin - dw > 1) c.push([0.2, 'Desk off window']);
  return c.sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1]))[0]?.[1];
}

/**
 * What a layout is about, from numbers alone: a 2-4 word title, up to three reason chips from what truly differs
 * from the other layouts, one trade-off, and what was left out. Titles stay unique across the set.
 */
export function caseFor(candidate: LayoutCandidate, report: DesignReport | undefined, model: SpaceModel, others: LayoutCandidate[] = []): Case {
  const all = [candidate, ...others.filter((x) => x.id !== candidate.id)];
  const feats = new Map(all.map((c) => [c.id, featuresOf(c, model)] as const));
  const rest = (id: string) => all.filter((x) => x.id !== id).map((x) => feats.get(x.id)!);
  const ideas = new Map(all.map((c) => [c.id, ideasFor(feats.get(c.id)!, rest(c.id))] as const));
  const taken = new Set<string>(), titles = new Map<string, string>();
  for (const c of [...all].sort((a, b) => a.id.localeCompare(b.id))) {
    const pick = ideas.get(c.id)!.find((i) => !taken.has(i.title));
    const fallback = ['Classic plan', 'Easy flow', 'Fresh take', 'Simple plan', 'Tidy edges'].find((t) => !taken.has(t)) ?? `Plan ${taken.size + 1}`;
    const t = leftOutOf(c).length && !taken.has('Trimmed set') ? 'Trimmed set' : pick?.title ?? fallback;
    taken.add(t); titles.set(c.id, t);
  }
  const chips: string[] = [];
  for (const i of ideas.get(candidate.id)!) if (chips.length < 3 && !chips.includes(i.chip)) chips.push(i.chip);
  const checks = report?.verdicts.length
    ? { total: report.verdicts.length, passed: report.verdicts.filter((v) => v.pass).length }
    : { total: candidate.checks.length, passed: candidate.checks.filter((k) => k.result === 'pass').length };
  return { title: titles.get(candidate.id)!, chips, tradeoff: tradeoffOf(feats.get(candidate.id)!, rest(candidate.id)), leftOut: leftOutOf(candidate), ...checks };
}

/** One spoken paragraph on why this layout was chosen. */
export function whyText(c: Case, candidate: LayoutCandidate): string {
  const bits = c.chips.map((x) => x.toLowerCase());
  const trade = c.tradeoff ? ` The trade-off is ${c.tradeoff.toLowerCase()}.` : '';
  const out = c.leftOut.length ? ` It leaves out ${c.leftOut.join(' and ')}.` : '';
  const kron = Math.round(candidate.metrics.costSek).toLocaleString('sv-SE');
  return `I would go with ${c.title.toLowerCase()}. ${bits.length ? `It stands out for ${bits.join(', ')}. ` : ''}It passes ${c.passed} of ${c.total} checks and costs ${kron} kronor.${trade}${out}`.replace(/\s+/g, ' ').trim();
}
