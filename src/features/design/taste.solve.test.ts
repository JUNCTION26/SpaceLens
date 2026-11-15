import { describe, expect, it } from 'vitest';
import { makeItem } from '../furniture/catalog';
import { opening, rect, reqs, room } from '../referee/fixtures';
import { buildProfile } from '../taste/profile';
import type { TasteProfile } from '../taste/profile';
import { defaultProgram } from './program';
import { solveProgram } from './solve';

const at = (id: string, key: string) => ({ ...makeItem(id, { x: 2, y: 2, rotation: 0 }), id: key });
const profile = (hug: number): TasteProfile => {
  const p = buildProfile([]);
  return { ...p, confidence: 1, traits: { ...p.traits, hug: { v: hug, c: 1 } } };
};

describe('taste weights steer the solver', () => {
  it('a wall-hugging profile changes the winning layout in a simple room', async () => {
    const m = room(rect(5, 4), [opening('door', 'door', 0, 1, 0.9, 'in'), opening('win', 'window', 2, 2.5, 1.2)]);
    const items = [at('desk', 'd'), at('office-chair', 'c'), at('bookshelf', 'b'), at('armchair', 'a')];
    const req = reqs({ minRouteWidthM: 0.8, routeTargets: [{ kind: 'window' }] });
    const run = (taste: TasteProfile | null) => solveProgram(m, items, defaultProgram(m, items, req), { seed: 5, req, taste });
    const hug = await run(profile(1)), float = await run(profile(0));
    const key = (r: Awaited<ReturnType<typeof run>>) => r.candidates[0].furniture.map((f) => `${f.id}:${f.x.toFixed(2)},${f.y.toFixed(2)},${f.rotation.toFixed(2)}`).join('|');
    expect(hug.candidates.length).toBeGreaterThan(0);
    expect(key(hug)).not.toBe(key(float));
    // Deterministic per seed.
    expect(key(await run(profile(1)))).toBe(key(hug));
  }, 120000);
});
