// Renders an ObjectSpec as real geometry: rounded and bevelled blocks, soft cushions with piping,
// tapered legs, turned (lathe) and extruded curved parts, PBR materials with texel density in
// metres, moving groups (hinges, slides) and an assembly animation while a spec streams in.
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { ContactShadows, Environment, OrbitControls } from '@react-three/drei';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { ObjectMotion, ObjectPart, ObjectSpec } from '../../core/types';
import { materialFor, MATERIAL_DEFS } from './materials';
import { coneTopRadius, longestAxis } from './spec';

// ---- Geometry ----------------------------------------------------------------------------

type V3 = [number, number, number];
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Sample positions along one axis: dense near rounded corners, `inner` segments across the flat. */
function axisSamples(h: number, r: number, nCorner: number, inner: number): number[] {
  const out: number[] = [];
  const c = h - r;
  if (r > 1e-6) for (let k = nCorner; k >= 1; k--) out.push(-(c + r * Math.tan((k * Math.PI) / 4 / nCorner)));
  for (let i = 0; i <= inner; i++) out.push(-c + (2 * c * i) / inner);
  if (r > 1e-6) for (let k = 1; k <= nCorner; k++) out.push(c + r * Math.tan((k * Math.PI) / 4 / nCorner));
  return out;
}

interface SoftBoxOpts {
  /** Corner radius. */
  r: number;
  nCorner: number;
  inner: [number, number, number];
  /** Outward puff per axis (cushions). */
  bulge?: V3;
  /** Taper along an axis: section scales from `k` at the negative end to 1 at the positive end. */
  taper?: { axis: number; k: number };
}

/** Maps a point on the base box surface to the final surface. Defined everywhere outside the inner box. */
function softBoxMap(H: V3, o: SoftBoxOpts) {
  const b = o.bulge ?? [0, 0, 0];
  const Hb: V3 = [H[0] - b[0], H[1] - b[1], H[2] - b[2]];
  const r = Math.min(o.r, Hb[0], Hb[1], Hb[2]);
  const w = (x: number) => { const t = Math.min(1, x * x); return (1 - t) * (1 - t); };
  return (p: V3, out: V3): V3 => {
    let q0 = p[0], q1 = p[1], q2 = p[2];
    if (r > 1e-7) {
      const i0 = clamp(q0, -(Hb[0] - r), Hb[0] - r), i1 = clamp(q1, -(Hb[1] - r), Hb[1] - r), i2 = clamp(q2, -(Hb[2] - r), Hb[2] - r);
      const d0 = q0 - i0, d1 = q1 - i1, d2 = q2 - i2, L = Math.hypot(d0, d1, d2);
      if (L > 1e-12) { q0 = i0 + (d0 * r) / L; q1 = i1 + (d1 * r) / L; q2 = i2 + (d2 * r) / L; }
    }
    const q: V3 = [q0, q1, q2];
    if (o.bulge) {
      const base: V3 = [q0, q1, q2];
      for (let a = 0; a < 3; a++) {
        if (b[a] <= 0) continue;
        const u = (a + 1) % 3, v = (a + 2) % 3;
        q[a] += Math.sign(base[a]) * b[a] * w(base[u] / Hb[u]) * w(base[v] / Hb[v]);
      }
    }
    if (o.taper) {
      const t = o.taper.axis;
      const s = o.taper.k + (1 - o.taper.k) * clamp((q[t] + H[t]) / (2 * H[t]), 0, 1);
      for (let a = 0; a < 3; a++) if (a !== t) q[a] *= s;
    }
    out[0] = q[0]; out[1] = q[1]; out[2] = q[2];
    return out;
  };
}

/** Rounded / soft / tapered block with seamless analytic-ish normals and metre UVs. */
function softBox(size: V3, o: SoftBoxOpts, uvLong: number, uvOff: [number, number]): { geo: THREE.BufferGeometry; map: (p: V3, out: V3) => V3 } {
  const H: V3 = [size[0] / 2, size[1] / 2, size[2] / 2];
  const F = softBoxMap(H, o);
  const b = o.bulge ?? [0, 0, 0];
  const r = Math.min(o.r, H[0] - b[0], H[1] - b[1], H[2] - b[2]);
  const S = [0, 1, 2].map((a) => axisSamples(H[a] - b[a], r, o.nCorner, o.inner[a]));
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
  const p: V3 = [0, 0, 0], q: V3 = [0, 0, 0], qa: V3 = [0, 0, 0], qb: V3 = [0, 0, 0], qc: V3 = [0, 0, 0], qd: V3 = [0, 0, 0];
  const eps = 1e-4;
  for (let a = 0; a < 3; a++) for (const s of [1, -1]) {
    const u = (a + 1) % 3, v = (a + 2) % 3;
    const su = S[u], sv = S[v], base = pos.length / 3;
    const hb = H[a] - b[a];
    for (let j = 0; j < sv.length; j++) for (let i = 0; i < su.length; i++) {
      p[a] = s * hb; p[u] = su[i]; p[v] = sv[j];
      F(p, q);
      const pu = [...p] as V3, pv = [...p] as V3;
      pu[u] += eps; F(pu, qa); pu[u] -= 2 * eps; F(pu, qb);
      pv[v] += eps; F(pv, qc); pv[v] -= 2 * eps; F(pv, qd);
      const tu = new THREE.Vector3(qa[0] - qb[0], qa[1] - qb[1], qa[2] - qb[2]);
      const tv = new THREE.Vector3(qc[0] - qd[0], qc[1] - qd[1], qc[2] - qd[2]);
      const n = tu.cross(tv);
      if (n.lengthSq() < 1e-20) n.set(0, 0, 0).setComponent(a, 1);
      n.normalize().multiplyScalar(s);
      pos.push(q[0], q[1], q[2]); nor.push(n.x, n.y, n.z);
      // V runs along the part's long axis when it lies in this face.
      const [ua, va] = v === uvLong ? [u, v] : u === uvLong ? [v, u] : [u, v];
      uv.push(q[ua] + uvOff[0], q[va] + uvOff[1]);
    }
    const W = su.length;
    for (let j = 0; j < sv.length - 1; j++) for (let i = 0; i < W - 1; i++) {
      const A = base + j * W + i, B = A + 1, C = A + W + 1, D = A + W;
      if (s > 0) idx.push(A, B, C, A, C, D); else idx.push(A, C, B, A, D, C);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  return { geo, map: F };
}

/** Metre UVs by dominant normal axis; V follows the long axis. */
function metreUV(geo: THREE.BufferGeometry, uvLong: number, off: [number, number]) {
  const P = geo.getAttribute('position'), N = geo.getAttribute('normal');
  const uv = new Float32Array(P.count * 2);
  for (let i = 0; i < P.count; i++) {
    const n = [Math.abs(N.getX(i)), Math.abs(N.getY(i)), Math.abs(N.getZ(i))];
    const a = n[0] >= n[1] && n[0] >= n[2] ? 0 : n[1] >= n[2] ? 1 : 2;
    const u = (a + 1) % 3, v = (a + 2) % 3;
    const [ua, va] = v === uvLong ? [u, v] : u === uvLong ? [v, u] : [u, v];
    const p = [P.getX(i), P.getY(i), P.getZ(i)];
    uv[i * 2] = p[ua] + off[0]; uv[i * 2 + 1] = p[va] + off[1];
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/** Corner cutting that rounds gentle corners and keeps sharp ones (> 60 degree turns). */
export function smoothOutline(pts: Array<[number, number]>, closed: boolean, iters = 2): Array<[number, number]> {
  let cur = pts;
  for (let it = 0; it < iters && cur.length < 160; it++) {
    const out: Array<[number, number]> = [];
    const n = cur.length;
    for (let i = 0; i < n; i++) {
      const p = cur[i];
      if (!closed && (i === 0 || i === n - 1)) { out.push(p); continue; }
      const a = cur[(i - 1 + n) % n], c = cur[(i + 1) % n];
      const v1x = p[0] - a[0], v1y = p[1] - a[1], v2x = c[0] - p[0], v2y = c[1] - p[1];
      const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
      const cos = l1 > 0 && l2 > 0 ? (v1x * v2x + v1y * v2y) / (l1 * l2) : 1;
      if (cos < 0.5) { out.push(p); continue; }
      out.push([p[0] - v1x * 0.25, p[1] - v1y * 0.25], [p[0] + v2x * 0.25, p[1] + v2y * 0.25]);
    }
    cur = out;
  }
  return cur;
}

function lathe(profile: Array<[number, number]>, segs: number): THREE.BufferGeometry {
  return new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(Math.max(0, r), y)), segs);
}

/** Round profile (bottom radius rb, top radius rt, half height h) with small bevels. */
function roundProfile(rb: number, rt: number, h: number, bevel: number): Array<[number, number]> {
  const pts: Array<[number, number]> = [[0, -h]];
  const arc = (cx: number, cy: number, r: number, a0: number, a1: number) => {
    for (let k = 0; k <= 3; k++) { const a = a0 + ((a1 - a0) * k) / 3; pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  };
  const bb = Math.min(bevel, rb * 0.4, h * 0.4), bt = Math.min(bevel, rt * 0.4, h * 0.4);
  if (bb > 1e-5) arc(rb - bb, -h + bb, bb, -Math.PI / 2, 0); else pts.push([rb, -h]);
  if (rt > 1e-5) { if (bt > 1e-5) arc(rt - bt, h - bt, bt, 0, Math.PI / 2); else pts.push([rt, h]); }
  pts.push([0, h]);
  return pts;
}

const isMetal = (p: ObjectPart) => MATERIAL_DEFS[p.material]?.kind === 'metal' || p.material === 'plastic';

/** Seed in [0, 3) so identical parts do not show identical texture. */
function uvSeed(p: ObjectPart, i: number): [number, number] {
  let h = 2166136261 ^ i;
  for (const ch of p.name) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return [((h >>> 0) % 997) / 333, ((h >>> 10) % 991) / 331];
}

export interface PartGeometry { geo: THREE.BufferGeometry; piping?: THREE.BufferGeometry }

/** Geometry for one part in its local frame (centred, before rotation). */
export function partGeometry(p: ObjectPart, seed: [number, number] = [0, 0]): PartGeometry {
  const s = p.size.map((v) => Math.max(v, 0.002)) as V3;
  const minS = Math.min(...s), long = longestAxis(s);
  switch (p.shape) {
    case 'box':
      return { geo: softBox(s, { r: Math.min(0.0015, minS * 0.15), nCorner: 1, inner: [1, 1, 1] }, long, seed).geo };
    case 'panel':
      return { geo: softBox(s, { r: Math.min(0.003, minS * 0.3), nCorner: 2, inner: [1, 1, 1] }, long, seed).geo };
    case 'rounded': {
      const r = clamp(p.radius ?? Math.min(minS * 0.25, 0.03), 0.0005, minS / 2 * 0.98);
      return { geo: softBox(s, { r, nCorner: r > 0.02 ? 6 : 4, inner: [1, 1, 1] }, long, seed).geo };
    }
    case 'cushion': {
      const t = minS, thin = s.indexOf(minS);
      const bulge: V3 = [0, 0, 0];
      for (let a = 0; a < 3; a++) bulge[a] = a === thin ? t * 0.14 : Math.min(t * 0.06, 0.012);
      const r = Math.min((t - 2 * bulge[thin]) * 0.48, ...s.map((v, a) => (v / 2 - bulge[a]) * 0.6));
      const inner: V3 = [0, 1, 2].map((a) => (a === thin ? 1 : clamp(Math.round(s[a] / 0.05), 6, 14))) as V3;
      const { geo, map } = softBox(s, { r, nCorner: 5, inner, bulge }, long, seed);
      // Piping welt around the mid-plane perimeter.
      const H: V3 = [s[0] / 2 - bulge[0], s[1] / 2 - bulge[1], s[2] / 2 - bulge[2]];
      const u = (thin + 1) % 3, v = (thin + 2) % 3;
      const pts: THREE.Vector3[] = [];
      const ring: Array<[number, number]> = [];
      const su = axisSamples(H[u], 0, 1, 12), sv = axisSamples(H[v], 0, 1, 12);
      for (const x of su) ring.push([x, -H[v]]);
      for (const y of sv.slice(1)) ring.push([H[u], y]);
      for (const x of [...su].reverse().slice(1)) ring.push([x, H[v]]);
      for (const y of [...sv].reverse().slice(1, -1)) ring.push([-H[u], y]);
      const pipeR = clamp(t * 0.035, 0.0025, 0.006);
      const tmp: V3 = [0, 0, 0], o: V3 = [0, 0, 0];
      for (const [x, y] of ring) {
        tmp[thin] = 0; tmp[u] = x; tmp[v] = y;
        map(tmp, o);
        const c = new THREE.Vector3(o[0], o[1], o[2]);
        const n = new THREE.Vector3(o[0], o[1], o[2]).setComponent(thin, 0).normalize();
        pts.push(c.addScaledVector(n, -pipeR * 0.7));
      }
      const curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal');
      const piping = new THREE.TubeGeometry(curve, Math.min(400, pts.length * 3), pipeR, 6, true);
      metreUV(piping, long, seed);
      return { geo, piping };
    }
    case 'leg': {
      const tAxis = long;
      const round = isMetal(p) || (p.radius != null && p.radius >= 0.4 * Math.min(...s.filter((_, a) => a !== tAxis)));
      if (round) {
        const L = s[tAxis] / 2, others = s.filter((_, a) => a !== tAxis), R = Math.max(...others) / 2;
        const geo = lathe(roundProfile(R * (isMetal(p) ? 0.85 : 0.68), R, L, Math.min(0.002, R * 0.3)), 20);
        const sx = others[0] / 2 / R, sz = others[1] / 2 / R;
        geo.scale(sx, 1, sz);
        if (tAxis === 0) geo.rotateZ(-Math.PI / 2); else if (tAxis === 2) geo.rotateX(Math.PI / 2);
        metreUV(geo, tAxis, seed);
        return { geo };
      }
      return { geo: softBox(s, { r: Math.min(minS * 0.22, 0.008), nCorner: 3, inner: [1, 4, 1].map((v, a) => (a === tAxis ? 4 : 1)) as V3, taper: { axis: tAxis, k: 0.7 } }, long, seed).geo };
    }
    case 'tube': {
      const L = s[long] / 2, others = s.filter((_, a) => a !== long), R = Math.max(...others) / 2;
      const geo = lathe(roundProfile(R, R, L, Math.min(0.002, R * 0.4)), R > 0.03 ? 24 : 14);
      geo.scale(others[0] / 2 / R, 1, others[1] / 2 / R);
      if (long === 0) geo.rotateZ(-Math.PI / 2); else if (long === 2) geo.rotateX(Math.PI / 2);
      metreUV(geo, long, seed);
      return { geo };
    }
    case 'cylinder': case 'cone': {
      const R = Math.max(s[0], s[2]) / 2;
      const rt = p.shape === 'cone' ? coneTopRadius(p) : R;
      const rb = R;
      const big = Math.max(rb, rt);
      const geo = lathe(roundProfile(rb, rt, s[1] / 2, Math.min(0.004, big * 0.15)), big > 0.15 ? 64 : big > 0.04 ? 40 : 20);
      geo.scale(s[0] / 2 / R, 1, s[2] / 2 / R);
      metreUV(geo, long, seed);
      return { geo };
    }
    case 'sphere': {
      const geo = new THREE.SphereGeometry(0.5, 40, 24);
      geo.scale(s[0], s[1], s[2]);
      metreUV(geo, long, seed);
      return { geo };
    }
    case 'lathe': {
      let prof = (p.profile ?? [[0.5, -0.5], [0.5, 0.5]]).map(([r, y]) => [Math.abs(r), y] as [number, number]);
      const f = prof[0], l = prof[prof.length - 1];
      // A closed loop that stays off the axis revolves into a ring (a footrest, a rim).
      const ring = prof.length > 3 && Math.abs(f[0] - l[0]) < 1e-6 && Math.abs(f[1] - l[1]) < 1e-6 && f[0] > 1e-6;
      if (!ring) {
        if (f[0] > 1e-6) prof = [[0, f[1]], ...prof];
        if (prof[prof.length - 1][0] > 1e-6) prof = [...prof, [0, prof[prof.length - 1][1]]];
      }
      if (prof.length < 48) prof = ring ? ((sm) => [...sm, sm[0]])(smoothOutline(prof.slice(0, -1), true, 2)) : smoothOutline(prof, false, 2);
      if (ring) prof[prof.length - 1] = prof[0];
      const maxR = Math.max(...prof.map((q) => q[0])) || 1;
      const ys = prof.map((q) => q[1]), y0 = Math.min(...ys), y1 = Math.max(...ys), hy = (y1 - y0) || 1;
      const norm = prof.map(([r, y]) => [(r / maxR) * 0.5, (y - y0) / hy - 0.5] as [number, number]);
      const geo = lathe(norm, 64);
      geo.scale(s[0], s[1], s[2]);
      metreUV(geo, long, seed);
      return { geo };
    }
    case 'extrude': {
      let prof = p.profile ?? [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
      if (prof.length > 2) {
        const f = prof[0], l = prof[prof.length - 1];
        if (Math.abs(f[0] - l[0]) < 1e-6 && Math.abs(f[1] - l[1]) < 1e-6) prof = prof.slice(0, -1);
      }
      if (prof.length < 48) prof = smoothOutline(prof, true, 2);
      const bevel = Math.min(0.006, s[2] * 0.25, s[0] * 0.1, s[1] * 0.1);
      const xs = prof.map((q) => q[0]), ys = prof.map((q) => q[1]);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      const W = s[0] - 2 * bevel, Hh = s[1] - 2 * bevel;
      const shape = new THREE.Shape(prof.map(([x, y]) => new THREE.Vector2(((x - x0) / ((x1 - x0) || 1) - 0.5) * W, ((y - y0) / ((y1 - y0) || 1) - 0.5) * Hh)));
      const depth = Math.max(0.0005, s[2] - 2 * bevel);
      let geo: THREE.BufferGeometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: bevel > 0.0003, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, curveSegments: 4 });
      geo.translate(0, 0, -depth / 2);
      geo.deleteAttribute('normal');
      geo = toCreasedNormals(geo, Math.PI / 5);
      metreUV(geo, long, seed);
      return { geo };
    }
  }
  return { geo: softBox(s, { r: 0.002, nCorner: 1, inner: [1, 1, 1] }, long, seed).geo };
}

function geoKey(p: ObjectPart, seed: [number, number]): string {
  const mm = (v: number) => Math.round(v * 10000);
  return [p.shape, ...p.size.map(mm), p.radius != null ? mm(p.radius) : '', p.shape === 'leg' ? isMetal(p) : '', p.profile ? JSON.stringify(p.profile) : '', seed[0].toFixed(2), seed[1].toFixed(2)].join('|');
}

// ---- Rendering ---------------------------------------------------------------------------

export interface GeneratedMeshProps {
  spec: ObjectSpec;
  selected?: boolean;
  ghost?: boolean;
  /** Animate parts flying in one by one in spec order (the parts array may keep growing). */
  assembling?: boolean;
  /** 0 closed .. 1 fully open, for specs with motions. Animated. */
  open?: number;
}

const FLY_S = 0.55, STAGGER_S = 0.07;
const easeOutBack = (t: number) => { const c1 = 1.5, c3 = c1 + 1; return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2; };
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;

function PartMesh({ part, g, start, ghost, selected }: { part: ObjectPart; g: PartGeometry; start: number; ghost: boolean; selected: boolean }) {
  const shared = materialFor(part.material, part.color, { ghost, selected });
  const [done, setDone] = useState(() => now() >= start + FLY_S);
  const animMat = useMemo(() => {
    if (done) return null;
    const m = shared.clone();
    m.transparent = true; m.opacity = 0;
    return m;
  }, [done, shared]);
  useEffect(() => () => animMat?.dispose(), [animMat]);
  const ref = useRef<THREE.Group>(null);
  const invalidate = useThree((s) => s.invalidate);
  const lift = Math.max(0.35, part.size[1] * 2);
  useFrame(() => {
    if (done || !ref.current || !animMat) return;
    const t = clamp((now() - start) / FLY_S, 0, 1);
    const e = easeOutBack(t);
    ref.current.position.set(part.pos[0] * (1 + (1 - t) * 0.25), part.pos[1] + (1 - e) * lift, part.pos[2] * (1 + (1 - t) * 0.25));
    ref.current.scale.setScalar(0.6 + 0.4 * e);
    animMat.opacity = Math.min(1, t * 1.6) * (ghost ? 0.35 : 1);
    if (t >= 1) setDone(true);
    invalidate();
  });
  const mat = animMat ?? shared;
  const shadow = !ghost && part.material !== 'glass';
  const rot = part.rot ?? [0, 0, 0];
  return (
    <group ref={ref} position={done ? part.pos : [part.pos[0], part.pos[1] + lift, part.pos[2]]} scale={done ? 1 : 0.6}>
      <group rotation={rot}>
        <mesh geometry={g.geo} material={mat} castShadow={shadow} receiveShadow />
        {g.piping && <mesh geometry={g.piping} material={mat} castShadow={false} receiveShadow />}
      </group>
    </group>
  );
}

function MotionGroup({ motion, open, children }: { motion: ObjectMotion; open: number; children: React.ReactNode }) {
  const outer = useRef<THREE.Group>(null);
  const cur = useRef(open);
  const invalidate = useThree((s) => s.invalidate);
  const pivot = motion.pivot ?? [0, 0, 0];
  const apply = (t: number) => {
    const g = outer.current;
    if (!g) return;
    const ax = new THREE.Vector3(...motion.axis);
    if (motion.kind === 'hinge') { g.quaternion.setFromAxisAngle(ax, motion.open * t); g.position.set(...pivot); }
    else { g.quaternion.identity(); g.position.copy(ax.multiplyScalar(motion.open * t)); }
  };
  useEffect(() => { apply(cur.current); });
  useFrame((_, dt) => {
    const target = clamp(open, 0, 1);
    if (Math.abs(cur.current - target) < 1e-4) return;
    const step = Math.min(1, dt * 3.2);
    cur.current += (target - cur.current) * step + Math.sign(target - cur.current) * Math.min(Math.abs(target - cur.current), dt * 0.15);
    if (Math.abs(cur.current - target) < 1e-3) cur.current = target;
    apply(cur.current);
    invalidate();
  });
  return (
    <group ref={outer}>
      <group position={motion.kind === 'hinge' ? [-pivot[0], -pivot[1], -pivot[2]] : [0, 0, 0]}>{children}</group>
    </group>
  );
}

/** A generated object in its local frame (floor centre at the origin, front facing +z). */
export function GeneratedMesh({ spec, selected = false, ghost = false, assembling = false, open = 0 }: GeneratedMeshProps) {
  const cache = useRef(new Map<string, PartGeometry>());
  const starts = useRef<number[]>([]);
  const parts = spec.parts;

  // Geometry per part, deduplicated and kept across renders while the parts array grows.
  const geos = useMemo(() => parts.map((p, i) => {
    const seed = uvSeed(p, i);
    const k = geoKey(p, seed);
    let g = cache.current.get(k);
    if (!g) { g = partGeometry(p, seed); cache.current.set(k, g); }
    return { k, g };
  }), [parts]);
  useEffect(() => {
    const live = new Set(geos.map((x) => x.k));
    for (const [k, g] of cache.current) if (!live.has(k)) { g.geo.dispose(); g.piping?.dispose(); cache.current.delete(k); }
  }, [geos]);
  useEffect(() => () => { for (const g of cache.current.values()) { g.geo.dispose(); g.piping?.dispose(); } cache.current.clear(); }, []);

  // Fly-in start times: each new part waits for the previous one.
  const t = now();
  for (let i = 0; i < parts.length; i++) {
    if (starts.current[i] !== undefined) continue;
    if (!assembling) { starts.current[i] = -Infinity; continue; }
    const prev = i > 0 && Number.isFinite(starts.current[i - 1]) ? starts.current[i - 1] + STAGGER_S : t;
    starts.current[i] = Math.max(t, prev);
  }
  if (starts.current.length > parts.length) starts.current.length = parts.length;

  const motions = new Map((spec.motions ?? []).map((m) => [m.group, m]));
  const render = (i: number) => (
    <PartMesh key={`${i}:${geos[i].k}`} part={parts[i]} g={geos[i].g} start={starts.current[i]} ghost={ghost} selected={selected} />
  );
  const fixed: number[] = [], grouped = new Map<string, number[]>();
  parts.forEach((p, i) => {
    if (p.group && motions.has(p.group)) { const arr = grouped.get(p.group) ?? []; arr.push(i); grouped.set(p.group, arr); }
    else fixed.push(i);
  });
  return (
    <group>
      {fixed.map(render)}
      {[...grouped].map(([gname, idx]) => (
        <MotionGroup key={gname} motion={motions.get(gname)!} open={open}>{idx.map(render)}</MotionGroup>
      ))}
    </group>
  );
}

// ---- Headless visual check -----------------------------------------------------------------

/**
 * A standalone stage for looking at one spec (or a grid of them): studio lighting, soft contact
 * shadow, camera framed on the object. Used by scripts/forge-shot for screenshots.
 */
export function ForgeShot({ specs, open = 0, cols, assembling = false }: { specs: ObjectSpec[]; open?: number; cols?: number; assembling?: boolean }) {
  const n = Math.max(1, specs.length), c = cols ?? Math.ceil(Math.sqrt(n));
  const cell = Math.max(1.2, ...specs.map((s) => Math.max(s.size.w, s.size.d, (s.openSize?.d ?? 0)) + 0.6));
  const rows = Math.ceil(n / c);
  const placed = specs.map((s, i) => ({ s, x: ((i % c) - (c - 1) / 2) * cell, z: (Math.floor(i / c) - (rows - 1) / 2) * cell }));
  const maxH = Math.max(...specs.map((s) => s.size.h), 0.5);
  const span = Math.max(c, rows) * cell;
  const dist = n === 1 ? Math.max(specs[0].size.w, specs[0].size.d * 1.2, specs[0].size.h * 1.2, (open ? specs[0].openSize?.d : 0) ?? 0) * 1.6 + 0.5 : span * 1.05;
  const target: V3 = [0, n === 1 ? maxH * 0.42 : 0.3, 0];
  const BASE = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  return (
    <Canvas shadows dpr={1} camera={{ position: [dist * 0.62, maxH * 0.55 + dist * 0.42, dist * 0.82], fov: 38, near: 0.02, far: 100 }}
      gl={{ antialias: true, preserveDrawingBuffer: true }}
      onCreated={({ gl, camera }) => { gl.toneMapping = THREE.ACESFilmicToneMapping; gl.toneMappingExposure = 0.95; gl.shadowMap.type = THREE.PCFSoftShadowMap; camera.lookAt(...target); }}
      style={{ width: '100%', height: '100%', background: '#ece9e4' }}>
      <color attach="background" args={['#ece9e4']} />
      <hemisphereLight args={['#f4f1ea', '#6b6358', 0.25]} />
      <directionalLight position={[3, 5, 4]} intensity={2.2} castShadow shadow-mapSize={[2048, 2048]} shadow-bias={-0.0003} shadow-normalBias={0.02}
        shadow-camera-left={-span} shadow-camera-right={span} shadow-camera-top={span} shadow-camera-bottom={-span} />
      <Suspense fallback={null}>
        <Environment files={BASE + 'assets/env/lebombo_1k.hdr'} environmentIntensity={0.8} />
      </Suspense>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[60, 60]} />
        <meshStandardMaterial color="#e4e0d9" roughness={0.95} />
      </mesh>
      <ContactShadows position={[0, 0.002, 0]} scale={span * 1.6} opacity={0.5} blur={2.4} far={1.5} resolution={1024} color="#2a2118" />
      {placed.map(({ s, x, z }) => (
        <group key={s.id + x + z} position={[x, 0, z]}>
          <GeneratedMesh spec={s} open={open} assembling={assembling} />
        </group>
      ))}
      <OrbitControls target={target} makeDefault />
    </Canvas>
  );
}
