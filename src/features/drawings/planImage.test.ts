import { describe, expect, it } from 'vitest';
import { buildFromRaw, closeGaps, factorForLength, mergeSharedWalls, parseLengthM, rescaleModel, scaleFromRaw, snapAxis, solveScale, type RawPlan } from './planImage';

const sq = (x: number, y: number, w: number, h: number) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];

describe('parseLengthM', () => {
  it('reads units', () => {
    expect(parseLengthM('3,50 m')).toBeCloseTo(3.5);
    expect(parseLengthM('350 cm')).toBeCloseTo(3.5);
    expect(parseLengthM('3500')).toBeCloseTo(3.5);
    expect(parseLengthM('4.2')).toBeCloseTo(4.2);
    expect(parseLengthM('abc')).toBeNull();
  });
});

describe('solveScale', () => {
  it('fits a clean set', () => {
    const s = solveScale([{ pxLen: 100, m: 2, weight: 1, kind: 'dimension' }, { pxLen: 200, m: 4.02, weight: 1, kind: 'dimension' }]);
    expect(s.mPerPx).toBeCloseTo(0.02, 3);
    expect(s.source).toBe('dimensions');
  });
  it('rejects an outlier', () => {
    const s = solveScale([
      { pxLen: 100, m: 2, weight: 1, kind: 'dimension' }, { pxLen: 150, m: 3, weight: 1, kind: 'dimension' },
      { pxLen: 200, m: 4, weight: 1, kind: 'dimension' }, { pxLen: 100, m: 9, weight: 1, kind: 'dimension' },
    ]);
    expect(s.mPerPx).toBeCloseTo(0.02, 4);
    expect(s.rejected).toBe(1);
  });
  it('is empty without hints', () => expect(solveScale([]).mPerPx).toBeNull());
});

const raw: RawPlan = {
  width: 1000, height: 800,
  rooms: [
    { name: 'Living', areaM2: 20, polygon: sq(100, 100, 400, 500) },
    { name: 'Bedroom', areaM2: 20, polygon: sq(504, 102, 400, 500) },
  ],
  openings: [{ kind: 'door', at: { x: 502, y: 300 }, widthPx: 40 }],
  dimensions: [],
};

describe('scaleFromRaw', () => {
  it('uses printed areas', () => {
    const s = scaleFromRaw(raw);
    expect(s.source).toBe('areas');
    expect(s.mPerPx).toBeCloseTo(0.01, 3);
  });
  it('uses dimensions first', () => {
    const s = scaleFromRaw({ ...raw, dimensions: [{ text: '4 m', a: { x: 100, y: 50 }, b: { x: 500, y: 50 } }] });
    expect(s.source).toBe('dimensions');
    expect(s.mPerPx).toBeCloseTo(0.01, 3);
  });
  it('falls back to a standard door', () => {
    const s = scaleFromRaw({ ...raw, rooms: raw.rooms.map((r) => ({ ...r, areaM2: undefined })) });
    expect(s.source).toBe('door');
    expect(s.mPerPx).toBeCloseTo(0.02, 4);
  });
  it('asks for a length when nothing is known', () => {
    const r = buildFromRaw({ ...raw, openings: [], rooms: raw.rooms.map((x) => ({ ...x, areaM2: undefined })) }, { name: 'a.png' });
    expect(r.report.needsLength).toBe(true);
    expect(r.model.spaces).toHaveLength(2);
  });
});

describe('geometry clean-up', () => {
  it('snaps near-axis edges', () => {
    const p = snapAxis([[{ x: 0, y: 0 }, { x: 5, y: 0.1 }, { x: 5.05, y: 4 }, { x: 0, y: 4 }]]);
    expect(p[0][0].y).toBe(p[0][1].y);
    expect(p[0][1].x).toBe(p[0][2].x);
  });
  it('leaves a diagonal alone', () => {
    const p = snapAxis([[{ x: 0, y: 0 }, { x: 4, y: 2 }, { x: 0, y: 4 }]]);
    expect(p[0][1]).toEqual({ x: 4, y: 2 });
  });
  it('merges a shared wall', () => {
    const [a, b] = mergeSharedWalls([sq(0, 0, 4, 5), sq(4.1, 0, 3, 5)], 0.3);
    expect(a[1].x).toBe(b[0].x);
    expect(a[2].x).toBe(b[3].x);
  });
  it('does not merge far walls', () => {
    const [a, b] = mergeSharedWalls([sq(0, 0, 4, 5), sq(6, 0, 3, 5)], 0.3);
    expect(a[1].x).toBe(4);
    expect(b[0].x).toBe(6);
  });
  it('closes small corner gaps', () => {
    const [a, b] = closeGaps([sq(0, 0, 4, 5), sq(4.1, 0.05, 3, 5)], 0.15);
    expect(a[1]).toEqual(b[0]);
    const [c, d] = closeGaps([sq(0, 0, 4, 5), sq(4.5, 0, 3, 5)], 0.15);
    expect(c[1]).not.toEqual(d[0]);
  });
});

describe('buildFromRaw', () => {
  it('meets shared walls exactly and places the door', () => {
    const { model, report } = buildFromRaw(raw, { name: 'plan.png', now: 1 });
    expect(report.ok).toBe(true);
    const [a, b] = model.spaces;
    expect(a.polygon[1].x).toBe(b.polygon[0].x);
    expect(model.openings).toHaveLength(1);
    expect(model.openings[0].widthM).toBeCloseTo(0.4, 1);
    expect(model.spaces[0].walls[0].status).toBe('estimated');
    expect(report.sizeM.w).toBeGreaterThan(7.9);
    expect(report.rooms[0].outline[0].x).toBeGreaterThan(0);
  });
  it('rescales to one known length', () => {
    const { model, report } = buildFromRaw(raw, { name: 'plan.png', now: 1 });
    const k = factorForLength(report.sizeM, 16)!;
    const m2 = rescaleModel(model, k);
    const xs = m2.spaces.flatMap((s) => s.polygon.map((v) => v.x));
    expect(Math.max(...xs)).toBeCloseTo(16, 1);
  });
  it('reports no rooms', () => expect(buildFromRaw({ ...raw, rooms: [] }, { name: 'x.png' }).report.ok).toBe(false));
});
