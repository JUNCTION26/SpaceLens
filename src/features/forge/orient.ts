// Catch a model that built the object on the wrong axes before it is stretched to size.
//
// Fitting maps the parts' bounding box onto the requested W x D x H. If the model laid a bed's
// length along x, or stood a desk on its side (z up), that map squashes one axis and stretches
// another, and a desk comes out as a tower. Comparing the raw box with the requested box under each
// axis swap finds the orientation the model meant, and the parts are turned to match first.

import type { ObjectSpec } from '../../core/types';
import { rotateAll } from './kits';
import { specFootprint } from './spec';

type Size = { w: number; d: number; h: number };
type V3 = [number, number, number];

interface Candidate { name: string; rot: V3; map: (s: Size) => Size }

// Each candidate: the rotation that fixes it, and the raw size it would produce if applied.
const CANDIDATES: Candidate[] = [
  { name: 'swap-wd', rot: [0, Math.PI / 2, 0], map: (s) => ({ w: s.d, d: s.w, h: s.h }) },
  { name: 'z-up', rot: [-Math.PI / 2, 0, 0], map: (s) => ({ w: s.w, d: s.h, h: s.d }) },
  { name: 'x-up', rot: [0, 0, Math.PI / 2], map: (s) => ({ w: s.h, d: s.d, h: s.w }) },
];

/** Sum of absolute log ratios between two boxes, per axis weights (0 = identical proportions). */
export function boxMismatch(a: Size, b: Size, wt: Size = { w: 1, d: 1, h: 1 }): number {
  const l = (x: number, y: number) => Math.abs(Math.log(Math.max(x, 1e-3) / Math.max(y, 1e-3)));
  return wt.w * l(a.w, b.w) + wt.d * l(a.d, b.d) + wt.h * l(a.h, b.h);
}

/**
 * Turn the parts when a swapped orientation matches the target far better than the one given.
 * `stated` marks the dimensions the person said (they weigh double). Returns the spec unchanged
 * when the given orientation is fine or nothing is clearly better.
 */
export function fixAxes(spec: ObjectSpec, target: Size, stated: Partial<Record<keyof Size, boolean>> = {}): { spec: ObjectSpec; fixed?: string } {
  if (spec.parts.length < 2) return { spec };
  const fp = specFootprint(spec);
  const raw: Size = { w: fp.w, d: fp.d, h: fp.h };
  const wt: Size = { w: stated.w ? 2 : 1, d: stated.d ? 2 : 1, h: stated.h ? 2 : 1 };
  const base = boxMismatch(raw, target, wt);
  if (base < 0.9) return { spec };
  let best: Candidate | null = null, bestErr = base;
  for (const c of CANDIDATES) {
    const e = boxMismatch(c.map(raw), target, wt);
    if (e < bestErr) { best = c; bestErr = e; }
  }
  // Only act on a clear win: the swap must remove most of the mismatch.
  if (!best || bestErr > base * 0.45 || base - bestErr < 0.7) return { spec };
  const parts = spec.parts.map((p) => ({ ...p, pos: [...p.pos] as V3, ...(p.rot ? { rot: [...p.rot] as V3 } : {}) }));
  const motions = (spec.motions ?? []).map((m) => ({ ...m, axis: [...m.axis] as V3, ...(m.pivot ? { pivot: [...m.pivot] as V3 } : {}) }));
  rotateAll(parts, motions, best.rot, [0, 0, 0]);
  // Re-centre on the floor.
  const nf = specFootprint({ parts });
  const c: V3 = [(nf.minX + nf.maxX) / 2, nf.minY, (nf.minZ + nf.maxZ) / 2];
  const shift = (v: V3): V3 => [v[0] - c[0], v[1] - c[1], v[2] - c[2]].map((x) => Math.round(x * 10000) / 10000) as V3;
  for (const p of parts) p.pos = shift(p.pos);
  for (const m of motions) if (m.pivot) m.pivot = shift(m.pivot);
  const out: ObjectSpec = { ...spec, parts };
  if (motions.length) out.motions = motions;
  return { spec: out, fixed: best.name };
}
