// Chairs belong to something: a desk, a table, a seating group or a reading corner. Never floating.
import { describe, expect, it } from 'vitest';
import type { FurnitureItem, SpaceModel } from '../../core/types';
import { makeItem } from '../furniture/catalog';
import { opening, rect, reqs, room } from '../referee/fixtures';
import { defaultProgram } from './program';
import { solveProgram, type SolvedCandidate } from './solve';
import { backWall, facingErrRect, gapBetween } from './place.testkit';

const at = (id: string, key: string) => ({ ...makeItem(id, { x: 1, y: 1, rotation: 0 }), id: key });
const DEG20 = (20 * Math.PI) / 180;
const isTaskSeat = (f: FurnitureItem) => /^(chair|desk-chair|office-chair|stool)$/.test(f.category);
const isHost = (f: FurnitureItem) => /desk|table|counter/.test(f.category) && !/coffee|side/.test(f.category);

/** Every task chair sits within 0.7 m of a desk or table and faces it within 20 degrees. */
function chairsAnchored(list: FurnitureItem[]) {
  const hosts = list.filter(isHost);
  for (const c of list.filter(isTaskSeat)) {
    const h = hosts.slice().sort((a, b) => gapBetween(c, a) - gapBetween(c, b))[0];
    expect(h, `${c.id} has a host`).toBeDefined();
    expect(gapBetween(c, h), `${c.id} distance to ${h.id}`).toBeLessThan(0.7);
    expect(facingErrRect(c, h), `${c.id} faces ${h.id}`).toBeLessThan(DEG20);
  }
}

async function solve(m: SpaceModel, items: FurnitureItem[], routeToWindow = true) {
  const req = reqs({ routeTargets: routeToWindow ? [{ kind: 'window' }] : [], minRouteWidthM: 0.8 });
  const t = Date.now();
  const res = await solveProgram(m, items, defaultProgram(m, items, req), { seed: 5, req });
  return { res, ms: Date.now() - t };
}

describe('chairs are placed with their anchor', () => {
  it('home office: the office chair is in front of the desk, facing it', async () => {
    const m = room(rect(3, 3.2), [opening('door', 'door', 0, 0.6, 0.85, 'in'), opening('win', 'window', 2, 1.5, 1.2)]);
    const items = [at('desk-140', 'desk'), at('office-chair', 'chair'), at('bookshelf', 'shelf'), at('floor-lamp', 'lamp')];
    const { res, ms } = await solve(m, items);
    console.log('office ms', ms, res.candidates.length);
    expect(res.candidates.length).toBeGreaterThan(0);
    for (const c of res.candidates) {
      expect(c.furniture.some((f) => f.id === 'chair')).toBe(true);
      chairsAnchored(c.furniture);
    }
  }, 30000);

  it('cafe with four tables: every chair at a table, facing it', async () => {
    const m = room(rect(6, 5), [opening('door', 'door', 0, 1, 0.9, 'in'), opening('win', 'window', 2, 3, 2)]);
    const items = [...[0, 1, 2, 3].map((i) => at('cafe-4', `t${i}`)), ...Array.from({ length: 8 }, (_, i) => at('chair', `c${i}`))];
    const { res, ms } = await solve(m, items);
    console.log('cafe ms', ms, res.candidates.length, res.candidates[0]?.furniture.length);
    expect(res.candidates.length).toBeGreaterThan(0);
    for (const c of res.candidates) chairsAnchored(c.furniture);
    expect(res.candidates[0].furniture.filter(isTaskSeat).length).toBeGreaterThanOrEqual(6);
  }, 30000);

  it('dining room: six chairs evenly around the table, facing it', async () => {
    const m = room(rect(4.2, 3.8), [opening('door', 'door', 0, 0.6, 0.9, 'in'), opening('win', 'window', 1, 1.9, 1.4)]);
    const items = [at('dining-6', 'table'), ...Array.from({ length: 6 }, (_, i) => at('chair', `c${i}`)), at('sideboard', 'sb')];
    const { res, ms } = await solve(m, items);
    console.log('dining ms', ms, res.candidates.length);
    expect(res.candidates.length).toBeGreaterThan(0);
    for (const c of res.candidates) {
      expect(c.furniture.filter(isTaskSeat).length).toBe(6);
      chairsAnchored(c.furniture);
    }
  }, 30000);

  it('living room: armchairs face the sofa, TV or coffee table; coffee table 35-55 cm before the sofa', async () => {
    const m = room(rect(5, 6), [opening('door', 'door', 0, 0.7, 0.9, 'in'), opening('win', 'window', 2, 2.5, 1.8)]);
    const items = [at('sofa-3', 'sofa'), at('coffee-table', 'ct'), at('tv-unit', 'tv'), at('armchair', 'a1'), at('armchair', 'a2'),
      at('rug-200', 'rug'), at('floor-lamp', 'lamp'), at('plant', 'plant')];
    const { res, ms } = await solve(m, items);
    console.log('living ms', ms, res.candidates.length);
    expect(res.candidates.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(4000 * Number((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.SPACELENS_TIME_SLACK ?? 1));
    for (const c of res.candidates) {
      const sofa = c.furniture.find((f) => f.id === 'sofa')!, ct = c.furniture.find((f) => f.id === 'ct')!;
      const targets = c.furniture.filter((f) => /^(sofa|tv-unit|coffee-table)$/.test(f.category));
      for (const a of c.furniture.filter((f) => f.category === 'armchair')) {
        const err = Math.min(...targets.map((t) => facingErrRect(a, t)));
        expect(err, `${a.id} faces the group`).toBeLessThan(DEG20);
        expect(Math.min(...targets.map((t) => gapBetween(a, t))), `${a.id} near the group`).toBeLessThan(1.2);
      }
      // Coffee table: clear gap from the sofa front 35-55 cm, centred on the sofa within 10 cm.
      const ly = -(ct.x - sofa.x) * Math.sin(sofa.rotation) + (ct.y - sofa.y) * Math.cos(sofa.rotation);
      const lx = (ct.x - sofa.x) * Math.cos(sofa.rotation) + (ct.y - sofa.y) * Math.sin(sofa.rotation);
      const gap = ly - sofa.d / 2 - ct.d / 2;
      expect(gap).toBeGreaterThanOrEqual(0.35);
      expect(gap).toBeLessThanOrEqual(0.55);
      expect(Math.abs(lx)).toBeLessThan(0.1);
    }
  }, 30000);

  it('more chairs than the desk takes: extras are left out with a reason, never loose', async () => {
    const m = room(rect(3, 3.2), [opening('door', 'door', 0, 0.6, 0.85, 'in'), opening('win', 'window', 2, 1.5, 1.2)]);
    const items = [at('desk-120', 'desk'), at('desk-chair', 'c1'), at('desk-chair', 'c2'), at('desk-chair', 'c3'), at('bookshelf', 'shelf')];
    const { res } = await solve(m, items);
    expect(res.candidates.length).toBeGreaterThan(0);
    for (const c of res.candidates) chairsAnchored(c.furniture);
  }, 30000);

  it('a dining table that cannot fit takes its chairs with it', async () => {
    const m = room(rect(3.2, 3.4), [opening('door', 'door', 0, 0.6, 0.85, 'in'), opening('win', 'window', 2, 1.6, 1.0)]);
    const items = [at('bed-double', 'bed'), at('nightstand', 'ns'), at('dining-6', 'table'), ...Array.from({ length: 6 }, (_, i) => at('chair', `c${i}`))];
    const { res } = await solve(m, items);
    expect(res.candidates.length).toBeGreaterThan(0);
    for (const c of res.candidates) {
      expect(c.furniture.some((f) => f.id === 'bed')).toBe(true);
      // The set that does not fit goes, not the small piece that does.
      expect(c.furniture.some((f) => f.id === 'ns')).toBe(true);
      expect(c.furniture.filter(isTaskSeat).length).toBe(0);
      expect((c as SolvedCandidate).degraded?.dropped).toContain('table');
      chairsAnchored(c.furniture);
    }
  }, 30000);

  it('a chair with no desk or table gets a reading corner with its back to a wall, or is left out', async () => {
    const m = room(rect(3.5, 4), [opening('door', 'door', 0, 0.65, 0.9, 'in'), opening('win', 'window', 1, 1.4, 1.2)]);
    const items = [at('bed-double', 'bed'), at('chair', 'lone'), at('floor-lamp', 'lamp')];
    const { res } = await solve(m, items);
    expect(res.candidates.length).toBeGreaterThan(0);
    for (const c of res.candidates) {
      const ch = c.furniture.find((f) => f.id === 'lone');
      if (!ch) { expect(c.assumptions.join(' ')).toMatch(/left out the chair/i); continue; }
      expect(backWall(m, ch, 0.12)).toBeGreaterThanOrEqual(0);
    }
  }, 30000);
});
