import { describe, expect, it } from 'vitest';
import type { MoveInPlan, MoveItem, Verdict } from './plan';
import { buildMoveTimeline, frameAt, summarize } from './timeline';

const mi = (id: string, verdict: Verdict, flat = false): MoveItem => ({
  id, name: id, verdict, tight: 'Entrance', tightId: 'd', steps: [], roomId: 'r', depth: 0, flat,
});
const plan: MoveInPlan = { items: [mi('a', 'fits'), mi('b', 'wont'), mi('c', 'tilt'), mi('d', 'assemble')] };

describe('move timeline', () => {
  it('keeps the delivery order and total duration', () => {
    const tl = buildMoveTimeline(plan);
    expect(tl.slots.map((s) => s.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(tl.total).toBeCloseTo(4.8);
    expect(tl.slots[2].start).toBeCloseTo(2.4);
  });
  it('blocked items never enter', () => {
    const tl = buildMoveTimeline(plan);
    expect(tl.slots[1].enters).toBe(false);
    const f = frameAt(tl, tl.total);
    expect(f.placed).toEqual(['a', 'c', 'd']);
    expect(f.stopped).toEqual(['b']);
    expect(f.done).toBe(true);
  });
  it('frames follow time', () => {
    const tl = buildMoveTimeline(plan);
    const f = frameAt(tl, 1.8);
    expect(f.slot?.id).toBe('b');
    expect(f.p).toBeCloseTo(0.5);
    expect(f.placed).toEqual(['a']);
    expect(frameAt(tl, 0).placed).toEqual([]);
  });
  it('marks tilt and flat-pack slots', () => {
    const tl = buildMoveTimeline(plan);
    expect(tl.slots[2].tilt).toBe(true);
    expect(tl.slots[3].flatPack).toBe(true);
  });
  it('summarises counts and the widest item', () => {
    const s = summarize(plan, [{ id: 'a', w: 1, d: 1 }, { id: 'c', w: 2.2, d: 1 }]);
    expect(s).toMatchObject({ fits: 1, tilt: 1, assemble: 1, wont: 1 });
    expect(s.widest?.name).toBe('c');
  });
});
