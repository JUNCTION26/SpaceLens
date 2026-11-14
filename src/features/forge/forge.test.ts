import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { EXAMPLES } from './examples';
import { fitSpec } from './fit';
import { checkSpec, contactComponents, forgeSpec, validateSpec } from './validate';
import { normalizeSpec, partBounds, partsBounds, posedParts, specFootprint, SPEC_JSON_SCHEMA, PART_SHAPES, MATERIAL_IDS } from './spec';
import { partGeometry } from './GeneratedMesh';
import type { ObjectSpec } from '../../core/types';

const ext = (s: ObjectSpec) => { const f = specFootprint(s); return [f.w, f.h, f.d]; };

describe('examples', () => {
  it('has 11 hand-authored objects with 12-40 parts', () => {
    expect(EXAMPLES).toHaveLength(11);
    for (const s of EXAMPLES) {
      expect(s.parts.length, s.name).toBeGreaterThanOrEqual(12);
      expect(s.parts.length, s.name).toBeLessThanOrEqual(40);
    }
  });

  it.each(EXAMPLES.map((s) => [s.name, s] as const))('%s passes every hard check untouched', (_, s) => {
    expect(checkSpec(s)).toEqual([]);
    const v = validateSpec(s);
    expect(v.ok).toBe(true);
    expect(v.issues).toEqual([]);
  });

  it('wall bed folds down into a bed deeper than its cabinet', () => {
    const wb = EXAMPLES.find((s) => s.id === 'example-wall-bed')!;
    expect(wb.openSize).toBeDefined();
    expect(wb.openSize!.d).toBeGreaterThan(2);
    expect(wb.openSize!.h).toBeLessThan(wb.size.h + 1e-6);
    // Open, the foot leg reaches the floor and the mattress top is at a sensible bed height.
    const open = posedParts(wb, 1);
    const leg = partBounds(open.find((p) => p.name === 'Fold-out leg')!);
    expect(leg.min[1]).toBeCloseTo(0, 2);
    const mat = partBounds(open.find((p) => p.name === 'Mattress')!);
    expect(mat.max[1]).toBeGreaterThan(0.4);
    expect(mat.max[1]).toBeLessThan(0.55);
  });
});

describe('fitSpec', () => {
  const sizes = [{ w: 1.2, d: 0.6, h: 0.9 }, { w: 2.4, d: 1.1, h: 0.6 }, { w: 0.5, d: 0.5, h: 1.8 }];
  it.each(EXAMPLES.map((s) => [s.name, s] as const))('%s fits any size exactly and stays valid', (_, s) => {
    for (const size of [...sizes, s.size]) {
      const f = fitSpec(s, size);
      const [w, h, d] = ext(f);
      expect(Math.abs(w - size.w)).toBeLessThan(0.0005);
      expect(Math.abs(h - size.h)).toBeLessThan(0.0005);
      expect(Math.abs(d - size.d)).toBeLessThan(0.0005);
      const b = partsBounds(f.parts);
      expect(Math.abs(b.min[1])).toBeLessThan(0.0005);
      expect(Math.abs(b.min[0] + b.max[0])).toBeLessThan(0.001);
      const v = validateSpec(f);
      expect(v.ok, `${s.name} @ ${JSON.stringify(size)}: ${v.issues.join(' | ')}`).toBe(true);
    }
  });

  it('keeps thin parts at real thickness instead of stretching them', () => {
    const desk = EXAMPLES[0];
    const big = fitSpec(desk, { w: 2.0, d: 0.9, h: 1.05 });
    const top = big.parts.find((p) => p.name === 'Desktop')!;
    const leg = big.parts.find((p) => p.name === 'Front left leg')!;
    expect(top.size[1]).toBeCloseTo(0.025, 4);
    expect(leg.size[0]).toBeCloseTo(0.04, 4);
    expect(leg.size[1]).toBeGreaterThan(0.95);
    expect(top.size[0]).toBeCloseTo(2.0, 3);
    // The top still sits on the legs.
    expect(partBounds(leg).max[1]).toBeCloseTo(partBounds(top).min[1], 3);
  });

  it('is idempotent at the same size', () => {
    for (const s of EXAMPLES) {
      const f = fitSpec(s, s.size);
      f.parts.forEach((p, i) => {
        p.size.forEach((v, k) => expect(Math.abs(v - s.parts[i].size[k])).toBeLessThan(1e-4));
        p.pos.forEach((v, k) => expect(Math.abs(v - s.parts[i].pos[k])).toBeLessThan(1e-4));
      });
    }
  });

  it('moves hinge pivots with the parts', () => {
    const wb = EXAMPLES.find((s) => s.id === 'example-wall-bed')!;
    const f = fitSpec(wb, { w: 1.4, d: 0.45, h: 2.1 });
    const open = posedParts(f, 1);
    const leg = partBounds(open.find((p) => p.name === 'Fold-out leg')!);
    expect(leg.min[1]).toBeCloseTo(0, 2);
    expect(f.openSize!.d).toBeGreaterThan(1.9);
  });
});

describe('normalizeSpec', () => {
  it('cleans a sloppy model reply', () => {
    const raw = {
      name: 'Green velvet sofa',
      category: 'Curved Sofa',
      parts: [
        { name: 'base', shape: 'roundedBox', size: [240, 40, 95], pos: [0, 25, 0], material: 'green velvet', color: '2f5d3a' },
        { name: 'back', shape: 'rounded_box', size: ['240', 45, 20], pos: [0, 67.5, -37.5], material: 'velvet' },
        { name: 'leg', shape: 'post', size: [4, 5, 4], pos: [-110, 2.5, 40], material: 'brass' },
        { name: 'bad', shape: 'box', size: [1, 2], pos: [0, 0, 0], material: 'oak' },
        { name: 'tilted', shape: 'pillow', size: [50, 45, 15], pos: [60, 60, -20], rot: [-15, 0, 0], material: 'linen' },
        { name: 'curve', shape: 'extrude', size: [80, 40, 4], pos: [0, 70, -45], material: 'velvet', profile: 'nope' },
      ],
      semantics: { role: 'seating', faces: 'screen', wallBacked: true, pairsWith: ['Coffee Table'], description: 'A curved sofa.' },
    };
    const s = normalizeSpec(JSON.stringify(raw), { prompt: 'curved green velvet sofa 240 wide', w: 2.4 });
    expect(s.parts).toHaveLength(5);
    expect(s.parts[0].shape).toBe('rounded');
    expect(s.parts[0].material).toBe('velvet');
    expect(s.parts[0].color).toBe('#2f5d3a');
    expect(s.parts[0].size[0]).toBeCloseTo(2.4, 4);
    expect(s.parts[2].shape).toBe('leg');
    expect(s.parts[3].rot![0]).toBeCloseTo((-15 * Math.PI) / 180, 4);
    expect(s.parts[4].shape).toBe('rounded'); // extrude without a usable profile
    expect(s.semantics.category).toBe('sofa');
    expect(s.semantics.pairsWith).toContain('coffee-table');
    expect(s.size.w).toBe(2.4);
    const b = partsBounds(s.parts);
    expect(b.min[1]).toBeCloseTo(0, 4);
  });

  it('forgeSpec delivers a valid object at the requested size', () => {
    const raw = { name: 'Box shelf', category: 'shelf', parts: [
      { name: 'side', shape: 'panel', size: [0.02, 1, 0.3], pos: [-0.4, 0.5, 0], material: 'oak' },
      { name: 'side', shape: 'panel', size: [0.02, 1, 0.3], pos: [0.4, 0.5, 0], material: 'oak' },
      { name: 'shelf', shape: 'panel', size: [0.78, 0.02, 0.3], pos: [0, 0.5, 0], material: 'oak' },
      { name: 'floating vase', shape: 'sphere', size: [0.1, 0.15, 0.1], pos: [0, 0.75, 0], material: 'ceramic' },
    ], semantics: {} };
    const v = forgeSpec(raw, { prompt: 'shelf', w: 1.2, d: 0.35, h: 1.4 });
    expect(v.ok).toBe(true);
    expect(v.issues.some((s) => /floating/.test(s))).toBe(true);
    const [w, h, d] = ext(v.fixed);
    expect(w).toBeCloseTo(1.2, 3); expect(h).toBeCloseTo(1.4, 3); expect(d).toBeCloseTo(0.35, 3);
    const { grounded } = contactComponents(v.fixed.parts);
    expect(grounded.every(Boolean)).toBe(true);
  });

  it('exposes the schema enums', () => {
    expect(SPEC_JSON_SCHEMA.properties.parts.items.properties.shape.enum).toEqual([...PART_SHAPES]);
    expect(SPEC_JSON_SCHEMA.properties.parts.items.properties.material.enum).toEqual([...MATERIAL_IDS]);
  });
});

describe('validateSpec', () => {
  it('snaps floating parts, drops duplicates and reports undersized specs', () => {
    const base = EXAMPLES[2];
    const parts = base.parts.map((p) => (p.name === 'Top rail' ? { ...p, pos: [p.pos[0], p.pos[1], p.pos[2] + 0.3] as [number, number, number] } : p));
    parts.push({ ...parts[0] });
    const v = validateSpec({ ...base, parts });
    expect(v.issues.some((s) => /floating/.test(s))).toBe(true);
    expect(v.issues.some((s) => /duplicated/.test(s))).toBe(true);
    expect(v.ok).toBe(true);
    expect(v.fixed.parts).toHaveLength(base.parts.length);
    expect(validateSpec({ ...base, parts: base.parts.slice(0, 2) }).ok).toBe(false);
  });
});

describe('geometry', () => {
  it.each(EXAMPLES.map((s) => [s.name, s] as const))('%s builds clean geometry that matches the spec bounds', (_, s) => {
    const all = new THREE.Box3();
    s.parts.forEach((p) => {
      const { geo, piping } = partGeometry(p);
      const pos = geo.getAttribute('position'), nor = geo.getAttribute('normal');
      for (let i = 0; i < pos.count; i++) {
        expect(Number.isFinite(pos.getX(i) + pos.getY(i) + pos.getZ(i))).toBe(true);
        const l = Math.hypot(nor.getX(i), nor.getY(i), nor.getZ(i));
        expect(Math.abs(l - 1), `${p.name} normal`).toBeLessThan(0.02);
      }
      expect(geo.getAttribute('uv')).toBeDefined();
      const m = new THREE.Matrix4().compose(new THREE.Vector3(...p.pos), new THREE.Quaternion().setFromEuler(new THREE.Euler(...(p.rot ?? [0, 0, 0]))), new THREE.Vector3(1, 1, 1));
      const g = geo.clone().applyMatrix4(m);
      g.computeBoundingBox();
      const gb = g.boundingBox!, pb = partBounds(p);
      for (let k = 0; k < 3; k++) {
        expect(gb.min.getComponent(k), `${p.name} min ${k}`).toBeGreaterThan(pb.min[k] - 0.003);
        expect(gb.max.getComponent(k), `${p.name} max ${k}`).toBeLessThan(pb.max[k] + 0.003);
      }
      all.union(gb);
      void piping;
    });
    const size = all.getSize(new THREE.Vector3());
    expect(Math.abs(size.x - s.size.w)).toBeLessThan(0.006);
    expect(Math.abs(size.y - s.size.h)).toBeLessThan(0.006);
    expect(Math.abs(size.z - s.size.d)).toBeLessThan(0.006);
  });
});
