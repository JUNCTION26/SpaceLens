import { memo, Suspense, useEffect, useMemo } from 'react';
import { buildParts, type Role } from './build';
import * as THREE from 'three';
import { useGLTF } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import { modelSpecFor, modelUrl, type ModelSpec } from './assets';
import type { FurnitureItem, MaterialId } from '../../core/types';
import { MATERIAL_DEFS, materialFor, preloadMaterials } from '../forge/materials';
import { GeneratedMesh } from '../forge/GeneratedMesh';
import { fitSpec } from '../forge/fit';

type Mat = THREE.MeshStandardMaterial;
type Mats = Record<Role, Mat>;

const shade = (hex: string, f: number) => {
  const col = new THREE.Color(hex);
  return f >= 0 ? col.lerp(new THREE.Color('#ffffff'), f) : col.multiplyScalar(1 + f);
};

/** Linear luminance of a hex colour. */
const lum = (hex: string) => { const c = new THREE.Color(hex); return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; };
const hexOf = (c: THREE.Color) => '#' + c.getHexString();

/** The library material a catalogue material string reads as: real wood, weave, leather, stone or metal. */
export function surfaceFor(material = '', color = '#999999'): MaterialId {
  const t = material.toLowerCase();
  if (/velvet/.test(t)) return 'velvet';
  if (/leather|vinyl/.test(t)) return 'leather';
  if (/linen/.test(t)) return 'linen';
  if (/sisal|coir|rattan|wicker/.test(t)) return 'rattan';
  if (/wool|felt|fleece|plush/.test(t)) return 'wool';
  if (/fabric|upholster|mesh|cotton/.test(t)) return 'fabric';
  if (/walnut/.test(t)) return 'walnut';
  if (/pine/.test(t)) return 'pine';
  if (/birch|beech|maple/.test(t)) return 'birch';
  if (/oak|wood|veneer/.test(t)) return 'oak';
  if (/marble/.test(t)) return 'marble';
  if (/porcelain|ceramic|acrylic|glass/.test(t)) return 'ceramic';
  if (/white steel|painted/.test(t)) return 'plastic';
  if (/steel|metal|chrome|iron|wire/.test(t) && !/laminate/.test(t)) return lum(color) < 0.08 ? 'black-metal' : 'steel';
  if (/plastic/.test(t)) return 'plastic';
  return 'white-laminate';
}

/** Categories whose 'soft' parts are cushions, duvets or pads rather than drawer and door fronts. */
const TEXTILE_SOFT = new Set(['bed', 'bunk-bed', 'crib', 'sofa', 'sofa-bed', 'armchair', 'office-chair', 'office-pod', 'bench', 'cat-tree', 'pet-bed', 'window-perch', 'scratching-post', 'toy-basket', 'stool']);
/** Categories dressed in bed linen. */
const BEDDING = new Set(['bed', 'bunk-bed', 'crib', 'pet-bed', 'treatment-bed']);
/** Upholstered pieces that stand on solid walnut legs. */
const WOOD_LEGS = new Set(['sofa', 'sofa-bed', 'armchair', 'bed', 'bench', 'stool']);
/** Cloth-bound spines in muted catalogue tones. */
const BOOKS = ['#7d4a43', '#3e5a6c', '#c4a46a', '#55705d', '#e6dfd2'];

// The lamp shade is the one material that is not in the library; one per state, shared.
const glowCache = new Map<string, Mat>();
function glowMat(selected: boolean, ghost: boolean): Mat {
  const key = `${selected ? 's' : ''}${ghost ? 'g' : ''}`;
  let m = glowCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color: '#fff3d6', roughness: 0.6, emissive: new THREE.Color('#ffd9a0'), emissiveIntensity: selected ? 0.9 : 0.55, side: THREE.DoubleSide });
    if (ghost) { m.transparent = true; m.opacity = 0.35; m.depthWrite = false; }
    glowCache.set(key, m);
  }
  return m;
}

/**
 * Materials per role. Every role resolves to a shared PBR material from the library: CC0 photo
 * textures with colour (sRGB), normal and roughness (linear) maps, tiled in metres. They are cached
 * per material, colour and state and are never disposed with an item.
 */
function makeMats(color: string, selected: boolean, ghost: boolean, material: string | undefined, category: string): { mats: Mats; ids: MaterialId[] } {
  const opts = { selected, ghost }, ids = new Set<MaterialId>();
  const M = (id: MaterialId, c?: string) => { ids.add(id); return materialFor(id, c, opts) as Mat; };
  const id = surfaceFor(material, color), kind = MATERIAL_DEFS[id].kind;
  const wood = kind === 'wood', textile = kind === 'fabric' || kind === 'leather' || kind === 'rattan' || kind === 'quilt';
  const tone = (f: number) => hexOf(shade(color, f));
  const main = M(id, color);
  const dark = textile && WOOD_LEGS.has(category) ? M('walnut')
    : kind === 'metal' ? M('black-metal', tone(-0.35))
    : M(id, tone(wood ? -0.28 : -0.25));
  const soft = category === 'bed' || category === 'bunk-bed' ? M('linen', tone(0.35))
    : TEXTILE_SOFT.has(category) ? (textile ? M(id, tone(0.12)) : M('fabric', tone(0.2)))
    : M(id, tone(wood ? 0.06 : 0.04));
  const books = BOOKS.map((c) => M('fabric', c));
  const mats: Mats = {
    main, dark, soft,
    white: BEDDING.has(category) ? M('linen', '#f2efe9') : M('white-laminate', '#f3f1ec'),
    metal: M('steel'), green: M('plant', '#4f7d4a'), pot: M('concrete', '#d8d2c8'),
    glow: glowMat(selected, ghost), glass: M('glass'), ceramic: M('ceramic', '#f4f3f0'),
    book0: books[0], book1: books[1], book2: books[2], book3: books[3], book4: books[4],
  };
  return { mats, ids: [...ids] };
}

// A soft dark pad under each floor-standing piece: the cheap contact occlusion that grounds it.
let blob: { geo: THREE.PlaneGeometry; mat: THREE.MeshBasicMaterial } | null = null;
function contactBlob() {
  if (blob || typeof document === 'undefined') return blob;
  const n = 64, cv = document.createElement('canvas'); cv.width = cv.height = n;
  const g = cv.getContext('2d');
  if (!g) return null;
  g.filter = 'blur(7px)'; g.fillStyle = '#000'; g.fillRect(11, 11, n - 22, n - 22);
  const map = new THREE.CanvasTexture(cv);
  const geo = new THREE.PlaneGeometry(1, 1); geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({ color: '#000000', map, transparent: true, opacity: 0.34, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2 });
  blob = { geo, mat };
  return blob;
}
const noRay = () => null;

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
  const { mats, ids } = useMemo(() => makeMats(item.color, !!selected, !!ghost, item.material, item.category), [item.color, selected, ghost, item.material, item.category]);
  // Photo textures arrive after the first frame; draw once more when they have.
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => { let live = true; void preloadMaterials(ids).then(() => { if (live) invalidate(); }); return () => { live = false; }; }, [ids, invalidate]);
  const shadow = !ghost;
  const pad = !ghost && (item.elevationM ?? 0) < 0.05 && item.category !== 'rug' ? contactBlob() : null;
  const spec = modelSpecFor(item);
  const body = <Body item={item} mats={mats} shadow={shadow} />;
  return (
    <group position={[item.x, item.elevationM ?? 0, item.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      {spec ? (
        <Suspense fallback={body}>
          <ModelBody spec={spec} item={item} selected={!!selected} ghost={!!ghost} />
        </Suspense>
      ) : body}
      {pad && <mesh geometry={pad.geo} material={pad.mat} position={[0, 0.012, 0]} scale={[item.w + 0.3, 1, item.d + 0.3]} raycast={noRay} renderOrder={1} />}
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
