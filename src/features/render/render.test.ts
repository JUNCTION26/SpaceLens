import { describe, expect, it } from 'vitest';
import { buildPrompt, isBlankFrame, describeItem, cacheKey, placeWords } from './prompt';
import type { FurnitureItem, SpaceModel } from '../../core/types';

const wall = { thicknessM: 0.1, sourceKind: 'manual' as const, status: 'verified' as const };
const model: SpaceModel = {
  id: 'm', name: 'Flat', version: 1, units: 'm', ceilingM: 2.5, sourceLabel: 'x',
  spaces: [{ id: 's', name: 'Living room', polygon: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }], walls: [wall, wall, wall, wall] }],
  openings: [{ id: 'w', kind: 'window', spaceId: 's', wallIndex: 0, offsetM: 2, widthM: 1, heightM: 1, sillM: 0.9, swing: 'none', hinge: 'start', sourceKind: 'manual', status: 'verified' }],
  furniture: [], measurements: [], evidence: [],
};
const sofa = { id: 'f', name: 'Sofa', material: 'linen', color: '#808080', w: 2.1, d: 0.9, h: 0.8 } as FurnitureItem;

describe('render prompt', () => {
  it('includes room, item, style and strict rules', () => {
    const p = buildPrompt({ model, furniture: [sofa], style: 'evening', requirements: { style: 'Scandinavian', purpose: 'living' } });
    expect(p).toContain('400 cm by 300 cm');
    expect(p).toContain('Sofa (linen, grey #808080, 210 cm wide, 90 cm deep, 80 cm high)');
    expect(p).toContain('Scandinavian');
    expect(p).toContain('warm evening light');
    expect(p).toContain('1 window');
    expect(p).toContain('No people');
    expect(p).toContain('every object position');
  });
  it('says so when there is no furniture', () => {
    expect(buildPrompt({ model, furniture: [], style: 'daylight' })).toContain('show no furniture');
  });
  it('describes an item without a material', () => {
    expect(describeItem({ ...sofa, material: undefined })).toBe('Sofa (grey #808080, 210 cm wide, 90 cm deep, 80 cm high)');
  });
});

describe('blank frame check', () => {
  const fill = (r: number, g: number, b: number, a: number, n = 1000) => {
    const d = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) d.set([r, g, b, a], i * 4);
    return d;
  };
  it('flags transparent and flat frames', () => {
    expect(isBlankFrame(fill(0, 0, 0, 0))).toBe(true);
    expect(isBlankFrame(fill(240, 240, 240, 255))).toBe(true);
    expect(isBlankFrame(new Uint8ClampedArray(0))).toBe(true);
  });
  it('passes a frame with content', () => {
    const d = fill(240, 240, 240, 255);
    for (let i = 0; i < 500; i++) d.set([30, 40, 50, 255], i * 4);
    expect(isBlankFrame(d)).toBe(false);
  });
});

describe('prompt fidelity', () => {
  const at = (id: string, name: string, x: number, y: number) => ({ ...sofa, id, name, x, y }) as FurnitureItem;
  it('names every item once and states the count', () => {
    const items = [at('a', 'Sofa', 0.4, 1.5), at('b', 'Table', 2, 1.5), at('c', 'Lamp', 3.8, 2.8)];
    const p = buildPrompt({ model, furniture: items, style: 'bold' });
    expect(p).toContain('exactly 3 items');
    expect(p).toContain('count and the positions must not change');
    for (const n of ['Sofa (', 'Table (', 'Lamp (']) expect(p.split(n).length - 1).toBe(1);
    expect(p).toContain('against the left wall');
    expect(p).toContain('in the middle of the room');
    expect(p).toContain('front right corner');
    expect(p).toContain('window 100 cm wide');
  });
  it('places items in words', () => {
    expect(placeWords(at('a', 'Sofa', 3.9, 1.5), model.spaces[0])).toBe('against the right wall');
  });
});

describe('cache key', () => {
  it('is stable and changes with style, camera or furniture', () => {
    const k = cacheKey(model, [sofa], 'cam1', 'daylight');
    expect(cacheKey(model, [sofa], 'cam1', 'daylight')).toBe(k);
    expect(cacheKey(model, [sofa], 'cam1', 'evening')).not.toBe(k);
    expect(cacheKey(model, [sofa], 'cam2', 'daylight')).not.toBe(k);
    expect(cacheKey(model, [{ ...sofa, x: 1 }], 'cam1', 'daylight')).not.toBe(k);
    expect(cacheKey({ ...model, version: 2 }, [sofa], 'cam1', 'daylight')).not.toBe(k);
  });
});
