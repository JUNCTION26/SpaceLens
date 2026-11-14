import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/examples/jsm/webxr/XRControllerModelFactory.js';
import { XRHandModelFactory } from 'three/examples/jsm/webxr/XRHandModelFactory.js';
import { useStore, useShownFurniture } from '../../core/store';
import { itemCorners, pointInPolygon } from '../../core/geometry';
import type { FurnitureItem, Vec2 } from '../../core/types';
import { FurnitureMesh } from '../furniture/FurnitureMesh';

const SNAP = 0.05;
const snap = (v: number) => Math.round(v / SNAP) * SNAP;
const PINCH_ON = 0.02, PINCH_OFF = 0.035;
const floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

interface Hand { obj: THREE.Group; ctrl: THREE.Group; src?: XRInputSource; pressed: boolean; down: boolean; up: boolean; ray: THREE.Ray | null }
interface Held { id: string; idx: number; ox: number; oy: number; x: number; y: number; rot: number; roll0: number; rot0: number; moved: boolean }

/** Ray against an item's rotated bounding box; returns distance or null. */
function hitItem(ray: THREE.Ray, it: FurnitureItem): number | null {
  const o = ray.origin.clone().sub(new THREE.Vector3(it.x, 0, it.y)).applyAxisAngle(new THREE.Vector3(0, 1, 0), it.rotation);
  const d = ray.direction.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), it.rotation);
  const box = new THREE.Box3(new THREE.Vector3(-it.w / 2, 0, -it.d / 2), new THREE.Vector3(it.w / 2, Math.max(it.h, 0.05), it.d / 2));
  const p = new THREE.Ray(o, d).intersectBox(box, new THREE.Vector3());
  return p ? p.distanceTo(o) : null;
}

const wristRoll = (h: THREE.Group) => {
  const w = (h as unknown as { joints?: Record<string, THREE.Object3D> }).joints?.wrist;
  if (!w) return 0;
  return new THREE.Euler().setFromQuaternion(w.quaternion, 'ZYX').z;
};

/**
 * Immersive VR/AR input: controller rays + trigger and hand pinch grab furniture, slide it on the
 * floor (5 cm snap, kept inside the room) and commit with UPDATE_OBJECT on release. Pressing on the
 * floor teleports. Renders nothing and does nothing until a WebXR session is presenting.
 */
export function XRRig({ spawn }: { spawn: Vec2 }) {
  const { gl, scene } = useThree();
  const items = useShownFurniture();
  const spaces = useStore((s) => s.model.spaces);
  const sel = useStore((s) => s.selection);
  const [presenting, setPresenting] = useState(false);
  const [held, setHeld] = useState<Held | null>(null);
  const heldRef = useRef<Held | null>(null);
  const hands = useRef<Hand[]>([]);
  const base = useRef<XRReferenceSpace | null>(null);
  const userPos = useRef<Vec2>(spawn);
  const panel = useRef<THREE.Group>(null);
  const mic = useRef<THREE.Mesh>(null);
  const lastStick = useRef(0);
  const canVoice = typeof window !== 'undefined' && !!((window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition || (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition);
  const spawnRef = useRef(spawn); spawnRef.current = spawn;

  const fits = (it: FurnitureItem, x: number, y: number, rotation = it.rotation) => {
    const c = itemCorners({ ...it, x, y, rotation });
    return spaces.some((sp) => c.every((p) => pointInPolygon(p, sp.polygon)));
  };

  const moveUser = (p: Vec2) => {
    const b = base.current; if (!b) return;
    userPos.current = p;
    gl.xr.setReferenceSpace(b.getOffsetReferenceSpace(new XRRigidTransform({ x: -p.x, y: 0, z: -p.y })));
  };

  // Controllers, grips and hands live in the scene only while a session runs.
  useEffect(() => {
    const cmf = new XRControllerModelFactory(), hmf = new XRHandModelFactory();
    const added: THREE.Object3D[] = [];
    const list: Hand[] = [];
    for (let i = 0; i < 2; i++) {
      const ctrl = gl.xr.getController(i);
      const grip = gl.xr.getControllerGrip(i);
      grip.add(cmf.createControllerModel(grip));
      const hand = gl.xr.getHand(i);
      hand.add(hmf.createHandModel(hand, 'mesh'));
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -4)]), new THREE.LineBasicMaterial({ color: '#4da3ff' }));
      ctrl.add(line);
      const h: Hand = { obj: hand, ctrl, pressed: false, down: false, up: false, ray: null };
      ctrl.addEventListener('connected', (e) => { h.src = (e as unknown as { data: XRInputSource }).data; line.visible = !h.src.hand; });
      ctrl.addEventListener('disconnected', () => { h.src = undefined; h.pressed = false; });
      ctrl.addEventListener('selectstart', () => { if (h.src && !h.src.hand) { h.pressed = true; h.down = true; } });
      ctrl.addEventListener('selectend', () => { if (h.src && !h.src.hand && h.pressed) { h.pressed = false; h.up = true; } });
      list.push(h);
      added.push(ctrl, grip, hand);
    }
    hands.current = list;
    const start = () => {
      base.current = gl.xr.getReferenceSpace();
      added.forEach((o) => scene.add(o));
      setPresenting(true);
      moveUser(spawnRef.current);
    };
    const end = () => { added.forEach((o) => scene.remove(o)); base.current = null; heldRef.current = null; setHeld(null); setPresenting(false); };
    gl.xr.addEventListener('sessionstart', start);
    gl.xr.addEventListener('sessionend', end);
    return () => { gl.xr.removeEventListener('sessionstart', start); gl.xr.removeEventListener('sessionend', end); end(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, scene]);

  const tmpA = useMemo(() => new THREE.Vector3(), []), tmpB = useMemo(() => new THREE.Vector3(), []);

  useFrame(() => {
    if (!presenting) return;
    const st = useStore.getState();
    hands.current.forEach((h) => {
      h.ray = null;
      if (!h.src) return;
      if (h.src.hand) {
        const j = (h.obj as unknown as { joints: Record<string, THREE.Object3D> }).joints;
        const ti = j['thumb-tip'], ii = j['index-finger-tip'], wr = j.wrist;
        if (!ti || !ii || !wr) return;
        ti.getWorldPosition(tmpA); ii.getWorldPosition(tmpB);
        const dd = tmpA.distanceTo(tmpB);
        if (!h.pressed && dd < PINCH_ON) { h.pressed = true; h.down = true; }
        else if (h.pressed && dd > PINCH_OFF) { h.pressed = false; h.up = true; }
        const pinch = tmpA.add(tmpB).multiplyScalar(0.5);
        const o = wr.getWorldPosition(new THREE.Vector3());
        h.ray = new THREE.Ray(o, pinch.clone().sub(o).normalize());
      } else {
        h.ctrl.updateMatrixWorld();
        const o = new THREE.Vector3().setFromMatrixPosition(h.ctrl.matrixWorld);
        const q = new THREE.Quaternion().setFromRotationMatrix(h.ctrl.matrixWorld);
        h.ray = new THREE.Ray(o, new THREE.Vector3(0, 0, -1).applyQuaternion(q));
      }
    });

    hands.current.forEach((h, idx) => {
      const ray = h.ray;
      if (h.down && ray) {
        h.down = false;
        // Mic button first, then furniture, then floor teleport.
        if (mic.current && ray.intersectsSphere(new THREE.Sphere(mic.current.getWorldPosition(new THREE.Vector3()), 0.04))) {
          window.dispatchEvent(new CustomEvent('spacelens:voice', { detail: { source: 'xr' } }));
          return;
        }
        let best: FurnitureItem | null = null, bd = Infinity;
        for (const it of items) { const d = hitItem(ray, it); if (d !== null && d < bd) { bd = d; best = it; } }
        const fp = ray.intersectPlane(floor, new THREE.Vector3());
        if (best) {
          st.select({ kind: 'furniture', id: best.id });
          if (!best.locked && !heldRef.current) {
            const g = fp ?? new THREE.Vector3(best.x, 0, best.y);
            const hv: Held = { id: best.id, idx, ox: best.x - g.x, oy: best.y - g.z, x: best.x, y: best.y, rot: best.rotation, rot0: best.rotation, roll0: wristRoll(h.obj), moved: false };
            heldRef.current = hv; setHeld({ ...hv });
          }
        } else if (fp) {
          const p = { x: fp.x, y: fp.z };
          if (spaces.some((sp) => pointInPolygon(p, sp.polygon))) moveUser(p);
        }
      }
      h.down = false;
      const hv = heldRef.current;
      if (!hv || hv.idx !== idx) { h.up = false; return; }
      const it = items.find((f) => f.id === hv.id);
      if (!it) { heldRef.current = null; setHeld(null); return; }
      let changed = false;
      const fp = ray?.intersectPlane(floor, new THREE.Vector3());
      if (fp) {
        const x = snap(fp.x + hv.ox), y = snap(fp.z + hv.oy);
        if ((x !== hv.x || y !== hv.y) && fits(it, x, y, hv.rot)) { hv.x = x; hv.y = y; changed = true; }
      }
      // Rotation: thumbstick on controllers, wrist twist on hands (15 degree steps).
      let rot = hv.rot;
      const axes = h.src?.gamepad?.axes;
      if (axes && axes.length >= 4) {
        const ax = axes[2];
        const now = performance.now();
        if (Math.abs(ax) > 0.6 && now - lastStick.current > 250) { rot += Math.sign(ax) * Math.PI / 12; lastStick.current = now; }
      } else if (h.src?.hand) {
        const step = Math.PI / 12;
        rot = hv.rot0 + Math.round((hv.roll0 - wristRoll(h.obj)) / step) * step;
      }
      if (rot !== hv.rot && fits(it, hv.x, hv.y, rot)) { hv.rot = rot; changed = true; }
      if (changed) { hv.moved = true; setHeld({ ...hv }); }
      if (h.up) {
        h.up = false;
        if (hv.moved) {
          const r = ((hv.rot % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
          st.dispatch({ type: 'UPDATE_OBJECT', id: hv.id, patch: { x: hv.x, y: hv.y, rotation: r } });
        }
        heldRef.current = null; setHeld(null);
      }
    });

    // Wrist panel follows the first hand/controller (left if present).
    const anchor = hands.current.find((h) => h.src?.handedness === 'left') ?? hands.current.find((h) => h.src);
    if (panel.current && anchor) {
      const src = anchor.src?.hand ? (anchor.obj as unknown as { joints: Record<string, THREE.Object3D> }).joints.wrist ?? anchor.ctrl : anchor.ctrl;
      src.getWorldPosition(tmpA);
      panel.current.position.copy(tmpA).add(new THREE.Vector3(0, 0.1, 0));
      const cam = gl.xr.getCamera();
      panel.current.lookAt(cam.getWorldPosition(tmpB));
      panel.current.visible = true;
    }
  });

  if (!presenting) return null;
  const selItem = sel?.kind === 'furniture' ? items.find((f) => f.id === sel.id) : undefined;
  const heldItem = held ? items.find((f) => f.id === held.id) : undefined;
  return (
    <>
      {heldItem && held && <FurnitureMesh item={{ ...heldItem, x: held.x, y: held.y, rotation: held.rot, id: heldItem.id + '-xr' }} ghost />}
      <group ref={panel} visible={false}>
        <mesh position={[0, 0, -0.002]}>
          <planeGeometry args={[0.2, 0.08]} />
          <meshBasicMaterial color="#1b1e24" transparent opacity={0.85} />
        </mesh>
        <Text position={[0, 0.015, 0]} fontSize={0.016} color="#ffffff" anchorX="center" anchorY="middle" maxWidth={0.18}>
          {selItem ? selItem.name : 'Pinch an item'}
        </Text>
        <Text position={[0, -0.015, 0]} fontSize={0.012} color="#9fd0ff" anchorX="center" anchorY="middle">
          {selItem ? `${Math.round(selItem.w * 100)} × ${Math.round(selItem.d * 100)} × ${Math.round(selItem.h * 100)} cm` : 'Pinch the floor to teleport'}
        </Text>
        {canVoice && (
          <mesh ref={mic} position={[0.13, 0, 0]}>
            <sphereGeometry args={[0.02, 16, 12]} />
            <meshBasicMaterial color="#ff5a5f" />
          </mesh>
        )}
      </group>
    </>
  );
}
