import { describe, expect, it } from 'vitest';
import { approach, clampTarget, floorUnderReticle, orientationLook, slideMove, wishVelocity } from './walkMath';

describe('slideMove', () => {
  const wallAtX1 = (p: { x: number; y: number }) => p.x > 1;
  it('moves freely when clear', () => {
    expect(slideMove({ x: 0, y: 0 }, { x: 0.1, y: 0 }, () => false)).toEqual({ x: 0.1, y: 0 });
  });
  it('slides along a wall when walking into it at an angle', () => {
    const p = slideMove({ x: 0.95, y: 0 }, { x: 0.1, y: 0.1 }, wallAtX1);
    expect(p.x).toBeLessThanOrEqual(1);
    expect(p.y).toBeGreaterThan(0.05);
  });
  it('slides along a diagonal wall instead of sticking', () => {
    const diag = (p: { x: number; y: number }) => p.x + p.y > 1;
    const p = slideMove({ x: 0.49, y: 0.49 }, { x: 0.1, y: 0 }, diag);
    expect(diag(p)).toBe(false);
    expect(p.x).toBeGreaterThan(0.49);
  });
  it('stays put when boxed in', () => {
    expect(slideMove({ x: 0, y: 0 }, { x: 0.1, y: 0.1 }, () => true)).toEqual({ x: 0, y: 0 });
  });
});

describe('walk helpers', () => {
  it('eases toward a target regardless of frame rate', () => {
    const a = approach(0, 1, 10, 0.1);
    let b = 0; for (let i = 0; i < 10; i++) b = approach(b, 1, 10, 0.01);
    expect(a).toBeCloseTo(b, 6);
  });
  it('does not walk faster on diagonals', () => {
    const v = wishVelocity(1, 1, 0, 2);
    expect(Math.hypot(v.x, v.y)).toBeCloseTo(2, 6);
    const f = wishVelocity(1, 0, 0, 1);
    expect(f.y).toBeCloseTo(-1, 6);
  });
  it('finds the floor under the reticle only when looking down', () => {
    expect(floorUnderReticle({ x: 0, y: 0 }, 1.6, 0, 0)).toBeNull();
    const p = floorUnderReticle({ x: 0, y: 0 }, 1.6, 0, -Math.PI / 4)!;
    expect(p.x).toBeCloseTo(0, 6);
    expect(p.y).toBeCloseTo(-1.6, 6);
  });
  it('keeps the orbit target above the floor and near the building', () => {
    expect(clampTarget({ x: 20, y: -3, z: -9 }, { minX: 0, minY: 0, maxX: 4, maxY: 4 }, 2.5)).toEqual({ x: 5, y: 0, z: -1 });
  });
  it('maps phone tilt to pitch and turn to yaw', () => {
    const l = orientationLook(100, 90, 90, 0.5);
    expect(l.pitch).toBeCloseTo(0, 6);
    expect(l.yaw).toBeCloseTo(0.5 + (10 * Math.PI) / 180, 6);
  });
});
