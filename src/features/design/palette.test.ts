import { describe, expect, it } from 'vitest';
import { CATALOG, makeItem } from '../furniture/catalog';
import { MATERIAL_DEFS } from '../forge/materialDefs';
import { FORBIDDEN_FINISH, STYLES, STYLE_IDS, applyPalette, isRust, pickStyle, styleRoom } from './palette';

const room = () => ['bed-double', 'nightstand', 'wardrobe-100', 'dresser', 'desk-140', 'chair', 'armchair', 'sofa-3', 'rug-160', 'floor-lamp', 'bookshelf', 'coffee-table', 'toilet', 'plant']
  .filter((id) => CATALOG.some((e) => e.id === id)).map((id) => makeItem(id));

describe('palette', () => {
  it('has eight styles built from catalogue materials and no rust', () => {
    expect(STYLE_IDS).toHaveLength(8);
    for (const s of Object.values(STYLES)) for (const t of [s.wood, s.fabric, s.accent, s.metal, s.rug]) {
      expect(MATERIAL_DEFS[t.material], `${s.id} ${t.material}`).toBeTruthy();
      expect(isRust(t.color), `${s.id} ${t.color}`).toBe(false);
      expect(FORBIDDEN_FINISH.test(t.material)).toBe(false);
      expect(t.color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
  it('uses one wood tone in a room, for every style', () => {
    for (const id of STYLE_IDS) {
      const out = applyPalette(room(), STYLES[id]);
      const woods = out.filter((f) => ['bed', 'nightstand', 'wardrobe', 'dresser', 'desk', 'chair', 'coffee-table'].includes(f.category));
      expect(woods.length).toBeGreaterThan(3);
      expect(new Set(woods.map((f) => `${f.color}|${f.material}`)).size, id).toBe(1);
      expect(woods[0].color).toBe(STYLES[id].wood.color);
    }
  });
  it('leaves no rust hue on any item', () => {
    for (const id of STYLE_IDS) for (const f of applyPalette(room(), STYLES[id])) {
      if (f.catalogId === 'toilet' || f.category === 'plant') continue;
      expect(isRust(f.color), `${id} ${f.catalogId} ${f.color}`).toBe(false);
    }
  });
  it('gives "Japandi bedroom" the Japandi palette', () => {
    expect(pickStyle('Japandi bedroom').id).toBe('japandi');
    const out = styleRoom(room(), 'Japandi bedroom');
    expect(out.find((f) => f.category === 'bed')!.color).toBe(STYLES.japandi.wood.color);
  });
  it('picks by theme, then room use', () => {
    expect(pickStyle('make it', 'cosy cabin').id).toBe('cabin');
    expect(pickStyle('', '', 'kids bedroom').id).toBe('kids');
    expect(pickStyle('', '', 'home office').id).toBe('industrial');
    expect(pickStyle('').id).toBe('scandinavian');
  });
  it('keeps fixtures untouched', () => {
    const t = room().find((f) => f.catalogId === 'toilet');
    if (t) expect(styleRoom([t], 'zen')[0]).toEqual(t);
  });
});
