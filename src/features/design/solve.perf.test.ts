import { describe, expect, it } from 'vitest';
import { makeItem } from '../furniture/catalog';
import { opening, rect, reqs, room } from '../referee/fixtures';
import { defaultProgram } from './program';
import { solveProgram } from './solve';

const at = (id: string, key: string) => ({ ...makeItem(id, { x: 1, y: 1, rotation: 0 }), id: key });

describe('solveProgram speed', () => {
  it('lays out a waiting room with eight identical chairs quickly', async () => {
    const m = room(rect(4, 5), [opening('door', 'door', 2, 2, 0.9, 'in'), opening('win', 'window', 0, 2, 1.2)]);
    const items = [
      ...Array.from({ length: 8 }, (_, i) => at('waiting-chair', `c${i}`)),
      at('reception-desk', 'desk'), at('coffee-table', 'low'), at('plant', 'p1'), at('plant', 'p2'),
    ];
    const req = reqs({ routeTargets: [{ kind: 'window' }], minRouteWidthM: 0.9 });
    const t = Date.now();
    const res = await solveProgram(m, items, defaultProgram(m, items, req), { seed: 3, req });
    const ms = Date.now() - t;
    console.log('waiting room ms', ms, 'candidates', res.candidates.length);
    expect(ms).toBeLessThan(5000);
  }, 200000);
});
