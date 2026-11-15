// From a sentence to placed furniture: every chair ends up at its desk or table, facing it, or with its
// back to a wall. Covers each path that writes furniture positions: the design pipeline (solver),
// the themed-room pipeline and the building fit-out.
import { describe, expect, it } from 'vitest';
import type { FurnitureItem, SpaceModel } from '../../core/types';
import { opening, rect, room } from '../referee/fixtures';
import { describeBrief, resetStore, st } from '../../flows/helpers';
import { isTaskSeat, looseChairs } from './place.testkit';

const seats = (f: FurnitureItem[]) => f.filter(isTaskSeat);

async function fromSentence(brief: string, m: SpaceModel) {
  resetStore(m);
  const { req, res } = await describeBrief(brief);
  return { req, res };
}

describe('chairs from a sentence (design pipeline)', () => {
  it('"home office for two": two chairs, each at a desk', async () => {
    const m = room(rect(3.6, 3.4), [opening('door', 'door', 0, 0.6, 0.85, 'in'), opening('win', 'window', 2, 1.6, 1.4)]);
    const { res } = await fromSentence('home office for two', m);
    expect(res.candidates.length).toBeGreaterThan(0);
    for (const c of res.candidates) {
      expect(looseChairs(m, c.furniture), c.name).toEqual([]);
      expect(seats(c.furniture).length).toBeGreaterThanOrEqual(2);
    }
  }, 30000);

  it('"cafe with 12 seats": every chair at a table', async () => {
    const m = room(rect(7, 6), [opening('door', 'door', 0, 1, 0.9, 'in'), opening('win', 'window', 2, 3, 2.4)]);
    const { res } = await fromSentence('cafe with 12 seats', m);
    expect(res.candidates.length).toBeGreaterThan(0);
    for (const c of res.candidates) {
      expect(looseChairs(m, c.furniture), c.name).toEqual([]);
      expect(seats(c.furniture).length).toBeGreaterThanOrEqual(8);
    }
  }, 30000);

  it('"dining room for 6": six chairs round the table', async () => {
    const m = room(rect(4.4, 3.8), [opening('door', 'door', 0, 0.6, 0.9, 'in'), opening('win', 'window', 1, 1.9, 1.4)]);
    const { res } = await fromSentence('dining room for 6', m);
    expect(res.candidates.length).toBeGreaterThan(0);
    for (const c of res.candidates) {
      expect(looseChairs(m, c.furniture), c.name).toEqual([]);
      expect(seats(c.furniture).length).toBe(6);
    }
  }, 30000);
});

describe('chairs in a themed room', () => {
  it('"a room for my cat named Gerard": any chair is at a table or against a wall', async () => {
    const m = room(rect(4, 3.6), [opening('door', 'door', 0, 0.6, 0.85, 'in'), opening('win', 'window', 2, 1.5, 1.2)]);
    const { res } = await fromSentence('a room for my cat named Gerard', m);
    expect(res.candidates.length).toBeGreaterThan(0);
    for (const c of res.candidates) expect(looseChairs(m, c.furniture), c.name).toEqual([]);
  }, 30000);
});

describe('chairs in a building fit-out', () => {
  it('an office floor: every chair in every room is at a desk or table, or against a wall', async () => {
    const { programmeFromSentence, shellForArea } = await import('../building/sentence');
    const { rectShell } = await import('../building/partition');
    const { planBuildingAsync } = await import('../building/planAsync');
    const { toSpaceModel } = await import('../building/assemble');
    const { furnishBuilding } = await import('../building/furnish');
    const s = programmeFromSentence('an office floor for 12 people');
    const { w, d } = shellForArea(s.areaM2);
    const plans = await planBuildingAsync(rectShell(w, d), [{ wallIndex: 2, offsetM: w / 2 }], [], s.programme, { count: 1, seed: 1 });
    expect(plans.length).toBeGreaterThan(0);
    const m = toSpaceModel(plans[0], undefined, { now: 0 });
    resetStore(m);
    const res = await furnishBuilding(st().model, {}, { parallel: 2, timeBudgetMs: 700 });
    expect(seats(res.furniture).length).toBeGreaterThan(0);
    expect(looseChairs(st().model, res.furniture)).toEqual([]);
  }, 60000);
});
