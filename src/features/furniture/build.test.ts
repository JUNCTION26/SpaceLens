import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CATALOG, CATEGORIES } from './catalog';
import { buildParts, triangleCount } from './build';
import { SEMANTICS } from '../design/semantics';

function hsl(hex: string) { const c = new THREE.Color(hex); const o = { h: 0, s: 0, l: 0 }; c.getHSL(o); return o; }

describe('catalogue data', () => {
  it('has at least 180 entries with unique ids', () => {
    expect(CATALOG.length).toBeGreaterThanOrEqual(180);
    expect(new Set(CATALOG.map((e) => e.id)).size).toBe(CATALOG.length);
  });
  for (const e of CATALOG) {
    it(`${e.id} has valid size, price, clearance and semantics`, () => {
      for (const v of [e.w, e.d, e.h]) { expect(Number.isFinite(v)).toBe(true); expect(v).toBeGreaterThan(0); expect(v).toBeLessThan(6); }
      expect(e.priceSek).toBeGreaterThan(0);
      expect(e.priceSek).toBeLessThan(200000);
      for (const v of Object.values(e.clearance)) expect(v).toBeGreaterThanOrEqual(0);
      expect(e.name.length).toBeGreaterThan(2);
      expect(e.tags.length).toBeGreaterThan(0);
      expect(e.color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(SEMANTICS[e.category], e.category).toBeTruthy();
      if (e.unfoldedD) expect(e.unfoldedD).toBeGreaterThan(e.d);
    });
  }
  it('covers the key size ladders', () => {
    const wOf = (cat: string) => new Set(CATALOG.filter((e) => e.category === cat).map((e) => Math.round(e.w * 100)));
    for (const w of [80, 90, 120, 140, 160, 180]) expect(wOf('bed').has(w), `bed ${w}`).toBe(true);
    for (const cat of ['wardrobe', 'bookshelf', 'desk', 'sofa', 'table', 'rug', 'plant']) expect(wOf(cat).size, cat).toBeGreaterThanOrEqual(5);
  });
  it('categories with catalogue entries all have semantics', () => {
    for (const c of CATEGORIES) expect(SEMANTICS[c], c).toBeTruthy();
  });
});

describe('material sanity', () => {
  it('no bed, sofa, wardrobe, desk or chair default is rust or oxidised orange', () => {
    for (const e of CATALOG.filter((x) => ['bed', 'sofa', 'sofa-bed', 'armchair', 'wardrobe', 'desk', 'chair', 'office-chair'].includes(x.category))) {
      if (/oak|birch|pine|beech|walnut|wood|veneer/i.test(e.material ?? '')) continue; // natural wood tones are fine
      const { h, s, l } = hsl(e.color);
      const hue = h * 360;
      const rust = hue >= 5 && hue <= 40 && s > 0.5 && l < 0.65;
      expect(rust, `${e.id} ${e.color}`).toBe(false);
    }
  });
  it('every bed is built with a mattress, duvet, pillows and a headboard', () => {
    for (const e of CATALOG.filter((x) => x.category === 'bed')) {
      const parts = buildParts(e.category, e.id, e.w, e.d, e.h);
      expect(parts.has('white'), e.id).toBe(true);
      expect(parts.has('soft'), e.id).toBe(true);
      expect(parts.has('main'), e.id).toBe(true);
      const g = parts.get('white')!; g.computeBoundingBox();
      expect(g.boundingBox!.max.y - g.boundingBox!.min.y, `${e.id} mattress thickness`).toBeGreaterThan(0.15);
      expect(g.boundingBox!.max.x - g.boundingBox!.min.x).toBeGreaterThan(e.w * 0.9);
    }
  });
});

describe('catalogue geometry', () => {
  for (const e of CATALOG) {
    it(`${e.id} fits its footprint within 1 cm and stays light`, () => {
      const parts = buildParts(e.category, e.id, e.w, e.d, e.h);
      const box = new THREE.Box3();
      parts.forEach((g) => { g.computeBoundingBox(); box.union(g.boundingBox!); });
      const s = box.getSize(new THREE.Vector3());
      expect(Math.abs(s.x - e.w)).toBeLessThan(0.01);
      expect(Math.abs(s.y - e.h)).toBeLessThan(0.01);
      expect(Math.abs(s.z - e.d)).toBeLessThan(0.01);
      expect(Math.abs(box.min.y)).toBeLessThan(0.01);
      expect(triangleCount(parts)).toBeLessThan(2000);
    });
  }
});
