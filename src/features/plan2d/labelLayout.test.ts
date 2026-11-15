import { describe, expect, it } from 'vitest';
import { boxesHit, chipBox, makePlacer, pickChips, placeRoomLabels, poleOfInaccessibility } from './labelLayout';

const sq = (x: number, y: number, w: number, h: number) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];

describe('label layout', () => {
  it('detects box collisions', () => {
    expect(boxesHit({ x0: 0, y0: 0, x1: 2, y1: 2 }, { x0: 1, y0: 1, x1: 3, y1: 3 })).toBe(true);
    expect(boxesHit({ x0: 0, y0: 0, x1: 1, y1: 1 }, { x0: 1, y0: 0, x1: 2, y1: 1 })).toBe(false);
  });
  it('places only non-colliding boxes', () => {
    const p = makePlacer();
    expect(p.place({ x0: 0, y0: 0, x1: 2, y1: 2 })).toBe(true);
    expect(p.place({ x0: 1, y0: 1, x1: 3, y1: 3 })).toBe(false);
    expect(p.place({ x0: 5, y0: 5, x1: 6, y1: 6 })).toBe(true);
  });
  it('finds the pole inside an L shape', () => {
    const L = [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 2 }, { x: 2, y: 2 }, { x: 2, y: 6 }, { x: 0, y: 6 }];
    const c = poleOfInaccessibility(L);
    expect(c.r).toBeGreaterThan(0.9);
    expect(c.x < 2 || c.y < 2).toBe(true);
  });
  it('skips labels that do not fit or collide, biggest first', () => {
    const rooms = [
      { id: 'big', name: 'Living', polygon: sq(0, 0, 6, 5), areaM2: 30 },
      { id: 'tiny', name: 'Storage room', polygon: sq(6, 0, 0.5, 0.5), areaM2: 0.25 },
    ];
    const { labels } = placeRoomLabels(rooms, 0.12);
    expect(labels.map((l) => l.id)).toEqual(['big']);
  });
  it('hides short and colliding chips', () => {
    const p = makePlacer();
    p.add({ x0: 0, y0: 0, x1: 1, y1: 1 });
    const shown = pickChips([
      { key: 'a', lengthM: 5, box: chipBox(0.5, 0.5, 1, 0.3, 0) },
      { key: 'b', lengthM: 5, box: chipBox(10, 10, 1, 0.3, 0) },
      { key: 'c', lengthM: 0.1, box: chipBox(20, 20, 1, 0.3, 0) },
    ], 100, p);
    expect([...shown]).toEqual(['b']);
  });
});
