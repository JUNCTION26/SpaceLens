import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CATALOG } from './catalog';
import { buildParts, type Parts } from './build';
import { modelSpecFor } from './assets';

const first = (cat: string) => CATALOG.find((e) => e.category === cat)!;
const bb = (g?: THREE.BufferGeometry) => { if (!g) return null; g.computeBoundingBox(); return g.boundingBox!; };
const build = (cat: string): { e: typeof CATALOG[number]; p: Parts } => { const e = first(cat); return { e, p: buildParts(e.category, e.id, e.w, e.d, e.h) }; };

describe('scanned models', () => {
  it('only clean modern scans remain mapped', () => {
    const old = /classic|drawer_cabinet|dining_chair_02|dining_table|side_table|old_|worn/i;
    for (const e of CATALOG) { const s = modelSpecFor(e); if (s) expect(old.test(s.id), `${e.id} -> ${s.id}`).toBe(false); }
    for (const c of ['bed', 'desk', 'bookshelf', 'toy-storage', 'chair', 'table', 'nightstand', 'dresser']) expect(modelSpecFor(first(c)), c).toBeUndefined();
  });
});

describe('procedural categories read at room scale', () => {
  it('bed has frame, mattress, duvet and a headboard taller than the mattress at the head end', () => {
    const { e, p } = build('bed');
    for (const r of ['main', 'white', 'soft'] as const) expect(p.has(r), r).toBe(true);
    const main = bb(p.get('main'))!, mat = bb(p.get('white'))!;
    expect(main.max.y).toBeGreaterThan(mat.max.y);
    expect(main.min.z).toBeCloseTo(-e.d / 2, 1);
  });
  for (const c of ['sofa', 'armchair']) it(`${c} has base, soft cushions and back at -d/2`, () => {
    const { e, p } = build(c);
    expect(p.has('main') && p.has('soft') && p.has('dark')).toBe(true);
    const main = bb(p.get('main'))!;
    expect(main.min.z).toBeCloseTo(-e.d / 2, 1);
    expect(main.max.y).toBeGreaterThan(e.h * 0.8);
    expect(bb(p.get('soft'))!.max.y).toBeLessThan(e.h + 0.001);
  });
  it('dining chair: back rises above the seat on the -d/2 side, legs reach the floor', () => {
    const { e, p } = build('chair');
    const main = bb(p.get('main'))!, dark = bb(p.get('dark'))!;
    expect(main.max.y).toBeGreaterThan(e.h * 0.85);
    expect(dark.min.y).toBeCloseTo(0, 2);
    // back panel sits on the -z half; centre of high geometry is behind the middle
    expect(dark.min.z).toBeLessThan(-e.d * 0.3);
  });
  it('office chair has a star base and a back behind the seat', () => {
    const { e, p } = build('office-chair');
    const metal = bb(p.get('metal'))!, soft = bb(p.get('soft'))!;
    expect(metal.max.x - metal.min.x).toBeGreaterThan(e.w * 0.6);
    expect(metal.max.y).toBeLessThan(0.3);
    expect(soft.max.y).toBeGreaterThan(e.h * 0.8);
    expect(soft.min.z).toBeLessThan(-e.d * 0.2);
  });
  it('desk has a top at full height, legs to the floor', () => {
    const { e, p } = build('desk');
    expect(bb(p.get('main'))!.max.y).toBeCloseTo(e.h, 2);
    expect(bb(p.get('metal'))!.min.y).toBeCloseTo(0, 2);
  });
  for (const c of ['table', 'coffee-table']) it(`${c} has a top at full height and legs to the floor`, () => {
    const { e, p } = build(c);
    expect(bb(p.get('main'))!.max.y).toBeCloseTo(e.h, 2);
    const sup = bb(p.get('dark') ?? p.get('metal'))!;
    expect(sup.min.y).toBeLessThan(0.03);
  });
  it('wardrobe has doors and handles and fills its height', () => {
    const { e, p } = build('wardrobe');
    expect(bb(p.get('main'))!.max.y).toBeGreaterThan(e.h * 0.9);
    expect(p.size).toBeGreaterThanOrEqual(2);
  });
  it('bookshelf carries books in at least three colours', () => {
    const { p } = build('bookshelf');
    expect(['book0', 'book1', 'book2', 'book3', 'book4'].filter((r) => p.has(r as never)).length).toBeGreaterThanOrEqual(3);
  });
  for (const c of ['tv-unit', 'nightstand']) it(`${c} is a closed body with a visible front detail`, () => {
    const { e, p } = build(c);
    expect(p.size).toBeGreaterThanOrEqual(2);
    const main = bb(p.get('main'))!;
    expect(main.max.x - main.min.x).toBeGreaterThan(e.w * 0.85);
  });
  it('rug is flat and wide', () => {
    const { e, p } = build('rug');
    expect(e.h).toBeLessThan(0.05);
    const b = bb([...p.values()][0])!;
    expect(b.max.x - b.min.x).toBeGreaterThan(e.w * 0.95);
  });
  it('plant has a pot below green foliage', () => {
    const { e, p } = build('plant');
    const pot = bb(p.get('pot'))!, green = bb(p.get('green'))!;
    expect(pot.max.y).toBeLessThan(e.h * 0.5);
    expect(green.max.y).toBeGreaterThan(e.h * 0.9);
    expect(green.max.y).toBeGreaterThan(pot.max.y);
  });
  it('floor lamp has a base, a pole and a glowing shade at the top', () => {
    const { e, p } = build('lamp');
    expect(p.has('glow')).toBe(true);
    expect(bb(p.get('glow'))!.max.y).toBeGreaterThan(e.h * 0.9);
  });
});

describe('default colours are calm', () => {
  it('no catalogue default is rust or orange, and no scanned-model tint is either', () => {
    for (const e of CATALOG) {
      const o = { h: 0, s: 0, l: 0 }; new THREE.Color(e.color).getHSL(o);
      const hue = o.h * 360;
      const warm = hue >= 8 && hue <= 38 && o.s > 0.55 && o.l < 0.6;
      expect(warm, `${e.id} ${e.color}`).toBe(false);
    }
  });
});
