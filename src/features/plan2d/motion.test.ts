import { describe, expect, it } from 'vitest';
import { appearScale, damp, dampBox, lerpPose, magnet, niceScale, pinchView, shortestAngle, snapAxis, staggerDelay, zoomAround } from './motion';

describe('motion helpers', () => {
  it('takes the short way round', () => {
    expect(shortestAngle(0.1, Math.PI * 2 - 0.1)).toBeCloseTo(-0.2);
    expect(shortestAngle(0, Math.PI / 2)).toBeCloseTo(Math.PI / 2);
  });
  it('damps to the target without overshoot and settles', () => {
    let s = { value: 0, velocity: 0 }; let max = 0;
    for (let i = 0; i < 40; i++) { s = damp(s.value, s.velocity, 10, 16); max = Math.max(max, s.value); }
    expect(max).toBeLessThanOrEqual(10.0001);
    expect(s.value).toBeGreaterThan(9.9);
  });
  it('damped box reports done at the target', () => {
    let b = { x: 0, y: 0, w: 10, h: 10 }, v = { x: 0, y: 0, w: 0, h: 0 }; const t = { x: 5, y: 5, w: 5, h: 5 };
    let done = false;
    for (let i = 0; i < 100 && !done; i++) { const r = dampBox(b, v, t, 16); b = r.box; v = r.vel; done = r.done; }
    expect(done).toBe(true); expect(b).toEqual(t);
  });
  it('pinch keeps the plan point under the fingers', () => {
    const start = { x: 0, y: 0, w: 10, h: 10 };
    const r = pinchView(start, 100, { x: 100, y: 100 }, 200, { x: 100, y: 100 }, { left: 0, top: 0 }, 500);
    expect(r.w).toBeCloseTo(5);
    // plan point at pixel 100 was 2 m; still 2 m after zoom.
    expect(r.x + 100 * (r.w / 500)).toBeCloseTo(2);
  });
  it('zoomAround keeps the focus fixed and clamps', () => {
    const r = zoomAround({ x: 0, y: 0, w: 10, h: 10 }, 0.5, 0.5, 0.5);
    expect(r).toEqual({ x: 2.5, y: 2.5, w: 5, h: 5 });
    expect(zoomAround({ x: 0, y: 0, w: 1, h: 1 }, 0, 0, 0.001).w).toBeCloseTo(0.4);
  });
  it('interpolates pose with delay and shortest rotation', () => {
    const a = { x: 0, y: 0, rotation: 0.1 }, b = { x: 10, y: 0, rotation: Math.PI * 2 - 0.1 };
    expect(lerpPose(a, b, 0, 350, 50)).toEqual(a);
    const end = lerpPose(a, b, 400, 350, 50);
    expect(end.x).toBeCloseTo(10); expect(Math.sin(end.rotation)).toBeCloseTo(Math.sin(-0.1));
    expect(lerpPose(a, b, 175, 350).rotation).toBeLessThan(0.1);
  });
  it('staggers within a cap', () => {
    expect(staggerDelay(0, 10)).toBe(0); expect(staggerDelay(50, 60)).toBe(140); expect(staggerDelay(3, 1)).toBe(0);
  });
  it('scales new items in', () => {
    expect(appearScale(0)).toBeCloseTo(0.85); expect(appearScale(500)).toBe(1);
  });
  it('snaps to the nearest line inside tolerance', () => {
    const r = snapAxis([1.0, 1.5, 2.0], [{ value: 1.52, kind: 'centre' }, { value: 5, kind: 'wall' }], 0.05);
    expect(r?.shift).toBeCloseTo(0.02); expect(r?.target.kind).toBe('centre');
    expect(snapAxis([0], [{ value: 1, kind: 'wall' }], 0.05)).toBeNull();
  });
  it('magnet pulls inside, releases outward', () => {
    expect(magnet(0.01, 0.1)).toBe(0.01); expect(magnet(0.1, 0.1)).toBe(0); expect(Math.abs(magnet(0.075, 0.1))).toBeCloseTo(0.0375);
  });
  it('picks a 1-2-5 scale bar', () => {
    expect(niceScale(1.4).m).toBe(1); expect(niceScale(3).m).toBe(2); expect(niceScale(7).m).toBe(5); expect(niceScale(0.3).label).toBe('20 cm');
  });
});
