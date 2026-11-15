import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CATALOG } from './catalog';
import { buildParts, triangleCount } from './build';

describe('catalogue geometry', () => {
  for (const e of CATALOG) {
    it(`${e.id} fits its footprint and stays light`, () => {
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
