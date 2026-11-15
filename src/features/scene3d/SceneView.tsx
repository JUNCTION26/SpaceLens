import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from 'react';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { AdaptiveDpr, ContactShadows, Edges, Environment, Html, OrbitControls, PerformanceMonitor } from '@react-three/drei';
import * as THREE from 'three';
import { useStore, useShownFurniture } from '../../core/store';
import {
  area, bounds, centroid, itemCorners, pointInPolygon, wallId,
} from '../../core/geometry';
import type { FurnitureItem, Space, Vec2 } from '../../core/types';
import { BOX_MATS, buildingBoxes, isOutdoor, mergedPlates, writeBox, type BoxMat } from './buildingMesh';
import { buildGrid, isRug, type OccGrid } from '../sim/grid';
import { clearOfWalls, doorBridges, entranceSpawn, onFloor, solidSegments, spaceAt, wallEdges, yawFor } from '../sim/walls';
import { pathBetween, planTour } from '../sim/tour';
import { applyDemoLink } from '../building/demo';
import { FurnitureMesh } from '../furniture/FurnitureMesh';
import { Icon } from '../../ui/icons';
import './scene3d.css';
import { XRRig } from '../xr/XRRig';
import { enterXR, useXRSupport, type XRMode } from '../xr/xrSupport';
import { approach, clampTarget, orientationLook } from './walkMath';
import { attachWalkInput, clampPitch, type WalkInput as WalkKeys } from '../sim/walkInput';
import { stepWalker } from '../sim/walker';
import { furnitureObstacles, segmentObstacles } from '../sim/collide';
import { Minimap } from '../sim/Minimap';

type CamMode = 'orbit' | 'walk';
type ViewKind = 'corner' | 'top' | 'front';
const EYES = [
  { id: 'standing', label: 'Standing', h: 1.6 },
  { id: 'seated', label: 'Seated', h: 1.2 },
  { id: 'child', label: 'Child', h: 1.0 },
  { id: 'wheelchair', label: 'Wheelchair', h: 1.2 },
];

interface CamReq { toP?: THREE.Vector3; toT?: THREE.Vector3; view?: ViewKind; focus?: THREE.Vector3; box?: { cx: number; cy: number; w: number; d: number }; n: number }

/** Shared between the furniture, the camera rig and the frame loop without React renders. */
interface Gesture {
  /** Pointer is down on a piece of furniture: orbit stays off until it is released. */
  onPiece: boolean;
  /** The user moved the camera since the last automatic framing. */
  touched: boolean;
  /** Something in the scene moved, so the sun's shadows must be redrawn. */
  shadowDirty: boolean;
  /** Walker is moving or turning this frame. */
  walking: boolean;
  /** The idle drift is turning the view: the light has not moved, so shadows stay as they are. */
  drifting?: boolean;
}

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
  /** Smoothed plan velocity (m/s) and current eye height, eased toward the wanted values. */
  vel?: Vec2; eyeY?: number;
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
// Faint ambient occlusion: walls darken softly toward the floor, the way light pools in a real room.
wallMat.onBeforeCompile = (sh) => {
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nvarying float vAoY;')
    .replace('#include <project_vertex>', `#include <project_vertex>
    vec4 aoW = vec4(transformed, 1.0);
    #ifdef USE_INSTANCING
    aoW = instanceMatrix * aoW;
    #endif
    vAoY = (modelMatrix * aoW).y;`);
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vAoY;')
    .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb *= mix(0.7, 1.0, smoothstep(0.0, 0.6, vAoY));');
};
const ceilMat = new THREE.MeshStandardMaterial({ color: '#f7f5f0', roughness: 0.95 });
const glassMat = new THREE.MeshPhysicalMaterial({ color: '#eef6ff', transmission: 1, thickness: 0.01, ior: 1.5, roughness: 0.04, metalness: 0, transparent: true, opacity: 1, depthWrite: false });
const frameMat = new THREE.MeshStandardMaterial({ color: '#fafaf8', roughness: 0.35 });
const doorMat = new THREE.MeshStandardMaterial({ color: '#d9cbb5', roughness: 0.6 });
const baseMat = new THREE.MeshStandardMaterial({ color: '#fbfaf7', roughness: 0.4 });
const railMat = new THREE.MeshStandardMaterial({ color: '#3d4148', roughness: 0.45, metalness: 0.6 });
const outdoorFloorMat = new THREE.MeshStandardMaterial({ color: '#bdb6aa', roughness: 0.95 });
const unitBox = new THREE.BoxGeometry(1, 1, 1);
const BOX_MAT: Record<BoxMat, THREE.Material> = { wall: wallMat, glass: glassMat, frame: frameMat, base: baseMat, rail: railMat, door: doorMat };
const SEL_COLOR = new THREE.Color('#9fd0ff'), PLAIN = new THREE.Color('#ffffff');

/** Motion is off for people who asked their system for less of it. */
const REDUCED = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
/** Automated browsers get a still camera so scripted checks see stable poses. */
const SCRIPTED = typeof navigator !== 'undefined' && !!(navigator as Navigator & { webdriver?: boolean }).webdriver;
/** True while walking: pieces settle at once instead of dropping or gliding. */
const WALKING = { on: false };
/** Vertical field of view: wide at eye level so a small room does not feel like a tunnel. */
const FOV = { orbit: 50, walk: 70 } as const;
type Quality = 'high' | 'low';
/** Start at full quality unless the screen is low density on a small CPU; frame drops lower it later. */
const START_QUALITY: Quality = typeof window !== 'undefined' && (window.devicePixelRatio || 1) < 1.25 && (navigator.hardwareConcurrency || 8) <= 4 ? 'low' : 'high';

/** Light of the day: 0..1 daylight strength and 0..1 night, from an hour between 6 and 23. */
function daylight(hour: number) {
  const t = Math.min(1, Math.max(0, (hour - 6) / 15));
  const day = Math.max(0, Math.sin(Math.PI * t));
  const night = Math.min(1, Math.max(0, (hour - 19) / 2.5));
  return { t, day, night };
}

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
    const bridges = doorBridges(edges);
    return { model, cx, cy, w, d, size, key, edges, solids, spawn, bridges };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model.version, model]);
}

/* ---------- Geometry ---------- */

/**
 * Floors (or ceilings) of every room as one mesh each for indoor and outdoor areas. Clicks select
 * or walk to the room under the pointer; hovering only writes a ref, so nothing re-renders.
 */
function Plates({ spaces, y, ceiling, onWalkTo, onFocus, hover }: { spaces: Space[]; y: number; ceiling?: boolean; onWalkTo?: (p: Vec2) => void; onFocus?: (p: THREE.Vector3) => void; hover?: MutableRefObject<string | null> }) {
  const invalidate = useThree((st) => st.invalidate);
  const parts = useMemo(() => {
    const groups = ceiling ? [spaces.filter((s) => !isOutdoor(s))] : [spaces.filter((s) => !isOutdoor(s)), spaces.filter(isOutdoor)];
    return groups.map((list, k) => ({ list, mat: ceiling ? ceilMat : k === 0 ? floorMat : outdoorFloorMat, ...mergedPlates(list, y, !ceiling) }));
  }, [spaces, y, ceiling]);
  useEffect(() => () => parts.forEach((pt) => pt.geometry.dispose()), [parts]);
  const roomOf = (pt: (typeof parts)[number], f: number | undefined) => (f == null ? undefined : pt.list[pt.triSpace[f]]);
  return (
    <>
      {parts.map((pt, k) => pt.list.length > 0 && (
        <mesh key={k} geometry={pt.geometry} material={pt.mat} receiveShadow
          raycast={ceiling ? () => null : undefined}
          onClick={ceiling ? undefined : (e) => {
            e.stopPropagation();
            // the end of an orbit or pan drag is not a click
            if (e.delta > 5) return;
            if (onWalkTo) { onWalkTo({ x: e.point.x, y: e.point.z }); return; }
            const sp = roomOf(pt, e.faceIndex ?? undefined);
            if (sp) useStore.getState().select({ kind: 'space', id: sp.id });
          }}
          onDoubleClick={ceiling || !onFocus ? undefined : (e) => { e.stopPropagation(); onFocus(e.point.clone()); }}
          onPointerMove={ceiling || !hover ? undefined : (e) => {
            const id = roomOf(pt, e.faceIndex ?? undefined)?.id ?? null;
            if (hover.current !== id) { hover.current = id; invalidate(); }
          }}
          onPointerOut={ceiling || !hover ? undefined : () => { if (hover.current) { hover.current = null; invalidate(); } }} />
      ))}
    </>
  );
}

/**
 * Every wall, window, baseboard, railing and door leaf of the building as instanced unit boxes,
 * one draw call per material. Facade walls between the camera and the building fold down by
 * rewriting only their instances; inner walls and railings stay standing.
 */
function BuildingShell({ room, selectedWall, cutaway, gesture, onFocus, pickable }: { room: ReturnType<typeof useRoom>; selectedWall: string | null; cutaway: boolean; gesture: MutableRefObject<Gesture>; onFocus?: (p: THREE.Vector3) => void; pickable: boolean }) {
  const data = useMemo(() => buildingBoxes(room.model, room.edges), [room]);
  const meshes = useRef<Partial<Record<BoxMat, THREE.InstancedMesh | null>>>({});
  const scale = useRef<number[]>([]);
  const invalidate = useThree((st) => st.invalidate);
  const sides = useMemo(() => data.edges.map((e) => ({ mid: { x: (e.a.x + e.b.x) / 2, y: (e.a.y + e.b.y) / 2 }, out: { x: -e.inward.x, y: -e.inward.y } })), [data]);
  // When a building is first shown, its walls rise out of the floor plan room by room over about 1.2 s.
  const rise = useRef<{ start: number; key: string; delay: number[]; span: number } | null>(null);
  const roomDelay = useMemo(() => {
    const order = new Map(room.model.spaces.map((sp, k) => [sp.id, k]));
    const n = Math.max(1, room.model.spaces.length);
    const gap = Math.min(0.12, 0.6 / n);
    return data.edges.map((e) => (order.get(e.spaceId) ?? 0) * gap);
  }, [data, room.model.spaces]);
  if (!REDUCED && (!rise.current || rise.current.key !== room.key)) {
    rise.current = { start: -1, key: room.key, delay: roomDelay, span: Math.max(0, ...roomDelay) + 1.2 };
  } else if (rise.current) rise.current.delay = roomDelay;

  useLayoutEffect(() => {
    scale.current = data.edges.map(() => 1);
    for (const m of BOX_MATS) {
      const mesh = meshes.current[m];
      if (!mesh) continue;
      data.byMat[m].forEach((bx, i) => writeBox(mesh, i, bx));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      // bounds come from the full height; a building still rising starts flat on the plan
      if (rise.current && rise.current.start !== -2) data.byMat[m].forEach((bx, i) => writeBox(mesh, i, bx, 0.002));
    }
    invalidate();
  }, [data, invalidate]);

  useLayoutEffect(() => {
    const mesh = meshes.current.wall;
    if (!mesh) return;
    data.byMat.wall.forEach((bx, i) => {
      const e = data.edges[bx.edge];
      mesh.setColorAt(i, e && selectedWall === wallId(e.spaceId, e.wallIndex) ? SEL_COLOR : PLAIN);
    });
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    invalidate();
  }, [data, selectedWall, invalidate]);

  useFrame(({ camera, clock }) => {
    const sc = scale.current;
    const r = rise.current;
    if (r && r.start !== -2) {
      if (r.start < 0) r.start = clock.elapsedTime;
      const t = clock.elapsedTime - r.start;
      const done = t >= r.span;
      const k = (edge: number) => {
        if (done) return 1;
        const d = edge >= 0 ? r.delay[edge] ?? 0 : r.span - 1.2;
        const u = Math.min(1, Math.max(0, (t - d) / 1.2));
        return Math.max(0.002, 1 - (1 - u) ** 3);
      };
      for (const m of BOX_MATS) {
        const mesh = meshes.current[m];
        if (!mesh) continue;
        data.byMat[m].forEach((bx, j) => writeBox(mesh, j, bx, k(bx.edge) * (bx.edge >= 0 ? sc[bx.edge] ?? 1 : 1)));
        mesh.instanceMatrix.needsUpdate = true;
      }
      if (done) r.start = -2;
      gesture.current.shadowDirty = true;
      invalidate();
      return;
    }
    let dirty: Set<number> | null = null;
    for (let i = 0; i < data.edges.length; i++) {
      if (!data.cuttable[i]) continue;
      const { mid, out } = sides[i];
      const outside = (camera.position.x - mid.x) * out.x + (camera.position.z - mid.y) * out.y > 0;
      const target = cutaway && outside && camera.position.y > 1.9 ? 0.06 : 1;
      if (Math.abs((sc[i] ?? 1) - target) > 0.005) { sc[i] = (sc[i] ?? 1) + (target - (sc[i] ?? 1)) * 0.2; (dirty ??= new Set()).add(i); }
    }
    if (!dirty) return;
    for (const m of ['wall', 'glass', 'frame', 'base'] as BoxMat[]) {
      const mesh = meshes.current[m];
      if (!mesh) continue;
      let touched = false;
      data.byMat[m].forEach((bx, j) => { if (dirty!.has(bx.edge)) { writeBox(mesh, j, bx, sc[bx.edge]); touched = true; } });
      if (touched) mesh.instanceMatrix.needsUpdate = true;
    }
    gesture.current.shadowDirty = true;
    invalidate();
  });

  const onWall = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (e.delta > 5) return;
    const bx = e.instanceId != null ? data.byMat.wall[e.instanceId] : undefined;
    const ed = bx ? data.edges[bx.edge] : undefined;
    if (ed) useStore.getState().select({ kind: 'wall', id: wallId(ed.spaceId, ed.wallIndex) });
  };
  return (
    <>
      {BOX_MATS.map((m) => {
        const n = data.byMat[m].length;
        if (!n) return null;
        return (
          <instancedMesh key={`${m}:${n}`} ref={(r) => { meshes.current[m] = r; }} args={[unitBox, BOX_MAT[m], n]}
            castShadow={m !== 'glass'} receiveShadow={m !== 'glass'} onClick={m === 'wall' && pickable ? onWall : undefined}
            onDoubleClick={m === 'wall' && onFocus ? (e) => { e.stopPropagation(); onFocus(e.point.clone()); } : undefined}
            raycast={m === 'wall' ? undefined : () => null} />
        );
      })}
    </>
  );
}

interface LabelAnchor { id: string; at: THREE.Vector3; side: number; nameW: number; fullW: number }

/**
 * Room labels for big plans. Each frame (only when the view changes) the labels are placed by
 * priority: the hovered room first, then the largest rooms. A label that would overlap one already
 * placed is hidden, labels fade out as their room gets small on screen, and the hovered room always
 * shows its full label with the area. All of it writes styles directly, without React renders.
 */
function LabelLayout({ spaces, box, hover }: { spaces: Space[]; box: RefObject<HTMLDivElement | null>; hover: MutableRefObject<string | null> }) {
  const anchors = useMemo<LabelAnchor[]>(() => spaces.map((s) => {
    const c = centroid(s.polygon);
    const at = pointInPolygon(c, s.polygon) ? c : s.polygon[0];
    const a = area(s.polygon);
    return { id: s.id, at: new THREE.Vector3(at.x, 0.1, at.y), side: Math.sqrt(a), nameW: s.name.length * 7 + 20, fullW: Math.max(s.name.length * 7, 48) + 20 };
  }).sort((p, q) => q.side - p.side), [spaces]);
  const v = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ camera, size }) => {
    const root = box.current;
    if (!root) return;
    const els = new Map<string, HTMLElement>();
    for (const el of Array.from(root.children) as HTMLElement[]) els.set(el.dataset.id ?? '', el);
    const cam = camera as THREE.PerspectiveCamera;
    const k = size.height / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov || 50) / 2));
    const placed: Array<[number, number, number, number]> = [];
    const hot = hover.current;
    const order = hot ? [...anchors.filter((a) => a.id === hot), ...anchors.filter((a) => a.id !== hot)] : anchors;
    for (const a of order) {
      const el = els.get(a.id);
      if (!el) continue;
      v.copy(a.at).applyMatrix4(camera.matrixWorldInverse);
      const depth = -v.z;
      v.copy(a.at).project(camera);
      const isHot = a.id === hot;
      const px = (a.side * k) / Math.max(depth, 0.1);
      const fade = isHot ? 1 : Math.max(0, Math.min(1, (px - 34) / 36));
      const full = isHot || px > 150;
      const w = full ? a.fullW : a.nameW, h = full ? 36 : 24;
      const x = (v.x * 0.5 + 0.5) * size.width, y = (-v.y * 0.5 + 0.5) * size.height;
      let show = depth > 0 && v.z < 1 && fade > 0.02 && x > -w && x < size.width + w && y > -h && y < size.height + h;
      if (show && !isHot) {
        for (const r of placed) if (x - w / 2 < r[2] && x + w / 2 > r[0] && y - h / 2 < r[3] && y + h / 2 > r[1]) { show = false; break; }
      }
      if (!show) { if (el.style.display !== 'none') el.style.display = 'none'; continue; }
      placed.push([x - w / 2 - 4, y - h / 2 - 2, x + w / 2 + 4, y + h / 2 + 2]);
      el.style.display = '';
      el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -50%)`;
      el.style.opacity = fade.toFixed(2);
      el.classList.toggle('full', full);
      el.classList.toggle('hot', isHot);
    }
  });
  return null;
}

/**
 * Moves a piece in instead of popping it: new pieces drop from 30 cm on a spring with a small squash
 * on landing, pieces that change pose between layouts glide there, and leaving pieces shrink away.
 * Everything is a transform on a wrapper group, so the furniture itself never re-renders.
 */
function Settle({ it, delay, leaving, instant, gesture, children }: { it: FurnitureItem; delay: number; leaving?: boolean; instant?: boolean; gesture: MutableRefObject<Gesture>; children: React.ReactNode }) {
  const outer = useRef<THREE.Group>(null);
  const invalidate = useThree((st) => st.invalidate);
  const st = useRef({ born: -1, y: REDUCED || leaving ? 0 : 0.3, vy: 0, dx: 0, dz: 0, dr: 0, s: 1, last: { x: it.x, y: it.y, r: it.rotation }, done: REDUCED });
  // a pose change that is not a live drag becomes an offset that springs back to zero: a glide
  const prev = st.current.last;
  if (prev.x !== it.x || prev.y !== it.y || prev.r !== it.rotation) {
    if (!instant && !REDUCED) {
      st.current.dx += prev.x - it.x; st.current.dz += prev.y - it.y;
      st.current.dr += angleTo(it.rotation, prev.r);
      st.current.done = false;
    }
    st.current.last = { x: it.x, y: it.y, r: it.rotation };
  }
  if (leaving && st.current.s > 0 && st.current.done) st.current.done = false;
  useLayoutEffect(() => { invalidate(); });
  // hidden until its turn in the stagger comes
  useLayoutEffect(() => { if (!st.current.done && !leaving) outer.current?.scale.setScalar(1e-4); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useFrame(({ clock }, dt) => {
    const g = outer.current, k = st.current;
    if (!g || k.done) return;
    const now = clock.elapsedTime;
    if (WALKING.on && !leaving) { k.y = 0; k.vy = 0; k.dx = 0; k.dz = 0; k.dr = 0; k.born = Math.min(k.born < 0 ? now : k.born, now); }
    if (k.born < 0) k.born = now + delay / 1000;
    const h = Math.min(dt, 1 / 30);
    let busy = false;
    if (now >= k.born) {
      // under-damped spring for the drop (a little bounce), near-critical for the glide
      const a = -170 * k.y - 13 * k.vy;
      k.vy += a * h; k.y += k.vy * h;
      if (Math.abs(k.y) + Math.abs(k.vy) > 0.002) busy = true; else { k.y = 0; k.vy = 0; }
      const f = 1 - Math.exp(-9 * h);
      k.dx -= k.dx * f; k.dz -= k.dz * f; k.dr -= k.dr * f;
      if (Math.abs(k.dx) + Math.abs(k.dz) + Math.abs(k.dr) > 0.002) busy = true; else { k.dx = 0; k.dz = 0; k.dr = 0; }
    } else busy = true;
    if (leaving) { k.s = Math.max(0, k.s - h / 0.25); if (k.s > 0) busy = true; }
    if (now < k.born) { g.scale.setScalar(1e-4); invalidate(); return; }
    // squash on impact: flatten while moving down fast near the floor, stretch slightly on rebound
    const sq = Math.max(-0.08, Math.min(0.05, k.vy * 0.035)) * (k.y < 0.06 ? 1 : 0.3);
    const sy = (1 + sq) * k.s, sxz = (1 / Math.sqrt(1 + sq)) * k.s;
    g.position.set(it.x + k.dx, Math.max(0, k.y), it.y + k.dz);
    g.rotation.y = -k.dr;
    g.scale.set(sxz, sy, sxz);
    gesture.current.shadowDirty = true;
    if (!busy) k.done = true;
    invalidate();
  });
  // pivot at the piece's own floor point, so scale and turn happen in place
  return (
    <group ref={outer} position={[it.x + st.current.dx, Math.max(0, st.current.y), it.y + st.current.dz]}>
      <group position={[-it.x, 0, -it.y]}>{children}</group>
    </group>
  );
}

function Furniture({ items, ghost, interactive, onFocus, gesture }: { items: FurnitureItem[]; ghost?: boolean; interactive?: boolean; onFocus?: (it: FurnitureItem) => void; gesture: MutableRefObject<Gesture> }) {
  const sel = useStore((s) => s.selection);
  const spaces = useStore((s) => s.model.spaces);
  const [hover, setHover] = useState<string | null>(null);
  const [dragPos, setDragPos] = useState<{ id: string; x: number; y: number } | null>(null);
  // Arrival order of new pieces (staggered drops) and pieces on their way out (shrink, then unmount).
  const seen = useRef<Map<string, FurnitureItem> | null>(null);
  const delays = useRef(new Map<string, number>());
  const [leaving, setLeaving] = useState<FurnitureItem[]>([]);
  useLayoutEffect(() => {
    if (ghost) return;
    const before = seen.current;
    const now = new Map(items.map((it) => [it.id, it]));
    const fresh = items.filter((it) => !before?.has(it.id));
    const step = Math.min(60, 1800 / Math.max(1, fresh.length));
    fresh.forEach((it, k) => delays.current.set(it.id, REDUCED ? 0 : k * step));
    if (before && !REDUCED) {
      const gone = [...before.values()].filter((it) => !now.has(it.id));
      if (gone.length) {
        setLeaving((l) => [...l.filter((g) => !now.has(g.id)), ...gone]);
        const ids = new Set(gone.map((g) => g.id));
        window.setTimeout(() => setLeaving((l) => l.filter((g) => !ids.has(g.id))), 320);
      }
    }
    seen.current = now;
  }, [items, ghost]);
  // A press on a piece becomes a drag only after the pointer travels a few pixels; a still press is a click.
  const drag = useRef<{ id: string; ox: number; oy: number; sx: number; sy: number; active: boolean; moved: boolean } | null>(null);
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
    gesture.current.onPiece = false;
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
            onClick={ghost ? undefined : (e) => { e.stopPropagation(); if (e.delta <= 5) useStore.getState().select({ kind: 'furniture', id: it.id }); }}
            onDoubleClick={live ? (e) => { e.stopPropagation(); onFocus?.(it); } : undefined}
            onPointerOver={live ? (e) => { e.stopPropagation(); setHover(it.id); document.body.style.cursor = it.locked ? 'pointer' : 'grab'; } : undefined}
            onPointerOut={live ? () => { setHover((h) => (h === it.id ? null : h)); document.body.style.cursor = ''; } : undefined}
            onPointerDown={live && !it.locked ? (e) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              const p = hit(e); if (!p) return;
              (e.target as Element).setPointerCapture?.(e.pointerId);
              drag.current = { id: it.id, ox: it.x - p.x, oy: it.y - p.z, sx: e.nativeEvent.clientX, sy: e.nativeEvent.clientY, active: false, moved: false };
              gesture.current.onPiece = true;
              if (controls) controls.enabled = false;
            } : undefined}
            onPointerMove={live ? (e) => {
              const d = drag.current; if (!d || d.id !== it.id) return;
              e.stopPropagation();
              if (!d.active) {
                if (Math.hypot(e.nativeEvent.clientX - d.sx, e.nativeEvent.clientY - d.sy) < 5) return;
                d.active = true;
                useStore.getState().select({ kind: 'furniture', id: it.id });
              }
              const p = hit(e); if (!p) return;
              const x = snap(p.x + d.ox), y = snap(p.z + d.oy);
              if (fits(raw, x, y)) { d.moved = true; gesture.current.shadowDirty = true; setDragPos({ id: it.id, x, y }); }
            } : undefined}
            onPointerUp={live ? (e) => end(e, raw) : undefined}
            onPointerCancel={live ? (e) => end(e, raw) : undefined}>
            <Settle it={it} delay={delays.current.get(it.id) ?? 0} instant={!!ghost || dragPos?.id === it.id || drag.current?.id === it.id} gesture={gesture}>
            <FurnitureMesh item={it} ghost={ghost} selected={isSel} />
            {live && (hover === it.id || isSel) && (
              <mesh position={[it.x, it.h / 2, it.y]} rotation={[0, -it.rotation, 0]} raycast={() => null}>
                <boxGeometry args={[it.w + 0.03, it.h + 0.03, it.d + 0.03]} />
                <meshBasicMaterial visible={false} />
                <Edges color={isSel ? '#4da3ff' : '#ffffff'} lineWidth={isSel ? 2.5 : 1.5} />
              </mesh>
            )}
            {live && isSel && (
              <Html position={[it.x, it.h + 0.18, it.y]} center zIndexRange={[2, 0]} style={{ pointerEvents: 'none' }}>
                <div className="scene3d-dim">{Math.round(it.w * 100)} × {Math.round(it.d * 100)} × {Math.round(it.h * 100)} cm</div>
              </Html>
            )}
            </Settle>
          </group>
        );
      })}
      {leaving.filter((it) => !items.some((f) => f.id === it.id)).map((it) => (
        <group key={'out:' + it.id} raycast={() => null}>
          <Settle it={it} delay={0} leaving gesture={gesture}><FurnitureMesh item={it} /></Settle>
        </group>
      ))}
    </>
  );
}

const ghostMat = new THREE.MeshBasicMaterial({ color: '#9aa4b2', transparent: true, opacity: 0.12, depthWrite: false });

/** The layout before a preview, drawn as see-through outlines so it never reads as real furniture. */
function GhostBoxes({ items }: { items: FurnitureItem[] }) {
  return (
    <group>
      {items.map((it) => (
        <mesh key={it.id} position={[it.x, it.h / 2, it.y]} rotation={[0, -it.rotation, 0]} material={ghostMat} raycast={() => null}>
          <boxGeometry args={[it.w, it.h, it.d]} />
          <Edges color="#8a94a3" />
        </mesh>
      ))}
    </group>
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
          <mesh key={`${k}:${id}`} position={[it.x, it.h / 2, it.y]} rotation={[0, -it.rotation, 0]}>
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
function homeView(room: ReturnType<typeof useRoom>, cam: THREE.Camera, kind: ViewKind, box?: { cx: number; cy: number; w: number; d: number }) {
  const pc = cam as THREE.PerspectiveCamera;
  const vHalf = THREE.MathUtils.degToRad(pc.fov || 50) / 2;
  const hHalf = Math.atan(Math.tan(vHalf) * (pc.aspect || 1));
  const { cx, cy, w, d } = box ?? room;
  const ceil = room.model.ceilingM || 2.5;
  if (kind === 'top') {
    const h = Math.max(d / 2 / Math.tan(vHalf), w / 2 / Math.tan(hHalf)) * 1.15 + ceil;
    return { p: new THREE.Vector3(cx, h, cy + 0.001), t: new THREE.Vector3(cx, 0, cy) };
  }
  // Bounding sphere of the room box; the target sits a little low so the floor reads well.
  const r = 0.5 * Math.hypot(w, d, ceil);
  // a little margin so corners and labels clear the pane edges and the floating bars
  const dist = (r / Math.sin(Math.min(vHalf, hHalf))) * 1.12;
  const t = new THREE.Vector3(cx, ceil * 0.35, cy);
  const dir = kind === 'front' ? new THREE.Vector3(0, 0.6, 1) : new THREE.Vector3(0.75, 1.05, 1.0);
  return { p: t.clone().addScaledVector(dir.normalize(), dist), t };
}

const angleTo = (from: number, to: number) => Math.atan2(Math.sin(to - from), Math.cos(to - from));

const UP_AXIS = new THREE.Vector3(0, 1, 0);
const nowMs = () => globalThis.performance.now();
interface Shot { t: number; dur: number; fromP: THREE.Vector3; fromT: THREE.Vector3; toP: THREE.Vector3; toT: THREE.Vector3; sweep: number }

type Controls = THREE.EventDispatcher<{ change: object; start: object; end: object }> & { target: THREE.Vector3; update: () => void; enabled: boolean };

function CameraRig({ mode, eye, room, walk, input, req, gesture, onRoom, onTourEnd }: {
  mode: CamMode; eye: number; room: ReturnType<typeof useRoom>; walk: MutableRefObject<Walk>; input: MutableRefObject<WalkKeys | null>; req: CamReq | null;
  gesture: MutableRefObject<Gesture>; onRoom: (spaceId: string | null) => void; onTourEnd: () => void;
}) {
  const { camera, invalidate } = useThree();
  const performance = useThree((s) => s.performance);
  const controls = useThree((s) => s.controls) as unknown as Controls | null;
  const anim = useRef<Shot | null>(null);
  /** Shots waiting to play after the current one (a door reveal is a move in, then a push forward). */
  const queue = useRef<Shot[]>([]);
  const lastInput = useRef(nowMs());
  const drift = useRef<{ t0: number; angle: number } | null>(null);
  const items = useShownFurniture();
  const lastRoom = useRef<string | null | undefined>(undefined);

  const aspect = useThree((s) => s.size.width / Math.max(1, s.size.height));
  const framed = useRef<{ key: string; aspect: number; mode: CamMode } | null>(null);
  const orbitPose = useRef<{ p: THREE.Vector3; t: THREE.Vector3; key: string } | null>(null);
  // Where the last glide ended, for controls that mount after the first framing.
  const lastT = useRef<THREE.Vector3 | null>(null);
  const flyTo = (toP: THREE.Vector3, toT: THREE.Vector3, seconds?: number, sweep = 0) => {
    if (controls) {
      // spend any leftover inertia now, so the camera does not drift off the new view after the glide
      const c = controls as unknown as { enableDamping: boolean };
      const damp = c.enableDamping; c.enableDamping = false; controls.update(); c.enableDamping = damp;
    }
    lastT.current = toT.clone();
    // start from where the camera actually looks (the walker does not move the orbit target)
    const fromT = controls
      ? camera.position.clone().add(camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(Math.max(1, camera.position.distanceTo(controls.target))))
      : new THREE.Vector3(room.cx, 0, room.cy);
    // a damped dolly: longer moves take a little longer, and nothing ever cuts unless motion is reduced
    const dur = REDUCED ? 0.001 : seconds ?? Math.min(1.6, Math.max(0.8, 0.7 + camera.position.distanceTo(toP) * 0.05));
    anim.current = { t: 0, dur, fromP: camera.position.clone(), fromT, toP: toP.clone(), toT: toT.clone(), sweep };
    queue.current = [];
    drift.current = null;
    gesture.current.touched = false;
    invalidate();
  };

  // The user's own camera moves win: they cancel any glide and stop automatic re-framing, and the
  // orbit target is kept over the building and above the floor so the view can never get lost.
  const boxRef = useRef({ minX: 0, minY: 0, maxX: 0, maxY: 0, ceil: 2.5 });
  boxRef.current = { minX: room.cx - room.w / 2, minY: room.cy - room.d / 2, maxX: room.cx + room.w / 2, maxY: room.cy + room.d / 2, ceil: room.model.ceilingM || 2.5 };
  useEffect(() => {
    if (!controls) return;
    if (lastT.current && !anim.current) { controls.target.copy(lastT.current); controls.update(); }
    const start = () => { anim.current = null; queue.current = []; gesture.current.touched = true; };
    const change = () => {
      if (anim.current) return;
      const b = boxRef.current;
      const t = controls.target, c = clampTarget(t, b, b.ceil);
      if (c.x !== t.x || c.y !== t.y || c.z !== t.z) {
        const dx = c.x - t.x, dy = c.y - t.y, dz = c.z - t.z;
        t.set(c.x, c.y, c.z); camera.position.x += dx; camera.position.y += dy; camera.position.z += dz;
      }
      if (camera.position.y < 0.25) camera.position.y = 0.25;
    };
    controls.addEventListener('start', start);
    controls.addEventListener('change', change);
    return () => { controls.removeEventListener('start', start); controls.removeEventListener('change', change); };
  }, [controls, camera, gesture]);

  useEffect(() => {
    // Frame when the mode or the room changes. A big pane resize (3D to Split) re-frames only if
    // the user has not moved the camera since, so the view never jumps out from under them.
    const f = framed.current;
    const sameRoom = f && f.key === room.key && f.mode === mode;
    if (sameRoom && (mode === 'walk' || gesture.current.touched || Math.abs(Math.log(f.aspect / aspect)) < 0.2)) return;
    framed.current = { key: room.key, aspect, mode };
    let toP: THREE.Vector3, toT: THREE.Vector3;
    // entering the walk remembers the orbit view; leaving it glides back there
    if (mode === 'walk' && f?.mode === 'orbit') orbitPose.current = { p: camera.position.clone(), t: controls ? controls.target.clone() : new THREE.Vector3(room.cx, 0, room.cy), key: room.key };
    const back = orbitPose.current;
    if (mode !== 'walk' && f?.mode === 'walk' && back && back.key === room.key) { toP = back.p.clone(); toT = back.t.clone(); }
    else if (mode !== 'walk') ({ p: toP, t: toT } = homeView(room, camera, 'corner'));
    else {
      const w = walk.current;
      // first walk in this building (or standing outside it): start at the entrance, looking in
      if (w.spawnedFor !== room.key || !spaceAt(room.model, w.pos)) {
        w.pos = { ...room.spawn.pos }; w.yaw = room.spawn.yaw; w.pitch = 0; w.spawnedFor = room.key; w.path = null; w.goal = null;
      }
      w.vel = { x: 0, y: 0 }; w.eyeY = eye;
      toP = new THREE.Vector3(w.pos.x, eye, w.pos.y);
      toT = toP.clone().add(new THREE.Vector3(-Math.sin(w.yaw) * Math.cos(w.pitch), Math.sin(w.pitch), -Math.cos(w.yaw) * Math.cos(w.pitch)));
    }
    flyTo(toP, toT);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, room.key, aspect]);

  useEffect(() => {
    if (!req || mode === 'walk') return;
    let toP = req.toP, toT = req.toT;
    if (req.view || req.box) ({ p: toP, t: toT } = homeView(room, camera, req.view ?? 'corner', req.box));
    if (req.focus && controls) {
      // keep the viewing direction, move the target to the point and come a little closer
      const off = camera.position.clone().sub(controls.target);
      const dist = Math.min(Math.max(off.length() * 0.6, 1.8), 6);
      toT = req.focus.clone();
      toP = toT.clone().addScaledVector(off.normalize(), dist);
      if (toP.y < 0.4) toP.y = 0.4;
    }
    if (!toP || !toT) return;
    flyTo(toP, toT);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req?.n]);

  // Camera director: other features ask for a named shot with
  //   window.dispatchEvent(new CustomEvent('spacelens:camera', { detail: { shot, seconds } }))
  // shot: 'orbit' (quarter turn around the building), 'dolly-in' (push toward the centre),
  // 'top-down' (plan view from above), 'eye-level' (standing height at the edge, looking in),
  // 'door-reveal' (arrive at the entrance, then push into the room). seconds is optional.
  const shotRef = useRef<(shot: string, seconds?: number) => void>(() => {});
  shotRef.current = (shot, seconds) => {
    if (mode === 'walk') return;
    const tgt = controls ? controls.target.clone() : new THREE.Vector3(room.cx, 0, room.cy);
    const sec = typeof seconds === 'number' && seconds > 0 ? seconds : undefined;
    const ceil = room.model.ceilingM || 2.5;
    if (shot === 'orbit') { flyTo(camera.position.clone(), tgt, sec ?? 8, Math.PI / 2); return; }
    if (shot === 'dolly-in') {
      const p = tgt.clone().add(camera.position.clone().sub(tgt).multiplyScalar(0.55));
      if (p.y < 0.6) p.y = 0.6;
      flyTo(p, tgt, sec ?? 2.5); return;
    }
    if (shot === 'top-down') { const v = homeView(room, camera, 'top'); flyTo(v.p, v.t, sec ?? 2); return; }
    if (shot === 'eye-level') {
      const c = new THREE.Vector3(room.cx, 1.2, room.cy);
      const p = new THREE.Vector3(room.cx + room.w * 0.42, 1.6, room.cy + room.d * 0.42);
      flyTo(p, c, sec ?? 2.5); return;
    }
    if (shot === 'door-reveal') {
      const sp = room.spawn, dir = new THREE.Vector3(-Math.sin(sp.yaw), 0, -Math.cos(sp.yaw));
      const at = new THREE.Vector3(sp.pos.x, 1.6, sp.pos.y).addScaledVector(dir, -0.8);
      const look = at.clone().addScaledVector(dir, 4).setY(1.2);
      const total = sec ?? 4;
      flyTo(at, look, total * 0.45);
      const end = at.clone().addScaledVector(dir, 1.6).setY(Math.min(1.7, ceil - 0.3));
      queue.current = [{ t: 0, dur: REDUCED ? 0.001 : total * 0.55, fromP: at, fromT: look, toP: end, toT: look.clone().addScaledVector(dir, 1.6), sweep: 0 }];
    }
  };
  useEffect(() => {
    const h = (e: Event) => { const d = (e as CustomEvent<{ shot?: string; seconds?: number }>).detail; if (d?.shot) shotRef.current(d.shot, d.seconds); };
    window.addEventListener('spacelens:camera', h);
    return () => window.removeEventListener('spacelens:camera', h);
  }, []);

  // Idle drift: after 5 s without input the view turns slowly through a few degrees; any input stops it.
  useEffect(() => {
    if (REDUCED || SCRIPTED) return;
    const touch = () => { lastInput.current = nowMs(); drift.current = null; };
    const evs = ['pointerdown', 'wheel', 'keydown', 'touchstart'] as const;
    evs.forEach((ev) => window.addEventListener(ev, touch, { passive: true, capture: true }));
    const tick = window.setInterval(() => { if (nowMs() - lastInput.current > 5000) invalidate(); }, 1000);
    return () => { evs.forEach((ev) => window.removeEventListener(ev, touch, { capture: true })); clearInterval(tick); };
  }, [invalidate]);

  // Inside some room, clear of every wall piece (door and opening gaps are open) and of furniture.
  const solidItems = useMemo(() => items.filter((it) => !isRug(it)).map((it) => itemCorners(it)), [items]);
  const world = useMemo(() => ({
    obstacles: [...segmentObstacles(room.solids), ...furnitureObstacles(items)],
    canStand: (p: Vec2) => !room.model.spaces.length || onFloor(room.model, p, room.bridges),
  }), [room, items]);
  const blocked = (p: Vec2) => {
    if (!room.model.spaces.length) return false;
    if (!onFloor(room.model, p, room.bridges) || !clearOfWalls(p, 0.2, room.solids)) return true;
    return solidItems.some((c) => pointInPolygon(p, c));
  };

  useFrame((_, dt) => {
    if (controls) controls.enabled = mode !== 'walk' && !gesture.current.onPiece;
    WALKING.on = mode === 'walk';
    const pc = camera as THREE.PerspectiveCamera;
    const wantFov = mode === 'walk' ? FOV.walk : FOV.orbit;
    if (pc.isPerspectiveCamera && Math.abs(pc.fov - wantFov) > 0.01) {
      pc.fov = REDUCED || Math.abs(pc.fov - wantFov) < 0.05 ? wantFov : pc.fov + (wantFov - pc.fov) * Math.min(1, dt * 4);
      pc.near = 0.05;
      pc.updateProjectionMatrix();
      invalidate();
    }
    const a = anim.current;
    if (a) {
      a.t = Math.min(1, a.t + dt / a.dur);
      const e = a.t < 0.5 ? 4 * a.t ** 3 : 1 - (-2 * a.t + 2) ** 3 / 2;
      camera.position.lerpVectors(a.fromP, a.toP, e);
      const tgt = new THREE.Vector3().lerpVectors(a.fromT, a.toT, e);
      if (a.sweep) camera.position.sub(tgt).applyAxisAngle(UP_AXIS, a.sweep * e).add(tgt);
      camera.lookAt(tgt);
      if (controls) controls.target.copy(tgt);
      if (a.t >= 1 && queue.current.length) {
        anim.current = queue.current.shift()!;
      } else if (a.t >= 1) {
        anim.current = null;
        lastInput.current = nowMs();
        if (mode === 'walk') { const w = walk.current; camera.rotation.set(w.pitch, w.yaw, 0, 'YXZ'); }
        else if (controls) controls.update();
      }
      performance.regress();
      invalidate();
      return;
    }
    if (mode !== 'walk') {
      gesture.current.walking = false;
      gesture.current.drifting = false;
      if (REDUCED || SCRIPTED || !controls || gesture.current.onPiece) return;
      const now = nowMs();
      if (now - lastInput.current < 5000) return;
      // a slow sway of about four degrees each way around the orbit target
      const d = (drift.current ??= { t0: now, angle: 0 });
      const ramp = Math.min(1, (now - d.t0) / 4000);
      const angle = THREE.MathUtils.degToRad(4) * ramp * Math.sin(((now - d.t0) / 1000) * (2 * Math.PI / 24));
      camera.position.sub(controls.target).applyAxisAngle(UP_AXIS, angle - d.angle).add(controls.target);
      d.angle = angle;
      camera.lookAt(controls.target);
      gesture.current.drifting = true;
      invalidate();
      return;
    }
    const w = walk.current;
    // capped so a stalled frame never jumps through a wall; generous enough for slow devices
    const step = Math.min(dt, 0.1);
    const ax = input.current?.read(step) ?? { forward: 0, strafe: 0, sprint: false, dYaw: 0, dPitch: 0 };
    const f = ax.forward, s = ax.strafe;
    w.yaw += ax.dYaw;
    w.pitch = clampPitch(w.pitch + ax.dPitch);
    const turning = ax.dYaw !== 0 || ax.dPitch !== 0;
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
        const st = Math.min(gl, Math.max(0.01, gl * Math.min(1, dt * 4)));
        const next = { x: w.pos.x + (gx / gl) * st, y: w.pos.y + (gy / gl) * st };
        if (blocked(next)) w.goal = null; else w.pos = next;
      }
    }
    // keys, thumb pad and gamepad: smooth acceleration, fixed sub-steps, sliding along walls and furniture
    let walker = { pos: w.pos, vel: w.vel ?? { x: 0, y: 0 }, yaw: w.yaw, pitch: w.pitch, phase: 0, blockedAt: null as Vec2 | null };
    if (!w.path && !w.goal) {
      for (let left = step; left > 1e-6; left -= 0.05) walker = stepWalker(walker, { forward: f, strafe: s, sprint: ax.sprint }, Math.min(0.05, left), { seated: false, bob: false }, world);
      w.pos = walker.pos;
    }
    const vel = walker.vel;
    w.vel = vel;
    const eyeY = w.eyeY ?? eye;
    w.eyeY = Math.abs(eye - eyeY) < 0.002 ? eye : approach(eyeY, eye, 8, step);
    const moving = !!(vel.x || vel.y || w.path || w.goal) || turning || w.eyeY !== eye;
    gesture.current.walking = moving;
    if (moving) performance.regress();
    camera.position.set(w.pos.x, w.eyeY, w.pos.y);
    camera.rotation.set(w.pitch, w.yaw, 0, 'YXZ');
    const here = room.model.spaces.length > 1 ? spaceAt(room.model, w.pos)?.id ?? null : null;
    if (here !== lastRoom.current) { lastRoom.current = here; onRoom(here); }
  });
  return null;
}

/**
 * Keeps input instant and motion smooth: the sun's shadow map is redrawn only while the view is
 * still (the light does not move with the camera), and resolution drops while moving through
 * AdaptiveDpr, coming back as soon as the camera rests.
 */
function MotionBudget({ gesture, mode, deps }: { gesture: MutableRefObject<Gesture>; mode: CamMode; deps: unknown[] }) {
  const gl = useThree((s) => s.gl);
  const invalidate = useThree((s) => s.invalidate);
  const performance = useThree((s) => s.performance);
  useEffect(() => { gl.shadowMap.autoUpdate = false; gl.shadowMap.needsUpdate = true; return () => { gl.shadowMap.autoUpdate = true; }; }, [gl]);
  useEffect(() => { gesture.current.shadowDirty = true; invalidate(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, deps);
  const wasMoving = useRef(false);
  useFrame(() => {
    const g = gesture.current;
    const moving = performance.current < 1 || g.walking;
    if (!moving && (g.shadowDirty || wasMoving.current || (mode !== 'walk' && !g.drifting))) { gl.shadowMap.needsUpdate = true; g.shadowDirty = false; }
    else if (moving && g.shadowDirty && mode !== 'walk') { gl.shadowMap.needsUpdate = true; g.shadowDirty = false; }
    // one more frame once the camera rests, at full resolution with fresh shadows
    if (wasMoving.current && !moving) invalidate();
    wasMoving.current = moving;
  });
  return null;
}

/** Test handle: the live camera pose for browser scripts (window.__spacelens3d). */
function DevHandle({ mode, extra }: { mode: string; extra: MutableRefObject<Record<string, unknown>> }) {
  const get = useThree((s) => s.get);
  useEffect(() => {
    const w = window as unknown as { __spacelens3d?: unknown };
    const r = (v: THREE.Vector3) => [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)];
    w.__spacelens3d = {
      get pose() {
        const s = get();
        const c = s.controls as unknown as { target?: THREE.Vector3; enabled?: boolean } | null;
        const t = c?.target ?? new THREE.Vector3();
        return { p: r(s.camera.position), t: r(t), dist: +s.camera.position.distanceTo(t).toFixed(3), enabled: c?.enabled ?? null, frameloop: s.frameloop, dpr: s.viewport.dpr, lost: s.gl.getContext().isContextLost() };
      },
      mode,
      get frames() { return get().gl.info.render.frame; },
      /** Furniture ids that have meshes in the scene right now. */
      furniture() {
        const ids = new Set<string>();
        get().scene.traverse((o) => { const id = o.userData?.furnitureId; if (typeof id === 'string') ids.add(id); });
        return [...ids].sort();
      },
      project(x: number, y: number, z: number) {
        const s = get();
        const v = new THREE.Vector3(x, y, z).project(s.camera);
        const r = s.gl.domElement.getBoundingClientRect();
        return { x: Math.round(r.left + (v.x * 0.5 + 0.5) * r.width), y: Math.round(r.top + (-v.y * 0.5 + 0.5) * r.height) };
      },
      get ui() { return extra.current; },
    };
    return () => { delete w.__spacelens3d; };
  }, [get, mode, extra]);
  return null;
}

/**
 * The key light: a soft sun whose direction follows the time of day and which shines in through the
 * window openings. It warms and sinks toward evening and fades out at night.
 */
function Sun({ hour, room, quality }: { hour: number; room: ReturnType<typeof useRoom>; quality: Quality }) {
  const ref = useRef<THREE.DirectionalLight>(null);
  const { scene } = useThree();
  const { t, day, night } = daylight(hour);
  const az = Math.PI * (0.1 + 0.8 * t);
  const el = Math.max(0.1, day) * 1.05;
  const R = room.size * 2 + 4;
  const pos: [number, number, number] = [room.cx + Math.cos(az) * R * Math.cos(el), Math.sin(el) * R, room.cy - Math.sin(az) * R * 0.6];
  const warm = new THREE.Color('#ff9a52').lerp(new THREE.Color('#fff4e2'), Math.min(1, day * 1.6));
  const size = quality === 'high' ? 2048 : 1024;
  useEffect(() => {
    if (!ref.current) return;
    ref.current.target.position.set(room.cx, 0, room.cy);
    scene.add(ref.current.target);
    const s = room.size;
    const c = ref.current.shadow.camera;
    c.left = -s; c.right = s; c.top = s; c.bottom = -s; c.far = R * 3; c.updateProjectionMatrix();
  }, [room, scene, R, size]);
  return <directionalLight key={size} ref={ref} position={pos} intensity={(0.35 + 2.6 * day) * (1 - night)} color={warm} castShadow shadow-mapSize={[size, size]} shadow-bias={-0.0004} shadow-normalBias={0.02} shadow-radius={quality === 'high' ? 6 : 3} />;
}

/** Warm pools of light from lamps once the sun has gone down. A fixed number of lights, so shaders never recompile. */
const LAMP_LIGHTS = 3;
function LampGlow({ items, hour }: { items: FurnitureItem[]; hour: number }) {
  const lamps = useMemo(() => items.filter((it) => /lamp|light/i.test(it.category)).slice(0, LAMP_LIGHTS), [items]);
  const { night } = daylight(hour);
  return (
    <>
      {Array.from({ length: LAMP_LIGHTS }, (_, k) => {
        const it = lamps[k];
        return <pointLight key={k} position={it ? [it.x, Math.max(0.4, it.h * 0.85), it.y] : [0, -10, 0]} color="#ffb768" intensity={it ? night * 3.2 : 0} distance={4.5} decay={2} />;
      })}
    </>
  );
}

/** A soft cool rim light over the selected piece, so it reads as lifted rather than painted. */
function SelectionRim({ items }: { items: FurnitureItem[] }) {
  const sel = useStore((s) => s.selection);
  const it = sel?.kind === 'furniture' ? items.find((f) => f.id === sel.id) : undefined;
  return <pointLight position={it ? [it.x - 0.4, it.h + 0.7, it.y - 0.4] : [0, -10, 0]} color="#cfe6ff" intensity={it ? 2.2 : 0} distance={2.6} decay={2} />;
}


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

const COARSE = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
const isField = (t: EventTarget | null) => t instanceof HTMLElement && (/INPUT|TEXTAREA|SELECT/.test(t.tagName) || t.isContentEditable);

/** Mouse and key reference, opened from the "?" button. */
function HelpCard({ mode }: { mode: CamMode }) {
  const rows: Array<[string, string]> = mode === 'walk'
    ? [['Click', 'Look around'], ['W A S D, arrows', 'Move'], ['Shift', 'Move faster'], ['C, Space', 'Lower, raise eyes'], ['Click again', 'Walk there'], ['Esc', 'Release the mouse']]
    : [['Drag', 'Turn around'], ['Right-drag, Shift+drag', 'Pan'], ['Wheel', 'Zoom'], ['Double-click', 'Focus there'], ['F', 'Zoom to selection'], ['0, Home', 'Reset the view']];
  return (
    <div className="scene3d-opts scene3d-help" role="dialog" aria-label="Controls">
      <dl>{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
    </div>
  );
}

/** Plan chip in the corner of the eye view: where the visitor stands and which way they face. */
function WalkMinimap({ model, walk }: { model: ReturnType<typeof useRoom>['model']; walk: MutableRefObject<Walk> }) {
  const [at, setAt] = useState(() => ({ pos: walk.current.pos, yaw: walk.current.yaw }));
  useEffect(() => {
    const t = window.setInterval(() => {
      const w = walk.current;
      setAt((o) => (o.pos.x === w.pos.x && o.pos.y === w.pos.y && o.yaw === w.yaw ? o : { pos: { ...w.pos }, yaw: w.yaw }));
    }, 100);
    return () => clearInterval(t);
  }, [walk]);
  return <Minimap model={model} pos={at.pos} yaw={at.yaw} />;
}

export function SceneView() {
  const backdrop = useBackdrop();
  const room = useRoom();
  const { model } = room;
  const shown = useShownFurniture();
  const activeCandidateId = useStore((s) => s.activeCandidateId);
  const selection = useStore((s) => s.selection);
  const passage = useStore((s) => s.analysis.passage);
  const [mode, setMode] = useState<CamMode>('orbit');
  const [eyeId, setEyeId] = useState('standing');
  const [cutaway, setCutaway] = useState(true);
  const [figure, setFigure] = useState(false);
  const [showBefore, setShowBefore] = useState(false);
  const [hour, setHour] = useState(15);
  const [quality, setQuality] = useState<Quality>(START_QUALITY);
  const light = daylight(hour);
  const [menu, setMenu] = useState<'view' | 'help' | null>(null);
  const [fs, setFs] = useState(false);
  const [idle, setIdle] = useState(false);
  const [tilt, setTilt] = useState(false);
  const gesture = useRef<Gesture>({ onPiece: false, touched: false, shadowDirty: true, walking: false });
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
  const walkKeys = useRef<WalkKeys | null>(null);
  const [req, setReq] = useState<CamReq | null>(null);
  const reqN = useRef(0);
  const ask = (r: Omit<CamReq, 'n'>) => setReq({ ...r, n: ++reqN.current });
  const view = (v: ViewKind) => { if (mode === 'walk') setMode('orbit'); ask({ view: v }); };
  const fit = () => { if (mode === 'walk') { setMode('orbit'); return; } ask({ view: 'corner' }); };
  const focusItem = (it: FurnitureItem) => {
    const r = Math.max(it.w, it.d, it.h, 0.6) * 2.2 + 0.6;
    ask({ toP: new THREE.Vector3(it.x + r * 0.6, it.h + r * 0.7, it.y + r * 0.8), toT: new THREE.Vector3(it.x, it.h / 2, it.y) });
  };
  const focusPoint = (p: THREE.Vector3) => ask({ focus: p });
  const frameSelection = () => {
    const sel = useStore.getState().selection;
    if (sel?.kind === 'furniture') {
      const it = shown.find((f) => f.id === sel.id);
      if (it) { focusItem(it); return; }
    }
    if (sel?.kind === 'space') {
      const sp = model.spaces.find((s) => s.id === sel.id);
      if (sp) {
        const b = bounds(sp.polygon) as unknown as { minX: number; minY: number; maxX: number; maxY: number };
        ask({ box: { cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, w: Math.max(b.maxX - b.minX, 1), d: Math.max(b.maxY - b.minY, 1) } });
        return;
      }
    }
    ask({ view: 'corner' });
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
  const touringRef = useRef(touring); touringRef.current = touring;
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
    setMenu(null);
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

  /* ----- Full screen: the 3D view alone, with the control strip fading out while the mouse rests ----- */
  // Where the Fullscreen API is missing or refused (iPhone, embedded pages) the view fills the window instead.
  const [pseudoFs, setPseudoFs] = useState(false);
  const toggleFs = () => {
    const el = wrap.current;
    if (!el) return;
    if (pseudoFs) { setPseudoFs(false); return; }
    if (document.fullscreenElement) { void document.exitFullscreen().catch(() => {}); return; }
    const p = el.requestFullscreen?.();
    if (!p) { setPseudoFs(true); return; }
    p.catch(() => setPseudoFs(true));
  };
  useEffect(() => {
    const on = () => setFs(!!wrap.current && document.fullscreenElement === wrap.current);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  useEffect(() => {
    if (!pseudoFs) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setPseudoFs(false); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [pseudoFs]);
  const full = fs || pseudoFs;
  const idleT = useRef<number | undefined>(undefined);
  const wake = () => {
    if (!full) return;
    setIdle(false);
    clearTimeout(idleT.current);
    idleT.current = window.setTimeout(() => setIdle(true), 2500);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (full) wake(); else { clearTimeout(idleT.current); setIdle(false); } }, [full]);


  /* ----- Walk: keys, drag to look, touch halves, gamepad ----- */
  // Keys work the moment the walk opens: the view takes focus and a text field never keeps it.
  useEffect(() => {
    const el = wrap.current;
    if (mode !== 'walk' || !el) return;
    const a = document.activeElement;
    if (a instanceof HTMLElement && a !== el && isField(a)) a.blur();
    el.focus({ preventScroll: true });
    const h = attachWalkInput(el, { enabled: () => !touringRef.current, onExit: () => setMode('orbit') });
    walkKeys.current = h;
    return () => { h.dispose(); walkKeys.current = null; };
  }, [mode]);

  /* ----- Walk: look around by turning the phone ----- */
  const startTilt = async () => {
    const D = (window as unknown as { DeviceOrientationEvent?: { requestPermission?: () => Promise<string> } }).DeviceOrientationEvent;
    if (!D) { useStore.getState().toast('This device has no motion sensor', 'warn'); return; }
    if (typeof D.requestPermission === 'function') {
      try { if ((await D.requestPermission()) !== 'granted') { useStore.getState().toast('Motion access was not allowed', 'warn'); return; } } catch { return; }
    }
    setTilt(true);
  };
  useEffect(() => {
    if (!tilt || mode !== 'walk') return;
    let base: { a: number; yaw: number } | null = null;
    const on = (e: DeviceOrientationEvent) => {
      if (e.alpha == null || e.beta == null) return;
      const w = walk.current;
      if (!base) base = { a: e.alpha, yaw: w.yaw };
      const l = orientationLook(e.alpha, e.beta, base.a, base.yaw);
      w.yaw = l.yaw; w.pitch = l.pitch;
    };
    window.addEventListener('deviceorientation', on);
    return () => window.removeEventListener('deviceorientation', on);
  }, [tilt, mode]);

  // Development handle for the browser test scripts: read the walker, send it somewhere, start a tour.
  const devRef = useRef({ walk, walkTo, startTour, setMode });
  devRef.current = { walk, walkTo, startTour, setMode };
  useEffect(() => {
    const h = () => devRef.current.startTour(false);
    window.addEventListener('spacelens:auto-tour', h);
    return () => window.removeEventListener('spacelens:auto-tour', h);
  }, []);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as { __spacelensWalk?: unknown };
    w.__spacelensWalk = {
      get pos() { return devRef.current.walk.current.pos; },
      get path() { return devRef.current.walk.current.path; },
      get look() { const k = devRef.current.walk.current; return { yaw: k.yaw, pitch: k.pitch }; },
      walk: () => devRef.current.setMode('walk'),
      to: (x: number, y: number) => devRef.current.walkTo({ x, y }),
      tour: (record = false) => devRef.current.startTour(record),
      info: () => { const i = glRef.current?.info; return i ? { calls: i.render.calls, triangles: i.render.triangles, geometries: i.memory.geometries } : null; },
      place: (x: number, y: number, yaw: number) => { const k = devRef.current.walk.current; k.pos = { x, y }; k.yaw = yaw; k.path = null; },
    };
    return () => { delete w.__spacelensWalk; };
  }, []);

  // Keys for the orbit view (and Shift+F everywhere). Handlers read the latest closures through a ref.
  const keyActs = useRef({ toggleFs, frameSelection, view });
  keyActs.current = { toggleFs, frameSelection, view };
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (isField(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      const A = keyActs.current;
      if (k === 'f' && e.shiftKey) { e.preventDefault(); A.toggleFs(); return; }
      if (mode === 'walk') return;
      if (k === 'f') { A.frameSelection(); return; }
      if (k === '0' || e.key === 'Home') { e.preventDefault(); A.view('corner'); return; }
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


  const onDown = () => {
    // The orbit controls cancel the default pointer action, so a search box elsewhere would keep the
    // keyboard; take focus so F, Home and WASD reach the 3D view right after a click in it.
    if (wrap.current && document.activeElement !== wrap.current) wrap.current.focus({ preventScroll: true });
    if (menu) setMenu(null);
  };

  // The figure, the walk and VR all start at the entrance, looking in.
  const figAt = room.spawn.pos;
  const multi = model.spaces.length > 1;
  const hoverRoom = useRef<string | null>(null);
  const labelBox = useRef<HTMLDivElement>(null);

  const live = mode === 'walk' || !!(passage && passage.poses.length > 1);
  const devExtra = useRef<Record<string, unknown>>({});
  devExtra.current = { fs, pseudoFs, eye, menu };

  return (
    <div className={`scene3d${full ? ' is-fs' : ''}${pseudoFs ? ' is-pseudo' : ''}${idle ? ' is-idle' : ''}`} ref={wrap} tabIndex={-1} style={{ background: backdrop }}
      onPointerDown={onDown} onPointerMove={wake}>
      <Canvas shadows dpr={quality === 'high' ? [1, 2] : [1, 1.25]} performance={{ min: 0.6, debounce: 250 }} frameloop={live ? 'always' : 'demand'} camera={{ position: [room.cx + 6, 7, room.cy + 7], fov: 50, near: 0.05, far: 200 }}
        gl={{ antialias: true }} onCreated={({ gl }) => { glRef.current = gl; gl.xr.enabled = true; gl.shadowMap.type = THREE.PCFSoftShadowMap; gl.toneMapping = THREE.ACESFilmicToneMapping; gl.toneMappingExposure = 0.95; gl.outputColorSpace = THREE.SRGBColorSpace; }}>
        {xrMode !== 'immersive-ar' && <color attach="background" args={[backdrop]} />}
        <fog attach="fog" args={[backdrop, room.size * 2.6, room.size * 8]} />
        <hemisphereLight args={[light.night > 0.5 ? '#5a6a8a' : '#f4f1ea', '#5b5348', (mode === 'walk' ? 0.55 : 0.18) * (1 - 0.5 * light.night)]} />
        {mode === 'walk' && <ambientLight color="#fff6ea" intensity={0.3} />}
        <Sun hour={hour} room={room} quality={quality} />
        <Environment files={BASE + 'assets/env/lebombo_1k.hdr'} environmentIntensity={0.85 * (1 - 0.8 * light.night) * (0.75 + 0.25 * light.day)} />
        <LampGlow items={shown} hour={hour} />
        <SelectionRim items={shown} />
        <PerformanceMonitor onDecline={() => setQuality('low')} flipflops={2} />

        <Plates spaces={model.spaces} y={0} onWalkTo={mode === 'walk' ? () => {} : undefined} onFocus={mode === 'walk' ? undefined : focusPoint} hover={multi ? hoverRoom : undefined} />
        <BuildingShell room={room} selectedWall={selection?.kind === 'wall' ? selection.id : null} cutaway={cutaway && mode !== 'walk'} gesture={gesture} onFocus={mode === 'walk' ? undefined : focusPoint} pickable={mode !== 'walk'} />
        {multi && mode !== 'walk' && <LabelLayout spaces={model.spaces} box={labelBox} hover={hoverRoom} />}
        {mode === 'walk' && <Plates spaces={model.spaces} y={model.ceilingM} ceiling />}

        <Furniture items={shown} interactive={mode !== 'walk' && !activeCandidateId} onFocus={focusItem} gesture={gesture} />
        {activeCandidateId && showBefore && <GhostBoxes items={model.furniture} />}
        <Routes />
        <Heat />
        <Highlights items={shown} />
        <Passage items={shown} />
        {figure && mode !== 'walk' && <Figure at={figAt} />}

        {quality === 'high' && <ContactShadows position={[room.cx, 0.005, room.cy]} scale={room.size * 1.6} opacity={0.55} blur={2.8} far={1.6} resolution={512} color="#2a2118" frames={1} />}
        <OrbitControls makeDefault regress enableDamping dampingFactor={0.12} zoomToCursor screenSpacePanning={false} zoomSpeed={0.9} rotateSpeed={0.8}
          maxPolarAngle={Math.PI / 2 - 0.05} minDistance={0.6} maxDistance={room.size * 4} />
        <AdaptiveDpr />
        <MotionBudget gesture={gesture} mode={mode} deps={[model, shown, hour, showBefore, activeCandidateId, mode, figure, quality]} />
        <XRRig spawn={figAt} spawnYaw={room.spawn.yaw} />
        <CameraRig mode={mode} eye={eye} room={room} walk={walk} input={walkKeys} req={req} gesture={gesture} onRoom={setRoomId} onTourEnd={endTour} />
        <DevHandle mode={mode} extra={devExtra} />
      </Canvas>

      {multi && mode !== 'walk' && (
        <div className="scene3d-labels" ref={labelBox} aria-hidden="true">
          {model.spaces.map((s) => (
            <div key={s.id} data-id={s.id} className="scene3d-roomlabel" style={{ display: 'none' }}>{s.name}<span>{area(s.polygon).toFixed(0)} m²</span></div>
          ))}
        </div>
      )}
      <div className="scene3d-vignette" aria-hidden="true" />
      {mode !== 'walk' && selection?.kind === 'furniture' && <div className="scene3d-hint muted">Drag to move, Q/E to rotate</div>}
      <div className="scene3d-ui" onPointerDown={(e) => e.stopPropagation()}>
        <div className="scene3d-modes" role="toolbar" aria-label="3D view">
          <button className={`scene3d-ib${mode === 'walk' ? ' on' : ''}`} onClick={() => setMode(mode === 'walk' ? 'orbit' : 'walk')} aria-pressed={mode === 'walk'} aria-label="Walk" title={mode === 'walk' ? 'Back to orbit (Esc)' : 'Eye view'}>
            <Icon name="walk" />
          </button>
          {touring && <button className="scene3d-ib on" onClick={stopTour} aria-label="Stop tour" title="Stop tour"><Icon name="pause" /></button>}
          <button className={`scene3d-ib${full ? ' on' : ''}`} onClick={toggleFs} aria-pressed={full} aria-label="Full screen" title={full ? 'Leave full screen (Esc)' : 'Full screen (Shift+F)'}>
            <Icon name={full ? 'x' : 'maximize'} />
          </button>
          {mode !== 'walk' && (
            <button className={`scene3d-ib${menu === 'help' ? ' on' : ''}`} onClick={() => setMenu(menu === 'help' ? null : 'help')} aria-expanded={menu === 'help'} aria-label="Controls" title="Controls">
              <span className="scene3d-q" aria-hidden="true">?</span>
            </button>
          )}
          <button className={`scene3d-tb${menu === 'view' ? ' on' : ''}`} onClick={() => setMenu(menu === 'view' ? null : 'view')} aria-expanded={menu === 'view'}>
            View<Icon name="chevronDown" />
          </button>
        </div>
        {menu === 'help' && mode !== 'walk' && <HelpCard mode={mode} />}
        {menu === 'view' && (
          <div className="scene3d-opts">
            <div className="scene3d-chips" role="group" aria-label="Camera">
              {(['corner', 'top', 'front'] as ViewKind[]).map((v) => (
                <button key={v} className="scene3d-chip" onClick={() => view(v)}>{v === 'corner' ? 'Corner' : v === 'top' ? 'Top' : 'Front'}</button>
              ))}
            </div>
            {(multi && !touring) || xrSup.vr || xrSup.ar ? (
              <div className="scene3d-chips">
                {multi && !touring && <button className="scene3d-chip" onClick={() => startTour(false)}>Auto tour</button>}
                {multi && !touring && canRecord && <button className="scene3d-chip" onClick={() => startTour(true)}>Record tour</button>}
                {xrSup.vr && <button className={`scene3d-chip${xrMode === 'immersive-vr' ? ' on' : ''}`} onClick={() => startXR('immersive-vr')}>VR</button>}
                {xrSup.ar && <button className={`scene3d-chip${xrMode === 'immersive-ar' ? ' on' : ''}`} onClick={() => startXR('immersive-ar')}>AR</button>}
              </div>
            ) : null}
            {mode === 'walk' && (
              <label className="scene3d-row">Eye height
                <select value={eyeId} onChange={(e) => setEyeId(e.target.value)}>
                  {EYES.map((e) => <option key={e.id} value={e.id}>{e.label} {e.h} m</option>)}
                </select>
              </label>
            )}
            {mode === 'walk' && COARSE && <label className="scene3d-row"><input type="checkbox" checked={tilt} onChange={(e) => { if (e.target.checked) void startTilt(); else setTilt(false); }} /> Look by moving the phone</label>}
            {mode !== 'walk' && <label className="scene3d-row"><input type="checkbox" checked={cutaway} onChange={(e) => setCutaway(e.target.checked)} /> Cut away near walls</label>}
            {mode !== 'walk' && <label className="scene3d-row"><input type="checkbox" checked={figure} onChange={(e) => setFigure(e.target.checked)} /> 1.75 m person</label>}
            {activeCandidateId && <label className="scene3d-row"><input type="checkbox" checked={showBefore} onChange={(e) => setShowBefore(e.target.checked)} /> Show before</label>}
            <label className="scene3d-row scene3d-sun" title={`${String(Math.floor(hour)).padStart(2, '0')}:${String(Math.round((hour % 1) * 60)).padStart(2, '0')}`}>
              <Icon name="sun" /><span className="sr-only">Time of day</span>
              <input type="range" min={6} max={23} step={0.25} value={hour} onChange={(e) => setHour(Number(e.target.value))} aria-label="Time of day" />
            </label>
            <div className="scene3d-chips" role="group" aria-label="Quality">
              <button className={`scene3d-chip${quality === 'high' ? ' on' : ''}`} aria-pressed={quality === 'high'} onClick={() => setQuality(quality === 'high' ? 'low' : 'high')}>HQ</button>
            </div>
            <div className="muted scene3d-note">Illustrative light, not a daylight study</div>
          </div>
        )}
      </div>
      {mode === 'walk' && <WalkMinimap model={model} walk={walk} />}
      {mode === 'walk' && <div className="sr-only" aria-live="polite">{recording ? 'Recording' : multi && roomName ? roomName : ''}</div>}
    </div>
  );
}
