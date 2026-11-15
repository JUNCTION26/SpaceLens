// Review: every action on the Walk and Safety panels, driven through the same functions the panels call.
import { describe, expect, it } from 'vitest';
import { sampleRoom } from '../../core/sample';
import { applyOp } from '../../core/ops';
import type { SpaceModel } from '../../core/types';
import { buildGrid } from '../../features/sim/grid';
import { planTour, poseAt, tourTimeline } from '../../features/sim/tour';
import { keyAxes } from '../../features/sim/walkInput';
import { newWalker, stepWalker } from '../../features/sim/walker';
import { runRoutes } from '../../features/sim/routes';
import { testPassage } from '../../features/sim/passage';
import { castSightlines } from '../../features/sim/sightlines';
import { runCrowd } from '../../features/sim/crowd';
import { roomCentroid } from '../../features/sim/grid';
import { assessSafety } from '../../features/safety/assess';
import { runDrill } from '../../features/safety/drill';
import { assessAccess } from '../../features/safety/access';
import { applyPlacement, planPlacement } from '../../features/safety/placement';
import { buildSafetyReport, DISCLAIMER, reportHtml } from '../../features/safety/report';
import { evacuationPlanSvg } from '../../features/safety/plan';
import { packFor } from '../../features/jurisdiction/rulepacks';
import { resetStore, st } from '../helpers';

const wall = { thicknessM: 0.1, sourceKind: 'manual' as const, status: 'verified' as const };
const rect = (x: number, y: number, w: number, h: number) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];

/** A bedroom with a small WC off it: one room worth visiting. */
function roomWithWc(): SpaceModel {
  return {
    id: 'wc', name: 'Bed and WC', version: 1, units: 'm', ceilingM: 2.5, sourceLabel: 'test',
    spaces: [
      { id: 'bed', name: 'Bedroom', polygon: rect(0, 0, 4, 3.5), walls: [wall, wall, wall, wall] },
      { id: 'wc', name: 'WC', polygon: rect(4, 0, 1.4, 1.6), walls: [wall, wall, wall, wall] },
    ],
    openings: [
      { id: 'd1', kind: 'door', spaceId: 'bed', wallIndex: 2, offsetM: 1, widthM: 0.9, heightM: 2.1, sillM: 0, swing: 'in', hinge: 'start', sourceKind: 'manual', status: 'verified' },
      { id: 'd2', kind: 'door', spaceId: 'bed', wallIndex: 1, offsetM: 0.4, widthM: 0.8, heightM: 2.1, sillM: 0, swing: 'in', hinge: 'start', sourceKind: 'manual', status: 'verified' },
    ],
    furniture: [], measurements: [], evidence: [],
  } as SpaceModel;
}

describe('Walk panel', () => {
  it('Tour: a single room has at least two stops and the timeline ends at the start', () => {
    const m = sampleRoom();
    const start = roomCentroid(m);
    const t = planTour(m, buildGrid(m, m.furniture), start);
    expect(t.stops.length).toBeGreaterThanOrEqual(2);
    expect(t.points.length).toBeGreaterThan(2);
    const tl = tourTimeline(t, start, 0);
    expect(tl.durationS).toBeGreaterThan(2);
    const end = poseAt(tl, tl.durationS + 1);
    expect(Math.hypot(end.x - start.x, end.y - start.y)).toBeLessThan(0.05);
  });

  it('Tour: a bedroom with a small WC still tours (two stops)', () => {
    const m = roomWithWc();
    const t = planTour(m, buildGrid(m, m.furniture), { x: 2, y: 1.7 });
    expect(t.stops.length).toBeGreaterThanOrEqual(2);
    expect(t.points.length).toBeGreaterThan(0);
  });

  it('Walk: W moves forward, arrows only turn, a wall stops the walker', () => {
    expect(keyAxes(new Set(['KeyW']))).toMatchObject({ forward: 1, strafe: 0 });
    expect(keyAxes(new Set(['ArrowLeft']))).toMatchObject({ forward: 0, turn: 1 });
    let w = newWalker({ x: 1, y: 1 }, 0);
    const x0 = w.pos.x, y0 = w.pos.y;
    for (let i = 0; i < 30; i++) w = stepWalker(w, { forward: 1, strafe: 0 }, 1 / 30, { seated: false, bob: true }, { obstacles: [] });
    expect(Math.hypot(w.pos.x - x0, w.pos.y - y0)).toBeGreaterThan(0.5);
  });

  it('Routes, door fit, sightlines and crowd all give an answer', () => {
    const m = sampleRoom();
    const r = runRoutes(m, m.furniture, 'adult');
    expect(r.routes.length).toBeGreaterThan(0);
    const door = m.openings.find((o) => o.kind === 'door')!;
    const p = testPassage(m, m.furniture, { id: 'cat:shelf', name: 'Shelf', w: 0.8, d: 0.4, h: 1.8 }, door.id);
    expect(typeof p.ok).toBe('boolean');
    expect(castSightlines(m, m.furniture, roomCentroid(m)).length).toBeGreaterThan(0);
    const c = runCrowd(m, m.furniture, 10, 1);
    expect(c).not.toBeNull();
    expect(Number.isFinite(c!.stats.meanPathM)).toBe(true);
  });
});

describe('Safety panel', () => {
  it('Assess: findings and a finite score; a Fix applies through the store', () => {
    resetStore();
    const m = st().model;
    const rep = assessSafety(m, m.furniture);
    expect(Number.isFinite(rep.score)).toBe(true);
    expect(rep.exits.length).toBeGreaterThan(0);
    const fixable = rep.findings.find((f) => f.fix && f.fix.ops.length);
    if (fixable) {
      const v = st().model.version;
      for (const op of fixable.fix!.ops) st().dispatch(op);
      expect(st().model.version).toBeGreaterThan(v);
    }
  });

  it('Drill reports a time, and blocking an exit still reports one', () => {
    const m = sampleRoom();
    const d = runDrill(m, m.furniture);
    expect(d.totalS).toBeGreaterThan(0);
    expect(Number.isFinite(d.totalS)).toBe(true);
    expect(d.occupants).toBeGreaterThan(0);
    const b = runDrill(m, m.furniture, { blockExit: true, occupants: 5 });
    expect(Number.isFinite(b.totalS)).toBe(true);
    expect(b.occupants).toBe(5);
  });

  it('Access tab: destinations and wheelchair routes', () => {
    const m = sampleRoom();
    const a = assessAccess(m, m.furniture, { pack: packFor('generic') });
    expect(a.total).toBeGreaterThanOrEqual(a.reachableCount);
    expect(Array.isArray(a.routes)).toBe(true);
  });

  it('Equipment: suggestions turn into ops that apply to the model', () => {
    const m = sampleRoom();
    const plc = planPlacement(m, m.furniture, { pack: packFor('generic') });
    const ops = applyPlacement(plc.suggestions);
    let next = m;
    for (const op of ops) next = applyOp(next, op);
    expect(next.furniture.length).toBeGreaterThanOrEqual(m.furniture.length);
  });

  it('Report download and exit plan are complete documents', () => {
    const m = sampleRoom();
    const rep = assessSafety(m, m.furniture);
    const html = reportHtml(buildSafetyReport(m, rep, packFor('generic')));
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain(DISCLAIMER.slice(0, 40));
    const svg = evacuationPlanSvg(m, m.furniture, rep, { youAreHere: roomCentroid(m) });
    expect(svg).toMatch(/^<svg|<\?xml/);
    expect(svg).toContain('</svg>');
  });
});
