// Turn a floor-plan proposal into the app's spatial model: one Space per room, shared walls
// carried by both rooms on the same line (each side holds half the wall), doors placed on both
// rooms at the same point, windows on facade walls. Everything is marked as a generated estimate.
import type { Evidence, Measurement, Opening, Space, SpaceModel, Vec2, WallMeta } from '../../core/types';
import type { BuildingPlan } from './partition';

const TOL = 1e-3;

function onSegment(p: Vec2, a: Vec2, b: Vec2, tol = TOL): boolean {
  const minX = Math.min(a.x, b.x) - tol, maxX = Math.max(a.x, b.x) + tol;
  const minY = Math.min(a.y, b.y) - tol, maxY = Math.max(a.y, b.y) + tol;
  if (p.x < minX || p.x > maxX || p.y < minY || p.y > maxY) return false;
  const cr = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  return Math.abs(cr) / (Math.hypot(b.x - a.x, b.y - a.y) || 1) < tol;
}

/** Insert vertices of other polygons that sit on this polygon's edges (T-junctions). */
export function splitAtJunctions(poly: Vec2[], others: Vec2[][]): Vec2[] {
  const pts = others.flat();
  const out: Vec2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    out.push(a);
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    const mids = pts
      .filter((p) => onSegment(p, a, b) && Math.hypot(p.x - a.x, p.y - a.y) > TOL && Math.hypot(p.x - b.x, p.y - b.y) > TOL)
      .map((p) => ({ p, t: Math.hypot(p.x - a.x, p.y - a.y) / L }))
      .sort((x, y) => x.t - y.t);
    for (const m of mids) if (!out.some((q) => Math.abs(q.x - m.p.x) < TOL && Math.abs(q.y - m.p.y) < TOL)) out.push({ x: m.p.x, y: m.p.y });
  }
  return out;
}

/** Wall of `space` that contains point p (and leaves room for `width`), with the offset along it. */
export function wallAt(space: Space, p: Vec2, width = 0): { wallIndex: number; offsetM: number } | null {
  const n = space.polygon.length;
  let best: { wallIndex: number; offsetM: number; slack: number } | null = null;
  for (let i = 0; i < n; i++) {
    const a = space.polygon[i], b = space.polygon[(i + 1) % n];
    if (!onSegment(p, a, b, 0.01)) continue;
    const off = Math.hypot(p.x - a.x, p.y - a.y), L = Math.hypot(b.x - a.x, b.y - a.y);
    const slack = Math.min(off, L - off) - width / 2;
    if (!best || slack > best.slack) best = { wallIndex: i, offsetM: Math.round(off * 1000) / 1000, slack };
  }
  return best ? { wallIndex: best.wallIndex, offsetM: best.offsetM } : null;
}

function onShell(shell: Vec2[], a: Vec2, b: Vec2): boolean {
  const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  for (let i = 0; i < shell.length; i++) if (onSegment(m, shell[i], shell[(i + 1) % shell.length])) return true;
  return false;
}

export interface AssembleOptions { ceilingM?: number; now?: number }

export function toSpaceModel(plan: BuildingPlan, base?: SpaceModel, opts: AssembleOptions = {}): SpaceModel {
  const now = opts.now ?? Date.now();
  const evidence: Evidence = {
    id: `ev-${plan.id}`, kind: 'manual', label: 'Generated floor plan proposal, not measured',
    note: `${plan.name}. Score ${plan.score}/100, ${plan.internalWallM} m of internal walls.`, createdAt: now,
  };
  const polys = plan.rooms.map((r) => r.polygon);
  const measurements: Measurement[] = [];
  const spaces: Space[] = plan.rooms.map((r, k) => {
    const polygon = splitAtJunctions(r.polygon, polys.filter((_, j) => j !== k));
    const walls: WallMeta[] = polygon.map((a, i) => {
      const b = polygon[(i + 1) % polygon.length];
      const exterior = onShell(plan.shell, a, b);
      return { thicknessM: exterior ? plan.exteriorWallM : plan.interiorWallM / 2, sourceKind: 'generated', status: 'estimated' };
    });
    // one width and one depth measurement per room, on its longest horizontal and vertical walls
    for (const horizontal of [true, false]) {
      let bi = -1, bl = 0;
      polygon.forEach((a, i) => {
        const b = polygon[(i + 1) % polygon.length];
        const isH = Math.abs(a.y - b.y) < TOL, L = Math.hypot(b.x - a.x, b.y - a.y);
        if (isH === horizontal && L > bl) { bl = L; bi = i; }
      });
      if (bi < 0) continue;
      const id = `m-${r.id}-${horizontal ? 'w' : 'd'}`;
      measurements.push({ id, label: `${r.name} ${horizontal ? 'width' : 'depth'}`, valueM: Math.round(bl * 1000) / 1000, sourceKind: 'generated', status: 'estimated', toleranceM: 0.05, evidenceIds: [evidence.id], targetId: `${r.id}:${bi}` });
      walls[bi] = { ...walls[bi], measurementId: id };
    }
    return { id: r.id, name: r.name, purpose: r.purpose, polygon, walls };
  });
  const byId = new Map(spaces.map((s) => [s.id, s]));
  const openings: Opening[] = [];
  const add = (spaceId: string, id: string, kind: Opening['kind'], at: Vec2, widthM: number, swing: Opening['swing']) => {
    const s = byId.get(spaceId);
    if (!s) return;
    const w = wallAt(s, at, widthM);
    if (!w) return;
    const isWin = kind === 'window';
    openings.push({
      id, kind, spaceId, wallIndex: w.wallIndex, offsetM: w.offsetM, widthM,
      heightM: isWin ? 1.3 : kind === 'opening' ? 2.1 : 2.05, sillM: isWin ? 0.9 : 0,
      swing, hinge: 'start', sourceKind: 'generated', status: 'estimated',
    });
  };
  for (const d of plan.doors) {
    const kind: Opening['kind'] = d.kind === 'opening' ? 'opening' : 'door';
    // the leaf is drawn once, in the room it opens into; the other side is a plain gap
    add(d.a, `${d.id}~${d.a}`, kind, d.at, d.widthM, kind === 'door' && d.swingInto === d.a ? 'in' : 'none');
    if (d.b !== 'outside') add(d.b, `${d.id}~${d.b}`, kind, d.at, d.widthM, kind === 'door' && d.swingInto === d.b ? 'in' : 'none');
  }
  plan.windows.forEach((w, k) => {
    const at = { x: (w.a.x + w.b.x) / 2, y: (w.a.y + w.b.y) / 2 };
    add(w.roomId, `win-${k + 1}`, 'window', at, Math.round(Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) * 1000) / 1000, 'none');
  });
  return {
    id: base?.id ?? plan.id,
    name: base?.name && base.name !== 'Sample room' ? base.name : plan.name,
    version: base?.version ?? 1,
    units: 'm',
    ceilingM: opts.ceilingM ?? base?.ceilingM ?? 2.6,
    sourceLabel: 'Generated floor plan',
    spaces, openings, furniture: [],
    measurements,
    evidence: [...(base?.evidence ?? []).filter((e) => e.kind !== 'sample'), evidence],
  };
}
