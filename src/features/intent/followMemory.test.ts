import { describe, expect, it, vi } from 'vitest';
import { applyOp } from '../../core/ops';
import { sampleRoom } from '../../core/sample';
import type { Op, SpaceModel } from '../../core/types';
import { makeItem } from '../furniture/catalog';
import { followUpRoom, isFollowUp, resetFollowMemory } from './refine';

vi.mock('../../core/gemini', () => ({ hasGemini: () => false, gemini: async () => ({}), usage: { calls: 0, inputTokens: 0, outputTokens: 0 } }));

const apply = (m: SpaceModel, ops: Op[]) => ops.reduce(applyOp, m);
const base = (): SpaceModel => ({ ...sampleRoom(), furniture: [{ ...makeItem('desk', { x: 2.5, y: 3, rotation: 0 }), id: 'd1' }, { ...makeItem('bed', { x: 1, y: 2.5, rotation: 0 }), id: 'b1' }] });

describe('follow-up memory', () => {
  it('"it" means the desk from the previous sentence', async () => {
    resetFollowMemory();
    let m = base();
    const a = await followUpRoom(m, 'move the desk to the window');
    expect(a.ok).toBe(true);
    if (a.ok) m = apply(m, a.ops);
    const x0 = m.furniture.find((f) => f.id === 'd1')!.x;
    const b = await followUpRoom(m, 'move it a bit left');
    expect(b.ok).toBe(true);
    if (b.ok) m = apply(m, b.ops);
    const d = m.furniture.find((f) => f.id === 'd1')!;
    expect(d.x).toBeLessThan(x0);
    expect(m.furniture.find((f) => f.id === 'b1')!.x).toBeCloseTo(1, 5);
  });
  it('after a reset "it" is unknown', async () => {
    resetFollowMemory();
    const r = await followUpRoom(base(), 'move it a bit left');
    expect(r.ok && r.ops.length > 0).toBe(false);
  });
  it('room size in an empty room is one resize op', async () => {
    const m = { ...sampleRoom(), furniture: [] };
    expect(isFollowUp(m, 'make the room 5 by 6')).toBe(true);
    expect(isFollowUp(m, 'move it left')).toBe(false);
    const r = await followUpRoom(m, 'make the room 5 by 6');
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.ops).toHaveLength(1); expect(r.ops[0].type).toBe('RESIZE_SPACE'); }
  });
});
