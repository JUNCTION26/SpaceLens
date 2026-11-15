import { describe, expect, it } from 'vitest';
import { demoBuilding } from './demo';
import { furnishBuilding } from './furnish';

describe('furnishing time', () => {
  it('a whole villa is furnished within 15 s on the default budget, with no room left failed', async () => {
    const model = demoBuilding('villa')!;
    const t0 = Date.now();
    const res = await furnishBuilding(model, {});
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(15000);
    expect(res.summary.ms).toBeLessThanOrEqual(ms);
    expect(res.rooms.filter((r) => r.status === 'failed').map((r) => r.name)).toEqual([]);
    expect(res.summary.roomsDone).toBeGreaterThanOrEqual(6);
  }, 60000);
});
