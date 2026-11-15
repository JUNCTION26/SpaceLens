import { describe, expect, it, vi } from 'vitest';
import type { ObjectSpec } from '../../core/types';

vi.mock('../../core/ai', async (orig) => ({ ...(await orig<typeof import('../../core/ai')>()), aiReady: () => false }));
import { composeObject } from './compose';
import { editObject, generateObject, holdToWish } from './generate';
import { checkSpec } from './validate';
import { parseWish } from './wish';
import { checkWishes } from './wishCheck';
import { editBySentence } from './wishEdit';

const count = (s: ObjectSpec, re: RegExp) => s.parts.filter((p) => re.test(p.name)).length;

describe('edit by sentence changes only what was asked', () => {
  it('20 cm taller keeps width, depth and counts', () => {
    const base = composeObject('bookshelf 80 wide with 4 shelves');
    const { spec, applied, unhandled } = editBySentence(base, '20 cm taller');
    expect(unhandled).toEqual([]); expect(applied).toContain('size h');
    expect(spec.size.h).toBeCloseTo(base.size.h + 0.2, 3);
    expect(spec.size.w).toBeCloseTo(base.size.w, 3);
    expect(count(spec, /^shelf \d/)).toBe(4);
    expect(checkSpec(spec)).toEqual([]);
  });
  it('add a shelf', () => {
    const base = composeObject('bookshelf with 4 shelves');
    const { spec } = editBySentence(base, 'add a shelf');
    expect(count(spec, /^shelf \d/)).toBe(5);
    expect(spec.size).toEqual(base.size);
  });
  it('walnut instead swaps the wood and nothing else', () => {
    const base = composeObject('oak desk 140 wide with two drawers');
    const { spec } = editBySentence(base, 'walnut instead');
    expect(spec.parts.find((p) => p.name === 'top')!.material).toBe('walnut');
    expect(count(spec, /^drawer \d/)).toBe(2);
    expect(spec.size).toEqual(base.size);
  });
  it('remove the wheels lowers nothing below the floor', () => {
    const base = composeObject('a bar cart with wheels and two shelves');
    const { spec, applied } = editBySentence(base, 'remove the wheels');
    expect(applied).toContain('remove wheels');
    expect(count(spec, /wheel/)).toBe(0);
    expect(checkSpec(spec)).toEqual([]);
  });
  it('round the corners', () => {
    const base = composeObject('a dresser with three drawers');
    const { spec } = editBySentence(base, 'round the corners');
    expect(spec.parts.some((p) => p.shape === 'rounded')).toBe(true);
    expect(count(spec, /^drawer \d/)).toBe(3);
  });
  it('a model-made object is edited part by part', () => {
    const model: ObjectSpec = { ...composeObject('bookshelf with 3 shelves'), model: 'gemini' };
    delete (model as { wish?: unknown }).wish;
    const r = editBySentence(model, 'add a shelf');
    expect(count(r.spec, /^shelf \d/)).toBe(4);
    const r2 = editBySentence(model, 'add wheels');
    expect(r2.unhandled).toContain('add wheels');
  });
});

describe('model results are held to the wish list', () => {
  it('wrong drawer count falls back to the builder and reports it', () => {
    const wish = parseWish('a 2 m long oak bench with three drawers');
    const builder = composeObject(wish);
    const bad: ObjectSpec = { ...builder, model: 'gemini', parts: builder.parts.filter((p) => p.name !== 'drawer 3') };
    const before = checkWishes(bad, wish);
    expect(before.unmet).toContain('3 drawers');
    const held = holdToWish(bad, wish, builder);
    expect(held.unmet).toEqual([]);
    expect(count(held.spec, /^drawer \d/)).toBe(3);
  });
  it('missing printed words and part material are repaired in place', () => {
    const wish = parseWish('a sideboard with black steel legs and GERARD written on it');
    const b = composeObject(wish);
    const plain: ObjectSpec = { ...b, model: 'gemini', parts: b.parts.filter((p) => !p.text).map((p) => (/^leg/.test(p.name) ? { ...p, material: 'oak' as const } : p)) };
    const held = holdToWish(plain, wish, b);
    expect(held.spec.parts.some((p) => p.text?.value === 'GERARD')).toBe(true);
    expect(held.spec.parts.filter((p) => /^leg/.test(p.name)).every((p) => p.material === 'black-metal')).toBe(true);
    expect(held.unmet).toEqual([]);
  });
});

describe('the Create flow offline', () => {
  const lines = ['oak desk 140 wide with two drawers', 'bunk bed for two kids', 'cat tree with 3 platforms', 'round dining table for 6', 'bookshelf 2 m tall with 5 shelves', 'velvet armchair in green'];
  it('returns a full object with wishes reported for each line', async () => {
    for (const l of lines) {
      const s = await generateObject(l, { detail: false });
      expect(s.parts.length).toBeGreaterThanOrEqual(3);
      expect(s.gen?.unmet).toEqual([]);
      expect((s.gen?.met ?? []).length).toBeGreaterThan(0);
    }
  });
  it('reports an unmet wish when the builder cannot meet it', async () => {
    const s = await generateObject('a stool with 9 legs', { detail: false });
    expect(s.parts.length).toBeGreaterThanOrEqual(3);
    expect(s.gen?.unmet).toContain('9 legs');
  });
  it('editObject applies a sentence offline', async () => {
    const base = await generateObject('bookshelf 2 m tall with 5 shelves', { detail: false });
    const e = await editObject(base, 'add a shelf');
    expect(count(e, /^shelf \d/)).toBe(6);
  });
});
