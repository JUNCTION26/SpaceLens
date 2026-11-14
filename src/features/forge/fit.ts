// Rescale a spec to an exact size without stretching thin parts.
//
// Each world axis gets a continuous piecewise-linear map from the old bounding box to the new one.
// Intervals covered by thin parts on that axis (a desk top's thickness, a leg's width, a side
// panel) map with slope 1, so they keep their real thickness; the free space between them takes
// up the change. Because the map is continuous, parts that touched before still touch, and because
// it maps the old bounds onto the new bounds, the result fills `size` exactly.
import type { ObjectMotion, ObjectPart, ObjectSpec } from '../../core/types';
import { coneTopRadius, partBounds, partsBounds, posedParts, rotMatrix, withOpenSize } from './spec';
import * as THREE from 'three';

type Size = { w: number; d: number; h: number };
type Map1 = (x: number) => number;

const THIN_ABS = 0.06;
const THIN_REL = 0.22;
const SMALL_PART = 0.15;
const r5 = (n: number) => Math.round(n * 100000) / 100000;

/** True when a world extent counts as "thickness" for this part. */
function thinExtent(ext: number, partMax: number): boolean {
  return ext <= THIN_ABS || ext <= THIN_REL * partMax || partMax <= SMALL_PART;
}

/** Build the per-axis map from [l0,l1] onto [t0,t1], keeping rigid intervals at slope ~1. */
export function axisMap(l0: number, l1: number, t0: number, t1: number, rigid: Array<[number, number]>): Map1 {
  const L = l1 - l0, T = t1 - t0;
  if (L < 1e-9) return (x) => t0 + T / 2 + (x - (l0 + l1) / 2);
  // Union of rigid intervals clipped to the box.
  const iv = rigid.map(([a, b]) => [Math.max(l0, a), Math.min(l1, b)] as [number, number]).filter(([a, b]) => b - a > 1e-6).sort((p, q) => p[0] - q[0]);
  const merged: Array<[number, number]> = [];
  for (const [a, b] of iv) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1] + 1e-6) last[1] = Math.max(last[1], b); else merged.push([a, b]);
  }
  const R = merged.reduce((s, [a, b]) => s + b - a, 0), F = L - R;
  let rho = 1, k = F > 1e-6 ? (T - R) / F : Infinity;
  const ok = (v: number) => v >= 0.3 && v <= 6;
  if (!ok(k)) {
    rho = Math.sqrt(T / L);
    k = F > 1e-6 ? (T - rho * R) / F : Infinity;
    if (!ok(k)) { rho = k = T / L; }
  }
  // Breakpoints.
  const xs: number[] = [l0], ys: number[] = [t0];
  let x = l0, y = t0;
  for (const [a, b] of merged) {
    if (a > x) { y += (a - x) * k; x = a; xs.push(x); ys.push(y); }
    y += (b - a) * rho; x = b; xs.push(x); ys.push(y);
  }
  if (l1 > x) { y += (l1 - x) * k; xs.push(l1); ys.push(y); }
  // Remove float drift so the far end lands exactly.
  const err = t1 - ys[ys.length - 1];
  for (let i = 1; i < ys.length; i++) ys[i] += err * ((xs[i] - l0) / L);
  const s = T / L;
  return (v: number) => {
    if (v <= l0) return t0 + (v - l0) * s;
    if (v >= l1) return t1 + (v - l1) * s;
    let i = 1;
    while (i < xs.length - 1 && xs[i] < v) i++;
    const x0 = xs[i - 1], x1 = xs[i];
    return x1 - x0 < 1e-12 ? ys[i] : ys[i - 1] + ((v - x0) / (x1 - x0)) * (ys[i] - ys[i - 1]);
  };
}

/** Local axis -> dominant world axis, plus whether the rotation is a signed axis permutation. */
function axisInfo(rot?: [number, number, number]): { dom: number[]; aligned: boolean } {
  const R = rotMatrix(rot);
  const dom: number[] = [];
  let aligned = true;
  for (let k = 0; k < 3; k++) {
    let best = 0, bv = -1;
    for (let i = 0; i < 3; i++) { const v = Math.abs(R[i * 3 + k]); if (v > bv) { bv = v; best = i; } }
    dom.push(best);
    if (bv < 0.9995) aligned = false;
  }
  return { dom, aligned };
}

function mapPart(p: ObjectPart, maps: Map1[]): ObjectPart {
  const b = partBounds(p);
  const { dom, aligned } = axisInfo(p.rot);
  const partMax = Math.max(...p.size);
  const ratio = [0, 1, 2].map((i) => {
    const e = b.max[i] - b.min[i];
    return e < 1e-9 ? 1 : (maps[i](b.max[i]) - maps[i](b.min[i])) / e;
  });
  const pos: [number, number, number] = [0, 1, 2].map((i) => (maps[i](b.min[i]) + maps[i](b.max[i])) / 2) as [number, number, number];
  // For axis-aligned parts the bounds map exactly; rotated parts keep thin local axes.
  const size = p.size.map((s, k) => {
    const r = ratio[dom[k]];
    return aligned || !thinExtent(s, partMax) ? s * r : s * Math.min(Math.max(r, 0.85), 1.15);
  }) as [number, number, number];
  const out: ObjectPart = { ...p, pos: pos.map(r5) as [number, number, number], size: size.map((v) => r5(Math.max(0.002, v))) as [number, number, number] };
  if (p.shape === 'cone' && p.radius != null) {
    const sc = (size[0] / p.size[0] + size[2] / p.size[2]) / 2;
    out.radius = r5(coneTopRadius(p) * sc);
  } else if (p.radius != null) {
    out.radius = r5(Math.min(p.radius, Math.min(...out.size) / 2));
  }
  return out;
}

function mapMotion(m: ObjectMotion, maps: Map1[], slope: number[]): ObjectMotion {
  if (m.kind === 'hinge' && m.pivot) return { ...m, pivot: m.pivot.map((v, i) => r5(maps[i](v))) as [number, number, number] };
  if (m.kind === 'slide') {
    const s = Math.abs(m.axis[0]) * slope[0] + Math.abs(m.axis[1]) * slope[1] + Math.abs(m.axis[2]) * slope[2];
    return { ...m, open: r5(m.open * Math.min(Math.max(s, 0.5), 2)) };
  }
  return m;
}

function applyMaps(spec: ObjectSpec, target: Array<[number, number]>, rigidAware: boolean): ObjectSpec {
  const b = partsBounds(spec.parts);
  const maps: Map1[] = [];
  const slope: number[] = [];
  for (let i = 0; i < 3; i++) {
    const rigid: Array<[number, number]> = [];
    if (rigidAware) for (const p of spec.parts) {
      const pb = partBounds(p);
      const e = pb.max[i] - pb.min[i];
      if (thinExtent(e, Math.max(...p.size))) rigid.push([pb.min[i], pb.max[i]]);
    }
    maps.push(axisMap(b.min[i], b.max[i], target[i][0], target[i][1], rigid));
    const L = b.max[i] - b.min[i];
    slope.push(L > 1e-9 ? (target[i][1] - target[i][0]) / L : 1);
  }
  return {
    ...spec,
    parts: spec.parts.map((p) => mapPart(p, maps)),
    motions: spec.motions?.map((m) => mapMotion(m, maps, slope)),
  };
}

const boxErr = (spec: ObjectSpec, t: Array<[number, number]>) => {
  const b = partsBounds(spec.parts);
  return Math.max(...[0, 1, 2].flatMap((i) => [Math.abs(b.min[i] - t[i][0]), Math.abs(b.max[i] - t[i][1])]));
};

/**
 * Rescale parts so the overall bounding box equals `size` exactly (centred on x/z, standing on
 * y = 0). Thin parts keep their thickness; positions and long axes take up the change.
 */
export function fitSpec(spec: ObjectSpec, size: Size): ObjectSpec {
  const w = Math.max(0.01, size.w), d = Math.max(0.01, size.d), h = Math.max(0.01, size.h);
  const target: Array<[number, number]> = [[-w / 2, w / 2], [0, h], [-d / 2, d / 2]];
  let out: ObjectSpec = { ...spec, size: { w, d, h } };
  if (!spec.parts.length) return out;
  out = applyMaps(out, target, true);
  // Rotated parts can leave a sliver of error; a few plain linear passes close it.
  for (let n = 0; n < 6 && boxErr(out, target) > 0.0002; n++) out = applyMaps(out, target, false);
  if (!out.motions) delete out.motions;
  else out = keepOpenFloorContact(spec, out);
  return withOpenSize(out);
}

/** Lowest point of a motion group when fully open. */
function openGroupMinY(spec: ObjectSpec, group: string): number {
  const parts = posedParts(spec, 1).filter((p) => p.group === group);
  return parts.length ? partsBounds(parts).min[1] : Infinity;
}

/**
 * A fold-down bed or a drop-front that rested on the floor when open should still do so after
 * rescaling. Moving a hinge pivot leaves the closed pose untouched and shifts only the open pose,
 * so the pivot is nudged until the open group touches the floor again.
 */
function keepOpenFloorContact(before: ObjectSpec, after: ObjectSpec): ObjectSpec {
  if (!after.motions) return after;
  const motions = after.motions.map((m) => {
    if (m.kind !== 'hinge' || !m.pivot) return m;
    const was = openGroupMinY(before, m.group);
    if (Math.abs(was) > 0.005) return m;
    const now = openGroupMinY({ ...after, motions: [m] }, m.group);
    if (Math.abs(now) < 1e-5) return m;
    // Effect of a unit pivot shift along y on the open pose: ((I - R) y)_y.
    const R = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(...m.axis), m.open);
    const ry = new THREE.Vector3(0, 1, 0).applyMatrix4(R);
    const e = 1 - ry.y;
    if (Math.abs(e) < 0.2) return m;
    return { ...m, pivot: [m.pivot[0], r5(m.pivot[1] - now / e), m.pivot[2]] as [number, number, number] };
  });
  return { ...after, motions };
}
