import { add, bounds, convexOverlap, dot, itemCorners, mul, openingSegment, polygonInside, sub, wallInwardNormal, wallSegment } from '../../core/geometry';
import type { FurnitureItem, PassagePose, PassageResult, SpaceModel, Vec2 } from '../../core/types';
import { isRug } from './grid';

export interface PassageItem { id: string; name: string; w: number; d: number; h: number }

export const PASSAGE_ASSUMPTIONS = [
  '2D footprint only, item kept flat',
  'Starts 1.5 m outside the door in a 2 m wide corridor',
  'Moves in 5 cm steps and 15° turns',
];

const STEP = 0.05, NTH = 12; // 12 x 15° covers 180°, rectangles are symmetric

interface Box { poly: Vec2[]; minX: number; maxX: number; minY: number; maxY: number }
const box = (poly: Vec2[]): Box => { const b = bounds(poly); return { poly, ...b }; };
const rect = (a: Vec2, b: Vec2, out: Vec2, t: number): Box => box([a, b, add(b, mul(out, t)), add(a, mul(out, t))]);

export function testPassage(model: SpaceModel, furniture: FurnitureItem[], item: PassageItem, doorId: string, maxStates = 2_000_000): PassageResult {
  const door = model.openings.find((o) => o.id === doorId);
  const space = door && model.spaces.find((s) => s.id === door.spaceId);
  if (!door || !space) return { itemId: item.id, ok: false, poses: [], details: 'Pick a door first.' };
  const seg = openingSegment(space, door), out = mul(seg.inward, -1);
  const t = space.walls[door.wallIndex]?.thicknessM ?? 0.1;
  const minSide = Math.min(item.w, item.d), tilt = Math.min(item.w, item.d, item.h);
  const tiltNote = `Tilted on edge its smallest side is ${tilt.toFixed(2)} m vs ${door.widthM.toFixed(2)} m wide, ${door.heightM.toFixed(2)} m high door (not simulated).`;

  // obstacles: walls with thickness (door gap open), virtual corridor, other furniture
  const obs: Box[] = [];
  space.polygon.forEach((_, i) => {
    const [a, b] = wallSegment(space, i), o = mul(wallInwardNormal(space, i), -1);
    const th = space.walls[i]?.thicknessM ?? 0.1;
    if (i === door.wallIndex) { obs.push(rect(a, seg.a, o, th)); obs.push(rect(seg.b, b, o, th)); }
    else obs.push(rect(a, b, o, th));
  });
  const half = Math.max(3, Math.max(item.w, item.d) + door.widthM);
  const cL = add(seg.c, mul(seg.dir, -half)), cR = add(seg.c, mul(seg.dir, half));
  obs.push(rect(add(cL, mul(out, t + 2)), add(cR, mul(out, t + 2)), out, 0.2));
  obs.push(rect(add(cL, mul(out, t)), add(cL, mul(out, t + 2.2)), seg.dir, -0.2));
  obs.push(rect(add(cR, mul(out, t)), add(cR, mul(out, t + 2.2)), seg.dir, 0.2));
  for (const f of furniture) if (f.id !== item.id && !isRug(f)) obs.push(box(itemCorners(f)));

  const all = bounds([...space.polygon, add(cL, mul(out, t + 2.2)), add(cR, mul(out, t + 2.2))]);
  const ox = all.minX, oy = all.minY;
  const cols = Math.ceil((all.maxX - ox) / STEP) + 1, rows = Math.ceil((all.maxY - oy) / STEP) + 1;
  const local = Array.from({ length: NTH }, (_, k) => itemCorners({ x: 0, y: 0, w: item.w, d: item.d, rotation: (k * Math.PI) / NTH }));
  const poseOf = (s: number): PassagePose => { const k = s % NTH, cell = (s - k) / NTH; return { x: ox + (cell % cols) * STEP, y: oy + Math.floor(cell / cols) * STEP, rotation: (k * Math.PI) / NTH }; };
  const cornersOf = (s: number) => { const p = poseOf(s); return local[s % NTH].map((q) => ({ x: q.x + p.x, y: q.y + p.y })); };
  const free = (s: number) => {
    const c = cornersOf(s), b = bounds(c);
    for (const o of obs) {
      if (b.maxX <= o.minX || b.minX >= o.maxX || b.maxY <= o.minY || b.minY >= o.maxY) continue;
      if (convexOverlap(c, o.poly) > 1e-6) return false;
    }
    return true;
  };

  // start pose: centre of the corridor, 1.5 m out, long side along the wall when it fits
  const startP = add(seg.c, mul(out, t + 1.0));
  const sc = Math.round((startP.x - ox) / STEP), sr = Math.round((startP.y - oy) / STEP);
  const wallAng = Math.atan2(seg.dir.y, seg.dir.x);
  const k0 = ((Math.round(wallAng / (Math.PI / NTH)) % NTH) + NTH) % NTH;
  let start = -1;
  for (const k of [k0, (k0 + NTH / 2) % NTH, ...Array.from({ length: NTH }, (_, i) => i)]) {
    const s = (sr * cols + sc) * NTH + k; if (free(s)) { start = s; break; }
  }
  if (start < 0) return { itemId: item.id, ok: false, poses: [], blockedAt: startP, details: `Item does not fit in the 2 m corridor outside the door. ${tiltNote}` };

  const N = cols * rows * NTH, parent = new Int32Array(N).fill(-2);
  parent[start] = -1;
  const q = new Int32Array(Math.min(N, maxStates)); let qh = 0, qt = 0; q[qt++] = start;
  let goal = -1, bestIn = -Infinity, bestS = start;
  while (qh < qt) {
    const s = q[qh++];
    const p = poseOf(s), depth = dot(sub(p, seg.c), seg.inward);
    if (depth > bestIn) { bestIn = depth; bestS = s; }
    if (depth > 0 && polygonInside(cornersOf(s), space.polygon)) { goal = s; break; }
    const k = s % NTH, cell = (s - k) / NTH, c = cell % cols, r = (cell - c) / cols;
    const nb: number[] = [];
    if (c > 0) nb.push(s - NTH); if (c < cols - 1) nb.push(s + NTH);
    if (r > 0) nb.push(s - cols * NTH); if (r < rows - 1) nb.push(s + cols * NTH);
    nb.push(cell * NTH + ((k + 1) % NTH), cell * NTH + ((k + NTH - 1) % NTH));
    for (const n of nb) {
      if (parent[n] !== -2) continue;
      if (!free(n)) { parent[n] = -3; continue; }
      parent[n] = s; if (qt < q.length) q[qt++] = n;
    }
  }
  if (goal < 0) {
    const bp = poseOf(bestS);
    const details = minSide > door.widthM
      ? `Too wide for the ${door.widthM.toFixed(2)} m door at every angle: narrowest side ${minSide.toFixed(2)} m.`
      : `No collision-free way in. Gets stuck near the door with the ${minSide.toFixed(2)} m side vs a ${door.widthM.toFixed(2)} m opening.`;
    return { itemId: item.id, ok: false, poses: [], blockedAt: { x: bp.x, y: bp.y }, details: `${details} ${tiltNote}` };
  }
  const chain: number[] = [];
  for (let s = goal; s >= 0; s = parent[s]) chain.push(s);
  chain.reverse();
  const stride = Math.max(1, Math.ceil(chain.length / 60));
  const poses = chain.filter((_, i) => i % stride === 0 || i === chain.length - 1).map(poseOf);
  return { itemId: item.id, ok: true, poses, details: `Fits through the ${door.widthM.toFixed(2)} m door in ${chain.length} moves. ${tiltNote}` };
}
