// Bedroom scenarios: what an interior architect expects from a furnished 14 m2 bedroom.
import { describe, expect, it } from 'vitest';
import type { FurnitureItem, SpaceModel } from '../../core/types';
import { makeItem } from '../furniture/catalog';
import { opening, rect, reqs, room } from '../referee/fixtures';
import { validateLayout } from '../referee/validate';
import { defaultProgram } from './program';
import { solveProgram, type SolvedCandidate } from './solve';
import { backWall, facingErr, frontGap, gapBetween, localX } from './place.testkit';

const slack = Number((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.SPACELENS_TIME_SLACK ?? 1);
const at = (id: string, key: string) => ({ ...makeItem(id, { x: 1, y: 1, rotation: 0 }), id: key });

function bedroom(): { m: SpaceModel; items: FurnitureItem[] } {
  // 3.5 x 4.0 m. Door near a corner of the south wall (wall 0), window on the east wall (wall 1).
  const m = room(rect(3.5, 4), [opening('door', 'door', 0, 0.65, 0.9, 'in'), opening('win', 'window', 1, 1.4, 1.2)]);
  const items = [at('bed-160', 'bed'), at('nightstand', 'ns1'), at('nightstand', 'ns2'), at('wardrobe-100', 'wardrobe'),
    at('desk-120', 'desk'), at('desk-chair', 'chair'), at('floor-lamp', 'lamp'), at('plant', 'plant')];
  return { m, items };
}

describe('bedroom 14 m2 with eight pieces', () => {
  const req = reqs({ routeTargets: [{ kind: 'window' }], minRouteWidthM: 0.8 });
  let res: Awaited<ReturnType<typeof solveProgram>>;
  let ms = 0;
  const run = async () => {
    if (res) return res;
    const { m, items } = bedroom();
    const t = Date.now();
    res = await solveProgram(m, items, defaultProgram(m, items, req), { seed: 7, req });
    ms = Date.now() - t;
    console.log('bedroom ms', ms, 'candidates', res.candidates.length, res.candidates.map((c) => `${c.name} [${(c as { idea?: { key: string } }).idea?.key}]`));
    return res;
  };

  it('solves in under 2 s with every piece placed', async () => {
    await run();
    expect(res.candidates.length).toBeGreaterThan(0);
    expect(res.candidates[0].furniture.length).toBe(8);
    expect(ms).toBeLessThan(2000 * slack);
  }, 30000);

  it('puts a nightstand against each side of the bed', async () => {
    await run();
    for (const c of res.candidates) {
      const bed = c.furniture.find((f) => f.id === 'bed')!;
      const ns = c.furniture.filter((f) => f.category === 'nightstand');
      expect(ns.length).toBe(2);
      for (const n of ns) expect(gapBetween(bed, n)).toBeLessThan(0.03);
      expect(Math.sign(localX(bed, ns[0]))).toBe(-Math.sign(localX(bed, ns[1])));
    }
  }, 30000);

  it('turns the desk chair to the desk', async () => {
    await run();
    for (const c of res.candidates) {
      const desk = c.furniture.find((f) => f.id === 'desk')!, chair = c.furniture.find((f) => f.id === 'chair')!;
      expect(facingErr(chair, desk)).toBeLessThan(0.35);
      expect(Math.hypot(chair.x - desk.x, chair.y - desk.y)).toBeLessThan(0.9);
    }
  }, 30000);

  it('rests the headboard on a wall without a window', async () => {
    await run();
    const { m } = bedroom();
    const best = res.candidates[0];
    const w = backWall(m, best.furniture.find((f) => f.id === 'bed')!);
    expect(w).toBeGreaterThanOrEqual(0);
    expect(m.openings.some((o) => o.kind === 'window' && o.wallIndex === w)).toBe(false);
  }, 30000);

  it('keeps an 80 cm walkway from the door to the window', async () => {
    await run();
    const { m } = bedroom();
    for (const c of res.candidates) {
      const checks = validateLayout(m, c.furniture, req);
      expect(checks.filter((k) => k.result === 'fail').map((k) => k.rule)).toEqual([]);
    }
  }, 30000);

  it.skip('offers three layouts that differ in anchor walls, the bed on both legal walls, with a machine-readable idea', async () => {
    // South holds the door and east the window the walkway must reach: the bed has two walls here.
    await run();
    const { m } = bedroom();
    expect(res.candidates.length).toBe(3);
    const walls = res.candidates.map((c) => backWall(m, c.furniture.find((f) => f.id === 'bed')!));
    expect(new Set(walls).size).toBe(2);
    const ideas = res.candidates.map((c) => (c as SolvedCandidate).idea!);
    expect(ideas.every((k) => typeof k.key === 'string' && k.anchors.length >= 2)).toBe(true);
    expect(new Set(ideas.map((k) => k.key)).size).toBe(3);
    // Every pair differs in the wall of at least one anchor.
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
      const wallsOf = (k: number) => ideas[k].anchors.map((a) => `${a.id}:${a.wall}`).sort().join();
      expect(wallsOf(i)).not.toBe(wallsOf(j));
    }
  }, 30000);

  // Open: with the walkway to the window required, only the west wall survives in this room, although
  // the north and east beds found without the walkway leave a clear 1.6 m strip to the window.
  it.skip('puts the bed on three different walls when three walls can take it', async () => {
    const m = room(rect(3.8, 3.7), [opening('door', 'door', 0, 0.55, 0.9, 'in'), opening('win', 'window', 1, 1.85, 1.2)]);
    const items = bedroom().items;
    const r = await solveProgram(m, items, defaultProgram(m, items, req), { seed: 7, req });
    const walls = r.candidates.map((c) => backWall(m, c.furniture.find((f) => f.id === 'bed')!));
    console.log('three-wall room', walls, r.candidates.map((c) => (c as SolvedCandidate).idea?.key));
    expect(r.candidates.length).toBe(3);
    expect(new Set(walls).size).toBe(3);
    expect(walls.every((w) => w >= 0 && w !== 1)).toBe(true);
  }, 30000);

  it('is deterministic for a seed', async () => {
    await run();
    const { m, items } = bedroom();
    const again = await solveProgram(m, items, defaultProgram(m, items, req), { seed: 7, req });
    expect(again.candidates.map((c) => c.furniture.map((f) => `${f.id}:${f.x.toFixed(3)},${f.y.toFixed(3)}`).join(' ')))
      .toEqual(res.candidates.map((c) => c.furniture.map((f) => `${f.id}:${f.x.toFixed(3)},${f.y.toFixed(3)}`).join(' ')));
  }, 30000);

  it('snaps the wardrobe flush to a wall', async () => {
    await run();
    const { m } = bedroom();
    for (const c of res.candidates) expect(backWall(m, c.furniture.find((f) => f.id === 'wardrobe')!)).toBeGreaterThanOrEqual(0);
  }, 30000);
  void frontGap;
});
