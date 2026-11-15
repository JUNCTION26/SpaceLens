import { describe, expect, it } from 'vitest';
import type { FurnitureItem, Opening, SpaceModel } from '../../core/types';
import { BODY, furnitureObstacles, hits, moveSliding, overlap, segmentObstacles, type Obstacle } from './collide';
import { eyeHeight, newWalker, stepWalker } from './walker';
import { doorPaths, planTour, poseAt, tourOrder, tourProgress, tourTimeline } from './tour';
import { solidSegments } from './walls';
import { wheelchairPinches } from './wheelchair';
import { bestFormat } from './recorder';
import { clampPitch, easeTurn, keyAxes, padAxes, TURN_RATE } from './walkInput';

const TURN_1S_MIN = (Math.PI / 2) * 0.8;

const wall = { thicknessM: 0.1, sourceKind: 'manual' as const, status: 'verified' as const };
const rect = (id: string, x0: number, y0: number, x1: number, y1: number) => ({ id, name: id, polygon: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }], walls: [wall, wall, wall, wall] });
const door = (id: string, spaceId: string, wallIndex: number, offsetM: number, widthM: number): Opening => ({
  id, kind: 'door', spaceId, wallIndex, offsetM, widthM, heightM: 2.1, sillM: 0, swing: 'none', hinge: 'start', sourceKind: 'manual', status: 'verified',
});
const piece = (id: string, x: number, y: number, w: number, d: number): FurnitureItem => ({
  id, catalogId: id, name: id, category: 'sofa', x, y, rotation: 0, w, d, h: 0.8, clearance: { front: 0, back: 0, left: 0, right: 0 },
  locked: false, owned: false, priceSek: 0, priceStatus: 'estimated', color: '#888', sourceKind: 'manual',
});
// A (0..4) | B (4..8) | C (8..12), all 4 m deep, doors on the shared walls at y = 2.
const three = (w2 = 0.9): SpaceModel => ({
  id: 'm', name: 't', version: 1, units: 'm', ceilingM: 2.5, sourceLabel: '',
  spaces: [rect('A', 0, 0, 4, 4), rect('B', 4, 0, 8, 4), rect('C', 8, 0, 12, 4)],
  openings: [door('ab1', 'A', 1, 2, 0.9), door('ab2', 'B', 3, 2, 0.9), door('bc1', 'B', 1, 2, w2), door('bc2', 'C', 3, 2, w2)],
  furniture: [piece('sofa', 2, 1, 2, 1), piece('bed', 6, 3, 1.6, 2), piece('desk', 10, 1, 1.2, 0.6)], measurements: [], evidence: [],
});

describe('collision', () => {
  const wallX: Obstacle[] = [{ kind: 'segment', a: { x: 5, y: -10 }, b: { x: 5, y: 10 }, halfM: 0.05 }];
  it('slides along a wall when pushing at an angle', () => {
    let p = { x: 4, y: 0 };
    for (let i = 0; i < 60; i++) p = moveSliding(p, { x: 0.03, y: 0.03 }, 0.2, wallX).pos;
    expect(p.x).toBeLessThan(5 - 0.25 + 1e-3);
    expect(p.y).toBeGreaterThan(1.2);
  });
  it('does not tunnel through a thin wall in one big step', () => {
    const r = moveSliding({ x: 4, y: 0 }, { x: 3, y: 0 }, 0.2, wallX);
    expect(r.pos.x).toBeLessThan(5);
    expect(r.blocked).toBe(true);
  });
  it('is not trapped in a corner and ends clear of both walls', () => {
    const corner: Obstacle[] = [wallX[0], { kind: 'segment', a: { x: -10, y: 5 }, b: { x: 10, y: 5 }, halfM: 0.05 }];
    let p = { x: 4, y: 4 };
    for (let i = 0; i < 100; i++) p = moveSliding(p, { x: 0.05, y: 0.05 }, 0.2, corner).pos;
    expect(hits(p, 0.19, corner)).toBe(false);
    const back = moveSliding(p, { x: -0.5, y: -0.5 }, 0.2, corner).pos;
    expect(back.x).toBeLessThan(p.x - 0.4);
  });
  it('slides around furniture and never ends inside it', () => {
    const f = furnitureObstacles([piece('s', 2, 2, 1, 1)]);
    let p = { x: 0.5, y: 1.7 };
    for (let i = 0; i < 80; i++) { p = moveSliding(p, { x: 0.04, y: 0.01 }, 0.2, f).pos; expect(hits(p, 0.19, f)).toBe(false); }
    expect(p.y).toBeGreaterThan(2.3);
    expect(p.x).toBeLessThan(1.31);
  });
  it('doorways are gaps: solid pieces leave the opening free', () => {
    const obs = segmentObstacles(solidSegments(three()));
    expect(hits({ x: 4, y: 2 }, BODY.stand, obs)).toBe(false);
    expect(hits({ x: 4, y: 0.7 }, BODY.stand, obs)).toBe(true);
  });
  it('a standing body passes a 0.6 m door and a wheelchair does not', () => {
    const passes = (m: SpaceModel, r: number) => moveSliding({ x: 3.4, y: 2 }, { x: 1.2, y: 0 }, r, segmentObstacles(solidSegments(m))).pos.x > 4.5;
    expect(passes(three(0.9), BODY.stand)).toBe(true);
    expect(passes(three(0.9), BODY.wheelchair)).toBe(true);
    const narrow = three(0.9); narrow.openings[0].widthM = 0.6; narrow.openings[1].widthM = 0.6;
    expect(passes(narrow, BODY.stand)).toBe(true);
    expect(passes(narrow, BODY.wheelchair)).toBe(false);
  });
  it('overlap points away from the surface', () => {
    const h = overlap({ x: 4.9, y: 0 }, 0.2, wallX[0])!;
    expect(h.nx).toBeLessThan(0);
    expect(h.depth).toBeCloseTo(0.2 + 0.05 - 0.1, 6);
  });
});

describe('walker', () => {
  const open = { obstacles: [] as Obstacle[] };
  const plain = { seated: false, bob: false };
  const run = (frames: number, dt: number) => {
    let w = newWalker({ x: 0, y: 0 }, 0);
    for (let i = 0; i < frames; i++) w = stepWalker(w, { forward: 1, strafe: 0 }, dt, plain, open);
    return w;
  };
  it('ramps up smoothly and is frame-rate independent', () => {
    const a = run(60, 1 / 60), b = run(240, 1 / 240);
    expect(Math.abs(a.pos.y - b.pos.y)).toBeLessThan(0.02);
    expect(Math.hypot(run(3, 1 / 60).vel.x, run(3, 1 / 60).vel.y)).toBeLessThan(0.6);
  });
  it('decelerates to a stop', () => {
    let w = run(60, 1 / 60);
    for (let i = 0; i < 60; i++) w = stepWalker(w, { forward: 0, strafe: 0 }, 1 / 60, plain, open);
    expect(Math.hypot(w.vel.x, w.vel.y)).toBe(0);
  });
  it('eye heights: 1.6 standing, 1.2 seated, bob a few millimetres and can be off', () => {
    const w = run(40, 1 / 60);
    expect(eyeHeight(w, plain)).toBe(1.6);
    expect(eyeHeight(w, { seated: true, bob: false })).toBe(1.2);
    let max = 0;
    let s = newWalker({ x: 0, y: 0 });
    for (let i = 0; i < 300; i++) { s = stepWalker(s, { forward: 1, strafe: 0 }, 1 / 60, { seated: false, bob: true }, open); max = Math.max(max, Math.abs(eyeHeight(s, { seated: false, bob: true }) - 1.6)); }
    expect(max).toBeGreaterThan(0.002); expect(max).toBeLessThanOrEqual(0.0041);
  });
  it('slides along a wall while walking at it diagonally', () => {
    const obs = segmentObstacles([{ a: { x: -10, y: -1 }, b: { x: 10, y: -1 }, interior: true, halfM: 0.05 }]);
    let w = newWalker({ x: 0, y: 0 }, Math.PI / 4); // faces plan -x and -y
    for (let i = 0; i < 120; i++) w = stepWalker(w, { forward: 1, strafe: 0 }, 1 / 60, plain, { obstacles: obs });
    expect(w.pos.y).toBeGreaterThan(-0.76);
    expect(w.pos.x).toBeLessThan(-1);
  });
});

describe('tour', () => {
  const m = three();
  it('door paths go through B to reach C', () => {
    const nodes = m.spaces.map((s) => ({ id: s.id, spot: { x: (s.polygon[0].x + s.polygon[1].x) / 2, y: 2 }, visit: true }));
    const p = doorPaths(nodes, [{ a: 'A', b: 'B', at: { x: 4, y: 2 } }, { a: 'B', b: 'C', at: { x: 8, y: 2 } }], 'A');
    expect(p.get('C')!.hops.map((h) => h.to)).toEqual(['B', 'C']);
    expect(p.get('C')!.cost).toBeCloseTo(8, 6);
  });
  it('visits every room nearest first and ends at the start', () => {
    const t = planTour(m, undefined, { x: 2, y: 2 }, 0);
    expect(t.stops.map((s) => s.spaceId)).toEqual(['A', 'B', 'C']);
    expect(t.points[t.points.length - 1]).toEqual({ x: 2, y: 2 });
    expect(t.points.some((p) => Math.abs(p.x - 8) < 0.5 && Math.abs(p.y - 2) < 0.5)).toBe(true);
  });
  it('from the middle room, starts there and still sees all', () => {
    const t = planTour(m, undefined, { x: 6, y: 2 }, 0);
    expect(t.stops[0].spaceId).toBe('B');
    expect(new Set(t.stops.map((s) => s.spaceId))).toEqual(new Set(['A', 'B', 'C']));
  });
  it('looks at the hero piece', () => {
    const t = planTour(m, undefined, { x: 2, y: 2 }, 0);
    expect(t.stops[0].look).toEqual({ x: 2, y: 1 });
    expect(t.stops[1].look).toEqual({ x: 6, y: 3 });
  });
  it('leaves out unreachable rooms', () => {
    const nodes = [{ id: 'A', spot: { x: 0, y: 0 }, visit: true }, { id: 'Z', spot: { x: 9, y: 9 }, visit: true }];
    expect(tourOrder(nodes, [], 'A').visits.map((v) => v.id)).toEqual(['A']);
  });
  it('timeline pauses 1.5 s per room, eases turns, ends at the start', () => {
    const t = planTour(m, undefined, { x: 2, y: 2 }, 0);
    const tl = tourTimeline(t, { x: 2, y: 2 }, 0.3);
    for (const i of [0, 1, 2]) expect(tl.poses.filter((p) => p.stop === i).length / 30).toBeGreaterThanOrEqual(1.45);
    const last = tl.poses[tl.poses.length - 1];
    expect(Math.hypot(last.x - 2, last.y - 2)).toBeLessThan(0.05);
    expect(last.yaw).toBeCloseTo(0.3, 6);
    let maxTurn = 0;
    for (let i = 1; i < tl.poses.length; i++) maxTurn = Math.max(maxTurn, Math.abs(Math.atan2(Math.sin(tl.poses[i].yaw - tl.poses[i - 1].yaw), Math.cos(tl.poses[i].yaw - tl.poses[i - 1].yaw))));
    expect(maxTurn).toBeLessThan(0.08);
    expect(tourProgress(tl, 0)).toBe(0);
    expect(tourProgress(tl, tl.durationS)).toBe(1);
    expect(poseAt(tl, tl.durationS / 2).t).toBeCloseTo(tl.durationS / 2, 6);
  });
});

describe('wheelchair', () => {
  it('reports a door that is too narrow', () => {
    const pinches = wheelchairPinches(three(0.6), [], { x: 2, y: 2 });
    expect(pinches.some((p) => p.kind === 'door' && Math.abs(p.at.x - 8) < 0.2)).toBe(true);
  });
  it('is clear when every door is wide enough', () => {
    expect(wheelchairPinches(three(0.9), [], { x: 2, y: 2 }).filter((p) => p.kind === 'door')).toEqual([]);
  });
  it('reports a room cut off by furniture', () => {
    const shelf = piece('shelf', 4.7, 2, 0.4, 4);
    expect(wheelchairPinches(three(), [shelf], { x: 2, y: 2 }).some((p) => p.kind === 'room')).toBe(true);
  });
});

describe('recording and input', () => {
  it('prefers mp4, then webm vp9, then webm', () => {
    expect(bestFormat(() => true)?.ext).toBe('mp4');
    expect(bestFormat((m) => m.startsWith('video/webm'))).toEqual({ mime: 'video/webm;codecs=vp9', ext: 'webm' });
    expect(bestFormat((m) => m === 'video/webm')).toEqual({ mime: 'video/webm', ext: 'webm' });
    expect(bestFormat(() => false)).toBeNull();
  });
  it('keys and thumb pad', () => {
    expect(keyAxes(new Set(['KeyW', 'KeyD']))).toEqual({ forward: 1, strafe: 1, turn: 0, tilt: 0 });
    expect(keyAxes(new Set(['ArrowUp', 'ArrowLeft']))).toEqual({ forward: 0, strafe: 0, turn: 1, tilt: 1 });
    expect(padAxes(0, -48).forward).toBeCloseTo(1, 6);
  });
  it('arrows never move and WASD never turn or tilt', () => {
    for (const k of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
      const a = keyAxes(new Set([k]));
      expect(a.forward).toBe(0); expect(a.strafe).toBe(0);
      expect(Math.abs(a.turn) + Math.abs(a.tilt)).toBe(1);
    }
    for (const k of ['KeyW', 'KeyA', 'KeyS', 'KeyD']) {
      const a = keyAxes(new Set([k]));
      expect(a.turn).toBe(0); expect(a.tilt).toBe(0);
      expect(Math.abs(a.forward) + Math.abs(a.strafe)).toBe(1);
    }
    expect(keyAxes(new Set(['KeyW']))).toMatchObject({ forward: 1, strafe: 0 });
    expect(keyAxes(new Set(['KeyS']))).toMatchObject({ forward: -1, strafe: 0 });
    expect(keyAxes(new Set(['KeyA']))).toMatchObject({ forward: 0, strafe: -1 });
    expect(keyAxes(new Set(['KeyD']))).toMatchObject({ forward: 0, strafe: 1 });
    expect(keyAxes(new Set(['ArrowLeft'])).turn).toBe(1);
    expect(keyAxes(new Set(['ArrowRight'])).turn).toBe(-1);
    expect(keyAxes(new Set(['ArrowUp'])).tilt).toBe(1);
    expect(keyAxes(new Set(['ArrowDown'])).tilt).toBe(-1);
  });
  it('arrow turning eases in and holds about 90 degrees a second, tilt stays within 60 degrees', () => {
    let v = 0, yaw = 0;
    for (let i = 0; i < 60; i++) { v = easeTurn(v, 1, 1 / 60); yaw += v * TURN_RATE / 60; }
    expect(yaw).toBeGreaterThan(TURN_1S_MIN);
    expect(yaw).toBeLessThan(Math.PI / 2 + 1e-6);
    expect(easeTurn(0, 1, 1 / 60)).toBeLessThan(0.5);
    expect(clampPitch(2)).toBeCloseTo(Math.PI / 3, 6);
    expect(clampPitch(-2)).toBeCloseTo(-Math.PI / 3, 6);
  });
  it('thumb pad', () => {
    expect(padAxes(2, -2)).toEqual({ forward: 0, strafe: 0 });
  });
});
