import type { FurnitureItem, HeatGrid, SpaceModel } from '../../core/types';
import { astar, buildGrid, centreOf, doorInner, pathLength, roomCentroid, snapFree } from './grid';

export const CROWD_ASSUMPTIONS = 'Agents 0.30 m wide minimum, prefer wider gaps, walk door to a seat and back';
export const TIGHT_M = 0.45;

export interface CrowdStats { agents: number; seed: number; meanPathM: number; tightPct: number; paths: number }
export interface CrowdRun { heat: HeatGrid; stats: CrowdStats }

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function runCrowd(model: SpaceModel, furniture: FurnitureItem[], agents: number, seed: number): CrowdRun | null {
  const g = buildGrid(model, furniture);
  const doors = model.openings.filter((o) => o.kind === 'door' || o.kind === 'opening');
  if (!doors.length) return null;
  const rnd = mulberry32(seed);
  const seats = furniture.filter((f) => /table|chair|seat|sofa|desk|bench/i.test(f.category + ' ' + f.name));
  const targets = (seats.length ? seats.map((f) => ({ x: f.x, y: f.y })) : [roomCentroid(model)]);
  const HC = 0.2, cols = Math.ceil((g.cols * g.cell) / HC), rows = Math.ceil((g.rows * g.cell) / HC);
  const counts = new Float32Array(cols * rows);
  let total = 0, tight = 0, n = 0;
  const minD = 0.15;
  for (let a = 0; a < agents; a++) {
    const d = doors[Math.floor(rnd() * doors.length)], tgt = targets[Math.floor(rnd() * targets.length)];
    const from = doorInner(model, d.id, 0.3); if (!from) continue;
    const s = snapFree(g, from, minD, 10), e = snapFree(g, tgt, minD, 30);
    if (s < 0 || e < 0) continue;
    const res = astar(g, s, e, minD, (dd) => (dd < 0.3 ? (0.3 - dd) * 40 : 0));
    if (!res.reached) continue;
    const pts = res.path.map((c) => centreOf(g, c));
    total += 2 * pathLength(pts); n += 2;
    if (res.path.some((c) => 2 * g.dist[c] < TIGHT_M)) tight += 2;
    for (const p of pts) {
      const hc = Math.floor((p.x - g.ox) / HC), hr = Math.floor((p.y - g.oy) / HC);
      if (hc >= 0 && hr >= 0 && hc < cols && hr < rows) counts[hr * cols + hc] += 2; // there and back
    }
  }
  let mx = 0; for (const c of counts) if (c > mx) mx = c;
  const values = Array.from(counts, (c) => (mx ? c / mx : 0));
  return {
    heat: { origin: { x: g.ox, y: g.oy }, cellM: HC, cols, rows, values },
    stats: { agents, seed, meanPathM: n ? total / n : 0, tightPct: n ? (100 * tight) / n : 0, paths: n },
  };
}
