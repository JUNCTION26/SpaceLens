import { describe, expect, it } from 'vitest';
import { buildPhotoRoom, itemFromPhoto, offsetAlong, parseEstimate, rescaleRoom } from './room';

const raw = {
  roomType: 'living room', cues: ['door 2.0 m'], widthM: 4, depthM: 5, ceilingM: 2.6, confidence: 0.6,
  openings: [{ kind: 'door', wall: 'left', at: 0.2, widthM: 0.9, heightM: 2.05, sillM: 0 }, { kind: 'window', wall: 'back', at: 0.5, widthM: 1.4, heightM: 1.3, sillM: 0.9 }],
  furniture: [
    { label: 'grey sofa', kind: 'sofa', widthM: 2.1, depthM: 0.9, heightM: 0.8, x: 0.5, y: 0.1, against: 'back', facing: 'camera', color: '#808080', material: 'fabric' },
    { label: 'tall cabinet', kind: 'cabinet', widthM: 1, depthM: 0.4, heightM: 1.8, x: 0.95, y: 0.5, against: 'right', facing: 'left', color: '#ffffff', material: 'wood' },
    { label: 'piano', kind: 'other', widthM: 1.5, depthM: 0.6, heightM: 1.2, x: 0.2, y: 0.6, against: 'none', facing: 'right', color: 'black', material: 'wood' },
  ],
};

describe('several photos', () => {
  it('reads per-wall confidence and widens the tolerance of unseen walls', () => {
    const e = parseEstimate({ ...raw, confidence: 0.8, photoCount: 3, wallConfidence: { back: 0.9, left: 0.2, right: 'x' } });
    expect(e.wallConfidence).toEqual({ back: 0.9, right: 0.8, front: 0.8, left: 0.2 });
    expect(e.photoCount).toBe(3);
    const m = buildPhotoRoom(e);
    const tol = (label: string) => m.measurements.find((x) => x.label === label)!.toleranceM!;
    expect(tol('Left wall')).toBeGreaterThan(tol('Back wall'));
    expect(m.evidence[0].label).toBe('Room photos (3)');
  });
  it('falls back to overall confidence', () => {
    expect(parseEstimate(raw).wallConfidence.left).toBe(0.6);
    expect(parseEstimate(raw).photoCount).toBe(1);
  });
});

describe('photo room', () => {
  it('cleans a raw answer', () => {
    const e = parseEstimate({ widthM: 99, depthM: 'x', confidence: 3, openings: [{ kind: 'hatch', wall: 'up', at: 2 }], furniture: [{ kind: 'spaceship', color: 'red', heightM: 9 }] });
    expect(e.widthM).toBe(15);
    expect(e.depthM).toBe(4);
    expect(e.confidence).toBe(1);
    expect(e.openings[0]).toMatchObject({ kind: 'window', wall: 'back', at: 1 });
    expect(e.furniture[0]).toMatchObject({ kind: 'other', color: '', heightM: 2.6 });
    expect(parseEstimate(null).furniture).toEqual([]);
  });

  it('maps wall fractions to plan offsets', () => {
    expect(offsetAlong('back', 0.25, 4, 5)).toBe(1);
    expect(offsetAlong('left', 0.2, 4, 5)).toBe(1);
    expect(offsetAlong('right', 0.2, 4, 5)).toBe(4);
    expect(offsetAlong('front', 0.25, 4, 5)).toBe(3);
  });

  it('builds an estimated, photo-inferred room with furniture against its walls', () => {
    const m = buildPhotoRoom(parseEstimate(raw));
    const s = m.spaces[0];
    expect(s.polygon).toEqual([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 5 }, { x: 0, y: 5 }]);
    expect(s.walls.every((w) => w.sourceKind === 'photo-inferred' && w.status === 'estimated')).toBe(true);
    expect(m.measurements.every((x) => x.status !== 'verified')).toBe(true);
    const door = m.openings.find((o) => o.kind === 'door')!;
    expect(door.wallIndex).toBe(3);
    expect(door.offsetM).toBe(1);
    const [sofa, cab, piano] = m.furniture;
    expect(sofa).toMatchObject({ catalogId: 'sofa-3', y: 0.45, x: 2, rotation: 0, owned: true, sourceKind: 'photo-inferred', color: '#808080' });
    expect(cab.x).toBeCloseTo(3.8);
    expect(cab.rotation).toBeCloseTo(Math.PI / 2);
    expect(piano.catalogId).toBe('custom');
  });

  it('keeps a piece inside the room when its estimate pokes out', () => {
    const it2 = itemFromPhoto({ ...parseEstimate(raw).furniture[0], against: 'none', x: 0, y: 1 }, 4, 5);
    expect(it2.x).toBeCloseTo(1.05);
    expect(it2.y).toBeCloseTo(4.55);
  });

  it('rescales everything from one measured wall', () => {
    const m = buildPhotoRoom(parseEstimate(raw));
    const r = rescaleRoom(m, m.spaces[0].id, 3, 6);
    expect(r.spaces[0].polygon[2]).toEqual({ x: 4.8, y: 6 });
    expect(r.ceilingM).toBeCloseTo(3.12);
    expect(r.furniture[0].w).toBeCloseTo(2.52);
    expect(r.spaces[0].walls[3]).toMatchObject({ sourceKind: 'user-measured', status: 'verified' });
    expect(r.spaces[0].walls[0].status).toBe('estimated');
    expect(r.measurements.filter((x) => x.status === 'verified')).toHaveLength(1);
    expect(rescaleRoom(m, 'nope', 0, 3)).toBe(m);
  });
});
