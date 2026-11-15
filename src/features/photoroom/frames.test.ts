import { describe, expect, it } from 'vitest';
import { evenPick, fitSize, frameTimes } from './frames';

describe('video frames', () => {
  it('spreads five times evenly inside the clip', () => {
    expect(frameTimes(10)).toEqual([1, 3, 5, 7, 9]);
    const t = frameTimes(7.3);
    expect(t).toHaveLength(5);
    expect(t[0]).toBeGreaterThan(0);
    expect(t[4]).toBeLessThan(7.3);
    expect(t.every((x, i) => i === 0 || x > t[i - 1])).toBe(true);
  });
  it('handles bad input', () => {
    expect(frameTimes(0)).toEqual([]);
    expect(frameTimes(NaN)).toEqual([]);
    expect(frameTimes(Infinity)).toEqual([]);
    expect(frameTimes(4, 1)).toEqual([2]);
    expect(frameTimes(4, 0)).toEqual([]);
  });
  it('thins a list evenly', () => {
    expect(evenPick([1, 2, 3], 6)).toEqual([1, 2, 3]);
    expect(evenPick([1, 2, 3, 4, 5, 6, 7, 8], 4)).toEqual([2, 4, 6, 8]);
  });
  it('caps the long side at 1024 without enlarging', () => {
    expect(fitSize(1920, 1080)).toEqual({ w: 1024, h: 576 });
    expect(fitSize(1080, 1920)).toEqual({ w: 576, h: 1024 });
    expect(fitSize(640, 480)).toEqual({ w: 640, h: 480 });
  });
});
