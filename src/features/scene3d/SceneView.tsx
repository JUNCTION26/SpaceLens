import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { ContactShadows, Edges, Environment, Html, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { useStore, useShownFurniture } from '../../core/store';
import {
  area, bounds, centroid, itemCorners, norm, openingSegment, pointInPolygon, sub, wallId,
} from '../../core/geometry';
import type { FurnitureItem, Opening, Space, Vec2 } from '../../core/types';
import { buildGrid, isRug, type OccGrid } from '../sim/grid';
import { clearOfWalls, entranceSpawn, solidSegments, spaceAt, wallEdges, yawFor, type WallEdge } from '../sim/walls';
import { pathBetween, planTour } from '../sim/tour';
import { applyDemoLink } from '../building/demo';
import { FurnitureMesh } from '../furniture/FurnitureMesh';
import { Icon } from '../../ui/icons';
import './scene3d.css';
import { XRRig } from '../xr/XRRig';
import { enterXR, useXRSupport, type XRMode } from '../xr/xrSupport';

type CamMode = 'dollhouse' | 'top' | 'walk';
const EYES = [
  { id: 'standing', label: 'Standing', h: 1.65 },
  { id: 'seated', label: 'Seated', h: 1.2 },
  { id: 'child', label: 'Child', h: 1.0 },
  { id: 'wheelchair', label: 'Wheelchair', h: 1.2 },
];

interface CamReq { toP?: THREE.Vector3; toT?: THREE.Vector3; home?: boolean; n: number }

const BASE = import.meta.env.BASE_URL;
const loader = typeof document !== 'undefined' ? new THREE.TextureLoader() : null;
function tex(file: string, repeat: number, srgb = false): THREE.Texture | null {
  if (!loader) return null;
  const t = loader.load(BASE + 'assets/textures/' + file);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat, repeat); t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
// Floor UVs are world metres (ShapeGeometry), so repeat 0.5 = one texture tile per 2 m.
const floorMat = new THREE.MeshStandardMaterial({
  map: tex('laminate_floor_02_diff_1k.jpg', 0.5, true), normalMap: tex('laminate_floor_02_nor_gl_1k.jpg', 0.5),
  roughnessMap: tex('laminate_floor_02_rough_1k.jpg', 0.5), color: '#fff8ee', roughness: 0.9, envMapIntensity: 0.9,
});
floorMat.normalScale.set(0.6, 0.6);
const SNAP = 0.05;
const snap = (v: number) => Math.round(v / SNAP) * SNAP;

interface Walk {
  pos: Vec2; goal?: Vec2 | null; yaw: number; pitch: number; joy: { x: number; y: number }; keys: Set<string>;
  /** Waypoints still to walk (click-to-move or tour). */
  path?: Vec2[] | null;
  /** True while the automatic tour drives the camera. */
  tour?: boolean;
  /** Room key the visitor was last placed at the entrance for. */
  spawnedFor?: string;
}

const wallMat = new THREE.MeshStandardMaterial({
  map: tex('painted_plaster_wall_diff_1k.jpg', 1, true), normalMap: tex('painted_plaster_wall_nor_gl_1k.jpg', 1),
  roughnessMap: tex('painted_plaster_wall_rough_1k.jpg', 1), color: '#f6f2ea', roughness: 1, metalness: 0,
});
wallMat.normalScale.set(0.35, 0.35);
const ceilMat = new THREE.MeshStandardMaterial({ color: '#f7f5f0', roughness: 0.95 });
const wallSelMat = new THREE.MeshStandardMaterial({ color: '#9fd0ff', roughness: 0.8 });
const glassMat = new THREE.MeshPhysicalMaterial({ color: '#eef6ff', transmission: 1, thickness: 0.01, ior: 1.5, roughness: 0.04, metalness: 0, transparent: true, opacity: 1, depthWrite: false });
const frameMat = new THREE.MeshStandardMaterial({ color: '#fafaf8', roughness: 0.35 });
const doorMat = new THREE.MeshStandardMaterial({ color: '#d9cbb5', roughness: 0.6 });
const baseMat = new THREE.MeshStandardMaterial({ color: '#fbfaf7', roughness: 0.4 });

function useRoom() {
  const model = useStore((s) => s.model);
  return useMemo(() => {
    const pts = model.spaces.flatMap((s) => s.polygon);
    const b = pts.length ? bounds(pts) : { minX: 0, minY: 0, maxX: 4, maxY: 4 } as ReturnType<typeof bounds>;
    const bb = b as unknown as { minX: number; minY: number; maxX: number; maxY: number };
    const cx = (bb.minX + bb.maxX) / 2, cy = (bb.minY + bb.maxY) / 2;
    const w = Math.max(bb.maxX - bb.minX, 1), d = Math.max(bb.maxY - bb.minY, 1);
    const size = Math.max(w, d, 2);
    // Changes only when the room itself changes, so moving furniture never resets the camera.
    const key = [cx, cy, w, d, model.spaces.length].map((v) => v.toFixed(2)).join(':');
    const edges = wallEdges(model);
    const solids = solidSegments(model, edges);
    const spawn = entranceSpawn(model);
    return { model, cx, cy, w, d, size, key, edges, solids, spawn };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model.version, model]);
}

/* ---------- Geometry ---------- */

function Floor({ space, onWalkTo }: { space: Space; onWalkTo?: (p: Vec2) => void }) {
  const geo = useMemo(() => {
    const shape = new THREE.Shape(space.polygon.map((p) => new THREE.Vector2(p.x, -p.y)));
    return new THREE.ShapeGeometry(shape);
  }, [space]);
  return (
    <mesh geometry={geo} material={floorMat} rotation={[-Math.PI / 2, 0, 0]} receiveShadow onClick={(e) => {
      e.stopPropagation();
      if (onWalkTo) { if (e.delta < 6) onWalkTo({ x: e.point.x, y: e.point.z }); return; }
      useStore.getState().select({ kind: 'space', id: space.id });
    }} />
  );
}

function Ceiling({ space, h }: { space: Space; h: number }) {
  const geo = useMemo(() => new THREE.ShapeGeometry(new THREE.Shape(space.polygon.map((p) => new THREE.Vector2(p.x, p.y)))), [space]);
  return <mesh geometry={geo} material={ceilMat} position={[0, h, 0]} rotation={[Math.PI / 2, 0, 0]} receiveShadow raycast={() => null} />;
}

interface Box { pos: [number, number, number]; size: [number, number, number]; mat: THREE.Material }

/**
 * Boxes for one wall. A facade wall stands outside the room's edge (inner face on the polygon); a
 * wall shared by two rooms is drawn once, centred on the shared line with both halves' thickness.
 * Local frame: x along the wall from `a`, +z outward from the owning room.
 */
function wallBoxes(edge: WallEdge, ceiling: number): { boxes: Box[]; extras: Box[] } {
  const L = edge.length;
  const interior = !!edge.neighbour;
  const t = interior ? Math.max(0.06, edge.thicknessM + edge.neighbourThicknessM) : edge.thicknessM || 0.12;
  const zc = interior ? 0 : t / 2;
  const ext = interior ? t / 2 : t;
  const boxes: Box[] = [], extras: Box[] = [];
  const solid = (x0: number, x1: number, y0: number, y1: number) => {
    if (x1 - x0 < 1e-3 || y1 - y0 < 1e-3) return;
    boxes.push({ pos: [(x0 + x1) / 2, (y0 + y1) / 2, zc], size: [x1 - x0, y1 - y0, t], mat: wallMat });
  };
  let cur = -ext;
  for (const g of edge.gaps) {
    const o = g.opening;
    const s = Math.max(cur, g.s), e = g.e;
    if (e - s < 0.05) continue;
    const sill = o.kind === 'window' ? o.sillM : 0;
    const head = Math.min(ceiling, sill + o.heightM);
    solid(cur, s, 0, ceiling);
    solid(s, e, 0, sill);
    solid(s, e, head, ceiling);
    if (o.kind === 'window') {
      extras.push({ pos: [(s + e) / 2, (sill + head) / 2, zc], size: [e - s, head - sill, 0.012], mat: glassMat });
      extras.push({ pos: [(s + e) / 2, sill + 0.02, zc - 0.02], size: [e - s, 0.04, t + 0.06], mat: frameMat });
      extras.push({ pos: [(s + e) / 2, head - 0.02, zc], size: [e - s, 0.04, t + 0.02], mat: frameMat });
      extras.push({ pos: [s + 0.02, (sill + head) / 2, zc], size: [0.04, head - sill, t + 0.02], mat: frameMat });
      extras.push({ pos: [e - 0.02, (sill + head) / 2, zc], size: [0.04, head - sill, t + 0.02], mat: frameMat });
    }
    cur = e;
  }
  solid(cur, L + ext, 0, ceiling);
  // Baseboards on each room-facing face, skipping door gaps.
  const faces = interior ? [-(t / 2 + 0.009), t / 2 + 0.009] : [-0.009];
  for (const z of faces) {
    let bs = 0;
    for (const g of edge.gaps.filter((q) => q.kind !== 'window')) {
      if (g.s > bs) extras.push({ pos: [(bs + g.s) / 2, 0.05, z], size: [g.s - bs, 0.1, 0.018], mat: baseMat });
      bs = Math.max(bs, g.e);
    }
    if (L > bs) extras.push({ pos: [(bs + L) / 2, 0.05, z], size: [L - bs, 0.1, 0.018], mat: baseMat });
  }
  return { boxes, extras };
}

function Wall({ edge, ceiling, selected, cutaway }: { edge: WallEdge; ceiling: number; selected: boolean; cutaway: boolean }) {
  const ref = useRef<THREE.Group>(null);
  const { a, ang, outward, mid, flip } = useMemo(() => {
    const { a, b, inward } = edge;
    const outward = { x: -inward.x, y: -inward.y };
    const d = norm(sub(b, a));
    // Local +z must point outward; with yaw = -atan2(d), local z maps to (-dy, dx).
    return { a, ang: -Math.atan2(b.y - a.y, b.x - a.x), outward, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, flip: (-d.y * outward.x + d.x * outward.y) < 0 };
  }, [edge]);
  const { boxes, extras } = useMemo(() => wallBoxes(edge, ceiling), [edge, ceiling]);
  const target = useRef(1);
  // Only facade walls between the camera and the building fold down; inner walls stay standing.
  const canCut = cutaway && !edge.neighbour;
  useFrame(({ camera, invalidate }) => {
    if (!ref.current) return;
    const outside = (camera.position.x - mid.x) * outward.x + (camera.position.z - mid.y) * outward.y > 0;
    target.current = canCut && outside && camera.position.y > 1.9 ? 0.06 : 1;
    const s = ref.current.scale.y;
    if (Math.abs(s - target.current) > 0.005) { ref.current.scale.y = s + (target.current - s) * 0.2; invalidate(); }
  });
  const onClick = (e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); useStore.getState().select({ kind: 'wall', id: wallId(edge.spaceId, edge.wallIndex) }); };
  return (
    <group position={[a.x, 0, a.y]} rotation={[0, ang, 0]}>
      <group scale-z={flip ? -1 : 1}><group ref={ref}>
        {boxes.map((bx, k) => (
          <mesh key={k} position={bx.pos} castShadow receiveShadow material={selected ? wallSelMat : bx.mat} onClick={onClick}>
            <boxGeometry args={bx.size} />
          </mesh>
        ))}
        {extras.map((bx, k) => (
          <mesh key={'x' + k} position={bx.pos} material={bx.mat} receiveShadow={bx.mat !== glassMat} castShadow={bx.mat === frameMat}><boxGeometry args={bx.size} /></mesh>
        ))}
      </group></group>
    </group>
  );
}

/** Room names floating over each floor, for buildings with more than one room. */
function RoomLabels({ spaces }: { spaces: Space[] }) {
  return (
    <>
      {spaces.map((s) => {
        const c = centroid(s.polygon);
        const at = pointInPolygon(c, s.polygon) ? c : s.polygon[0];
        return (
          <Html key={s.id} position={[at.x, 0.1, at.y]} center zIndexRange={[10, 0]} style={{ pointerEvents: 'none' }}>
            <div className="scene3d-roomlabel">{s.name}<span>{area(s.polygon).toFixed(0)} m²</span></div>
          </Html>
        );
      })}
    </>
  );
}

function DoorLeaf({ space, o }: { space: Space; o: Opening }) {
  if (o.swing === 'none') return null;
  const { a, b, dir, inward } = openingSegment(space, o);
  const hinge = o.hinge === 'start' ? a : b;
  const toward = o.hinge === 'start' ? dir : { x: -dir.x, y: -dir.y };
  const n = o.swing === 'in' ? inward : { x: -inward.x, y: -inward.y };
  const th = (70 * Math.PI) / 180;
  const ld = norm({ x: toward.x * Math.cos(th) + n.x * Math.sin(th), y: toward.y * Math.cos(th) + n.y * Math.sin(th) });
  const w = o.widthM - 0.02, h = o.heightM - 0.01;
  return (
    <mesh position={[hinge.x + ld.x * w / 2, h / 2, hinge.y + ld.y * w / 2]} rotation={[0, -Math.atan2(ld.y, ld.x), 0]} castShadow material={doorMat}>
      <boxGeometry args={[w, h, 0.04]} />
    </mesh>
  );
}

function Furniture({ items, ghost, interactive, onFocus }: { items: FurnitureItem[]; ghost?: boolean; interactive?: boolean; onFocus?: (it: FurnitureItem) => void }) {
  const sel = useStore((s) => s.selection);
  const spaces = useStore((s) => s.model.spaces);
  const [hover, setHover] = useState<string | null>(null);
  const [dragPos, setDragPos] = useState<{ id: string; x: number; y: number } | null>(null);
  const drag = useRef<{ id: string; ox: number; oy: number; moved: boolean } | null>(null);
  const controls = useThree((s) => s.controls) as unknown as { enabled: boolean } | null;
  const plane = useMemo(() => new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), []);
  const hit = (e: ThreeEvent<PointerEvent>) => e.ray.intersectPlane(plane, new THREE.Vector3());
  const fits = (it: FurnitureItem, x: number, y: number) => {
    const c = itemCorners({ ...it, x, y });
    return spaces.some((sp) => c.every((p) => pointInPolygon(p, sp.polygon)));
  };
  const end = (e: ThreeEvent<PointerEvent>, it: FurnitureItem) => {
    const d = drag.current; if (!d || d.id !== it.id) return;
    drag.current = null;
    try { (e.target as Element).releasePointerCapture?.(e.pointerId); } catch { /* already released */ }
    if (controls) controls.enabled = true;
    if (d.moved && dragPos) useStore.getState().dispatch({ type: 'UPDATE_OBJECT', id: it.id, patch: { x: dragPos.x, y: dragPos.y } });
    setDragPos(null);
  };
  return (
    <>
      {items.map((raw) => {
        const it = dragPos && dragPos.id === raw.id ? { ...raw, x: dragPos.x, y: dragPos.y } : raw;
        const isSel = !ghost && sel?.kind === 'furniture' && sel.id === it.id;
        const live = !ghost && interactive;
        return (
          <group key={it.id}
            onClick={ghost ? undefined : (e) => { e.stopPropagation(); useStore.getState().select({ kind: 'furniture', id: it.id }); }}
            onDoubleClick={live ? (e) => { e.stopPropagation(); onFocus?.(it); } : undefined}
            onPointerOver={live ? (e) => { e.stopPropagation(); setHover(it.id); document.body.style.cursor = it.locked ? 'pointer' : 'grab'; } : undefined}
            onPointerOut={live ? () => { setHover((h) => (h === it.id ? null : h)); document.body.style.cursor = ''; } : undefined}
            onPointerDown={live && !it.locked ? (e) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              const p = hit(e); if (!p) return;
              (e.target as Element).setPointerCapture?.(e.pointerId);
              drag.current = { id: it.id, ox: it.x - p.x, oy: it.y - p.z, moved: false };
              if (controls) controls.enabled = false;
              useStore.getState().select({ kind: 'furniture', id: it.id });
            } : undefined}
            onPointerMove={live ? (e) => {
              const d = drag.current; if (!d || d.id !== it.id) return;
              e.stopPropagation();
              const p = hit(e); if (!p) return;
              const x = snap(p.x + d.ox), y = snap(p.z + d.oy);
              if (fits(raw, x, y)) { d.moved = true; setDragPos({ id: it.id, x, y }); }
            } : undefined}
            onPointerUp={live ? (e) => end(e, raw) : undefined}
            onPointerCancel={live ? (e) => end(e, raw) : undefined}>
            <FurnitureMesh item={it} ghost={ghost} selected={isSel} />
            {live && (hover === it.id || isSel) && (
              <mesh position={[it.x, it.h / 2, it.y]} rotation={[0, -it.rotation, 0]} raycast={() => null}>
                <boxGeometry args={[it.w + 0.03, it.h + 0.03, it.d + 0.03]} />
                <meshBasicMaterial visible={false} />
                <Edges color={isSel ? '#4da3ff' : '#ffffff'} lineWidth={isSel ? 2.5 : 1.5} />
              </mesh>
            )}
            {live && isSel && (
              <Html position={[it.x, it.h + 0.18, it.y]} center zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
                <div className="scene3d-dim">{Math.round(it.w * 100)} × {Math.round(it.d * 100)} × {Math.round(it.h * 100)} cm</div>
              </Html>
            )}
          </group>
        );
      })}
    </>
  );
}

/* ---------- Overlays ---------- */

function Routes() {
  const routes = useStore((s) => s.analysis.routes);
  const on = useStore((s) => s.layers.routes);
  if (!on) return null;
  return (
    <>
      {routes.filter((r) => r.points.length >= 2).map((r) => {
        const curve = new THREE.CatmullRomCurve3(r.points.map((p) => new THREE.Vector3(p.x, 0.06, p.y)), false, 'centripetal', 0.2);
        const c = r.ok ? '#3ddc84' : '#ff5a5f';
        return (
          <mesh key={r.id}>
            <tubeGeometry args={[curve, Math.max(16, r.points.length * 8), 0.035, 8, false]} />
            <meshStandardMaterial color={c} emissive={c} emissiveIntensity={1.4} toneMapped={false} />
          </mesh>
        );
      })}
    </>
  );
}

function Heat() {
  const heat = useStore((s) => s.analysis.heat);
  const on = useStore((s) => s.layers.heat);
  const tex = useMemo(() => {
    if (!heat || !heat.values.length) return null;
    const max = Math.max(...heat.values.map(Math.abs), 1e-6);
    const data = new Uint8Array(heat.cols * heat.rows * 4);
    heat.values.forEach((v, k) => {
      const t = Math.min(1, Math.abs(v) / max);
      data.set([Math.round(60 + 195 * t), Math.round(200 - 140 * t), Math.round(255 - 215 * t), Math.round(t > 0.01 ? 90 + 120 * t : 0)], k * 4);
    });
    const tx = new THREE.DataTexture(data, heat.cols, heat.rows);
    tx.magFilter = THREE.LinearFilter; tx.needsUpdate = true;
    return tx;
  }, [heat]);
  if (!on || !heat || !tex) return null;
  const w = heat.cols * heat.cellM, d = heat.rows * heat.cellM;
  // Texture row 0 is at plane bottom (v=0); after rotating, v=0 lands at +z (larger y). Flip so row 0 is at origin.y.
  return (
    <mesh position={[heat.origin.x + w / 2, 0.02, heat.origin.y + d / 2]} rotation={[-Math.PI / 2, 0, 0]} scale={[1, -1, 1]}>
      <planeGeometry args={[w, d]} />
      <meshBasicMaterial map={tex} transparent depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
  );
}

function Highlights({ items }: { items: FurnitureItem[] }) {
  const hl = useStore((s) => s.analysis.highlights);
  return (
    <>
      {hl.flatMap((h, k) => h.ids.map((id) => {
        const it = items.find((f) => f.id === id);
        if (!it) return null;
        return (
          <mesh key={k + id} position={[it.x, it.h / 2, it.y]} rotation={[0, -it.rotation, 0]}>
            <boxGeometry args={[it.w + 0.04, it.h + 0.04, it.d + 0.04]} />
            <meshBasicMaterial visible={false} />
            <Edges color={h.color} lineWidth={2} />
          </mesh>
        );
      }))}
    </>
  );
}

function Passage({ items }: { items: FurnitureItem[] }) {
  const passage = useStore((s) => s.analysis.passage);
  const ref = useRef<THREE.Group>(null);
  const item = passage ? items.find((f) => f.id === passage.itemId) : undefined;
  useFrame(({ clock }) => {
    if (!passage || passage.poses.length < 2 || !ref.current) return;
    const n = passage.poses.length;
    const t = (clock.elapsedTime * 2.5) % (n - 1 + 1.5);
    const k = Math.min(n - 2, Math.floor(t)), f = Math.min(1, t - k);
    const p = passage.poses[k], q = passage.poses[k + 1];
    ref.current.position.set(p.x + (q.x - p.x) * f, 0, p.y + (q.y - p.y) * f);
    ref.current.rotation.y = -(p.rotation + (q.rotation - p.rotation) * f);
  });
  if (!passage || !item || passage.poses.length < 2) return null;
  return (
    <group ref={ref}>
      <FurnitureMesh item={{ ...item, x: 0, y: 0, rotation: 0, id: item.id + '-ghost' }} ghost />
    </group>
  );
}

function Figure({ at }: { at: Vec2 }) {
  return (
    <group position={[at.x, 0, at.y]}>
      <mesh position={[0, 0.775, 0]} castShadow>
        <capsuleGeometry args={[0.2, 1.15, 6, 16]} />
        <meshStandardMaterial color="#8aa4c8" roughness={0.6} />
      </mesh>
      <mesh position={[0, 1.62, 0]} castShadow>
        <sphereGeometry args={[0.12, 20, 16]} />
        <meshStandardMaterial color="#8aa4c8" roughness={0.6} />
      </mesh>
    </group>
  );
}

/* ---------- Cameras ---------- */

/** Camera pose that fits the whole room in the current pane, whatever its shape (narrow in Split, wide in 3D). */
function homeView(room: ReturnType<typeof useRoom>, cam: THREE.Camera, kind: 'dollhouse' | 'top') {
  const pc = cam as THREE.PerspectiveCamera;
  const vHalf = THREE.MathUtils.degToRad(pc.fov || 50) / 2;
  const hHalf = Math.atan(Math.tan(vHalf) * (pc.aspect || 1));
  const { cx, cy, w, d } = room;
  const ceil = room.model.ceilingM || 2.5;
  if (kind === 'top') {
    const h = Math.max(d / 2 / Math.tan(vHalf), w / 2 / Math.tan(hHalf)) * 1.15 + ceil;
    return { p: new THREE.Vector3(cx, h, cy + 0.001), t: new THREE.Vector3(cx, 0, cy) };
  }
  // Bounding sphere of the room box; the target sits a little low so the floor reads well.
  const r = 0.5 * Math.hypot(w, d, ceil);
  const dist = r / Math.sin(Math.min(vHalf, hHalf));
  const t = new THREE.Vector3(cx, ceil * 0.35, cy);
  return { p: t.clone().addScaledVector(new THREE.Vector3(0.75, 1.05, 1.0).normalize(), dist), t };
}

const angleTo = (from: number, to: number) => Math.atan2(Math.sin(to - from), Math.cos(to - from));

function CameraRig({ mode, eye, room, walk, req, onRoom, onTourEnd }: {
  mode: CamMode; eye: number; room: ReturnType<typeof useRoom>; walk: MutableRefObject<Walk>; req: CamReq | null;
  onRoom: (spaceId: string | null) => void; onTourEnd: () => void;
}) {
  const { camera, invalidate } = useThree();
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3; update: () => void; enabled: boolean } | null;
  const anim = useRef<{ t: number; fromP: THREE.Vector3; fromT: THREE.Vector3; toP: THREE.Vector3; toT: THREE.Vector3 } | null>(null);
  const items = useShownFurniture();
  const lastRoom = useRef<string | null | undefined>(undefined);

  const aspect = useThree((s) => s.size.width / Math.max(1, s.size.height));
  const framed = useRef<{ key: string; aspect: number; mode: CamMode } | null>(null);

  useEffect(() => {
    // Re-frame when the mode or the room changes, or the pane is resized a lot (switching 3D and Split).
    const f = framed.current;
    const sameRoom = f && f.key === room.key && f.mode === mode;
    if (sameRoom && (mode === 'walk' || Math.abs(Math.log(f.aspect / aspect)) < 0.2)) return;
    framed.current = { key: room.key, aspect, mode };
    let toP: THREE.Vector3, toT: THREE.Vector3;
    if (mode !== 'walk') ({ p: toP, t: toT } = homeView(room, camera, mode));
    else {
      const w = walk.current;
      // first walk in this building (or standing outside it): start at the entrance, looking in
      if (w.spawnedFor !== room.key || !spaceAt(room.model, w.pos)) {
        w.pos = { ...room.spawn.pos }; w.yaw = room.spawn.yaw; w.pitch = 0; w.spawnedFor = room.key; w.path = null; w.goal = null;
      }
      toP = new THREE.Vector3(w.pos.x, eye, w.pos.y);
      toT = toP.clone().add(new THREE.Vector3(-Math.sin(w.yaw), 0, -Math.cos(w.yaw)));
    }
    const fromT = controls ? controls.target.clone() : new THREE.Vector3(room.cx, 0, room.cy);
    anim.current = { t: 0, fromP: camera.position.clone(), fromT, toP, toT };
    invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, room.key, aspect, eye]);

  useEffect(() => {
    if (!req || mode === 'walk') return;
    const home = req.home ? homeView(room, camera, mode) : null;
    const toP = home?.p ?? req.toP, toT = home?.t ?? req.toT;
    if (!toP || !toT) return;
    const fromT = controls ? controls.target.clone() : new THREE.Vector3(room.cx, 0, room.cy);
    anim.current = { t: 0, fromP: camera.position.clone(), fromT, toP: toP.clone(), toT: toT.clone() };
    invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req?.n]);

  // Inside some room, clear of every wall piece (door and opening gaps are open) and of furniture.
  const solidItems = useMemo(() => items.filter((it) => !isRug(it)).map((it) => itemCorners(it)), [items]);
  const blocked = (p: Vec2) => {
    if (!room.model.spaces.length) return false;
    if (!spaceAt(room.model, p) || !clearOfWalls(p, 0.2, room.solids)) return true;
    return solidItems.some((c) => pointInPolygon(p, c));
  };

  useFrame((_, dt) => {
    if (controls) controls.enabled = mode !== 'walk' && !anim.current;
    const a = anim.current;
    if (a) {
      a.t = Math.min(1, a.t + dt / 0.8);
      const e = a.t < 0.5 ? 4 * a.t ** 3 : 1 - (-2 * a.t + 2) ** 3 / 2;
      camera.position.lerpVectors(a.fromP, a.toP, e);
      const tgt = new THREE.Vector3().lerpVectors(a.fromT, a.toT, e);
      camera.lookAt(tgt);
      if (controls) controls.target.copy(tgt);
      if (a.t >= 1) { anim.current = null; if (controls && mode !== 'walk') controls.update(); }
      invalidate();
      return;
    }
    if (mode !== 'walk') return;
    const w = walk.current;
    let f = -w.joy.y, s = w.joy.x;
    const k = w.keys;
    if (k.has('w') || k.has('arrowup')) f += 1;
    if (k.has('s') || k.has('arrowdown')) f -= 1;
    if (k.has('d') || k.has('arrowright')) s += 1;
    if (k.has('a') || k.has('arrowleft')) s -= 1;
    const step = Math.min(dt, 0.05);
    const speed = 1.4 * step;
    if (f || s) {
      w.goal = null; w.path = null;
      if (w.tour) { w.tour = false; onTourEnd(); }
    }
    if (w.path?.length) {
      // follow planned waypoints (already clear of walls), turning to face the way ahead
      const g = w.path[0];
      const gx = g.x - w.pos.x, gy = g.y - w.pos.y, gl = Math.hypot(gx, gy);
      const v = (w.tour ? 1.15 : 1.4) * step;
      if (gl <= v) { w.pos = { x: g.x, y: g.y }; w.path.shift(); }
      else w.pos = { x: w.pos.x + (gx / gl) * v, y: w.pos.y + (gy / gl) * v };
      if (gl > 0.05) w.yaw += angleTo(w.yaw, yawFor({ x: gx, y: gy })) * Math.min(1, step * (w.tour ? 2.2 : 4));
      if (w.tour) w.pitch += (-0.08 - w.pitch) * Math.min(1, step * 2);
      if (!w.path.length) { w.path = null; if (w.tour) { w.tour = false; onTourEnd(); } }
    } else if (w.goal) {
      const gx = w.goal.x - w.pos.x, gy = w.goal.y - w.pos.y, gl = Math.hypot(gx, gy);
      if (gl < 0.02) w.goal = null;
      else {
        const step = Math.min(gl, Math.max(0.01, gl * Math.min(1, dt * 4)));
        const next = { x: w.pos.x + (gx / gl) * step, y: w.pos.y + (gy / gl) * step };
        if (blocked(next)) w.goal = null; else w.pos = next;
      }
    }
    if (f || s) {
      const fx = -Math.sin(w.yaw), fy = -Math.cos(w.yaw);
      const dx = (fx * f + -fy * s) * speed, dy = (fy * f + fx * s) * speed;
      const next = { x: w.pos.x + dx, y: w.pos.y + dy };
      if (!blocked(next)) w.pos = next;
      else if (!blocked({ x: w.pos.x + dx, y: w.pos.y })) w.pos = { x: w.pos.x + dx, y: w.pos.y };
      else if (!blocked({ x: w.pos.x, y: w.pos.y + dy })) w.pos = { x: w.pos.x, y: w.pos.y + dy };
    }
    camera.position.set(w.pos.x, eye, w.pos.y);
    camera.rotation.set(w.pitch, w.yaw, 0, 'YXZ');
    const here = room.model.spaces.length > 1 ? spaceAt(room.model, w.pos)?.id ?? null : null;
    if (here !== lastRoom.current) { lastRoom.current = here; onRoom(here); }
  });
  return null;
}

function Sun({ hour, room }: { hour: number; room: ReturnType<typeof useRoom> }) {
  const ref = useRef<THREE.DirectionalLight>(null);
  const { scene } = useThree();
  const t = (hour - 6) / 15;
  const az = Math.PI * (0.1 + 0.8 * t);
  const el = Math.max(0.12, Math.sin(Math.PI * t)) * 1.1;
  const R = room.size * 2 + 4;
  const pos: [number, number, number] = [room.cx + Math.cos(az) * R * Math.cos(el), Math.sin(el) * R, room.cy - Math.sin(az) * R * 0.6];
  const warm = new THREE.Color('#ffb070').lerp(new THREE.Color('#fff6e8'), Math.min(1, Math.sin(Math.PI * t) * 1.6));
  useEffect(() => {
    if (!ref.current) return;
    ref.current.target.position.set(room.cx, 0, room.cy);
    scene.add(ref.current.target);
    const s = room.size;
    const c = ref.current.shadow.camera;
    c.left = -s; c.right = s; c.top = s; c.bottom = -s; c.far = R * 3; c.updateProjectionMatrix();
  }, [room, scene, R]);
  return <directionalLight ref={ref} position={pos} intensity={1.2 + 1.3 * Math.sin(Math.PI * t)} color={warm} castShadow shadow-mapSize={[1024, 1024]} shadow-bias={-0.0004} shadow-normalBias={0.02} shadow-radius={4} />;
}

/* ---------- Joystick ---------- */

function Joystick({ walk }: { walk: MutableRefObject<Walk> }) {
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const base = useRef<HTMLDivElement>(null);
  const move = (e: React.PointerEvent) => {
    const r = base.current!.getBoundingClientRect();
    let x = (e.clientX - r.left - r.width / 2) / (r.width / 2), y = (e.clientY - r.top - r.height / 2) / (r.height / 2);
    const l = Math.hypot(x, y); if (l > 1) { x /= l; y /= l; }
    walk.current.joy = { x, y }; setKnob({ x, y });
  };
  const end = () => { walk.current.joy = { x: 0, y: 0 }; setKnob({ x: 0, y: 0 }); };
  return (
    <div ref={base} className="scene3d-joy" aria-label="Move" onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); move(e); e.stopPropagation(); }}
      onPointerMove={(e) => { if (e.buttons || e.pointerType === 'touch') move(e); }} onPointerUp={end} onPointerCancel={end}>
      <div className="scene3d-knob" style={{ transform: `translate(${knob.x * 28}px, ${knob.y * 28}px)` }} />
    </div>
  );
}

/* ---------- Main ---------- */

/** Backdrop colour for the 3D view that sits quietly next to the rest of the UI in either theme. */
function useBackdrop() {
  const theme = useStore((s) => s.settings.theme);
  const [sysLight, setSysLight] = useState(() => typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: light)').matches);
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return;
    const mq = matchMedia('(prefers-color-scheme: light)');
    const on = () => setSysLight(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  const light = theme === 'light' || (theme === 'system' && sysLight);
  return light ? '#e4e4e8' : '#18181b';
}

export function SceneView() {
  const backdrop = useBackdrop();
  const room = useRoom();
  const { model } = room;
  const shown = useShownFurniture();
  const activeCandidateId = useStore((s) => s.activeCandidateId);
  const selection = useStore((s) => s.selection);
  const passage = useStore((s) => s.analysis.passage);
  const [mode, setMode] = useState<CamMode>('dollhouse');
  const [eyeId, setEyeId] = useState('standing');
  const [cutaway, setCutaway] = useState(true);
  const [figure, setFigure] = useState(false);
  const [showBefore, setShowBefore] = useState(true);
  const [hour, setHour] = useState(15);
  const [open, setOpen] = useState(false);
  const xrSup = useXRSupport();
  const glRef = useRef<THREE.WebGLRenderer | null>(null);
  const [xrMode, setXrMode] = useState<XRMode | null>(null);
  const startXR = async (m: XRMode) => {
    const gl = glRef.current;
    if (!(await enterXR(gl, m)) || !gl) return;
    setXrMode(m);
    const s = gl.xr.getSession();
    s?.addEventListener('end', () => setXrMode(null), { once: true });
  };
  const eye = EYES.find((e) => e.id === eyeId)!.h;
  const walk = useRef<Walk>({ pos: { x: room.cx, y: room.cy }, yaw: 0, pitch: 0, joy: { x: 0, y: 0 }, keys: new Set() });
  const wrap = useRef<HTMLDivElement>(null);
  const [req, setReq] = useState<CamReq | null>(null);
  const reqN = useRef(0);
  const ask = (toP: THREE.Vector3, toT: THREE.Vector3) => setReq({ toP, toT, n: ++reqN.current });
  const fit = () => {
    if (mode === 'walk') { setMode('dollhouse'); return; }
    setReq({ home: true, n: ++reqN.current });
  };
  const focusItem = (it: FurnitureItem) => {
    const r = Math.max(it.w, it.d, it.h, 0.6) * 2.2 + 0.6;
    ask(new THREE.Vector3(it.x + r * 0.6, it.h + r * 0.7, it.y + r * 0.8), new THREE.Vector3(it.x, it.h / 2, it.y));
  };
  // Walking grid (rooms, interior walls with door gaps, furniture), built on first use per change.
  const gridRef = useRef<{ model: unknown; items: unknown; g: OccGrid } | null>(null);
  const grid = () => {
    const c = gridRef.current;
    if (c && c.model === model && c.items === shown) return c.g;
    const g = buildGrid(model, shown);
    gridRef.current = { model, items: shown, g };
    return g;
  };
  const walkTo = (p: Vec2) => {
    if (!spaceAt(model, p)) return;
    const w = walk.current;
    if (w.tour) { w.tour = false; endTour(); }
    const path = pathBetween(grid(), w.pos, p);
    if (path) { w.path = path; w.goal = null; }
    else if (clearOfWalls(p, 0.25, room.solids)) { w.path = null; w.goal = p; }
  };

  // Where the visitor is during walk and tour, for the "you are in" label.
  const [roomId, setRoomId] = useState<string | null>(null);
  const roomName = roomId ? model.spaces.find((s) => s.id === roomId)?.name ?? null : null;

  // Auto tour: walk every room along the door graph; optionally record it as a WebM video.
  const [touring, setTouring] = useState(false);
  const [recording, setRecording] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const canRecord = typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement !== 'undefined' && 'captureStream' in HTMLCanvasElement.prototype;
  const endTour = () => {
    setTouring(false);
    const r = recorder.current;
    if (r && r.state !== 'inactive') r.stop();
  };
  const startTour = (record: boolean) => {
    const st = useStore.getState();
    const t = planTour(model, grid(), room.spawn.pos);
    if (t.stops.length < 2 || !t.points.length) { st.toast('No route between rooms to tour', 'warn'); return; }
    const w = walk.current;
    w.pos = { ...room.spawn.pos }; w.yaw = room.spawn.yaw; w.pitch = 0; w.spawnedFor = room.key;
    w.path = t.points.map((p) => ({ ...p })); w.goal = null; w.tour = true;
    setTouring(true);
    setMode('walk');
    if (record && glRef.current) {
      try {
        const canvas = glRef.current.domElement as HTMLCanvasElement & { captureStream: (fps?: number) => MediaStream };
        const stream = canvas.captureStream(30);
        const type = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
        const rec = new MediaRecorder(stream, type ? { mimeType: type, videoBitsPerSecond: 6_000_000 } : undefined);
        const chunks: Blob[] = [];
        rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
        rec.onstop = () => {
          setRecording(false);
          stream.getTracks().forEach((tr) => tr.stop());
          if (!chunks.length) return;
          const url = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
          const a = document.createElement('a');
          a.href = url; a.download = `${(model.name || 'tour').replace(/[^\w-]+/g, '-').toLowerCase()}-tour.webm`;
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 10_000);
          useStore.getState().toast('Tour video saved', 'ok');
        };
        rec.start(500);
        recorder.current = rec;
        setRecording(true);
      } catch {
        st.toast('This browser cannot record the view', 'warn');
      }
    }
  };
  const stopTour = () => { walk.current.tour = false; walk.current.path = null; endTour(); };
  useEffect(() => () => { const r = recorder.current; if (r && r.state !== 'inactive') r.stop(); }, []);
  useEffect(() => { applyDemoLink(); }, []);
  // Development handle for the browser test scripts: read the walker, send it somewhere, start a tour.
  const devRef = useRef({ walk, walkTo, startTour, setMode });
  devRef.current = { walk, walkTo, startTour, setMode };
  useEffect(() => {
    const h = () => devRef.current.startTour(false);
    window.addEventListener('spacelens:tour', h);
    return () => window.removeEventListener('spacelens:tour', h);
  }, []);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as { __spacelensWalk?: unknown };
    w.__spacelensWalk = {
      get pos() { return devRef.current.walk.current.pos; },
      get path() { return devRef.current.walk.current.path; },
      walk: () => devRef.current.setMode('walk'),
      to: (x: number, y: number) => devRef.current.walkTo({ x, y }),
      tour: (record = false) => devRef.current.startTour(record),
      place: (x: number, y: number, yaw: number) => { const k = devRef.current.walk.current; k.pos = { x, y }; k.yaw = yaw; k.path = null; },
    };
    return () => { delete w.__spacelensWalk; };
  }, []);

  useEffect(() => {
    if (mode === 'walk') return;
    const isField = (t: EventTarget | null) => t instanceof HTMLElement && /INPUT|TEXTAREA|SELECT/.test(t.tagName);
    const down = (e: KeyboardEvent) => {
      if (isField(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k !== 'q' && k !== 'e') return;
      const st = useStore.getState();
      const sel = st.selection;
      if (sel?.kind !== 'furniture') return;
      const it = st.model.furniture.find((f) => f.id === sel.id);
      if (!it || it.locked) return;
      const deg = Math.PI / 180;
      const step = (e.shiftKey ? 90 : 15) * deg;
      let rot = Math.round((it.rotation + (k === 'e' ? step : -step)) / deg) * deg;
      rot = ((rot % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      const c = itemCorners({ ...it, rotation: rot });
      e.preventDefault();
      if (!st.model.spaces.some((s) => c.every((p) => pointInPolygon(p, s.polygon)))) { st.toast('No room to rotate here', 'warn'); return; }
      st.dispatch({ type: 'UPDATE_OBJECT', id: it.id, patch: { rotation: rot } });
    };
    window.addEventListener('keydown', down);
    return () => window.removeEventListener('keydown', down);
  }, [mode]);
  const fitRef = useRef(fit); fitRef.current = fit;
  useEffect(() => {
    const h = () => fitRef.current();
    window.addEventListener('spacelens:reset-view', h);
    return () => window.removeEventListener('spacelens:reset-view', h);
  }, []);

  useEffect(() => {
    const h = () => setMode('walk');
    window.addEventListener('spacelens:walk', h);
    return () => window.removeEventListener('spacelens:walk', h);
  }, []);

  useEffect(() => {
    if (mode !== 'walk') return;
    const isField = (t: EventTarget | null) => t instanceof HTMLElement && /INPUT|TEXTAREA|SELECT/.test(t.tagName);
    const down = (e: KeyboardEvent) => {
      if (isField(e.target)) return;
      const k = e.key.toLowerCase();
      if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) { walk.current.keys.add(k); e.preventDefault(); }
    };
    const up = (e: KeyboardEvent) => walk.current.keys.delete(e.key.toLowerCase());
    const blur = () => walk.current.keys.clear();
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur); blur(); };
  }, [mode]);

  const drag = useRef<{ x: number; y: number; id: number } | null>(null);
  const onDown = (e: React.PointerEvent) => { if (mode === 'walk') drag.current = { x: e.clientX, y: e.clientY, id: e.pointerId }; };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current; if (!d || d.id !== e.pointerId) return;
    const w = walk.current;
    w.yaw -= (e.clientX - d.x) * 0.005;
    w.pitch = Math.max(-1.2, Math.min(1.2, w.pitch - (e.clientY - d.y) * 0.004));
    d.x = e.clientX; d.y = e.clientY;
  };
  const onUp = () => { drag.current = null; };

  // The figure, the walk and VR all start at the entrance, looking in.
  const figAt = room.spawn.pos;
  const multi = model.spaces.length > 1;

  const live = mode === 'walk' || !!(passage && passage.poses.length > 1);

  return (
    <div className="scene3d" ref={wrap} style={{ background: backdrop }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
      <Canvas shadows dpr={[1, 2]} frameloop={live ? 'always' : 'demand'} camera={{ position: [room.cx + 6, 7, room.cy + 7], fov: 50, near: 0.05, far: 200 }}
        gl={{ antialias: true }} onCreated={({ gl }) => { glRef.current = gl; gl.xr.enabled = true; gl.shadowMap.type = THREE.PCFSoftShadowMap; gl.toneMapping = THREE.ACESFilmicToneMapping; gl.toneMappingExposure = 0.92; gl.outputColorSpace = THREE.SRGBColorSpace; }}>
        {xrMode !== 'immersive-ar' && <color attach="background" args={[backdrop]} />}
        <fog attach="fog" args={[backdrop, room.size * 4, room.size * 10]} />
        <hemisphereLight args={['#f4f1ea', '#5b5348', 0.18]} />
        <Sun hour={hour} room={room} />
        <Environment files={BASE + 'assets/env/lebombo_1k.hdr'} environmentIntensity={0.85} />

        {model.spaces.map((s) => <Floor key={s.id} space={s} onWalkTo={mode === 'walk' ? walkTo : undefined} />)}
        {room.edges.filter((e) => e.owner).map((e) => (
          <Wall key={e.spaceId + e.wallIndex + ':' + model.version} edge={e} ceiling={model.ceilingM}
            selected={selection?.kind === 'wall' && (selection.id === wallId(e.spaceId, e.wallIndex))} cutaway={cutaway && mode !== 'walk'} />
        ))}
        {multi && mode !== 'walk' && <RoomLabels spaces={model.spaces} />}
        {mode === 'walk' && model.spaces.map((s) => <Ceiling key={'c' + s.id} space={s} h={model.ceilingM} />)}
        {model.openings.filter((o) => o.kind === 'door').map((o) => {
          const s = model.spaces.find((x) => x.id === o.spaceId);
          return s && s.polygon.length > o.wallIndex ? <DoorLeaf key={o.id} space={s} o={o} /> : null;
        })}

        <Furniture items={shown} interactive={mode !== 'walk' && !activeCandidateId} onFocus={focusItem} />
        {activeCandidateId && showBefore && <Furniture items={model.furniture} ghost />}
        <Routes />
        <Heat />
        <Highlights items={shown} />
        <Passage items={shown} />
        {figure && mode !== 'walk' && <Figure at={figAt} />}

        <ContactShadows position={[room.cx, 0.005, room.cy]} scale={room.size * 1.6} opacity={0.55} blur={2.8} far={1.6} resolution={512} color="#2a2118" frames={1} />
        <OrbitControls makeDefault enableDamping={false} maxPolarAngle={Math.PI / 2 - 0.05} minDistance={1} maxDistance={room.size * 5} />
        <XRRig spawn={figAt} spawnYaw={room.spawn.yaw} />
        <CameraRig mode={mode} eye={eye} room={room} walk={walk} req={req} onRoom={setRoomId} onTourEnd={endTour} />
      </Canvas>

      <div className="scene3d-vignette" aria-hidden="true" />
      {mode !== 'walk' && selection?.kind === 'furniture' && <div className="scene3d-hint muted">Drag to move, Q/E to rotate, double-click to focus</div>}
      <div className="scene3d-ui" onPointerDown={(e) => e.stopPropagation()}>
        <div className="scene3d-modes">
          {(['dollhouse', 'top', 'walk'] as CamMode[]).map((m) => {
            const label = m === 'dollhouse' ? '3D view' : m === 'top' ? 'Top view' : 'Walk';
            return (
              <button key={m} className={`scene3d-ib${mode === m ? ' on' : ''}`} onClick={() => setMode(m)} aria-pressed={mode === m} aria-label={label} title={label}>
                <Icon name={m === 'dollhouse' ? 'cube' : m === 'top' ? 'grid' : 'walk'} />
              </button>
            );
          })}
          {multi && (touring
            ? <button className="scene3d-ib on" onClick={stopTour} aria-label="Stop tour" title="Stop tour"><Icon name="pause" /></button>
            : <>
              <button className="scene3d-ib" onClick={() => startTour(false)} aria-label="Auto tour" title="Auto tour"><Icon name="play" /></button>
              {canRecord && <button className="scene3d-ib" onClick={() => startTour(true)} aria-label="Record tour as video" title="Record tour as video"><Icon name="camera" /></button>}
            </>)}
          <span className="scene3d-sep" aria-hidden="true" />
          <button className="scene3d-ib" onClick={fit} aria-label="Fit room in view" title="Fit room in view"><Icon name="maximize" /></button>
          {xrSup.vr && <button className={`scene3d-ib${xrMode === 'immersive-vr' ? ' on' : ''}`} onClick={() => startXR('immersive-vr')} aria-label="Enter VR" title="Enter VR"><Icon name="eye" /></button>}
          {xrSup.ar && <button className={`scene3d-ib${xrMode === 'immersive-ar' ? ' on' : ''}`} onClick={() => startXR('immersive-ar')} aria-label="Enter AR" title="Enter AR"><Icon name="sparkles" /></button>}
          <button className={`scene3d-ib${open ? ' on' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open} aria-label="View options" title="View options"><Icon name="settings" /></button>
        </div>
        {open && (
          <div className="scene3d-opts">
            {mode === 'walk' && (
              <label className="scene3d-row">Eye height
                <select value={eyeId} onChange={(e) => setEyeId(e.target.value)}>
                  {EYES.map((e) => <option key={e.id} value={e.id}>{e.label} {e.h} m</option>)}
                </select>
              </label>
            )}
            {mode === 'dollhouse' && <label className="scene3d-row"><input type="checkbox" checked={cutaway} onChange={(e) => setCutaway(e.target.checked)} /> Cut away near walls</label>}
            {mode !== 'walk' && <label className="scene3d-row"><input type="checkbox" checked={figure} onChange={(e) => setFigure(e.target.checked)} /> 1.75 m person</label>}
            {activeCandidateId && <label className="scene3d-row"><input type="checkbox" checked={showBefore} onChange={(e) => setShowBefore(e.target.checked)} /> Show before</label>}
            <label className="scene3d-row scene3d-sun">Sun {String(Math.floor(hour)).padStart(2, '0')}:00
              <input type="range" min={6} max={21} step={0.5} value={hour} onChange={(e) => setHour(Number(e.target.value))} />
            </label>
            <div className="muted scene3d-note">Illustrative light, not a daylight study</div>
          </div>
        )}
      </div>
      {mode === 'walk' && (
        <>
          {!touring && <Joystick walk={walk} />}
          <div className="scene3d-hint muted">
            {multi && roomName && <div className="scene3d-here" aria-live="polite"><span className="sr-only">You are in </span>{roomName}</div>}
            {recording ? <span className="scene3d-rec">Recording</span> : touring ? 'Touring every room. Press a move key to stop.' : 'Tap floor or WASD to move, drag to look'}
          </div>
        </>
      )}
    </div>
  );
}
