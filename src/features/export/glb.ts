import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import type { FurnitureItem, SpaceModel } from '../../core/types';
import { wallInwardNormal, wallLength, wallSegment } from '../../core/geometry';

/** Solid wall pieces along a wall of length L, split around openings: [t0, t1, y0, y1]. */
export function wallPieces(L: number, H: number, ops: Array<{ offsetM: number; widthM: number; sillM: number; heightM: number }>) {
  const pieces: Array<[number, number, number, number]> = [];
  let t = 0;
  for (const o of [...ops].sort((p, q) => p.offsetM - q.offsetM)) {
    const o0 = Math.max(t, o.offsetM - o.widthM / 2), o1 = Math.min(L, o.offsetM + o.widthM / 2);
    if (o1 <= o0) continue;
    if (o0 > t) pieces.push([t, o0, 0, H]);
    if (o.sillM > 0) pieces.push([o0, o1, 0, Math.min(H, o.sillM)]);
    const top = o.sillM + o.heightM;
    if (top < H) pieces.push([o0, o1, top, H]);
    t = o1;
  }
  if (t < L) pieces.push([t, L, 0, H]);
  return pieces.filter(([a, b, c, d]) => b - a > 1e-3 && d - c > 1e-3);
}

export function buildScene(model: SpaceModel, furniture: FurnitureItem[]): THREE.Scene {
  const scene = new THREE.Scene();
  scene.name = model.name;
  const H = model.ceilingM;
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xeeeae2, name: 'Wall' });
  for (const s of model.spaces) {
    const shape = new THREE.Shape(s.polygon.map((p) => new THREE.Vector2(p.x, -p.y)));
    const floor = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshStandardMaterial({ color: 0xc8b49a, name: 'Floor', side: THREE.DoubleSide }));
    floor.rotation.x = -Math.PI / 2;
    floor.name = `${s.name} floor`;
    scene.add(floor);
    s.walls.forEach((w, i) => {
      const [a, b] = wallSegment(s, i);
      const L = wallLength(s, i);
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const n = wallInwardNormal(s, i);
      const ops = model.openings.filter((o) => o.spaceId === s.id && o.wallIndex === i);
      for (const [t0, t1, y0, y1] of wallPieces(L, H, ops)) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(t1 - t0, y1 - y0, w.thicknessM), wallMat);
        const tm = (t0 + t1) / 2;
        m.position.set(a.x + Math.cos(ang) * tm - (n.x * w.thicknessM) / 2, (y0 + y1) / 2, a.y + Math.sin(ang) * tm - (n.y * w.thicknessM) / 2);
        m.rotation.y = -ang;
        m.name = `${s.name} wall ${i + 1}`;
        scene.add(m);
      }
    });
  }
  for (const f of furniture) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(f.w, f.h, f.d), new THREE.MeshStandardMaterial({ color: new THREE.Color(f.color || '#999999'), name: f.name }));
    m.position.set(f.x, f.h / 2, f.y);
    m.rotation.set(0, -f.rotation, 0);
    m.name = f.name;
    scene.add(m);
  }
  return scene;
}

export function exportGlb(model: SpaceModel, furniture: FurnitureItem[]): Promise<Blob> {
  const scene = buildScene(model, furniture);
  return new Promise((res, rej) =>
    new GLTFExporter().parse(scene, (r) => res(new Blob([r as ArrayBuffer], { type: 'model/gltf-binary' })), (e) => rej(e), { binary: true }));
}
