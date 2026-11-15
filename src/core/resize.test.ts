import { describe, expect, it } from 'vitest';
import { applyOp, resizeSpace } from './ops';
import { bounds, area, pointInPolygon, wallLength } from './geometry';
import { sampleRoom } from './sample';

describe('resizeSpace', () => {
  it('3.4 x 4.2 to 5 x 6 keeps the door on its wall and the desk inside', () => {
    const m = sampleRoom();
    const r = resizeSpace(m, 's1', { widthM: 5, depthM: 6 }).model;
    const b = bounds(r.spaces[0].polygon);
    expect(b.minX).toBeCloseTo(0); expect(b.minY).toBeCloseTo(0);
    expect(b.w).toBeCloseTo(5); expect(b.h).toBeCloseTo(6);
    const door = r.openings.find((o) => o.id === 'door1')!;
    expect(door.wallIndex).toBe(2);
    expect(door.widthM).toBe(0.8);
    expect(door.offsetM - 0.4).toBeGreaterThanOrEqual(-1e-9);
    expect(door.offsetM + 0.4).toBeLessThanOrEqual(wallLength(r.spaces[0], 2) + 1e-9);
    const desk = r.furniture[0], old = m.furniture[0];
    expect(desk.w).toBe(old.w); expect(desk.d).toBe(old.d);
    expect(pointInPolygon({ x: desk.x, y: desk.y }, r.spaces[0].polygon)).toBe(true);
  });
  it('clamps an opening that no longer fits', () => {
    const m = sampleRoom();
    const r = resizeSpace(m, 's1', { widthM: 1 }).model;
    const w = wallLength(r.spaces[0], 0);
    const win = r.openings.find((o) => o.id === 'win1')!;
    expect(win.offsetM).toBeCloseTo(w / 2);
  });
  it('scales an L-shape so its bounding box is the request', () => {
    const m = sampleRoom();
    m.spaces[0].polygon = [{ x: 1, y: 1 }, { x: 5, y: 1 }, { x: 5, y: 3 }, { x: 3, y: 3 }, { x: 3, y: 5 }, { x: 1, y: 5 }];
    m.spaces[0].walls = m.spaces[0].polygon.map(() => ({ ...m.spaces[0].walls[0] }));
    m.openings = []; m.furniture = [];
    const r = resizeSpace(m, 's1', { widthM: 8, depthM: 6 }).model;
    const b = bounds(r.spaces[0].polygon);
    expect([b.minX, b.minY, b.w, b.h]).toEqual([1, 1, 8, 6].map((n) => expect.closeTo(n)));
    expect(area(r.spaces[0].polygon)).toBeCloseTo(12 * 2 * 1.5);
  });
  it('height only changes the ceiling', () => {
    const m = sampleRoom();
    const r = resizeSpace(m, 's1', { heightM: 2.7 }).model;
    expect(r.ceilingM).toBe(2.7);
    expect(r.spaces[0].polygon).toEqual(m.spaces[0].polygon);
    expect(r.furniture).toEqual(m.furniture);
  });
  it('warns on overlap with another room without moving it', () => {
    const m = sampleRoom();
    m.spaces.push({ ...m.spaces[0], id: 's2', name: 'Hall', polygon: [{ x: 3.6, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 4 }, { x: 3.6, y: 4 }] });
    const r = resizeSpace(m, 's1', { widthM: 5 });
    expect(r.warning).toMatch(/Hall/);
    expect(r.model.spaces[1].polygon).toEqual(m.spaces[1].polygon);
  });
  it('is one op through applyOp', () => {
    const m = sampleRoom();
    const r = applyOp(m, { type: 'RESIZE_SPACE', spaceId: 's1', widthM: 5, depthM: 6, heightM: 2.7 });
    expect(r.version).toBe(m.version + 1);
    expect(bounds(r.spaces[0].polygon).w).toBeCloseTo(5);
    expect(r.ceilingM).toBe(2.7);
  });
});
