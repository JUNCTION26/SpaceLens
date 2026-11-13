import { applyOp } from '../../core/ops';
import { area, wallInwardNormal, wallLength, wallId } from '../../core/geometry';
import { validateLayout } from '../referee/validate';
import type { FurnitureItem, LayoutCandidate, Requirements, SourceKind, Space, SpaceModel, Status } from '../../core/types';

export const SOURCE_WORDS: Record<SourceKind, string> = {
  'user-measured': 'Measured with tape', 'ar-depth': 'Phone depth scan', 'photo-inferred': 'Phone photo',
  'pdf-annotation': 'Read from drawing', manual: 'Typed by you', catalog: 'Catalog estimate',
  generated: 'Generated layout', sample: 'Sample data',
};
export const STATUS_CHIP: Record<Status, string> = { verified: 'chip-ok', estimated: 'chip-warn', unknown: 'chip-warn', conflicting: 'chip-bad' };

export function wallSide(space: Space, i: number): string {
  const n = wallInwardNormal(space, i);
  if (Math.abs(n.x) > Math.abs(n.y)) return n.x > 0 ? 'west' : 'east';
  return n.y > 0 ? 'north' : 'south';
}
export const wallName = (space: Space, i: number) => `${wallSide(space, i)} wall`;

export const roomArea = (m: SpaceModel) => m.spaces.reduce((a, s) => a + area(s.polygon), 0);

export function measurementFor(m: SpaceModel, targetId: string, measurementId?: string) {
  return m.measurements.find((x) => x.id === measurementId) ?? m.measurements.find((x) => x.targetId === targetId);
}

export interface Layout { id: string; name: string; furniture: FurnitureItem[] }
export function layoutsOf(model: SpaceModel, candidates: LayoutCandidate[]): Layout[] {
  return [{ id: 'current', name: 'Current layout', furniture: model.furniture }, ...candidates.map((c) => ({ id: c.id, name: c.name, furniture: c.furniture }))];
}

function passes(model: SpaceModel, furniture: FurnitureItem[], req: Requirements | null): boolean {
  if (!furniture.length) return true;
  try { return !validateLayout(model, furniture, req).some((r) => r.result === 'fail'); } catch { return true; }
}

/** Snapshot of failing checks per layout, keyed "layout|rule". */
export function snapshot(model: SpaceModel, layouts: Layout[], req: Requirements | null) {
  const fails = new Map<string, string>(); const ok = new Set<string>();
  for (const l of layouts) {
    let res: ReturnType<typeof validateLayout> = [];
    try { res = validateLayout(model, l.furniture, req); } catch { /* validator not ready */ }
    if (!res.some((r) => r.result === 'fail')) ok.add(l.name);
    for (const r of res) if (r.result === 'fail') fails.set(`${l.name}|${r.rule}`, `${l.name}: ${r.details || r.rule}`);
  }
  const cost = model.furniture.filter((f) => !f.owned).reduce((a, f) => a + f.priceSek, 0);
  return { fails, ok, area: roomArea(model), cost };
}
export type Snap = ReturnType<typeof snapshot>;

export interface Diff { invalid: string[]; fixed: string[]; areaDelta: number; costDelta: number }
export function diffSnaps(a: Snap, b: Snap): Diff {
  return {
    invalid: [...b.fails].filter(([k]) => !a.fails.has(k)).map(([, v]) => v),
    fixed: [...a.fails].filter(([k]) => !b.fails.has(k)).map(([, v]) => v),
    areaDelta: b.area - a.area, costDelta: b.cost - a.cost,
  };
}

export interface UncertainWall { id: string; space: Space; index: number; name: string; len: number; tol: number; calibrated: boolean }
export function uncertainWalls(m: SpaceModel): UncertainWall[] {
  const out: UncertainWall[] = [];
  for (const s of m.spaces) s.walls.forEach((w, i) => {
    const id = wallId(s.id, i);
    const meas = measurementFor(m, id, w.measurementId);
    const status = meas?.status ?? w.status;
    let tol = meas?.toleranceM; const calibrated = tol != null;
    if (tol == null) { if (status === 'estimated') tol = 0.05; else if (status === 'unknown') tol = 0.15; }
    if (tol != null && tol > 0 && (status !== 'verified' || calibrated))
      out.push({ id, space: s, index: i, name: wallName(s, i), len: wallLength(s, i), tol: tol!, calibrated });
  });
  return out;
}

export interface Verdict { layout: string; holds: boolean; text: string }
export function evaluateWall(m: SpaceModel, w: UncertainWall, layouts: Layout[], req: Requirements | null): Verdict[] {
  const at = (L: number) => applyOp(m, { type: 'SET_WALL_LENGTH', spaceId: w.space.id, wallIndex: w.index, lengthM: L });
  const lo = w.len - w.tol, hi = w.len + w.tol;
  return layouts.filter((l) => l.furniture.length).map((l) => {
    const pLo = passes(at(lo), l.furniture, req), pHi = passes(at(hi), l.furniture, req);
    if (pLo && pHi) return { layout: l.name, holds: true, text: 'Holds for every likely size' };
    if (!pLo && !pHi) return { layout: l.name, holds: false, text: 'Fails at every likely size' };
    // Binary search the threshold to 1 cm, assuming monotone in length.
    let a = lo, b = hi; const okHigh = pHi;
    while (b - a > 0.01) { const mid = (a + b) / 2; if (passes(at(mid), l.furniture, req) === okHigh) b = mid; else a = mid; }
    const t = okHigh ? b : a;
    return { layout: l.name, holds: false, text: `Depends on ${w.name} being ${okHigh ? 'at least' : 'at most'} ${t.toFixed(2)} m` };
  });
}
