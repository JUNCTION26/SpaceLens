import { memo, Suspense, useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { RoundedBox, useGLTF } from '@react-three/drei';
import { modelSpecFor, modelUrl, type ModelSpec } from './assets';
import type { FurnitureItem } from '../../core/types';
import { GeneratedMesh } from '../forge/GeneratedMesh';
import { fitSpec } from '../forge/fit';

type Mat = THREE.MeshStandardMaterial;
interface Mats { main: Mat; dark: Mat; soft: Mat; white: Mat; metal: Mat; green: Mat; pot: Mat; book: Mat[]; glow: Mat }

const shade = (hex: string, f: number) => {
  const col = new THREE.Color(hex);
  return f >= 0 ? col.lerp(new THREE.Color('#ffffff'), f) : col.multiplyScalar(1 + f);
};

// Shared procedural textures, created once per page and never disposed with items.
let woodTex: THREE.CanvasTexture | null = null, fabricTex: THREE.CanvasTexture | null = null;
function canvasTex(draw: (g: CanvasRenderingContext2D, n: number) => void): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const n = 256, cv = document.createElement('canvas'); cv.width = cv.height = n;
  const g = cv.getContext('2d'); if (!g) return null;
  draw(g, n);
  const t = new THREE.CanvasTexture(cv); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function wood() {
  return woodTex ??= canvasTex((g, n) => {
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, n, n);
    for (let i = 0; i < 70; i++) {
      const y = Math.random() * n, a = 0.04 + Math.random() * 0.1;
      g.strokeStyle = `rgba(60,35,15,${a})`; g.lineWidth = 0.5 + Math.random() * 2; g.beginPath();
      for (let x = 0; x <= n; x += 8) g.lineTo(x, y + Math.sin(x / 40 + i) * 3);
      g.stroke();
    }
  });
}
function fabric() {
  return fabricTex ??= canvasTex((g, n) => {
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, n, n);
    for (let i = 0; i < n; i += 2) { g.fillStyle = `rgba(0,0,0,${0.03 + (i % 4) * 0.01})`; g.fillRect(i, 0, 1, n); g.fillRect(0, i, n, 1); }
  });
}
type Kind = 'wood' | 'fabric' | 'metal' | 'plain';
export function materialKind(material = ''): Kind {
  const t = material.toLowerCase();
  if (/oak|birch|pine|beech|walnut|wood|veneer/.test(t)) return 'wood';
  if (/fabric|linen|wool|velvet|felt|upholster|mesh/.test(t)) return 'fabric';
  if (/steel|metal|chrome/.test(t) && !/wood/.test(t)) return 'metal';
  return 'plain';
}

function makeMats(color: string, selected: boolean, ghost: boolean, material?: string): Mats {
  const kind = materialKind(material);
  const m = (c: THREE.Color | string, rough = 0.75, metal = 0, map?: THREE.Texture | null): Mat => {
    const mat = new THREE.MeshStandardMaterial({ color: c, roughness: rough, metalness: metal, map: map ?? null });
    if (ghost) { mat.transparent = true; mat.opacity = 0.35; mat.depthWrite = false; }
    if (selected) { mat.emissive = new THREE.Color('#4da3ff'); mat.emissiveIntensity = 0.35; }
    return mat;
  };
  return {
    main: kind === 'wood' ? m(color, 0.6, 0, wood()) : kind === 'fabric' ? m(color, 0.98, 0, fabric()) : kind === 'metal' ? m(color, 0.35, 0.6) : m(color, 0.55),
    dark: m(shade(color, -0.35), kind === 'metal' ? 0.4 : 0.7, kind === 'metal' ? 0.5 : 0),
    soft: m(shade(color, 0.25), 0.95, 0, kind === 'fabric' ? fabric() : null), white: m('#f3f1ec', 0.9),
    metal: m('#8a8f96', 0.35, 0.7), green: m('#4f7d4a', 0.9), pot: m('#b9a48d', 0.8), glow: m('#fff3d6', 0.4),
    book: ['#8c3b3b', '#2f5d7c', '#c9a227', '#3e6b48', '#6b4a7a'].map((c) => m(c, 0.8)),
  };
}

interface P { w: number; d: number; h: number; m: Mats; shadow: boolean }
type V3 = [number, number, number];

function B({ s, p, mat, shadow, r }: { s: V3; p: V3; mat: Mat; shadow: boolean; r?: number }) {
  if (r) return <RoundedBox args={s} radius={Math.min(r, ...s.map((x) => x / 2.01))} smoothness={3} position={p} material={mat} castShadow={shadow} receiveShadow />;
  return <mesh position={p} material={mat} castShadow={shadow} receiveShadow><boxGeometry args={s} /></mesh>;
}
function Cyl({ r, h, p, mat, shadow, r2 }: { r: number; h: number; p: V3; mat: Mat; shadow: boolean; r2?: number }) {
  return <mesh position={p} material={mat} castShadow={shadow} receiveShadow><cylinderGeometry args={[r2 ?? r, r, h, 16]} /></mesh>;
}

/** Four legs at the corners of a w x d footprint. */
function Legs({ w, d, h, t = 0.04, mat, shadow, inset = 0.04 }: { w: number; d: number; h: number; t?: number; mat: Mat; shadow: boolean; inset?: number }) {
  const xs = [-w / 2 + inset + t / 2, w / 2 - inset - t / 2], zs = [-d / 2 + inset + t / 2, d / 2 - inset - t / 2];
  return <>{xs.flatMap((x) => zs.map((z) => <B key={`${x}${z}`} s={[t, h, t]} p={[x, h / 2, z]} mat={mat} shadow={shadow} />))}</>;
}

function Bed({ w, d, h, m, shadow, crib }: P & { crib?: boolean }) {
  const frameH = 0.3, mattH = 0.2;
  if (crib) {
    const bars = Math.max(6, Math.round(d / 0.08));
    return (<>
      <B s={[w, 0.06, d]} p={[0, 0.3, 0]} mat={m.main} shadow={shadow} />
      <B s={[w - 0.06, 0.12, d - 0.06]} p={[0, 0.39, 0]} mat={m.white} shadow={shadow} r={0.03} />
      <Legs w={w} d={d} h={h} t={0.05} mat={m.main} shadow={shadow} inset={0} />
      {[-1, 1].flatMap((sx) => [<B key={`r${sx}`} s={[0.03, 0.03, d]} p={[sx * (w / 2 - 0.025), h - 0.02, 0]} mat={m.main} shadow={shadow} />,
        ...Array.from({ length: bars }, (_, i) => <B key={`${sx}-${i}`} s={[0.02, h - 0.35, 0.02]} p={[sx * (w / 2 - 0.025), 0.33 + (h - 0.35) / 2, -d / 2 + (i + 0.5) * d / bars]} mat={m.main} shadow={shadow} />)])}
      {[-1, 1].map((sz) => <B key={sz} s={[w, h - 0.3, 0.03]} p={[0, 0.3 + (h - 0.3) / 2, sz * (d / 2 - 0.015)]} mat={m.main} shadow={shadow} />)}
    </>);
  }
  const pillows = w > 1.1 ? [-w / 4, w / 4] : [0];
  return (<>
    <B s={[w, frameH - 0.08, d]} p={[0, 0.08 + (frameH - 0.08) / 2, 0]} mat={m.main} shadow={shadow} r={0.02} />
    <Legs w={w} d={d} h={0.08} t={0.06} mat={m.dark} shadow={shadow} inset={0.02} />
    <B s={[w - 0.04, mattH, d - 0.06]} p={[0, frameH + mattH / 2, 0.02]} mat={m.white} shadow={shadow} r={0.05} />
    <B s={[w - 0.02, 0.05, d * 0.6]} p={[0, frameH + mattH + 0.02, d * 0.18]} mat={m.soft} shadow={shadow} r={0.02} />
    <B s={[w, h, 0.07]} p={[0, h / 2, -d / 2 + 0.035]} mat={m.dark} shadow={shadow} r={0.03} />
    {pillows.map((x) => <B key={x} s={[Math.min(0.6, w * 0.42), 0.12, 0.38]} p={[x, frameH + mattH + 0.06, -d / 2 + 0.3]} mat={m.white} shadow={shadow} r={0.05} />)}
  </>);
}

function Sofa({ w, d, h, m, shadow }: P) {
  const armW = 0.16, seatH = 0.42, backD = 0.2;
  const inner = w - 2 * armW, n = inner > 1.5 ? 3 : 2, cw = inner / n;
  return (<>
    <B s={[w, 0.22, d]} p={[0, 0.06 + 0.11, 0]} mat={m.main} shadow={shadow} r={0.03} />
    <Legs w={w} d={d} h={0.06} t={0.04} mat={m.dark} shadow={shadow} inset={0.05} />
    {Array.from({ length: n }, (_, i) => <B key={i} s={[cw - 0.02, seatH - 0.28, d - backD - 0.02]} p={[-inner / 2 + cw * (i + 0.5), 0.28 + (seatH - 0.28) / 2, backD / 2]} mat={m.soft} shadow={shadow} r={0.05} />)}
    <B s={[inner, h - 0.28, backD]} p={[0, 0.28 + (h - 0.28) / 2, -d / 2 + backD / 2]} mat={m.main} shadow={shadow} r={0.06} />
    {Array.from({ length: n }, (_, i) => <B key={`b${i}`} s={[cw - 0.04, (h - seatH) * 0.8, 0.14]} p={[-inner / 2 + cw * (i + 0.5), seatH + (h - seatH) * 0.42, -d / 2 + backD + 0.06]} mat={m.soft} shadow={shadow} r={0.05} />)}
    {[-1, 1].map((sx) => <B key={sx} s={[armW, h * 0.75 - 0.06, d]} p={[sx * (w / 2 - armW / 2), 0.06 + (h * 0.75 - 0.06) / 2, 0]} mat={m.main} shadow={shadow} r={0.05} />)}
  </>);
}

function Table({ w, d, h, m, shadow, round }: P & { round?: boolean }) {
  const top = 0.035;
  if (round) return (<>
    <Cyl r={Math.min(w, d) / 2} h={top} p={[0, h - top / 2, 0]} mat={m.main} shadow={shadow} />
    <Cyl r={0.035} h={h - top} p={[0, (h - top) / 2, 0]} mat={m.metal} shadow={shadow} />
    <Cyl r={Math.min(w, d) * 0.3} h={0.02} p={[0, 0.01, 0]} mat={m.metal} shadow={shadow} />
  </>);
  return (<>
    <B s={[w, top, d]} p={[0, h - top / 2, 0]} mat={m.main} shadow={shadow} r={0.01} />
    <B s={[w - 0.12, 0.08, d - 0.12]} p={[0, h - top - 0.04, 0]} mat={m.dark} shadow={shadow} />
    <Legs w={w} d={d} h={h - top} t={0.05} mat={m.dark} shadow={shadow} />
  </>);
}

function Desk({ w, d, h, m, shadow, standing }: P & { standing?: boolean }) {
  const top = 0.03;
  return (<>
    <B s={[w, top, d]} p={[0, h - top / 2, 0]} mat={m.main} shadow={shadow} r={0.01} />
    {standing ? [-1, 1].map((sx) => (
      <group key={sx}>
        <B s={[0.07, h - top, 0.07]} p={[sx * (w / 2 - 0.12), (h - top) / 2, 0]} mat={m.metal} shadow={shadow} />
        <B s={[0.08, 0.04, d * 0.85]} p={[sx * (w / 2 - 0.12), 0.02, 0]} mat={m.metal} shadow={shadow} />
      </group>
    )) : <Legs w={w} d={d} h={h - top} t={0.045} mat={m.metal} shadow={shadow} inset={0.03} />}
    <B s={[0.55, 0.32, 0.03]} p={[0, h + 0.24, -d / 2 + 0.15]} mat={m.dark} shadow={shadow} />
    <B s={[0.08, 0.08, 0.03]} p={[0, h + 0.04, -d / 2 + 0.15]} mat={m.dark} shadow={shadow} />
  </>);
}

function Chair({ w, d, h, m, shadow, office }: P & { office?: boolean }) {
  const seatH = office ? 0.48 : 0.45;
  if (office) return (<>
    <B s={[w * 0.8, 0.08, d * 0.75]} p={[0, seatH, 0.03]} mat={m.main} shadow={shadow} r={0.03} />
    <B s={[w * 0.75, h - seatH - 0.1, 0.06]} p={[0, seatH + (h - seatH) / 2 + 0.02, -d * 0.36]} mat={m.main} shadow={shadow} r={0.03} />
    <Cyl r={0.03} h={seatH - 0.1} p={[0, (seatH - 0.1) / 2 + 0.06, 0]} mat={m.metal} shadow={shadow} />
    {Array.from({ length: 5 }, (_, i) => { const a = (i / 5) * Math.PI * 2; return (
      <mesh key={i} position={[Math.cos(a) * w * 0.22, 0.05, Math.sin(a) * w * 0.22]} rotation={[0, -a, 0]} material={m.metal} castShadow={shadow}><boxGeometry args={[w * 0.45, 0.03, 0.04]} /></mesh>); })}
    {[-1, 1].map((sx) => <B key={sx} s={[0.05, 0.03, d * 0.4]} p={[sx * w * 0.42, seatH + 0.2, 0]} mat={m.dark} shadow={shadow} />)}
  </>);
  return (<>
    <B s={[w, 0.04, d * 0.9]} p={[0, seatH, 0.02]} mat={m.main} shadow={shadow} r={0.01} />
    <Legs w={w} d={d * 0.9} h={seatH - 0.02} t={0.03} mat={m.dark} shadow={shadow} inset={0.02} />
    <B s={[w, h - seatH - 0.05, 0.03]} p={[0, seatH + (h - seatH) / 2, -d / 2 + 0.03]} mat={m.main} shadow={shadow} r={0.01} />
  </>);
}

function Shelf({ w, d, h, m, shadow }: P) {
  const t = 0.02, n = Math.max(2, Math.round(h / 0.38));
  const step = (h - t) / n;
  return (<>
    {[-1, 1].map((sx) => <B key={sx} s={[t, h, d]} p={[sx * (w / 2 - t / 2), h / 2, 0]} mat={m.main} shadow={shadow} />)}
    <B s={[w, h, 0.005]} p={[0, h / 2, -d / 2 + 0.003]} mat={m.dark} shadow={shadow} />
    {Array.from({ length: n + 1 }, (_, i) => <B key={i} s={[w - 2 * t, t, d]} p={[0, t / 2 + i * step, 0]} mat={m.main} shadow={shadow} />)}
    {Array.from({ length: n }, (_, i) => Array.from({ length: 4 + (i % 3) }, (_, j) => {
      const bh = step * (0.6 + ((i * 7 + j * 3) % 4) * 0.08);
      return <B key={`${i}-${j}`} s={[0.035, bh, d * 0.7]} p={[-w / 2 + t + 0.03 + j * 0.045 + (i % 2) * w * 0.35, t + i * step + bh / 2, 0]} mat={m.book[(i + j) % m.book.length]} shadow={shadow} />;
    }))}
  </>);
}

function Cabinet({ w, d, h, m, shadow, drawers, legs = 0.08 }: P & { drawers?: number; legs?: number }) {
  const body = h - legs;
  const doors = drawers ? 0 : w > 0.7 ? 2 : 1;
  return (<>
    <B s={[w, body, d]} p={[0, legs + body / 2, 0]} mat={m.main} shadow={shadow} r={0.01} />
    {legs > 0 && <Legs w={w} d={d} h={legs} t={0.035} mat={m.dark} shadow={shadow} inset={0.03} />}
    {drawers ? Array.from({ length: drawers }, (_, i) => {
      const dh = body / drawers, y = legs + dh * (i + 0.5);
      return (<group key={i}>
        <B s={[w - 0.02, dh - 0.015, 0.01]} p={[0, y, d / 2 + 0.005]} mat={m.soft} shadow={false} />
        <B s={[Math.min(0.16, w * 0.3), 0.015, 0.02]} p={[0, y, d / 2 + 0.02]} mat={m.metal} shadow={false} />
      </group>);
    }) : Array.from({ length: doors }, (_, i) => {
      const dw = w / doors, x = -w / 2 + dw * (i + 0.5);
      return (<group key={i}>
        <B s={[dw - 0.01, body - 0.02, 0.012]} p={[x, legs + body / 2, d / 2 + 0.006]} mat={m.soft} shadow={false} />
        <B s={[0.015, Math.min(0.3, body * 0.25), 0.025]} p={[x + (doors === 1 ? dw * 0.38 : (i === 0 ? 1 : -1) * dw * 0.4), legs + body * 0.5, d / 2 + 0.025]} mat={m.metal} shadow={false} />
      </group>);
    })}
  </>);
}

function Plant({ w, h, m, shadow }: P) {
  const potH = Math.min(0.35, h * 0.3), r = w / 2;
  const blobs: V3[] = [[0, 0.55, 0], [0.12, 0.7, 0.05], [-0.1, 0.8, -0.06], [0.05, 0.95, -0.1], [-0.06, 0.62, 0.12], [0, 1, 0.04]];
  return (<>
    <Cyl r={r * 0.7} r2={r * 0.85} h={potH} p={[0, potH / 2, 0]} mat={m.pot} shadow={shadow} />
    <Cyl r={0.015} h={h * 0.5} p={[0, potH + h * 0.2, 0]} mat={m.dark} shadow={shadow} />
    {blobs.map(([x, y, z], i) => <mesh key={i} position={[x * w * 2, potH + (h - potH) * (y - 0.4), z * w * 2]} material={m.green} castShadow={shadow}><sphereGeometry args={[r * (0.75 - i * 0.05), 12, 10]} /></mesh>)}
  </>);
}

function Lamp({ w, h, m, shadow }: P) {
  return (<>
    <Cyl r={w * 0.4} h={0.03} p={[0, 0.015, 0]} mat={m.metal} shadow={shadow} />
    <Cyl r={0.012} h={h - 0.25} p={[0, (h - 0.25) / 2, 0]} mat={m.metal} shadow={shadow} />
    <Cyl r={w / 2} r2={w * 0.32} h={0.28} p={[0, h - 0.14, 0]} mat={m.glow} shadow={shadow} />
  </>);
}

function Counter({ w, d, h, m, shadow }: P) {
  return (<>
    <B s={[w, h - 0.04, d - 0.05]} p={[0, (h - 0.04) / 2, -0.025]} mat={m.main} shadow={shadow} />
    <B s={[w + 0.02, 0.04, d]} p={[0, h - 0.02, 0]} mat={m.dark} shadow={shadow} />
    <B s={[w, 0.08, 0.01]} p={[0, 0.04, d / 2 - 0.05]} mat={m.dark} shadow={false} />
  </>);
}

function TreatmentBed({ w, d, h, m, shadow }: P) {
  return (<>
    <B s={[w, 0.1, d * 0.72]} p={[0, h - 0.05, d * 0.14]} mat={m.main} shadow={shadow} r={0.04} />
    <mesh position={[0, h + 0.08, -d / 2 + d * 0.14]} rotation={[0.35, 0, 0]} material={m.main} castShadow={shadow}><boxGeometry args={[w, 0.1, d * 0.28]} /></mesh>
    <B s={[0.12, h - 0.15, 0.12]} p={[0, (h - 0.15) / 2 + 0.05, 0]} mat={m.metal} shadow={shadow} />
    <B s={[w * 0.9, 0.05, d * 0.8]} p={[0, 0.025, 0]} mat={m.metal} shadow={shadow} />
  </>);
}

function Stool({ w, h, m, shadow }: P) {
  return (<>
    <Cyl r={w / 2} h={0.06} p={[0, h - 0.03, 0]} mat={m.main} shadow={shadow} />
    <Cyl r={0.025} h={h - 0.06} p={[0, (h - 0.06) / 2, 0]} mat={m.metal} shadow={shadow} />
    <Cyl r={w * 0.4} h={0.03} p={[0, 0.015, 0]} mat={m.metal} shadow={shadow} />
  </>);
}

function BunkBed({ w, d, h, m, shadow }: P) {
  const post = 0.06;
  return (<>
    {[-1, 1].flatMap((sx) => [-1, 1].map((sz) => <B key={`${sx}${sz}`} s={[post, h, post]} p={[sx * (w / 2 - post / 2), h / 2, sz * (d / 2 - post / 2)]} mat={m.main} shadow={shadow} r={0.01} />))}
    {[0.25, h * 0.62].map((y) => (<group key={y}>
      <B s={[w - 0.04, 0.05, d - 0.04]} p={[0, y, 0]} mat={m.main} shadow={shadow} />
      <B s={[w - 0.08, 0.15, d - 0.1]} p={[0, y + 0.1, 0]} mat={m.white} shadow={shadow} r={0.04} />
      <B s={[Math.min(0.6, w * 0.6), 0.1, 0.35]} p={[0, y + 0.22, -d / 2 + 0.28]} mat={m.white} shadow={shadow} r={0.04} />
    </group>))}
    {[-1, 1].map((sz) => <B key={sz} s={[w, 0.12, 0.03]} p={[0, h - 0.1, sz * (d / 2 - 0.02)]} mat={m.main} shadow={shadow} />)}
    <B s={[0.03, 0.12, d * 0.6]} p={[w / 2 - 0.02, h - 0.1, -d * 0.18]} mat={m.main} shadow={shadow} />
    {Array.from({ length: 4 }, (_, i) => <B key={`l${i}`} s={[0.03, 0.03, 0.4]} p={[w / 2 + 0.01, 0.35 + i * (h * 0.62 - 0.1) / 4, d * 0.32]} mat={m.dark} shadow={shadow} />)}
  </>);
}

function Pod({ w, d, h, m, shadow }: P) {
  return (<>
    <B s={[w, 0.08, d]} p={[0, 0.04, 0]} mat={m.dark} shadow={shadow} r={0.02} />
    <B s={[w, 0.1, d]} p={[0, h - 0.05, 0]} mat={m.dark} shadow={shadow} r={0.02} />
    <B s={[w, h - 0.18, 0.06]} p={[0, h / 2, -d / 2 + 0.03]} mat={m.main} shadow={shadow} />
    {[-1, 1].map((sx) => <B key={sx} s={[0.06, h - 0.18, d]} p={[sx * (w / 2 - 0.03), h / 2, 0]} mat={m.main} shadow={shadow} />)}
    <mesh position={[0, h / 2, d / 2 - 0.02]}><boxGeometry args={[w - 0.12, h - 0.2, 0.012]} /><meshStandardMaterial color="#cfe3ee" transparent opacity={0.25} roughness={0.05} depthWrite={false} /></mesh>
    <B s={[w * 0.7, 0.03, 0.4]} p={[0, 0.74, -d / 2 + 0.26]} mat={m.white} shadow={shadow} />
    <B s={[0.4, 0.45, 0.4]} p={[0, 0.27, 0.05]} mat={m.soft} shadow={shadow} r={0.06} />
  </>);
}

function Reception({ w, d, h, m, shadow }: P) {
  return (<>
    <B s={[w, h, 0.06]} p={[0, h / 2, d / 2 - 0.03]} mat={m.main} shadow={shadow} r={0.02} />
    <B s={[w + 0.04, 0.03, 0.3]} p={[0, h + 0.015, d / 2 - 0.12]} mat={m.dark} shadow={shadow} />
    <B s={[w, 0.03, d - 0.06]} p={[0, 0.74, -0.03]} mat={m.white} shadow={shadow} />
    {[-1, 1].map((sx) => <B key={sx} s={[0.04, 0.74, d - 0.06]} p={[sx * (w / 2 - 0.02), 0.37, -0.03]} mat={m.main} shadow={shadow} />)}
  </>);
}

function Divider({ w, d, h, m, shadow }: P) {
  const n = Math.max(2, Math.round(w / 0.45)), pw = w / n;
  return <>{Array.from({ length: n }, (_, i) => (<group key={i} position={[-w / 2 + pw * (i + 0.5), 0, (i % 2 ? 1 : -1) * d * 0.2]}>
    <B s={[pw - 0.02, h - 0.06, Math.max(0.02, d * 0.5)]} p={[0, 0.06 + (h - 0.06) / 2, 0]} mat={m.main} shadow={shadow} r={0.008} />
    <B s={[0.03, 0.06, 0.03]} p={[0, 0.03, 0]} mat={m.dark} shadow={shadow} />
  </group>))}</>;
}

function Body(props: P & { category: string; catalogId: string }) {
  const { category, catalogId } = props;
  switch (category) {
    case 'bed': return <Bed {...props} />;
    case 'crib': return <Bed {...props} crib />;
    case 'sofa': case 'sofa-bed': return <Sofa {...props} />;
    case 'armchair': return <Sofa {...props} />;
    case 'desk': return <Desk {...props} standing={catalogId === 'desk-standing'} />;
    case 'table': case 'coffee-table': case 'bench': return <Table {...props} />;
    case 'cafe-table': return <Table {...props} round />;
    case 'chair': return <Chair {...props} />;
    case 'office-chair': return <Chair {...props} office />;
    case 'bookshelf': return <Shelf {...props} />;
    case 'wardrobe': return <Cabinet {...props} legs={0.05} />;
    case 'storage-cabinet': return <Cabinet {...props} legs={0.05} />;
    case 'dresser': return <Cabinet {...props} drawers={catalogId === 'sideboard' ? 2 : 4} />;
    case 'nightstand': return <Cabinet {...props} drawers={2} legs={0.1} />;
    case 'filing-cabinet': return <Cabinet {...props} drawers={3} legs={0.02} />;
    case 'toy-storage': return <Cabinet {...props} drawers={2} legs={0.03} />;
    case 'tv-unit': return <Cabinet {...props} legs={0.1} />;
    case 'counter': return <Counter {...props} />;
    case 'bunk-bed': return <BunkBed {...props} />;
    case 'office-pod': return <Pod {...props} />;
    case 'reception-desk': return <Reception {...props} />;
    case 'room-divider': return <Divider {...props} />;
    case 'treatment-bed': return <TreatmentBed {...props} />;
    case 'stool': return <Stool {...props} />;
    case 'plant': return <Plant {...props} />;
    case 'lamp': return <Lamp {...props} />;
    case 'rug': return <B s={[props.w, Math.max(0.008, props.h), props.d]} p={[0, Math.max(0.008, props.h) / 2, 0]} mat={props.m.main} shadow={false} />;
    default: return <B s={[props.w, props.h, props.d]} p={[0, props.h / 2, 0]} mat={props.m.main} shadow={props.shadow} r={0.02} />;
  }
}

/** A real glTF model, fitted exactly to the item's footprint and height. Loaded on first use. */
function ModelBody({ spec, item, selected, ghost }: { spec: ModelSpec; item: FurnitureItem; selected: boolean; ghost: boolean }) {
  const { scene } = useGLTF(modelUrl(spec));
  const { obj, mats } = useMemo(() => {
    const inner = scene.clone(true);
    inner.rotation.y = spec.yaw;
    const holder = new THREE.Group(); holder.add(inner); holder.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(holder), size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    inner.position.set(-c.x, -box.min.y, -c.z);
    const fit = new THREE.Group(); fit.add(holder);
    fit.scale.set(item.w / (size.x || 1), item.h / (size.y || 1), item.d / (size.z || 1));
    const made: THREE.Material[] = [];
    const tint = new THREE.Color('#ffffff').lerp(new THREE.Color(item.color), 0.55);
    inner.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = !ghost; mesh.receiveShadow = true;
      const conv = (src: THREE.Material) => {
        const mat = src.clone() as THREE.MeshStandardMaterial;
        if (spec.fabric?.includes(src.name) && mat.color) mat.color.multiply(tint);
        if (ghost) { mat.transparent = true; mat.opacity = 0.35; mat.depthWrite = false; }
        if (selected && mat.emissive) { mat.emissive = new THREE.Color('#4da3ff'); mat.emissiveIntensity = 0.25; }
        made.push(mat); return mat;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(conv) : conv(mesh.material);
    });
    return { obj: fit, mats: made };
  }, [scene, spec, item.w, item.h, item.d, item.color, selected, ghost]);
  useEffect(() => () => mats.forEach((x) => x.dispose()), [mats]);
  return <primitive object={obj} />;
}

/** A generated object, refitted to the item's exact size whenever either changes. */
function CustomBody({ item, selected, ghost, open }: { item: FurnitureItem; selected: boolean; ghost: boolean; open?: number }) {
  const spec = item.custom!;
  const fitted = useMemo(() => fitSpec(spec, { w: item.w, d: item.d, h: item.h }), [spec, item.w, item.d, item.h]);
  return <GeneratedMesh spec={fitted} selected={selected} ghost={ghost} open={open} />;
}

function FurnitureMeshImpl({ item, selected, ghost, open }: { item: FurnitureItem; selected?: boolean; ghost?: boolean; open?: number }) {
  if (item.custom) {
    return (
      <group position={[item.x, 0, item.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
        <CustomBody item={item} selected={!!selected} ghost={!!ghost} open={open} />
        {selected && (
          <lineSegments position={[0, item.h / 2, 0]}>
            <edgesGeometry args={[new THREE.BoxGeometry(item.w + 0.04, item.h + 0.04, item.d + 0.04)]} />
            <lineBasicMaterial color="#4da3ff" />
          </lineSegments>
        )}
      </group>
    );
  }
  return <StockFurniture item={item} selected={selected} ghost={ghost} />;
}

function StockFurniture({ item, selected, ghost }: { item: FurnitureItem; selected?: boolean; ghost?: boolean }) {
  const mats = useMemo(() => makeMats(item.color, !!selected, !!ghost, item.material), [item.color, selected, ghost, item.material]);
  useEffect(() => () => { Object.values(mats).flat().forEach((x) => (x as Mat).dispose()); }, [mats]);
  const shadow = !ghost;
  const spec = modelSpecFor(item);
  const body = <Body w={item.w} d={item.d} h={item.h} m={mats} shadow={shadow} category={item.category} catalogId={item.catalogId} />;
  return (
    <group position={[item.x, 0, item.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      {spec ? (
        <Suspense fallback={body}>
          <ModelBody spec={spec} item={item} selected={!!selected} ghost={!!ghost} />
        </Suspense>
      ) : body}
      {selected && (
        <lineSegments position={[0, item.h / 2, 0]}>
          <edgesGeometry args={[new THREE.BoxGeometry(item.w + 0.04, item.h + 0.04, item.d + 0.04)]} />
          <lineBasicMaterial color="#4da3ff" />
        </lineSegments>
      )}
    </group>
  );
}

export const FurnitureMesh = memo(FurnitureMeshImpl);
