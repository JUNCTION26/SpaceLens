// Check any object (from the model or the builder) against the wish list, repair what can be
// repaired deterministically, and report which wishes were met and which were not.

import type { ObjectPart, ObjectSpec } from '../../core/types';
import { fitSpec } from './fit';
import { specFootprint } from './spec';
import type { CountKey, Role, Wish } from './wish';

const COUNT_RE: Partial<Record<CountKey, RegExp>> = {
  drawers: /drawer/i, doors: /door/i, shelves: /shel(f|ves)/i, legs: /\bleg/i, platforms: /platform/i,
  wheels: /wheel|caster|castor/i, drums: /\bdrum\b|\bdrum \d|tom|snare|kick/i, cymbals: /cymbal/i,
};
const HARDWARE = /handle|knob|pull|runner|rail|side|bottom|back|box|case|stand|mount|zone|base arm|foot|stretcher/i;
const ROLE_RE: Partial<Record<Role, RegExp>> = {
  top: /\btop\b|surface|worktop/i, legs: /\bleg|pedestal|trestle|column|base\b/i, doors: /door/i, drawers: /drawer/i,
  shelves: /shel(f|ves)/i, seat: /seat/i, back: /back/i, frame: /frame|side|carcass|body/i, cushions: /cushion|pillow/i,
  wheels: /wheel|caster/i, handles: /handle|knob|pull/i, post: /post|pole/i, platforms: /platform/i,
};

/** How many of a counted part an object has: moving groups first, then plain named parts. */
export function countOf(parts: readonly ObjectPart[], key: CountKey): number {
  const re = COUNT_RE[key];
  if (!re) return -1;
  const groups = new Set(parts.filter((p) => p.group && re.test(p.group)).map((p) => p.group));
  if (groups.size) return groups.size;
  return parts.filter((p) => re.test(p.name) && !HARDWARE.test(p.name.replace(re, ''))).length;
}

export interface WishResult { met: string[]; unmet: string[] }

/** Short phrases for each wish, split into met and unmet for this spec. */
export function checkWishes(spec: ObjectSpec, w: Wish): WishResult {
  const met: string[] = [], unmet: string[] = [];
  const say = (ok: boolean, phrase: string) => (ok ? met : unmet).push(phrase);
  const fp = specFootprint(spec);
  const ext = { w: fp.w, d: fp.d, h: fp.h };
  const cm = (m: number) => Math.round(m * 100);
  for (const k of ['w', 'd', 'h'] as const) if (w.stated[k]) say(Math.abs(ext[k] - w.size[k]) <= w.size[k] * 0.03 + 0.002, `${{ w: 'width', d: 'depth', h: 'height' }[k]} ${cm(w.size[k])} cm`);
  for (const [k, v] of Object.entries(w.counts) as Array<[CountKey, number]>) {
    if (!v || !COUNT_RE[k] || (k === 'legs' && w.support && w.support !== 'legs')) continue;
    if (!/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|a|an|tre|två|fyra|fem|kaksi|kolme|neljä|viisi)\b/i.test(w.text) && k !== 'drawers' && k !== 'doors' && k !== 'shelves' && k !== 'platforms' && k !== 'wheels') continue;
    say(countOf(spec.parts, k) === v, `${v} ${k}`);
  }
  for (const [r, look] of Object.entries(w.looks) as Array<[Role, { material?: string; color?: string }]>) {
    if (!look?.material) continue;
    const re = ROLE_RE[r];
    const parts = r === 'main' || !re ? spec.parts : spec.parts.filter((p) => re.test(p.name));
    const ok = r === 'main' ? parts.some((p) => p.material === look.material) : parts.length > 0 && parts.some((p) => p.material === look.material);
    say(ok, `${look.material.replace('-', ' ')} ${r === 'main' ? 'object' : r}`);
  }
  if (w.text_) say(spec.parts.some((p) => p.text?.value?.toUpperCase().includes(w.text_!.toUpperCase())), `printed ${w.text_}`);
  for (const f of w.features) {
    const re: Record<string, RegExp> = { wheels: /wheel|caster/i, slide: /slide/i, ladder: /ladder|rung/i, lamp: /lamp|shade/i, plant: /plant/i, armrests: /arm/i, backrest: /back/i, rope: /rope|sisal/i, handles: /handle|knob|pull/i, sliding: /track|sliding/i, 'monitor-arm': /monitor/i };
    if (re[f]) say(spec.parts.some((p) => re[f].test(p.name)), f === 'monitor-arm' ? 'monitor arm' : f === 'sliding' ? 'sliding doors' : f);
  }
  // Phrases the parser did not know: met only when some part carries one of their words.
  for (const u of w.unknown ?? []) {
    const words = u.split(' ').filter((x) => x.length > 2);
    say(words.some((x) => spec.parts.some((p) => p.name.toLowerCase().includes(x.replace(/s$/, '')))), u);
  }
  return { met, unmet };
}

/**
 * Deterministic repairs: overall size to the stated numbers, named materials onto the parts they
 * belong to, and printed words onto the front. Counts cannot be repaired here; the caller falls
 * back to the builder for those.
 */
export function enforceWishes(spec: ObjectSpec, w: Wish): { spec: ObjectSpec; fixes: string[] } {
  const fixes: string[] = [];
  let out = spec;
  const fp = specFootprint(out);
  const size = { w: w.stated.w ? w.size.w : fp.w, d: w.stated.d ? w.size.d : fp.d, h: w.stated.h ? w.size.h : fp.h };
  if ((['w', 'd', 'h'] as const).some((k) => w.stated[k] && Math.abs(fp[k] - w.size[k]) > w.size[k] * 0.03)) { out = fitSpec(out, size); fixes.push('size'); }
  for (const [r, look] of Object.entries(w.looks) as Array<[Role, { material?: ObjectPart['material']; color?: string }]>) {
    if (!look?.material || r === 'main') continue;
    const re = ROLE_RE[r];
    if (!re || out.parts.some((p) => re.test(p.name) && p.material === look.material)) continue;
    if (!out.parts.some((p) => re.test(p.name))) continue;
    out = { ...out, parts: out.parts.map((p) => (re.test(p.name) ? { ...p, material: look.material!, color: look.color } : p)) };
    fixes.push(`${r} ${look.material}`);
  }
  const main = w.looks.main?.material;
  if (main && !out.parts.some((p) => p.material === main)) {
    const top = out.parts.reduce((a, b) => (b.size[0] * b.size[2] > a.size[0] * a.size[2] ? b : a));
    const was = top.material;
    out = { ...out, parts: out.parts.map((p) => (p.material === was ? { ...p, material: main, color: w.looks.main?.color } : p)) };
    fixes.push(`main ${main}`);
  }
  if (w.text_ && !out.parts.some((p) => p.text?.value)) {
    const f = specFootprint(out);
    const front = out.parts.filter((p) => !p.rot && p.size[0] > 0.15 && p.size[1] > 0.05).sort((a, b) => (b.pos[2] + b.size[2] / 2) - (a.pos[2] + a.size[2] / 2))[0];
    if (front) {
      const ph = Math.min(0.1, front.size[1] * 0.6), pw = Math.min(front.size[0] * 0.7, 0.08 * w.text_.length + 0.1);
      const z = Math.min(f.maxZ - 0.003, front.pos[2] + front.size[2] / 2 - 0.003);
      out = { ...out, parts: [...out.parts, { name: 'name plate', shape: 'panel', size: [pw, ph, 0.006], pos: [front.pos[0], front.pos[1], z], material: 'brass', text: { value: w.text_, color: '#1b1b1b', style: 'display' } }] };
      fixes.push('printed text');
    }
  }
  return { spec: out, fixes };
}
