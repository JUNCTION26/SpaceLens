import { describe, it, expect, vi } from 'vitest';
import { tap, idle, distance, measured, formatMetres, midpoint, setMeasureCallback, reportMeasured, isFreeFloor } from './measure';

describe('measure', () => {
  it('distance for known points', () => {
    expect(distance({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 })).toBe(5);
    expect(distance({ x: 1, y: 1, z: 1 }, { x: 1, y: 1, z: 3.5 })).toBeCloseTo(2.5);
    expect(distance({ x: 0, y: 0, z: 0 }, { x: 2, y: 3, z: 6 })).toBe(7);
  });
  it('two taps make one measurement, a third starts a new one', () => {
    let s = tap(idle, { x: 0, y: 0, z: 0 });
    expect(s.phase).toBe('first');
    expect(measured(s)).toBeNull();
    s = tap(s, { x: 0, y: 0, z: 2 });
    expect(s.phase).toBe('done');
    expect(measured(s)).toBe(2);
    s = tap(s, { x: 5, y: 0, z: 5 });
    expect(s).toEqual({ phase: 'first', a: { x: 5, y: 0, z: 5 } });
    expect(measured(s)).toBeNull();
  });
  it('formats and finds midpoint', () => {
    expect(formatMetres(3.456)).toBe('3.46 m');
    expect(midpoint({ x: 0, y: 0, z: 0 }, { x: 2, y: 4, z: 6 })).toEqual({ x: 1, y: 2, z: 3 });
  });
  it('callback receives only valid lengths', () => {
    const cb = vi.fn();
    const off = setMeasureCallback(cb);
    reportMeasured(2.5); reportMeasured(NaN); reportMeasured(0);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(2.5);
    off(); reportMeasured(1);
    expect(cb).toHaveBeenCalledTimes(1);
  });
  it('free floor needs a room and no furniture', () => {
    const inRoom = (p: { x: number; y: number }, r: number) => p.x >= 0 && p.x <= r && p.y >= 0 && p.y <= r;
    const onItem = (p: { x: number; y: number }, f: number) => Math.abs(p.x - f) < 0.5 && Math.abs(p.y - f) < 0.5;
    expect(isFreeFloor({ x: 1, y: 1 }, [4], [], inRoom, onItem)).toBe(true);
    expect(isFreeFloor({ x: 5, y: 1 }, [4], [], inRoom, onItem)).toBe(false);
    expect(isFreeFloor({ x: 2, y: 2 }, [4], [2], inRoom, onItem)).toBe(false);
  });
});
