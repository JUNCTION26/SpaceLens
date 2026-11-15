// Descriptions a customer types, built offline with no key: every one must give a recognisable
// object at the right size whose parts match the words.
import { describe, expect, it, vi } from 'vitest';
import type { ObjectSpec } from '../../core/types';

vi.mock('../../core/ai', async (orig) => ({ ...(await orig<typeof import('../../core/ai')>()), aiReady: () => false }));

import { editObject, generateObject, type ForgeSpec } from './generate';
import { specFootprint } from './spec';
import { checkSpec } from './validate';

const n = (s: ObjectSpec, re: RegExp) => s.parts.filter((p) => re.test(p.name)).length;
const has = (s: ObjectSpec, re: RegExp) => s.parts.some((p) => re.test(p.name));
const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThanOrEqual(0.02);
const gen = (t: string) => generateObject(t, { detail: false });
const fp = (s: ObjectSpec) => specFootprint(s);
function sane(s: ForgeSpec) {
  expect(s.parts.length).toBeGreaterThanOrEqual(3);
  expect(Array.isArray(s.gen?.unmet)).toBe(true);
  expect(checkSpec(s)).toEqual([]);
  const f = fp(s);
  near(f.w, s.size.w); near(f.d, s.size.d); near(f.h, s.size.h);
}

describe('offline Create: sentences to objects', () => {
  it('oak desk 140 wide with two drawers', async () => {
    const s = await gen('oak desk 140 wide with two drawers'); sane(s);
    near(fp(s).w, 1.4); expect(fp(s).h).toBeGreaterThan(0.7); expect(fp(s).h).toBeLessThan(0.78);
    expect(n(s, /^drawer \d/)).toBe(2); expect(has(s, /^top$/)).toBe(true); expect(n(s, /^leg \d/)).toBeGreaterThanOrEqual(2);
    expect(s.parts.find((p) => p.name === 'top')!.material).toBe('oak');
    expect(s.gen!.unmet).toEqual([]);
  });
  it('bunk bed for two kids', async () => {
    const s = await gen('bunk bed for two kids'); sane(s);
    expect(n(s, /mattress/)).toBe(2); expect(has(s, /rung/)).toBe(true); expect(has(s, /guard rail/)).toBe(true);
    expect(fp(s).h).toBeGreaterThan(1.4); expect(fp(s).d).toBeGreaterThan(1.9);
    expect(s.gen!.unmet).toEqual([]);
  });
  it('cat tree with 3 platforms', async () => {
    const s = await gen('cat tree with 3 platforms'); sane(s);
    expect(n(s, /^platform \d/)).toBe(3); expect(has(s, /post/)).toBe(true); expect(has(s, /^base$/)).toBe(true);
    expect(s.gen!.unmet).toEqual([]);
  });
  it('round dining table for 6', async () => {
    const s = await gen('round dining table for 6'); sane(s);
    const top = s.parts.find((p) => p.name === 'top')!;
    expect(top.shape).toBe('cylinder'); near(fp(s).w, 1.3); near(fp(s).d, 1.3); near(fp(s).h, 0.75);
    expect(s.gen!.unmet).toEqual([]);
  });
  it('bookshelf 2 m tall with 5 shelves', async () => {
    const s = await gen('bookshelf 2 m tall with 5 shelves'); sane(s);
    near(fp(s).h, 2.0); expect(n(s, /^shelf \d/)).toBe(5); expect(has(s, /^side left$/)).toBe(true);
    expect(s.gen!.unmet).toEqual([]);
  });
  it('green velvet armchair', async () => {
    const s = await gen('green velvet armchair'); sane(s);
    expect(n(s, /^armrest \d/)).toBe(2); expect(has(s, /backrest/)).toBe(true); expect(has(s, /seat cushion/)).toBe(true);
    const cush = s.parts.find((p) => /seat cushion/.test(p.name))!;
    expect(cush.material).toBe('velvet'); expect(cush.color).toBeTruthy();
    expect(s.gen!.unmet).toEqual([]);
  });
  it('white wardrobe with sliding doors 180 wide', async () => {
    const s = await gen('white wardrobe with sliding doors 180 wide'); sane(s);
    near(fp(s).w, 1.8); expect(fp(s).h).toBeGreaterThan(1.8);
    expect(n(s, /^door \d/)).toBe(2);
    // Sliding doors overlap on two tracks instead of hinging side by side.
    const doors = s.parts.filter((p) => /^door \d/.test(p.name));
    expect(doors[0].pos[2]).not.toBeCloseTo(doors[1].pos[2], 3);
    expect(has(s, /track/)).toBe(true);
    expect(s.gen!.unmet).toEqual([]);
  });
  it('kids desk with a name sign that says MAYA', async () => {
    const s = await gen('kids desk with a name sign that says MAYA'); sane(s);
    expect(s.parts.some((p) => p.text?.value === 'MAYA')).toBe(true); expect(has(s, /^top$/)).toBe(true);
    expect(fp(s).h).toBeLessThan(0.66); expect(fp(s).w).toBeLessThan(1.1);
    expect(s.gen!.unmet).toEqual([]);
  });
  it('tv bench 160 in walnut', async () => {
    const s = await gen('tv bench 160 in walnut'); sane(s);
    near(fp(s).w, 1.6); expect(fp(s).h).toBeLessThan(0.6);
    expect(s.parts.find((p) => p.name === 'top')!.material).toBe('walnut');
    expect(s.gen!.unmet).toEqual([]);
  });
  it('standing desk with monitor arm', async () => {
    const s = await gen('standing desk with monitor arm'); sane(s);
    expect(has(s, /monitor arm/)).toBe(true); expect(has(s, /^top$/)).toBe(true);
    const top = s.parts.find((p) => p.name === 'top')!;
    expect(top.pos[1] + top.size[1] / 2).toBeGreaterThan(0.95);
    expect(s.gen!.unmet).toEqual([]);
  });
  it('plant stand with 3 tiers', async () => {
    const s = await gen('plant stand with 3 tiers'); sane(s);
    expect(n(s, /^platform \d/)).toBe(3);
    expect(s.gen!.unmet).toEqual([]);
  });
  it('a chest of drawers with 4 drawers', async () => {
    const s = await gen('a chest of drawers with 4 drawers'); sane(s);
    expect(n(s, /^drawer \d/)).toBe(4); near(fp(s).w, 0.8);
    // Drawers stack vertically on the front.
    const ys = s.parts.filter((p) => /^drawer \d/.test(p.name)).map((p) => p.pos[1]);
    expect(new Set(ys.map((y) => y.toFixed(2))).size).toBe(4);
    expect(s.gen!.unmet).toEqual([]);
  });
  it('words that cannot be built are reported, never thrown', async () => {
    const s = await gen('a stool with 9 legs'); sane(s);
    expect(s.gen!.unmet).toContain('9 legs');
    const u = await gen('a teleporting hoverboard'); expect(u.parts.length).toBeGreaterThanOrEqual(3);
  });
});

describe('offline edits change only what was asked', () => {
  it('20 cm taller changes only the height', async () => {
    const b = await gen('bookshelf 2 m tall with 5 shelves');
    const e = await editObject(b, '20 cm taller');
    near(fp(e).h, 2.2); near(fp(e).w, fp(b).w); near(fp(e).d, fp(b).d); expect(n(e, /^shelf \d/)).toBe(5);
  });
  it('make it walnut swaps the material', async () => {
    const b = await gen('oak desk 140 wide with two drawers');
    const e = await editObject(b, 'make it walnut');
    expect(e.parts.find((p) => p.name === 'top')!.material).toBe('walnut');
    expect(e.parts.some((p) => p.material === 'oak')).toBe(false);
    expect(n(e, /^drawer \d/)).toBe(2); near(fp(e).w, 1.4);
  });
  it('add a drawer adds one', async () => {
    const b = await gen('a chest of drawers with 4 drawers');
    const e = await editObject(b, 'add a drawer');
    expect(n(e, /^drawer \d/)).toBe(5); near(fp(e).h, fp(b).h);
  });
});
