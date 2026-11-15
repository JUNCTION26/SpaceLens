import { describe, expect, it } from 'vitest';
import { revealOrder, revealRank } from './revealOrder';

const p = (category: string, w = 0.5, d = 0.5) => ({ category, w, d });

describe('revealOrder', () => {
  it('ranks anchors, dependents and decor', () => {
    expect(revealRank(p('bed'))).toBe(0);
    expect(revealRank(p('sofa'))).toBe(0);
    expect(revealRank(p('chair'))).toBe(1);
    expect(revealRank(p('nightstand'))).toBe(1);
    expect(revealRank(p('rug'))).toBe(2);
    expect(revealRank(p('lamp'))).toBe(2);
    expect(revealRank(p('wall-art'))).toBe(2);
  });
  it('places a bedroom bed, then nightstands, then decor', () => {
    const out = revealOrder([p('lamp'), p('rug', 1.6, 2.3), p('nightstand'), p('bed', 1.4, 2), p('nightstand')]);
    expect(out.map((x) => x.category)).toEqual(['bed', 'nightstand', 'nightstand', 'lamp', 'rug']);
  });
  it('puts bigger anchors first and is stable for ties', () => {
    const a = { ...p('desk', 1.4, 0.7), id: 'a' }, b = { ...p('desk', 1.4, 0.7), id: 'b' }, s = { ...p('sofa', 2.1, 0.9), id: 's' };
    expect(revealOrder([a, b, s]).map((x) => x.id)).toEqual(['s', 'a', 'b']);
  });
  it('does not mutate its input', () => {
    const input = [p('lamp'), p('bed')];
    revealOrder(input);
    expect(input[0].category).toBe('lamp');
  });
});
