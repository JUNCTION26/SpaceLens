import { describe, it, expect } from 'vitest';
import { area, centroid, pointInPolygon, isSimplePolygon, convexOverlap, polygonInside, itemCorners, doorSwingPolygon, parseWallId, openingSegment, v } from './geometry';
import { sampleRoom } from './sample';

const sq = [v(0, 0), v(2, 0), v(2, 2), v(0, 2)];
const L = [v(0, 0), v(4, 0), v(4, 2), v(2, 2), v(2, 4), v(0, 4)];
const rect = (x: number, y: number, w: number, d: number, rotation = 0) => itemCorners({ x, y, w, d, rotation });

describe('geometry', () => {
  it('area and centroid', () => {
    expect(area(sq)).toBeCloseTo(4);
    expect(area([...sq].reverse())).toBeCloseTo(4);
    expect(area(L)).toBeCloseTo(12);
    expect(centroid(sq)).toEqual({ x: 1, y: 1 });
    const c = centroid(L);
    expect(c.x).toBeCloseTo(5 / 3);
    expect(c.y).toBeCloseTo(5 / 3);
    expect(centroid([v(1, 1), v(2, 2), v(3, 3)])).toEqual({ x: 1, y: 1 });
  });

  it('pointInPolygon', () => {
    expect(pointInPolygon(v(1, 1), sq)).toBe(true);
    expect(pointInPolygon(v(3, 1), sq)).toBe(false);
    expect(pointInPolygon(v(3, 3), L)).toBe(false);
    expect(pointInPolygon(v(1, 3), L)).toBe(true);
  });

  it('isSimplePolygon', () => {
    expect(isSimplePolygon(sq)).toBe(true);
    expect(isSimplePolygon(L)).toBe(true);
    expect(isSimplePolygon([v(0, 0), v(2, 2), v(2, 0), v(0, 2)])).toBe(false);
    expect(isSimplePolygon([v(0, 0), v(1, 0)])).toBe(false);
    expect(isSimplePolygon([v(0, 0), v(1, 1), v(2, 2)])).toBe(false);
  });

  it('convexOverlap with rotated rects', () => {
    expect(convexOverlap(rect(0, 0, 2, 2), rect(1.5, 0, 2, 2))).toBeCloseTo(0.5);
    expect(convexOverlap(rect(0, 0, 2, 2), rect(2, 0, 2, 2))).toBe(0);
    expect(convexOverlap(rect(0, 0, 2, 2), rect(5, 0, 2, 2))).toBe(0);
    expect(convexOverlap(rect(0, 0, 2, 2), rect(2.3, 0, 2, 2, Math.PI / 4))).toBeCloseTo(1 + Math.SQRT2 - 2.3, 5);
    expect(convexOverlap(rect(0, 0, 2, 2), rect(2.5, 0, 2, 2, Math.PI / 4))).toBe(0);
    expect(convexOverlap(rect(0, 0, 2, 2), rect(1.3, 1.3, 2, 2, Math.PI / 4))).toBeGreaterThan(0);
  });

  it('polygonInside', () => {
    expect(polygonInside(rect(1, 1, 1, 1), sq)).toBe(true);
    expect(polygonInside(rect(2, 1, 1, 1), sq)).toBe(false);
    expect(polygonInside([v(1, 1), v(3, 1), v(3, 3), v(1, 3)], L)).toBe(false);
  });

  it('itemCorners with clearance and rotation', () => {
    const item = { x: 0, y: 0, w: 2, d: 1, rotation: 0, clearance: { front: 1, back: 0.5, left: 0.2, right: 0.3 } };
    expect(itemCorners(item)).toEqual([v(-1, -0.5), v(1, -0.5), v(1, 0.5), v(-1, 0.5)]);
    const c = itemCorners(item, true);
    expect(c[0].x).toBeCloseTo(-1.2); expect(c[0].y).toBeCloseTo(-1);
    expect(c[2].x).toBeCloseTo(1.3); expect(c[2].y).toBeCloseTo(1.5);
    const r = itemCorners({ ...item, rotation: Math.PI / 2, x: 5, y: 5 });
    expect(r[0].x).toBeCloseTo(5.5); expect(r[0].y).toBeCloseTo(4);
    expect(itemCorners(item, false, 3)[2].y).toBeCloseTo(1.5);
  });

  it('doorSwingPolygon side', () => {
    const m = sampleRoom(); const s = m.spaces[0]; const door = m.openings[0];
    const pin = doorSwingPolygon(s, door)!;
    expect(pin).toHaveLength(4);
    expect(pin[2].y).toBeCloseTo(3.4);
    expect(pin[3].y).toBeCloseTo(3.4);
    const pout = doorSwingPolygon(s, { ...door, swing: 'out' })!;
    expect(pout[2].y).toBeCloseTo(5.0);
    expect(doorSwingPolygon(s, { ...door, swing: 'none' })).toBeNull();
    expect(doorSwingPolygon(s, m.openings[1])).toBeNull();
    expect(openingSegment(s, door).c.x).toBeCloseTo(0.6);
  });

  it('parseWallId', () => {
    expect(parseWallId('s1:2')).toEqual({ spaceId: 's1', wallIndex: 2 });
    expect(parseWallId('a:b:3')).toEqual({ spaceId: 'a:b', wallIndex: 3 });
    expect(parseWallId('nocolon')).toBeNull();
    expect(parseWallId('s1:x')).toBeNull();
  });
});
