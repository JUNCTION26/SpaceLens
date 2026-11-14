import { describe, expect, it } from 'vitest';
import { area, pointInPolygon } from '../../core/geometry';
import { makeItem } from '../furniture/catalog';
import { toSpaceModel } from './assemble';
import { buildingRoutes, roomGraph } from './connectivity';
import { furnishBuilding, mergeFurniture, subModelFor } from './furnish';
import { lShell, planBuilding, rectShell, type BuildingPlan } from './partition';
import { officeProgramme, programmeFromRules, villaProgramme } from './programme';
import { rArea } from './rects';
import { planSvg } from './render';

type NodeEnv = { process?: { env: Record<string, string | undefined> } };
const env = (globalThis as NodeEnv).process?.env ?? {};

/** Plans are written as SVG into the system temp folder so they can be looked at. */
async function writeProof(name: string, plan: BuildingPlan): Promise<string | null> {
  try {
    const fs = await import(/* @vite-ignore */ 'node:fs' as string);
    const os = await import(/* @vite-ignore */ 'node:os' as string);
    const path = await import(/* @vite-ignore */ 'node:path' as string);
    const dir = env.BUILDING_PROOF_DIR || path.join(os.tmpdir(), 'spacelens-building');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.svg`);
    fs.writeFileSync(file, planSvg(plan, { px: 56, title: true }));
    return file;
  } catch { return null; }
}

function noOverlaps(plan: BuildingPlan) {
  const rects = plan.rooms.flatMap((r) => r.rects.map((q) => ({ id: r.id, q })));
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
    const a = rects[i].q, b = rects[j].q;
    const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    expect(ox > 1e-6 && oy > 1e-6, `${rects[i].id} overlaps ${rects[j].id}`).toBe(false);
  }
}

describe('villa 10 x 12 m, 3 bedrooms', () => {
  const programme = villaProgramme(3);
  const plans = planBuilding(rectShell(10, 12), [{ wallIndex: 2, offsetM: 5 }], [], programme, { count: 3, seed: 1 });
  const best = plans[0];

  it('returns distinct options with named criteria and wall metres', async () => {
    expect(plans.length).toBe(3);
    expect(new Set(plans.map((p) => JSON.stringify(p.rooms.map((r) => r.rects)))).size).toBe(3);
    for (const p of plans) {
      expect(p.criteria.map((c) => c.id)).toEqual(expect.arrayContaining(['area', 'daylight', 'adjacency', 'circulation', 'privacy', 'walls', 'wet', 'reach', 'proportion']));
      expect(p.internalWallM).toBeGreaterThan(20);
    }
    const file = await writeProof('villa-10x12', best);
    expect(file === null || file.endsWith('.svg')).toBe(true);
  });

  it('covers the shell exactly with non-overlapping rooms', () => {
    noOverlaps(best);
    const sum = best.rooms.reduce((s, r) => s + r.rects.reduce((t, q) => t + rArea(q), 0), 0);
    expect(sum).toBeCloseTo(120, 1);
  });

  it('reaches every room from the entrance without passing through a private room', () => {
    expect(best.criteria.find((c) => c.id === 'reach')!.score).toBe(1);
    expect(best.doors.find((d) => d.b === 'outside')!.a).toBe('hall');
  });

  it('puts every bedroom on the facade', () => {
    for (const r of best.rooms.filter((x) => x.purpose === 'bedroom')) expect(r.daylightM, r.name).toBeGreaterThanOrEqual(1);
  });

  it('keeps areas within tolerance and no room narrower than its minimum', () => {
    for (const r of best.rooms.filter((x) => !x.isHall)) {
      expect(r.areaM2, r.name).toBeGreaterThanOrEqual(r.minAreaM2 * 0.97);
      expect(Math.abs(r.areaM2 - r.targetM2) / r.targetM2, r.name).toBeLessThan(0.45);
      expect(r.widthM, r.name).toBeGreaterThanOrEqual(r.minWidthM - 0.02);
      expect(r.aspect, r.name).toBeLessThanOrEqual(2.25);
    }
    const share = best.circulationShare;
    expect(share).toBeGreaterThan(0.06);
    expect(share).toBeLessThan(0.17);
  });

  it('assembles into one model with paired doors and a way out of every room', () => {
    const model = toSpaceModel(best, undefined, { now: 0 });
    expect(model.spaces.length).toBe(programme.rooms.length + 1);
    for (const o of model.openings) {
      const s = model.spaces.find((x) => x.id === o.spaceId)!;
      expect(o.wallIndex).toBeLessThan(s.polygon.length);
      expect(o.offsetM - o.widthM / 2).toBeGreaterThanOrEqual(-1e-6);
    }
    for (const s of model.spaces) expect(s.walls.length).toBe(s.polygon.length);
    expect(model.measurements.every((m) => m.sourceKind === 'generated' && m.status === 'estimated')).toBe(true);
    const g = roomGraph(model);
    expect(g.exits.length).toBe(1);
    expect(g.links.length).toBeGreaterThanOrEqual(programme.rooms.length);
    const routes = buildingRoutes(model);
    expect(routes.trapped).toEqual([]);
    expect(routes.worstEgressM!).toBeLessThan(25);
    const r = routes.route('room-bed-master', 'room-kitchen');
    expect(r).not.toBeNull();
    expect(r!.spaceIds[0]).toBe('room-bed-master');
    expect(r!.spaceIds).toContain('hall');
  });

  it('is deterministic for a seed', () => {
    const a = planBuilding(rectShell(10, 12), [{ wallIndex: 2, offsetM: 5 }], [], programme, { count: 2, seed: 7, iterations: 300 });
    const b = planBuilding(rectShell(10, 12), [{ wallIndex: 2, offsetM: 5 }], [], programme, { count: 2, seed: 7, iterations: 300 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('office 20 x 15 m for 24 people', () => {
  const programme = officeProgramme(24);
  const plans = planBuilding(rectShell(20, 15), [{ wallIndex: 2, offsetM: 10 }], [], programme, { count: 3, seed: 1 });
  const best = plans[0];

  it('plans every zone, reachable and daylit where needed', async () => {
    await writeProof('office-20x15', best);
    expect(programme.rooms.filter((r) => r.purpose === 'workspace').reduce((s, r) => s + (r.people ?? 0), 0)).toBe(24);
    expect(best.rooms.length).toBe(programme.rooms.length + 1);
    noOverlaps(best);
    expect(best.criteria.find((c) => c.id === 'reach')!.score).toBe(1);
    expect(best.criteria.find((c) => c.id === 'daylight')!.score).toBe(1);
    for (const r of best.rooms) for (const q of r.rects) expect(Math.min(q.x1 - q.x0, q.y1 - q.y0), r.name).toBeGreaterThanOrEqual(0.9);
    expect(best.score).toBeGreaterThan(80);
  });
});

describe('L-shaped shell', () => {
  it('runs the hall into the wing and reaches every room', () => {
    const plans = planBuilding(lShell(14, 12, 6, 6), [{ wallIndex: 0, offsetM: 9 }], [], villaProgramme(3), { count: 2, seed: 1 });
    expect(plans.length).toBeGreaterThan(0);
    noOverlaps(plans[0]);
    const sum = plans[0].rooms.reduce((s, r) => s + r.rects.reduce((t, q) => t + rArea(q), 0), 0);
    expect(sum).toBeCloseTo(14 * 6 + 6 * 6, 1);
    expect(plans[0].criteria.find((c) => c.id === 'reach')!.score).toBe(1);
  });
});

describe('programme', () => {
  it('reads a brief with rules', () => {
    expect(programmeFromRules('a villa with 4 bedrooms and a study').rooms.filter((r) => r.purpose === 'bedroom').length).toBe(4);
    expect(programmeFromRules('office for 30 people').kind).toBe('office');
    expect(programmeFromRules('small cafe with 20 seats').rooms.find((r) => r.id === 'seating')!.people).toBe(20);
  });
});

describe('furnishing a floor', () => {
  const plan = planBuilding(rectShell(10, 12), [{ wallIndex: 2, offsetM: 5 }], [], villaProgramme(3), { count: 1, seed: 1, iterations: 400 })[0];
  const model = toSpaceModel(plan, undefined, { now: 0 });

  it('cuts a room out net of shared walls and maps furniture back', () => {
    const s = model.spaces.find((x) => x.id === 'room-bed-master')!;
    const sub = subModelFor(model, s.id)!;
    expect(sub.model.spaces.length).toBe(1);
    expect(area(sub.model.spaces[0].polygon)).toBeLessThan(area(s.polygon));
    expect(area(sub.model.spaces[0].polygon)).toBeGreaterThan(area(s.polygon) - 2);
    expect(Math.min(...sub.model.spaces[0].polygon.map((p) => p.x))).toBeCloseTo(0, 6);
    expect(sub.model.openings.length).toBeGreaterThan(0);
    const bed = { ...makeItem('bed-160'), x: 1.5, y: 1.5 };
    const merged = mergeFurniture(model, s.id, [bed], sub.offset);
    expect(pointInPolygon(merged[0], s.polygon)).toBe(true);
  });

  it('furnishes every room with a brief and reports progress', async () => {
    const seen: string[] = [];
    const res = await furnishBuilding(model, {}, {
      parallel: 2,
      onRoom: (p) => { if (p.status === 'done') seen.push(p.spaceId); },
      compile: async () => ({ purpose: '', people: 1, budgetSek: null, items: [], routeTargets: [], minRouteWidthM: 0.8, style: '', lockedIds: [], notes: [], questions: [], compiledBy: 'rules' }),
      solve: async (sub) => { const p = sub.spaces[0].polygon; const c = { x: (Math.min(...p.map((q) => q.x)) + Math.max(...p.map((q) => q.x))) / 2, y: 1 }; return [{ ...makeItem('lamp'), ...c }]; },
    });
    const bedrooms = model.spaces.filter((s) => s.purpose === 'bedroom' || s.purpose === 'living' || s.purpose === 'kitchen');
    expect(seen.sort()).toEqual(bedrooms.map((s) => s.id).sort());
    for (const f of res.furniture) expect(model.spaces.some((s) => pointInPolygon(f, s.polygon))).toBe(true);
    expect(res.rooms.find((r) => r.spaceId === 'hall')!.status).toBe('skipped');
  });
});
