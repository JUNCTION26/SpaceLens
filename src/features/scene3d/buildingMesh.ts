// Geometry for whole buildings, built once per model change and drawn with a handful of draw calls:
// every wall piece, window frame, pane, baseboard, railing and door leaf becomes one instance of a
// unit box in an InstancedMesh per material, and all floors (or ceilings) become one merged mesh.
// A plan with 100+ rooms stays a few draw calls instead of thousands of meshes.
import * as THREE from 'three';
import { norm, openingSegment, sub } from '../../core/geometry';
import type { Opening, Space, SpaceModel } from '../../core/types';
import type { WallEdge } from '../sim/walls';

export type BoxMat = 'wall' | 'glass' | 'frame' | 'base' | 'rail' | 'door';
export const BOX_MATS: BoxMat[] = ['wall', 'glass', 'frame', 'base', 'rail', 'door'];

/** One box in world space at full height. `edge` indexes the owned edge list (-1 for door leaves). */
export interface WorldBox { x: number; y: number; z: number; yaw: number; sx: number; sy: number; sz: number; edge: number }

export interface BuildingBoxes {
  byMat: Record<BoxMat, WorldBox[]>;
  /** Owned edges in the order `edge` refers to. */
  edges: WallEdge[];
  /** Per edge: may fold down for the cutaway (facade walls of indoor rooms). */
  cuttable: boolean[];
}

const OUTDOOR = /(balcon|balkon|balcony|terrace|terrazz|terrasse|loggia|veranda|patio|parveke|sitzplatz|deck)/i;
/** Balconies, terraces and loggias: open to the sky, edged by a railing instead of walls. */
export const isOutdoor = (s: Pick<Space, 'name' | 'purpose'>) => s.purpose === 'balcony' || s.purpose === 'terrace' || OUTDOOR.test(`${s.purpose ?? ''} ${s.name}`);

export const RAIL_M = 1.0;

/** Local wall boxes: x along the wall from a, y up, z outward from the owning room (before flip). */
function localBoxes(edge: WallEdge, ceiling: number, railing: boolean): Array<{ mat: BoxMat; pos: [number, number, number]; size: [number, number, number] }> {
  const out: Array<{ mat: BoxMat; pos: [number, number, number]; size: [number, number, number] }> = [];
  const L = edge.length;
  if (railing) {
    // top rail, posts at most 1.2 m apart, glass infill
    const n = Math.max(1, Math.ceil(L / 1.2));
    out.push({ mat: 'rail', pos: [L / 2, RAIL_M - 0.025, 0.025], size: [L, 0.05, 0.05] });
    for (let k = 0; k <= n; k++) out.push({ mat: 'rail', pos: [Math.min(L - 0.02, Math.max(0.02, (L * k) / n)), RAIL_M / 2, 0.025], size: [0.04, RAIL_M, 0.04] });
    out.push({ mat: 'glass', pos: [L / 2, 0.08 + (RAIL_M - 0.16) / 2, 0.025], size: [L, RAIL_M - 0.16, 0.012] });
    return out;
  }
  // on a shared line: one wall centred on it; across a gap (imported net-area rooms): each room
  // draws its half outward, like a facade, and the two halves meet in the middle
  const interior = !!edge.neighbour && !edge.gapM;
  const t = interior ? Math.max(0.06, edge.thicknessM + edge.neighbourThicknessM) : edge.gapM ? edge.gapM / 2 + 0.005 : edge.thicknessM || 0.12;
  const zc = interior ? 0 : t / 2;
  const ext = interior ? t / 2 : t;
  const solid = (x0: number, x1: number, y0: number, y1: number) => {
    if (x1 - x0 < 1e-3 || y1 - y0 < 1e-3) return;
    out.push({ mat: 'wall', pos: [(x0 + x1) / 2, (y0 + y1) / 2, zc], size: [x1 - x0, y1 - y0, t] });
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
      out.push({ mat: 'glass', pos: [(s + e) / 2, (sill + head) / 2, zc], size: [e - s, head - sill, 0.012] });
      out.push({ mat: 'frame', pos: [(s + e) / 2, sill + 0.02, zc - 0.02], size: [e - s, 0.04, t + 0.06] });
      out.push({ mat: 'frame', pos: [(s + e) / 2, head - 0.02, zc], size: [e - s, 0.04, t + 0.02] });
      out.push({ mat: 'frame', pos: [s + 0.02, (sill + head) / 2, zc], size: [0.04, head - sill, t + 0.02] });
      out.push({ mat: 'frame', pos: [e - 0.02, (sill + head) / 2, zc], size: [0.04, head - sill, t + 0.02] });
    }
    cur = e;
  }
  solid(cur, L + ext, 0, ceiling);
  const faces = interior ? [-(t / 2 + 0.009), t / 2 + 0.009] : [-0.009];
  for (const z of faces) {
    let bs = 0;
    for (const g of edge.gaps) {
      if (g.kind === 'window') continue;
      if (g.s > bs) out.push({ mat: 'base', pos: [(bs + g.s) / 2, 0.05, z], size: [g.s - bs, 0.1, 0.018] });
      bs = Math.max(bs, g.e);
    }
    if (L > bs) out.push({ mat: 'base', pos: [(bs + L) / 2, 0.05, z], size: [L - bs, 0.1, 0.018] });
  }
  return out;
}

/** A door leaf standing open at 70 degrees on its hinge side. */
function doorLeaf(space: Space, o: Opening): WorldBox | null {
  if (o.kind !== 'door' || o.swing === 'none' || o.wallIndex >= space.polygon.length) return null;
  const { a, b, dir, inward } = openingSegment(space, o);
  const hinge = o.hinge === 'start' ? a : b;
  const toward = o.hinge === 'start' ? dir : { x: -dir.x, y: -dir.y };
  const n = o.swing === 'in' ? inward : { x: -inward.x, y: -inward.y };
  const th = (70 * Math.PI) / 180;
  const ld = norm({ x: toward.x * Math.cos(th) + n.x * Math.sin(th), y: toward.y * Math.cos(th) + n.y * Math.sin(th) });
  const w = o.widthM - 0.02, h = o.heightM - 0.01;
  return { x: hinge.x + ld.x * w / 2, y: h / 2, z: hinge.y + ld.y * w / 2, yaw: -Math.atan2(ld.y, ld.x), sx: w, sy: h, sz: 0.04, edge: -1 };
}

export function buildingBoxes(model: SpaceModel, allEdges: WallEdge[]): BuildingBoxes {
  const byMat = Object.fromEntries(BOX_MATS.map((m) => [m, [] as WorldBox[]])) as Record<BoxMat, WorldBox[]>;
  const outdoor = new Set(model.spaces.filter(isOutdoor).map((s) => s.id));
  const edges: WallEdge[] = [];
  const cuttable: boolean[] = [];
  for (const e of allEdges) {
    if (!e.owner) continue;
    const out = outdoor.has(e.spaceId);
    const nbOut = e.neighbour ? outdoor.has(e.neighbour) : false;
    // two outdoor areas side by side: no wall between them
    if (out && nbOut) continue;
    // a facade edge of a balcony (or the shared edge seen from the balcony side) gets a railing
    // only when it faces away from the building; the wall to the house stays a full wall
    const railing = out && !e.neighbour;
    const idx = edges.length;
    edges.push(e);
    cuttable.push(!e.neighbour && !railing);
    const outward = { x: -e.inward.x, y: -e.inward.y };
    const d = norm(sub(e.b, e.a));
    const flip = (-d.y * outward.x + d.x * outward.y) < 0;
    const yaw = -Math.atan2(e.b.y - e.a.y, e.b.x - e.a.x);
    const c = Math.cos(yaw), s = Math.sin(yaw);
    for (const bx of localBoxes(e, model.ceilingM, railing)) {
      const lx = bx.pos[0], lz = flip ? -bx.pos[2] : bx.pos[2];
      // rotate (lx, lz) about +Y by yaw, then move to a
      byMat[bx.mat].push({ x: e.a.x + lx * c + lz * s, y: bx.pos[1], z: e.a.y - lx * s + lz * c, yaw, sx: bx.size[0], sy: bx.size[1], sz: bx.size[2], edge: idx });
    }
  }
  const spaces = new Map(model.spaces.map((s) => [s.id, s]));
  for (const o of model.openings) {
    const sp = spaces.get(o.spaceId);
    const leaf = sp && doorLeaf(sp, o);
    if (leaf) byMat.door.push(leaf);
  }
  return { byMat, edges, cuttable };
}

const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpP = new THREE.Vector3(), tmpS = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);

/** Write one box into an InstancedMesh, scaled in height by `k` from the floor. */
export function writeBox(mesh: THREE.InstancedMesh, i: number, b: WorldBox, k = 1) {
  tmpQ.setFromAxisAngle(UP, b.yaw);
  tmpP.set(b.x, b.y * k, b.z);
  tmpS.set(b.sx, Math.max(1e-4, b.sy * k), b.sz);
  mesh.setMatrixAt(i, tmpM.compose(tmpP, tmpQ, tmpS));
}

/**
 * All room outlines as one floor (or ceiling) mesh in the XZ plane, with UVs in metres and a map
 * from triangle to room so clicks and hovers can still tell rooms apart.
 */
export function mergedPlates(spaces: Space[], y: number, facingUp: boolean): { geometry: THREE.BufferGeometry; triSpace: Int32Array } {
  const pos: number[] = [], uv: number[] = [], idx: number[] = [], tri: number[] = [];
  spaces.forEach((s, si) => {
    if (s.polygon.length < 3) return;
    const contour = s.polygon.map((p) => new THREE.Vector2(p.x, p.y));
    const faces = THREE.ShapeUtils.triangulateShape(contour, []);
    const base = pos.length / 3;
    for (const p of s.polygon) { pos.push(p.x, y, p.y); uv.push(p.x, -p.y); }
    for (const [a, b, c] of faces) {
      // plan y grows towards +z; pick the winding whose normal points the way we want
      const ax = s.polygon[a].x, az = s.polygon[a].y, bx = s.polygon[b].x, bz = s.polygon[b].y, cx = s.polygon[c].x, cz = s.polygon[c].y;
      const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      const up = ny > 0;
      if (up === facingUp) idx.push(base + a, base + b, base + c); else idx.push(base + a, base + c, base + b);
      tri.push(si);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return { geometry: g, triSpace: Int32Array.from(tri) };
}
