import { describe, expect, it } from 'vitest';
import { fitSpec } from './fit';
import { normalizeSpec } from './spec';
import { forgeSpec, validateSpec } from './validate';

const raw = (kit: string, size: [number, number, number], extra: Record<string, unknown> = {}) => ({
  name: kit, category: kit, parts: [{ name: kit, kit, size, pos: [0, size[1] / 2, 0], material: 'oak', ...extra }], semantics: { category: kit, role: 'decor' },
});

describe('decor kits and printed words', () => {
  it('a poster keeps its title through normalise, fit and validate', () => {
    const spec = normalizeSpec(raw('poster', [0.5, 0.7, 0.03], { style: 'paw', color: '#f6e7c8', accent: '#3b2a1a', text: 'GERARD', textStyle: 'display' }), { prompt: 'poster' });
    const fitted = fitSpec(spec, { w: 0.6, d: 0.03, h: 0.8 });
    const v = validateSpec(fitted);
    const titled = v.fixed.parts.filter((p) => p.text);
    expect(titled).toHaveLength(1);
    expect(titled[0].text).toMatchObject({ value: 'GERARD', color: '#3b2a1a', style: 'display' });
    expect(v.fixed.parts.filter((p) => /toe/.test(p.name))).toHaveLength(4);
  });

  it('text written as an object on a plain part survives', () => {
    const v = forgeSpec({ name: 'Sign', parts: [{ name: 'Board', shape: 'rounded', size: [0.6, 0.2, 0.02], pos: [0, 0.1, 0], material: 'oak', text: { value: 'GOOD BOY', color: '#ffffff', background: '#000000', style: 'serif' } }, { name: 'a', shape: 'box', size: [0.02, 0.02, 0.02], pos: [0, 0.21, 0], material: 'oak' }, { name: 'b', shape: 'box', size: [0.02, 0.02, 0.02], pos: [0.1, 0.21, 0], material: 'oak' }] }, { prompt: 'sign' });
    expect(v.fixed.parts[0].text).toEqual({ value: 'GOOD BOY', color: '#ffffff', background: '#000000', style: 'serif' });
  });

  it('every decor kit expands into a connected object with parts', () => {
    for (const [kit, size, style] of [['sign', [0.6, 0.2, 0.02], 'paw'], ['banner', [0.8, 0.5, 0.02], 'star'], ['wallshelf', [0.8, 0.3, 0.2], ''], ['clock', [0.35, 0.35, 0.05], ''],
      ['neon', [0.6, 0.25, 0.04], 'heart'], ['statue', [0.35, 0.9, 0.35], 'bat'], ['statue', [0.35, 0.6, 0.35], 'cat'], ['statue', [0.35, 0.9, 0.35], 'hero'], ['poster', [0.5, 0.7, 0.03], 'crown']] as const) {
      const v = forgeSpec(raw(kit, [...size], { style, text: kit === 'statue' ? undefined : 'HELLO' }), { prompt: kit, w: size[0], h: size[1], d: size[2] });
      expect(v.fixed.parts.length, `${kit} ${style}`).toBeGreaterThan(2);
      expect(v.fixed.size).toEqual({ w: size[0], h: size[1], d: size[2] });
      if (kit !== 'statue' && kit !== 'wallshelf') expect(v.fixed.parts.some((p) => p.text?.value === 'HELLO'), kit).toBe(true);
    }
  });
});
