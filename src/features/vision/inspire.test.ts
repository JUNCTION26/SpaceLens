import { describe, expect, it } from 'vitest';
import { sampleRoom } from '../../core/sample';
import { makeItem } from '../furniture/catalog';
import { applyOp } from '../../core/ops';
import { assignRoles, extractPalette, fromHex, medianCut, roleColors, toHex } from './palette';
import { cleanReading, planInspiration, roleOf, styleFromPalette, type StyleReading } from './style';

function image(blocks: Array<[string, number]>): number[] {
  const out: number[] = [];
  for (const [hex, count] of blocks) { const [r, g, b] = fromHex(hex); for (let i = 0; i < count; i++) out.push(r, g, b, 255); }
  return out;
}
const dist = (a: string, b: string) => { const x = fromHex(a), y = fromHex(b); return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]); };

const IMG = image([['#e8e2d6', 600], ['#8b5a2b', 200], ['#2f3a44', 100], ['#c0392b', 60], ['#9aa0a6', 40]]);

describe('palette extraction', () => {
  it('returns the known colours with shares', () => {
    const cols = medianCut(IMG, 5);
    expect(cols).toHaveLength(5);
    for (const hex of ['#e8e2d6', '#8b5a2b', '#2f3a44', '#c0392b', '#9aa0a6']) {
      expect(Math.min(...cols.map((c) => dist(toHex(c.rgb), hex)))).toBeLessThan(8);
    }
    expect(cols[0].share).toBeCloseTo(0.6, 1);
  });
  it('ignores transparent pixels and handles empty input', () => {
    expect(medianCut([], 5)).toEqual([]);
    expect(medianCut([10, 10, 10, 0], 5)).toEqual([]);
  });
  it('a flat colour gives one swatch', () => {
    const sw = extractPalette(image([['#336699', 50]]), 5);
    expect(sw).toHaveLength(1);
    expect(dist(sw[0].hex, '#336699')).toBeLessThan(3);
  });
});

describe('role assignment', () => {
  const sw = extractPalette(IMG, 5);
  const hexOf = (r: string) => sw.find((s) => s.role === r)?.hex ?? '';
  it('gives each of the five colours its own role', () => {
    expect(new Set(sw.map((s) => s.role)).size).toBe(5);
  });
  it('wall is the big light area, accent the saturated one, wood the warm brown, metal the grey', () => {
    expect(dist(hexOf('wall'), '#e8e2d6')).toBeLessThan(8);
    expect(dist(hexOf('accent'), '#c0392b')).toBeLessThan(8);
    expect(dist(hexOf('wood'), '#8b5a2b')).toBeLessThan(8);
    expect(dist(hexOf('metal'), '#9aa0a6')).toBeLessThan(8);
  });
  it('fills every role even with two colours', () => {
    const rc = roleColors(assignRoles(medianCut(image([['#ffffff', 10], ['#222222', 10]]), 2)));
    for (const v of Object.values(rc)) expect(v).toMatch(/^#[0-9a-f]{6}$/);
  });
});

const READING: StyleReading = {
  style: 'Warm Nordic', woods: ['oak'], fabrics: ['linen'], metals: [], shapes: 'rounded', density: 0.3, lighting: 'warm',
  pieces: [{ type: 'armchair', color: '#a0522d' }, { type: 'plant', color: '#4f7d4a' }, { type: 'floor lamp', color: '#d9c9a3' }, { type: 'rug', color: '#b7a58f' }],
  decor: ['framed print'],
};

describe('apply to a small room', () => {
  const base = sampleRoom();
  const model = { ...base, furniture: [...base.furniture, makeItem('sofa-2', { x: 2.2, y: 3.4 }), makeItem('coffee-table', { x: 2.2, y: 2.2 }), makeItem('bookshelf', { x: 1.5, y: 0.3 })] };
  const sw = extractPalette(IMG, 5);
  it('strength 0 changes nothing', () => {
    const p = planInspiration(model, sw, READING, 0);
    expect(p.ops).toEqual([]);
    expect(p.items).toEqual(model.furniture);
  });
  it('subtle touches few items, full touches all and adds pieces and decor', () => {
    const lo = planInspiration(model, sw, READING, 0.25);
    const hi = planInspiration(model, sw, READING, 1);
    expect(lo.recoloured).toBeLessThan(hi.recoloured);
    expect(hi.recoloured).toBe(model.furniture.filter((f) => !f.locked).length);
    expect(lo.added).toBeLessThanOrEqual(1);
    expect(hi.added).toBeLessThanOrEqual(3);
    expect(hi.decor).toBeGreaterThan(lo.decor);
    expect(hi.items.length).toBe(model.furniture.length + hi.added + hi.decor);
  });
  it('is one op, one undo step, and keeps wall decor on the wall in the accent colour', () => {
    const hi = planInspiration(model, sw, READING, 1);
    expect(hi.ops).toHaveLength(1);
    expect(hi.ops[0].type).toBe('SET_FURNITURE');
    const next = applyOp(model, hi.ops[0]);
    const art = next.furniture.filter((f) => f.mount === 'wall');
    expect(art.length).toBe(hi.decor);
    for (const a of art) expect(dist(a.color, roleColors(sw).accent)).toBeLessThan(2);
    expect(model.furniture.some((f) => f.mount === 'wall' && f.category === 'art')).toBe(false);
  });
  it('does not mutate the source model', () => {
    const before = JSON.stringify(model.furniture);
    planInspiration(model, sw, READING, 1);
    expect(JSON.stringify(model.furniture)).toBe(before);
  });
  it('works offline from the palette alone', () => {
    const r = styleFromPalette(sw);
    expect(r.style.split(' ').length).toBeLessThanOrEqual(2);
    expect(planInspiration(model, sw, null, 0.5).recoloured).toBeGreaterThan(0);
  });
});

describe('helpers', () => {
  it('roles by category', () => {
    expect(roleOf({ category: 'rug', w: 2, d: 3 })).toBe('floor');
    expect(roleOf({ category: 'sofa', w: 2, d: 0.9 })).toBe('furniture');
    expect(roleOf({ category: 'lamp', w: 0.3, d: 0.3 })).toBe('accent');
    expect(roleOf({ category: 'desk', w: 1.4, d: 0.7 })).toBe('wood');
  });
  it('cleans a messy reading', () => {
    const r = cleanReading({ style: 'Japandi minimal calm', density: 4, pieces: [{ type: 'sofa', color: 'red' }] } as Partial<StyleReading>);
    expect(r.style).toBe('Japandi minimal');
    expect(r.density).toBe(1);
    expect(r.pieces[0].color).toBe('');
  });
});
