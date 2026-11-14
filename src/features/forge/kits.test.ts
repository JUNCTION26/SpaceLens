import { describe, expect, it } from 'vitest';
import type { ObjectSpec } from '../../core/types';
import { expandItem, KITS } from './kits';
import { KIT_EXAMPLES } from './kitExamples';
import { fixAxes } from './orient';
import { parseRequest, resolveSize } from './parseRequest';
import { findColors, findTheme } from './palette';
import { presetProfile, PROFILE_STYLES } from './profiles';
import { normalizeSpec, specFootprint } from './spec';
import { forgeSpec } from './validate';

describe('kits', () => {
  it('every kit expands into parts inside sane bounds', () => {
    for (const kit of KITS) {
      const ex = expandItem({ name: kit, kit, size: [1, 0.8, 0.6], pos: [0, 0.4, 0], material: 'oak', count: 3 }, 0);
      expect(ex.parts.length, kit).toBeGreaterThan(0);
      const fp = specFootprint({ parts: ex.parts });
      expect(fp.minY, kit).toBeGreaterThan(-0.05);
      expect(fp.w, kit).toBeLessThan(3);
      for (const p of ex.parts) expect(p.size.every((v) => v > 0 && Number.isFinite(v)), `${kit} ${p.name}`).toBe(true);
    }
  });

  it('drawers get one moving group and a slide per drawer', () => {
    const ex = expandItem({ name: 'Drawer', kit: 'drawers', count: 3, size: [0.4, 0.6, 0.6], pos: [0.5, 0.4, 0], material: 'walnut' }, 2);
    expect(ex.motions).toHaveLength(3);
    expect(ex.motions.every((m) => m.kind === 'slide' && m.axis[2] === 1)).toBe(true);
    expect(new Set(ex.parts.map((p) => p.group)).size).toBe(3);
  });

  it('mirror adds a reflected copy with mirrored hinges', () => {
    const ex = expandItem({ name: 'Door', kit: 'doors', count: 1, size: [0.4, 0.8, 0.02], pos: [0.5, 0.4, 0.2], material: 'oak', mirror: 'x' }, 0);
    const xs = ex.parts.map((p) => p.pos[0]);
    expect(Math.min(...xs)).toBeLessThan(0);
    expect(ex.motions).toHaveLength(2);
    expect(Math.sign(ex.motions[0].open * ex.motions[0].axis[1])).toBe(-Math.sign(ex.motions[1].open * ex.motions[1].axis[1]));
  });

  it('arcs with the same width and depth share one curve', () => {
    const a = expandItem({ name: 'Base', kit: 'arc', radius: 0.9, size: [2.4, 0.3, 0.4], pos: [0, 0.15, 0], material: 'velvet' }, 0);
    const b = expandItem({ name: 'Back', kit: 'arc', radius: 0.2, size: [2.4, 0.4, 0.4], pos: [0, 0.5, 0], material: 'velvet' }, 1);
    const fa = specFootprint(a), fb = specFootprint(b);
    expect(fa.w).toBeCloseTo(2.4, 1);
    expect(fa.minZ).toBeCloseTo(fb.minZ, 3);
    expect(fa.d).toBeGreaterThan(fb.d);
  });

  it('every preset outline exists and is closed enough to extrude', () => {
    for (const s of PROFILE_STYLES) expect(presetProfile(s)!.length, s).toBeGreaterThanOrEqual(4);
    expect(presetProfile('heart-shaped')).toBeDefined();
    expect(presetProfile('scalloped')).toBeDefined();
  });

  it('every few-shot example builds a valid object', () => {
    for (const ex of KIT_EXAMPLES) {
      const v = forgeSpec(ex.json, { prompt: ex.prompt });
      expect(v.fixed.parts.length, ex.prompt).toBeGreaterThanOrEqual(5);
      expect(v.ok, `${ex.prompt}: ${v.issues.join(' | ')}`).toBe(true);
    }
  });

  it('the wall bed example folds down to the floor', () => {
    const spec = normalizeSpec(KIT_EXAMPLES[2].json, { prompt: 'wall bed' });
    expect(spec.motions?.[0].kind).toBe('hinge');
    expect(spec.openSize!.d).toBeGreaterThan(1.8);
  });
});

describe('request reading', () => {
  it('a three-drawer pedestal is a count, not a height', () => {
    const p = parseRequest('walnut desk 160 by 80 with a three-drawer pedestal on the right');
    expect(p).toMatchObject({ w: 1.6, d: 0.8, side: 'right' });
    expect(p.h).toBeUndefined();
    expect(p.counts.drawers).toBe(3);
    expect(parseRequest('kitchen island 200x90 with two bar stools').counts.stools).toBe(2);
    expect(parseRequest('3 stools 65 high').qty).toBe(3);
    expect(resolveSize(p).h).toBeLessThan(0.8);
  });

  it('names the object before "with"', () => {
    expect(parseRequest('kitchen island 200x90 with two bar stools').kind?.id).toBe('kitchen-island');
    expect(parseRequest('kids bunk bed with a slide').kind?.id).toBe('bunk-bed');
    expect(parseRequest('curved white reception desk 300').kind?.id).toBe('reception-desk');
    expect(parseRequest('black and red gaming chair').kind?.id).toBe('gaming-chair');
  });

  it('reads vivid colours and themes', () => {
    expect(findColors('hot pink and white')).toEqual([{ word: 'hot pink', hex: '#e0218a' }, { word: 'white', hex: '#f4f2ee' }]);
    expect(findColors('black and red gaming chair').map((c) => c.word)).toEqual(['black', 'red']);
    expect(findTheme('pink Barbie dream bed')?.id).toBe('barbie');
    expect(findTheme('industrial shelf')?.palette[0]).toBe('#1c1c1e');
  });
});

describe('axis repair', () => {
  const box = (name: string, size: [number, number, number], pos: [number, number, number]) => ({ name, shape: 'box' as const, size, pos, material: 'oak' as const });
  const spec = (parts: ReturnType<typeof box>[]): ObjectSpec => ({ id: 't', name: 't', prompt: 't', size: { w: 1, d: 1, h: 1 }, parts, semantics: { category: 'desk', role: 'surface', wallBacked: true, frontClearanceM: 0, sideClearanceM: 0, pairsWith: [], faces: 'none', tall: false, description: '' }, model: 'x', latencyMs: 0, createdAt: 0 });

  it('turns a bed built with z up so it lies down instead of standing as a tower', () => {
    // Mattress 0.9 wide, 2.0 along y (should be depth), 0.5 along z (should be height).
    const s = spec([box('Mattress', [0.9, 2.0, 0.25], [0, 1.0, 0.125]), box('Headboard', [0.9, 0.05, 0.5], [0, 0.025, 0.25])]);
    const r = fixAxes(s, { w: 0.9, d: 2.0, h: 0.5 }, { w: true, d: true });
    expect(r.fixed).toBe('z-up');
    const fp = specFootprint(r.spec);
    expect(fp.h).toBeCloseTo(0.5, 2);
    expect(fp.d).toBeCloseTo(2.0, 2);
    expect(fp.minY).toBeCloseTo(0, 4);
  });

  it('turns a bed laid along x', () => {
    const s = spec([box('Mattress', [2.0, 0.25, 0.9], [0, 0.3, 0]), box('Headboard', [0.05, 1.0, 0.9], [-1.0, 0.5, 0])]);
    expect(fixAxes(s, { w: 0.9, d: 2.0, h: 1.0 }, { w: true, d: true }).fixed).toBe('swap-wd');
  });

  it('leaves a well-built object alone', () => {
    const s = spec([box('Top', [1.6, 0.03, 0.8], [0, 0.735, 0]), box('Leg', [0.05, 0.72, 0.05], [-0.75, 0.36, 0.35])]);
    expect(fixAxes(s, { w: 1.4, d: 0.7, h: 0.74 }).fixed).toBeUndefined();
  });
});
