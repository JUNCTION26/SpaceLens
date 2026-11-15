import { memo, Suspense, useEffect, useMemo } from 'react';
import { buildParts, type Role } from './build';
import * as THREE from 'three';
import { useGLTF } from '@react-three/drei';
import { modelSpecFor, modelUrl, type ModelSpec } from './assets';
import type { FurnitureItem } from '../../core/types';
import { GeneratedMesh } from '../forge/GeneratedMesh';
import { fitSpec } from '../forge/fit';

type Mat = THREE.MeshStandardMaterial;
type Mats = Record<Role, Mat>;

const shade = (hex: string, f: number) => {
  const col = new THREE.Color(hex);
  return f >= 0 ? col.lerp(new THREE.Color('#ffffff'), f) : col.multiplyScalar(1 + f);
};

/** Stable 0..1 number from an item id, used to vary repeats slightly. */
function hash01(s: string, salt = 0): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 1000) / 1000;
}

// Procedural textures, generated once per page and cached per colour; never disposed with items.
const texCache = new Map<string, THREE.CanvasTexture | null>();
function canvasTex(key: string, draw: (g: CanvasRenderingContext2D, n: number) => void): THREE.CanvasTexture | null {
  if (texCache.has(key)) return texCache.get(key)!;
  let t: THREE.CanvasTexture | null = null;
  if (typeof document !== 'undefined') {
    const n = 128, cv = document.createElement('canvas'); cv.width = cv.height = n;
    const g = cv.getContext('2d');
    if (g) { draw(g, n); t = new THREE.CanvasTexture(cv); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; }
  }
  texCache.set(key, t);
  return t;
}
function wood(color: string) {
  return canvasTex(`wood${color}`, (g, n) => {
    g.fillStyle = color; g.fillRect(0, 0, n, n);
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 40; i++) {
      const y = rnd() * n, a = 0.04 + rnd() * 0.1;
      g.strokeStyle = `rgba(60,35,15,${a})`; g.lineWidth = 0.5 + rnd() * 1.6; g.beginPath();
      for (let x = 0; x <= n; x += 8) g.lineTo(x, y + Math.sin(x / 20 + i) * 2);
      g.stroke();
    }
  });
}
function fabric() {
  return canvasTex('fabric', (g, n) => {
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, n, n);
    for (let i = 0; i < n; i += 2) { g.fillStyle = `rgba(0,0,0,${0.03 + (i % 4) * 0.01})`; g.fillRect(i, 0, 1, n); g.fillRect(0, i, n, 1); }
  });
}
type Kind = 'wood' | 'fabric' | 'metal' | 'ceramic' | 'plain';
export function materialKind(material = ''): Kind {
  const t = material.toLowerCase();
  if (/oak|birch|pine|beech|walnut|wood|veneer/.test(t)) return 'wood';
  if (/fabric|linen|wool|velvet|felt|upholster|mesh|vinyl/.test(t)) return 'fabric';
  if (/porcelain|acrylic|ceramic/.test(t)) return 'ceramic';
  if (/steel|metal|chrome/.test(t) && !/wood|laminate/.test(t)) return 'metal';
  return 'plain';
}

function makeMats(color: string, selected: boolean, ghost: boolean, material: string | undefined, id: string): Mats {
  const kind = materialKind(material);
  const vary = (c: THREE.Color | string, salt: number, amt = 0.05) => {
    const col = new THREE.Color(c); const f = 1 + (hash01(id, salt) - 0.5) * 2 * amt; return col.multiplyScalar(f);
  };
  const m = (c: THREE.Color | string, rough = 0.75, metal = 0, map?: THREE.Texture | null, extra?: Partial<THREE.MeshStandardMaterialParameters>): Mat => {
    const mat = new THREE.MeshStandardMaterial({ color: c, roughness: rough, metalness: metal, map: map ?? null, ...extra });
    if (ghost) { mat.transparent = true; mat.opacity = 0.35; mat.depthWrite = false; }
    if (selected) { mat.emissive = new THREE.Color('#4da3ff'); mat.emissiveIntensity = 0.35; }
    return mat;
  };
  const base = vary(color, 1);
  const main = kind === 'wood' ? m(vary('#ffffff', 1, 0.04), 0.55, 0, wood(color))
    : kind === 'fabric' ? m(base, 0.98, 0, fabric())
    : kind === 'metal' ? m(base, 0.35, 0.65)
    : kind === 'ceramic' ? m(base, 0.12, 0.02)
    : m(base, 0.55);
  const glass = new THREE.MeshStandardMaterial({ color: '#cfe3ee', roughness: 0.05, metalness: 0.1, transparent: true, opacity: ghost ? 0.1 : 0.25, depthWrite: false });
  const glow = m('#fff3d6', 0.6, 0, null, { emissive: new THREE.Color('#ffd9a0'), emissiveIntensity: selected ? 0.9 : 0.55, side: THREE.DoubleSide });
  return {
    main,
    dark: m(shade(color, -0.35), kind === 'metal' ? 0.4 : 0.7, kind === 'metal' ? 0.5 : 0),
    soft: m(vary(shade(color, 0.2), 2), 0.95, 0, kind === 'fabric' ? fabric() : null),
    white: m(vary('#f3f1ec', 3, 0.02), 0.92),
    metal: m('#8a8f96', 0.3, 0.8), green: m(vary('#4f7d4a', 4, 0.12), 0.85), pot: m(vary('#b9a48d', 5, 0.08), 0.8),
    glow, glass,
    ceramic: m(vary('#f4f4f2', 6, 0.02), 0.1, 0.02),
    book0: m('#8c3b3b', 0.8), book1: m('#2f5d7c', 0.8), book2: m('#c9a227', 0.8), book3: m('#3e6b48', 0.8), book4: m('#6b4a7a', 0.8),
  };
}

function Body({ item, mats, shadow }: { item: FurnitureItem; mats: Mats; shadow: boolean }) {
  const parts = useMemo(() => buildParts(item.category, item.catalogId, item.w, item.d, item.h), [item.category, item.catalogId, item.w, item.d, item.h]);
  const cast = shadow && item.category !== 'rug';
  return <>{Array.from(parts.entries()).map(([role, g]) => (
    <mesh key={role} geometry={g} material={mats[role]} castShadow={cast && role !== 'glass'} receiveShadow />
  ))}</>;
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
      <group position={[item.x, item.elevationM ?? 0, item.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
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
  const mats = useMemo(() => makeMats(item.color, !!selected, !!ghost, item.material, item.id), [item.color, selected, ghost, item.material, item.id]);
  useEffect(() => () => { Object.values(mats).flat().forEach((x) => (x as Mat).dispose()); }, [mats]);
  const shadow = !ghost;
  const spec = modelSpecFor(item);
  const body = <Body item={item} mats={mats} shadow={shadow} />;
  return (
    <group position={[item.x, item.elevationM ?? 0, item.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
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
