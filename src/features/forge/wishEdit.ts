// Edit an object by a sentence ("20 cm taller", "add a shelf", "walnut instead", "remove the
// wheels", "round the corners"), changing only what was asked. Pure. Objects built from a wish
// are rebuilt from the edited wish (the builder is deterministic, so nothing else moves);
// any other object is edited part by part. What rules cannot do is returned in `unhandled`.

import type { MaterialId, ObjectPart, ObjectSpec } from '../../core/types';
import { composeObject, type ComposedSpec } from './compose';
import { fitSpec } from './fit';
import { parseEdit } from './parseRequest';
import { validateSpec } from './validate';
import { parseWish, type CountKey, type Feature, type Role, type Wish } from './wish';
import { enforceWishes } from './wishCheck';

export interface SentenceEdit { spec: ObjectSpec; applied: string[]; unhandled: string[] }

const NUM: Record<string, number> = { a: 1, an: 1, one: 1, another: 1, two: 2, three: 3, four: 4, five: 5, en: 1, ett: 1, två: 2, tre: 3, yksi: 1, kaksi: 2, kolme: 3 };
const COUNTS: Array<[RegExp, CountKey]> = [[/^(shel(f|ves)|hyll\w*)$/, 'shelves'], [/^(drawers?|låd\w*|laatik\w*)$/, 'drawers'], [/^(doors?|dörr\w*|ov\w*)$/, 'doors'], [/^(platforms?|levels?|tiers?)$/, 'platforms'], [/^legs?$/, 'legs'], [/^wheels?$/, 'wheels']];
const FEATS: Array<[RegExp, Feature]> = [[/wheels?|casters?|hjul/, 'wheels'], [/handles?|knobs?/, 'handles'], [/armrests?|arms/, 'armrests'], [/back ?rest|backrest/, 'backrest'], [/lamp/, 'lamp'], [/plant/, 'plant'], [/slide/, 'slide'], [/cushions?|pillows?/, 'cushions']];
const ROLE_RE: Partial<Record<Role, RegExp>> = { top: /\btop\b/i, legs: /\bleg|pedestal|column|foot|base\b/i, doors: /door/i, drawers: /drawer/i, shelves: /shel/i, seat: /seat/i, back: /back/i, frame: /frame|side|top|bottom|back|plinth/i, cushions: /cushion|pillow/i };

interface Ops {
  size: Partial<Record<'w' | 'd' | 'h', number>>;
  counts: Array<[CountKey, number]>; // delta
  add: Feature[]; remove: Feature[];
  looks: Array<[Role, { material?: MaterialId; color?: string }]>;
  round: boolean; text?: string;
}

/** Read what an edit sentence asks for. */
export function parseEditSentence(spec: ObjectSpec, sentence: string): Ops {
  const t = ` ${sentence.toLowerCase().replace(/[,.!?]/g, ' ')} `;
  const ops: Ops = { size: parseEdit(sentence, spec.size), counts: [], add: [], remove: [], looks: [], round: false };
  const toks = t.trim().split(/\s+/);
  for (let i = 0; i < toks.length; i++) {
    const verb = /^(add|plus|another|more|lägg|lisää)$/.test(toks[i]) ? 1 : /^(remove|drop|delete|without|less|fewer|ta|poista)$/.test(toks[i]) ? -1 : 0;
    if (!verb) continue;
    for (let j = i + 1; j < Math.min(toks.length, i + 5); j++) {
      const key = COUNTS.find(([re]) => re.test(toks[j]))?.[1];
      if (key) {
        const n = toks.slice(i + 1, j).map((x) => (/^\d+$/.test(x) ? parseInt(x, 10) : NUM[x])).find((x) => x !== undefined) ?? 1;
        if (key === 'wheels' && !/\d|two|three|four/.test(toks.slice(i + 1, j).join(' '))) { (verb > 0 ? ops.add : ops.remove).push('wheels'); break; }
        ops.counts.push([key, verb * n]); break;
      }
      const f = FEATS.find(([re]) => re.test(toks[j]))?.[1];
      if (f) { (verb > 0 ? ops.add : ops.remove).push(f); break; }
    }
  }
  const more = /\bone more (shelf|drawer|door|platform)/.exec(t);
  if (more) { const k = COUNTS.find(([re]) => re.test(more[1]))?.[1]; if (k && !ops.counts.some(([c]) => c === k)) ops.counts.push([k, 1]); }
  const no = /\bno (wheels|arms|armrests|handles|lamp)\b/.exec(t);
  if (no) { const f = FEATS.find(([re]) => re.test(no[1]))?.[1]; if (f && !ops.remove.includes(f)) ops.remove.push(f); }
  if (/\b(round(ed)? (the )?corners|round(ed)? (the )?edges|soften the corners|rundade hörn)\b/.test(t)) ops.round = true;
  const tm = /\b(?:write|print|put|add)\s+["“]?([^\s"“”]+(?: [^\s"“”]+){0,2}?)["”]?\s+on\s+(?:it|the\s+\w+)/i.exec(sentence);
  if (tm) ops.text = tm[1];
  // Materials and colours: reuse the description parser on the sentence alone.
  if (!tm) {
    const w = parseWish(sentence.replace(/\b(instead|please|make it|in|change to|switch to)\b/gi, ' '));
    for (const [r, l] of Object.entries(w.looks) as Array<[Role, { material?: MaterialId; color?: string }]>) if (l && (l.material || l.color)) ops.looks.push([r, l]);
  }
  return ops;
}

function applyToWish(w: Wish, spec: ObjectSpec, ops: Ops, applied: string[]): Wish {
  const n: Wish = { ...w, size: { ...spec.size }, stated: { w: true, d: true, h: true }, counts: { ...w.counts }, looks: { ...w.looks }, features: [...w.features] };
  for (const k of ['w', 'd', 'h'] as const) if (ops.size[k] !== undefined) { n.size[k] = ops.size[k]!; applied.push(`size ${k}`); }
  for (const [k, d] of ops.counts) { n.counts[k] = Math.max(0, (n.counts[k] ?? 0) + d); applied.push(`${k} ${d > 0 ? '+' : ''}${d}`); }
  for (const f of ops.add) if (!n.features.includes(f)) { n.features.push(f); if (f === 'wheels') { n.support = 'wheels'; n.counts.wheels ??= 4; } applied.push(`add ${f}`); }
  for (const f of ops.remove) { n.features = n.features.filter((x) => x !== f); if (f === 'wheels') { delete n.counts.wheels; if (n.support === 'wheels') n.support = undefined; } applied.push(`remove ${f}`); }
  for (const [r, l] of ops.looks) { n.looks[r] = { ...n.looks[r], ...l }; applied.push(`${r} ${l.material ?? l.color}`); }
  if (ops.round && !n.features.includes('round-corners')) { n.features.push('round-corners'); applied.push('round corners'); }
  if (ops.text) { n.text_ = ops.text; applied.push('text'); }
  return n;
}

/** Edit by sentence. Pure: the input spec is not changed. */
export function editBySentence(spec: ObjectSpec, sentence: string): SentenceEdit {
  const ops = parseEditSentence(spec, sentence);
  const applied: string[] = [], unhandled: string[] = [];
  const wish = (spec as Partial<ComposedSpec>).wish ?? (spec.model === 'rules' ? parseWish(spec.prompt) : undefined);
  if (wish) {
    const w2 = applyToWish(wish, spec, ops, applied);
    if (!applied.length) return { spec, applied, unhandled: [sentence] };
    const built = composeObject(w2);
    return { spec: { ...built, id: spec.id, name: spec.name, prompt: `${spec.prompt}; ${sentence}` }, applied, unhandled };
  }
  // A model-made object: part-level edits.
  let parts: ObjectPart[] = spec.parts.map((p) => ({ ...p }));
  let size = { ...spec.size };
  for (const k of ['w', 'd', 'h'] as const) if (ops.size[k] !== undefined) { size[k] = ops.size[k]!; applied.push(`size ${k}`); }
  for (const f of ops.remove) {
    const re = FEATS.find(([, x]) => x === f)?.[0];
    if (!re) { unhandled.push(`remove ${f}`); continue; }
    const before = parts.length;
    parts = parts.filter((p) => !re.test(p.name));
    if (parts.length < before) {
      applied.push(`remove ${f}`);
      if (f === 'wheels') { const lift = Math.min(...parts.map((p) => p.pos[1] - p.size[1] / 2)); parts = parts.map((p) => ({ ...p, pos: [p.pos[0], p.pos[1] - lift, p.pos[2]] })); size.h = Math.max(0.05, size.h - lift); }
    }
  }
  for (const [k, d] of ops.counts) {
    const re = { shelves: /shel/i, drawers: /drawer/i, doors: /door/i, platforms: /platform/i, legs: /\bleg/i, wheels: /wheel/i, drums: /drum/i, cymbals: /cymbal/i, seats: /seat/i, compartments: /divider/i }[k];
    const list = parts.filter((p) => re.test(p.name) && !/handle|knob/i.test(p.name)).sort((a, b) => a.pos[1] - b.pos[1]);
    if (k === 'shelves' && list.length) {
      const target = Math.max(0, list.length + d);
      const lo = list[0].pos[1], hi = list[list.length - 1].pos[1];
      const gap = list.length > 1 ? (hi - lo) / (list.length - 1) : size.h * 0.3;
      const y0 = lo - gap, y1 = hi + gap;
      const proto = list[0];
      parts = parts.filter((p) => !list.includes(p));
      for (let i = 1; i <= target; i++) parts.push({ ...proto, name: `shelf ${i}`, pos: [proto.pos[0], y0 + ((y1 - y0) * i) / (target + 1), proto.pos[2]] });
      applied.push(`shelves ${d > 0 ? '+' : ''}${d}`);
    } else if (d < 0 && list.length) {
      const drop = new Set(list.slice(d));
      const groups = new Set([...drop].map((p) => p.group).filter(Boolean));
      parts = parts.filter((p) => !drop.has(p) && !(p.group && groups.has(p.group)));
      applied.push(`${k} ${d}`);
    } else unhandled.push(`${k} ${d > 0 ? '+' : ''}${d}`);
  }
  for (const f of ops.add) unhandled.push(`add ${f}`);
  for (const [r, l] of ops.looks) {
    if (r === 'main') {
      const vol = new Map<string, number>();
      for (const p of parts) vol.set(p.material, (vol.get(p.material) ?? 0) + p.size[0] * p.size[1] * p.size[2]);
      const main = [...vol.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      parts = parts.map((p) => (p.material === main ? { ...p, material: l.material ?? p.material, color: l.color ?? (l.material ? undefined : p.color) } : p));
    } else {
      const re = ROLE_RE[r];
      if (!re || !parts.some((p) => re.test(p.name))) { unhandled.push(`${r} ${l.material ?? l.color}`); continue; }
      parts = parts.map((p) => (re.test(p.name) ? { ...p, material: l.material ?? p.material, color: l.color ?? (l.material ? undefined : p.color) } : p));
    }
    applied.push(`${r} ${l.material ?? l.color}`);
  }
  if (ops.round) { parts = parts.map((p) => (p.shape === 'box' && Math.min(...p.size) > 0.015 ? { ...p, shape: 'rounded', radius: Math.min(0.03, Math.min(...p.size) / 3) } : p)); applied.push('round corners'); }
  let out: ObjectSpec = { ...spec, parts, size, prompt: `${spec.prompt}; ${sentence}` };
  if (ops.text) { out = enforceWishes(out, { ...parseWish(''), text_: ops.text, looks: {}, stated: { w: false, d: false, h: false } }).spec; applied.push('text'); }
  if (!applied.length) return { spec, applied, unhandled: unhandled.length ? unhandled : [sentence] };
  out = validateSpec(fitSpec(out, size)).fixed;
  return { spec: out, applied, unhandled };
}
