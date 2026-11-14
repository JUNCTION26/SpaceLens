// Geometry checks for a generated object, with automatic repair.
//
// `issues` lists everything wrong with the spec as given (and what was done about it);
// `fixed` is the repaired spec; `ok` says whether `fixed` passes every hard check.
import type { ObjectPart, ObjectSpec } from '../../core/types';
import { fitSpec } from './fit';
import { MAX_PARTS, MIN_PART, PART_SHAPES, normalizeSpec, partBounds, partsBounds, withOpenSize, type Bounds } from './spec';

export const SIZE_TOL = 0.002;
export const CONTACT_TOL = 0.005;
export const MIN_PARTS = 3;

export interface SpecValidation { ok: boolean; issues: string[]; fixed: ObjectSpec }

const cm = (m: number) => `${Math.round(m * 1000) / 10} cm`;

function touches(a: Bounds, b: Bounds, tol = CONTACT_TOL): boolean {
  for (let i = 0; i < 3; i++) if (a.min[i] > b.max[i] + tol || b.min[i] > a.max[i] + tol) return false;
  return true;
}

function volume(b: Bounds) { return Math.max(0, b.max[0] - b.min[0]) * Math.max(0, b.max[1] - b.min[1]) * Math.max(0, b.max[2] - b.min[2]); }
function overlapVolume(a: Bounds, b: Bounds) {
  let v = 1;
  for (let i = 0; i < 3; i++) v *= Math.max(0, Math.min(a.max[i], b.max[i]) - Math.max(a.min[i], b.min[i]));
  return v;
}

/** Connected components of the contact graph, and which of them rest on the floor. */
export function contactComponents(parts: readonly ObjectPart[]): { comps: number[][]; grounded: boolean[] } {
  const bs = parts.map(partBounds);
  const n = parts.length, seen = new Array<boolean>(n).fill(false), comps: number[][] = [], grounded: boolean[] = [];
  for (let s = 0; s < n; s++) {
    if (seen[s]) continue;
    const comp: number[] = [], stack = [s]; seen[s] = true;
    while (stack.length) {
      const i = stack.pop()!; comp.push(i);
      for (let j = 0; j < n; j++) if (!seen[j] && touches(bs[i], bs[j])) { seen[j] = true; stack.push(j); }
    }
    comps.push(comp);
    grounded.push(comp.some((i) => bs[i].min[1] <= CONTACT_TOL));
  }
  return { comps, grounded };
}

/** Hard checks only; empty when the spec is valid. */
export function checkSpec(spec: ObjectSpec): string[] {
  const out: string[] = [];
  const { parts, size } = spec;
  if (parts.length < MIN_PARTS) out.push(`Only ${parts.length} parts; at least ${MIN_PARTS} are needed.`);
  if (parts.length > MAX_PARTS) out.push(`${parts.length} parts; at most ${MAX_PARTS} are allowed.`);
  if (!parts.length) return out;
  const b = partsBounds(parts);
  const ext = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
  const want = [size.w, size.h, size.d], label = ['Width', 'Height', 'Depth'];
  for (let i = 0; i < 3; i++) if (Math.abs(ext[i] - want[i]) > SIZE_TOL) out.push(`${label[i]} is ${cm(ext[i])}, asked for ${cm(want[i])}.`);
  if (b.min[1] < -SIZE_TOL) out.push(`Parts go ${cm(-b.min[1])} below the floor.`);
  else if (b.min[1] > SIZE_TOL) out.push(`Object floats ${cm(b.min[1])} above the floor.`);
  const box: Bounds = { min: [-size.w / 2, 0, -size.d / 2], max: [size.w / 2, size.h, size.d / 2] };
  const outside = parts.filter((p) => { const pb = partBounds(p); return [0, 1, 2].some((i) => pb.min[i] < box.min[i] - SIZE_TOL || pb.max[i] > box.max[i] + SIZE_TOL); });
  if (outside.length) out.push(`${outside.length} part(s) stick out of the ${cm(size.w)} x ${cm(size.d)} x ${cm(size.h)} box (${outside.slice(0, 3).map((p) => p.name).join(', ')}).`);
  const { comps, grounded } = contactComponents(parts);
  const floating = comps.filter((_, i) => !grounded[i]);
  if (floating.length) out.push(`${floating.length} floating piece(s): ${floating.map((c) => parts[c[0]].name).slice(0, 4).join(', ')}.`);
  for (const p of parts) {
    if (!PART_SHAPES.includes(p.shape)) out.push(`Part "${p.name}" has unknown shape ${p.shape}.`);
    if (p.size.some((v) => !(v >= MIN_PART * 0.5) || !Number.isFinite(v)) || p.pos.some((v) => !Number.isFinite(v))) out.push(`Part "${p.name}" has an invalid size or position.`);
  }
  return out;
}

const shift = (p: ObjectPart, t: number[]): ObjectPart => ({ ...p, pos: [p.pos[0] + t[0], p.pos[1] + t[1], p.pos[2] + t[2]] });

/** Move every floating piece the shortest distance that makes it touch a supported part or the floor. */
function snapFloating(parts: ObjectPart[], issues: string[]): ObjectPart[] {
  let cur = parts;
  for (let guard = 0; guard < 40; guard++) {
    const { comps, grounded } = contactComponents(cur);
    const fi = grounded.findIndex((g) => !g);
    if (fi < 0) break;
    const comp = comps[fi];
    const inComp = new Set(comp);
    const cb: Bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (const i of comp) { const b = partBounds(cur[i]); for (let k = 0; k < 3; k++) { cb.min[k] = Math.min(cb.min[k], b.min[k]); cb.max[k] = Math.max(cb.max[k], b.max[k]); } }
    let best: number[] = [0, -cb.min[1], 0], bestLen = Math.abs(cb.min[1]), target = 'the floor';
    const support = comps.flatMap((c, k) => (grounded[k] ? c : []));
    for (const j of support) {
      if (inComp.has(j)) continue;
      const pb = partBounds(cur[j]);
      const t = [0, 1, 2].map((k) => (cb.max[k] < pb.min[k] ? pb.min[k] - cb.max[k] : cb.min[k] > pb.max[k] ? pb.max[k] - cb.min[k] : 0));
      const len = Math.hypot(t[0], t[1], t[2]);
      if (len < bestLen) { best = t; bestLen = len; target = `"${cur[j].name}"`; }
    }
    issues.push(`"${cur[comp[0]].name}"${comp.length > 1 ? ` (+${comp.length - 1})` : ''} was floating; moved ${cm(bestLen)} to touch ${target}.`);
    cur = cur.map((p, i) => (inComp.has(i) ? shift(p, best) : p));
  }
  return cur;
}

/** Validate and repair. `fixed` always has 80 parts or fewer, rests on the floor, is connected and fits `size`. */
export function validateSpec(spec: ObjectSpec): SpecValidation {
  const issues = checkSpec(spec);
  let parts = spec.parts.filter((p) => PART_SHAPES.includes(p.shape) && p.size.every((v) => Number.isFinite(v) && v > 0) && p.pos.every(Number.isFinite));
  if (parts.length > MAX_PARTS) parts = parts.slice(0, MAX_PARTS);
  parts = parts.map((p) => (p.size.some((v) => v < MIN_PART) ? { ...p, size: p.size.map((v) => Math.max(MIN_PART, v)) as [number, number, number] } : p));

  // Exact duplicates (same shape and nearly the same box) are model stutter: keep the first.
  const bs = parts.map(partBounds);
  const keep = parts.map(() => true);
  for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
    if (!keep[j] || !keep[i] || parts[i].shape !== parts[j].shape) continue;
    const ri = parts[i].rot ?? [0, 0, 0], rj = parts[j].rot ?? [0, 0, 0];
    if (ri.some((v, k) => Math.abs(v - rj[k]) > 0.02)) continue;
    const ov = overlapVolume(bs[i], bs[j]), u = volume(bs[i]) + volume(bs[j]) - ov;
    if (u > 0 && ov / u > 0.95) { keep[j] = false; issues.push(`"${parts[j].name}" duplicated "${parts[i].name}"; removed.`); }
  }
  parts = parts.filter((_, i) => keep[i]);

  if (parts.length) {
    // Rest on the floor before checking supports.
    const y0 = partsBounds(parts).min[1];
    if (Math.abs(y0) > 1e-6) parts = parts.map((p) => shift(p, [0, -y0, 0]));
    parts = snapFloating(parts, issues);
  }
  let fixed: ObjectSpec = { ...spec, parts };
  // Snapping can move the bounds; refit to the exact size (refitting keeps contacts).
  for (let n = 0; n < 3 && checkSpec(fixed).some((s) => /asked for|stick out|floor/.test(s)); n++) fixed = fitSpec(fixed, spec.size);
  fixed = withOpenSize(fixed);
  const remaining = checkSpec(fixed);
  for (const r of remaining) if (!issues.includes(r)) issues.push(r);
  return { ok: remaining.length === 0, issues, fixed };
}

/**
 * The whole pipeline for a model reply: clean the JSON, fit to the requested size, repair.
 * `want.w/d/h` are the size the person asked for; missing values come from the model.
 */
export function forgeSpec(raw: unknown, want: { w?: number; d?: number; h?: number; name?: string; prompt: string }): SpecValidation {
  const spec = normalizeSpec(raw, want);
  return validateSpec(spec.parts.length ? fitSpec(spec, spec.size) : spec);
}
