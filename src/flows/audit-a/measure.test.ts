// Space > Measure: each control in the panel, driven through the same functions the panel calls.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { area, bounds } from '../../core/geometry';
import { sampleRoom } from '../../core/sample';
import type { RoomDraft } from '../../features/capture/build';
import { buildModel } from '../../features/capture/build';
import { parseSize } from '../../features/capture/SizeRow';
import { outside, resetStore, st } from './lite';

// No key and no server: the app's offline path.
vi.stubEnv('VITE_API_BASE', '');
vi.stubGlobal('fetch', () => Promise.reject(new TypeError('offline')));

/** The draft the Draw form hands to the panel for a W x D rectangle with one door and one window (cm). */
function rectDraft(Wcm: number, Dcm: number): RoomDraft {
  const W = Wcm / 100, D = Dcm / 100;
  const polygon = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: D }, { x: 0, y: D }];
  return {
    polygon,
    walls: polygon.map(() => ({ thicknessM: 0.12, sourceKind: 'user-measured' as const, status: 'verified' as const })),
    openings: [
      { id: 'door-1', kind: 'door', wallIndex: 0, offsetM: 0.6, widthM: 0.8, heightM: 2, sillM: 0, swing: 'in', hinge: 'start', sourceKind: 'user-measured', status: 'verified' },
      { id: 'win-1', kind: 'window', wallIndex: 2, offsetM: 1.5, widthM: 1.2, heightM: 1.2, sillM: 0.9, swing: 'none', hinge: 'start', sourceKind: 'user-measured', status: 'verified' },
    ],
    measurements: [], evidence: [],
  };
}

/** SizeRow: what Enter/blur on a size field does. */
function typeSize(field: 0 | 1 | 2, raw: string) {
  const nums = parseSize(raw);
  if (!nums) return false;
  const out: (number | undefined)[] = [undefined, undefined, undefined];
  nums.forEach((n, k) => { out[field + k] = n; });
  const space = st().model.spaces[0];
  st().dispatch({ type: 'RESIZE_SPACE', spaceId: space.id, widthM: out[0], depthM: out[1], heightM: out[2] });
  return true;
}

describe('Measure', () => {
  beforeEach(() => resetStore(sampleRoom()));

  it('typing "5x6" in W resizes the room to 5 by 6 m', () => {
    expect(typeSize(0, '5x6')).toBe(true);
    const b = bounds(st().model.spaces[0].polygon);
    expect(b.w).toBeCloseTo(5, 2);
    expect(b.h).toBeCloseTo(6, 2);
  });

  it('typing a depth alone changes only the depth; a comma decimal works', () => {
    const w0 = bounds(st().model.spaces[0].polygon).w;
    typeSize(1, '3,8');
    const b = bounds(st().model.spaces[0].polygon);
    expect(b.w).toBeCloseTo(w0, 2);
    expect(b.h).toBeCloseTo(3.8, 2);
  });

  it('typing a height sets the ceiling', () => {
    typeSize(2, '2.7');
    expect(st().model.ceilingM).toBeCloseTo(2.7, 2);
  });

  it('a bad size is refused and leaves the room unchanged', () => {
    const before = st().model.spaces[0].polygon;
    expect(typeSize(0, 'abc')).toBe(false);
    expect(typeSize(0, '-2')).toBe(false);
    expect(st().model.spaces[0].polygon).toEqual(before);
  });

  it('a smaller room keeps every piece inside', () => {
    typeSize(0, '3x3.5');
    expect(outside(st().model)).toEqual([]);
  });

  it('Draw > Create room builds a 4 x 3 m room with its door and window', () => {
    const next = buildModel([rectDraft(400, 300)], { name: 'My room', ceilingM: 2.5, sourceLabel: 'Measured by hand' });
    st().dispatch({ type: 'REPLACE_MODEL', model: next });
    const m = st().model;
    expect(m.spaces).toHaveLength(1);
    expect(area(m.spaces[0].polygon)).toBeCloseTo(12, 2);
    expect(m.openings.map((o) => o.kind).sort()).toEqual(['door', 'window']);
    expect(m.ceilingM).toBe(2.5);
  });

  it('Draw with "New room" ticked adds a second room beside the first', () => {
    const first = buildModel([rectDraft(400, 300)], { name: 'My room', ceilingM: 2.5, sourceLabel: 'Measured by hand' });
    st().dispatch({ type: 'REPLACE_MODEL', model: first });
    const next = buildModel([rectDraft(300, 300)], { name: 'My room', ceilingM: 2.5, sourceLabel: 'Measured by hand', keep: st().model });
    st().dispatch({ type: 'REPLACE_MODEL', model: next });
    const m = st().model;
    expect(m.spaces).toHaveLength(2);
    const [a, b] = m.spaces.map((s) => bounds(s.polygon));
    expect(b.minX).toBeGreaterThanOrEqual(a.maxX);
  });

  it('Design this room switches to Design', () => {
    st().setMode('design');
    expect(st().mode).toBe('design');
  });
});
