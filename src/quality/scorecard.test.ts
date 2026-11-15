// Honest measurement of offline furnishing. A floor the current code misses is marked it.fails
// (it turns into a failure the day the code meets the floor, which is the cue to drop the mark).
import { beforeAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { CASES, runCase, scorecardMarkdown, scorecardOn, type Scorecard } from './scorecard';

const cards = new Map<string, Scorecard>();
const normal = CASES.filter((c) => c.normal);

beforeAll(async () => {
  for (const c of CASES) { cards.set(c.name, (await runCase(c)).card); process.stderr.write(`case ${c.name} ${cards.get(c.name)!.ms}ms
`); }
  if (scorecardOn) {
    const all = CASES.map((c) => cards.get(c.name)!);
    writeFileSync(`${process.env.TEMP}/spacelens-shots/BOARD/scorecard.md`, scorecardMarkdown(all));
  }
}, 240_000);

describe('furnishing scorecard', () => {
  for (const c of normal) {
    describe(c.name, () => {
      it('has no overlaps', () => { expect(cards.get(c.name)!.overlaps).toEqual([]); });
      it('keeps every piece inside the room', () => { expect(cards.get(c.name)!.outside).toEqual([]); });
      it('leaves the door swing free', () => { expect(cards.get(c.name)!.doorBlocked).toBe(false); });
      it('keeps a walkway of 60 cm to every seat and bed', () => {
        const w = cards.get(c.name)!.walkwayM;
        if (w !== null) expect(w).toBeGreaterThanOrEqual(0.6);
      });
      it('seats every chair within 70 cm of a table, facing it', () => { const v = cards.get(c.name)!.chairFacing; if (v !== null) expect(v).toBe(1); });
      it('puts every bed headboard on a wall', () => { const v = cards.get(c.name)!.headboardFraction; if (v !== null) expect(v).toBe(1); });
      it('has at least 6 items', () => { expect(cards.get(c.name)!.items).toBeGreaterThanOrEqual(6); });
    });
  }
  it('names the cat in the room for Gerard', () => { expect(cards.get('cat')!.themeHit).toBe(true); });
  it('degrades the impossible 2x2 room gracefully', () => {
    const s = cards.get('impossible')!;
    expect(s.overlaps).toEqual([]);
    expect(s.outside).toEqual([]);
    expect(s.infeasibility).not.toBeNull();
  });
});
