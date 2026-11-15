import { describe, expect, it } from 'vitest';
import type { ObjectPart } from '../../core/types';
import { composeObject, type ComposedSpec } from './compose';
import { partBounds } from './spec';
import { checkSpec } from './validate';
import { parseWish } from './wish';

const count = (s: ComposedSpec, re: RegExp) => s.parts.filter((p) => re.test(p.name)).length;
const named = (s: ComposedSpec, re: RegExp): ObjectPart[] => s.parts.filter((p) => re.test(p.name));

/** Physical sense: valid against its own size, at most 60 parts, centre of mass over the floor contacts. */
function physical(s: ComposedSpec) {
  expect(checkSpec(s)).toEqual([]);
  expect(s.parts.length).toBeLessThanOrEqual(60);
  let m = 0, cx = 0, cz = 0;
  const floor = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
  for (const p of s.parts) {
    const b = partBounds(p), v = Math.max(1e-6, p.size[0] * p.size[1] * p.size[2]);
    m += v; cx += v * p.pos[0]; cz += v * p.pos[2];
    if (b.min[1] <= 0.005) { floor.x0 = Math.min(floor.x0, b.min[0]); floor.x1 = Math.max(floor.x1, b.max[0]); floor.z0 = Math.min(floor.z0, b.min[2]); floor.z1 = Math.max(floor.z1, b.max[2]); }
  }
  cx /= m; cz /= m;
  expect(cx).toBeGreaterThanOrEqual(floor.x0 - 1e-3); expect(cx).toBeLessThanOrEqual(floor.x1 + 1e-3);
  expect(cz).toBeGreaterThanOrEqual(floor.z0 - 1e-3); expect(cz).toBeLessThanOrEqual(floor.z1 + 1e-3);
}

describe('offline builder follows the description', () => {
  it('oak desk 140 wide with two drawers', () => {
    const s = composeObject('oak desk 140 wide with two drawers');
    physical(s);
    expect(s.size.w).toBeCloseTo(1.4, 3);
    expect(count(s, /^drawer \d/)).toBe(2);
    expect(named(s, /^top$/)[0].material).toBe('oak');
  });
  it('bunk bed for two kids: two decks, a ladder', () => {
    const s = composeObject('bunk bed for two kids');
    physical(s);
    expect(count(s, /mattress/)).toBe(2);
    expect(count(s, /^rung/)).toBeGreaterThanOrEqual(3);
  });
  it('cat tree with 3 platforms', () => {
    const s = composeObject('cat tree with 3 platforms');
    physical(s);
    expect(count(s, /^platform \d/)).toBe(3);
  });
  it('round dining table for 6', () => {
    const s = composeObject('round dining table for 6');
    physical(s);
    expect(s.size.w).toBeCloseTo(1.3, 2);
    expect(s.size.d).toBeCloseTo(1.3, 2);
    expect(named(s, /^top$/)[0].shape).toBe('cylinder');
  });
  it('bookshelf 2 m tall with 5 shelves', () => {
    const s = composeObject('bookshelf 2 m tall with 5 shelves');
    physical(s);
    expect(s.size.h).toBeCloseTo(2, 3);
    expect(count(s, /^shelf \d/)).toBe(5);
  });
  it('velvet armchair in green', () => {
    const s = composeObject('velvet armchair in green');
    physical(s);
    const seat = named(s, /^seat cushion/)[0];
    expect(seat.material).toBe('velvet');
    expect(seat.color).toBeTruthy();
    expect(count(s, /^armrest/)).toBe(2);
    expect(count(s, /^backrest/)).toBe(1);
  });
  it('a 2 m long oak bench with three drawers', () => {
    const s = composeObject('a 2 m long oak bench with three drawers');
    physical(s);
    expect(s.size.w).toBeCloseTo(2, 3);
    expect(count(s, /^drawer \d/)).toBe(3);
    expect(named(s, /^top$/)[0].material).toBe('oak');
  });
  it('a round glass coffee table 90 cm across on a black steel pedestal', () => {
    const s = composeObject('a round glass coffee table 90 cm across on a black steel pedestal');
    physical(s);
    expect(s.size.w).toBeCloseTo(0.9, 3); expect(s.size.d).toBeCloseTo(0.9, 3);
    expect(named(s, /^top$/)[0].material).toBe('glass');
    expect(named(s, /pedestal column/)[0].material).toBe('black-metal');
    expect(count(s, /^leg \d/)).toBe(0);
  });
  it('a bunk bed with a slide', () => {
    const s = composeObject('a bunk bed with a slide');
    physical(s);
    expect(count(s, /^slide$/)).toBe(1);
  });
  it('a cat tree with three platforms and a rope post', () => {
    const s = composeObject('a cat tree with three platforms and a rope post');
    physical(s);
    expect(count(s, /^platform \d/)).toBe(3);
    expect(count(s, /^rope post$/)).toBe(1);
  });
  it('a tall narrow bookshelf with five shelves and two doors at the bottom', () => {
    const s = composeObject('a tall narrow bookshelf with five shelves and two doors at the bottom');
    physical(s);
    expect(s.size.h).toBeGreaterThanOrEqual(2);
    expect(s.size.w).toBeLessThan(0.6);
    expect(count(s, /^shelf \d/)).toBe(5);
    const doors = named(s, /^door \d/);
    expect(doors.length).toBe(2);
    for (const sh of named(s, /^shelf \d/)) for (const d of doors) expect(sh.pos[1]).toBeGreaterThan(d.pos[1] + d.size[1] / 2);
  });
  it('a bar cart with wheels and two shelves', () => {
    const s = composeObject('a bar cart with wheels and two shelves');
    physical(s);
    expect(count(s, /^wheel \d/)).toBe(4);
    expect(count(s, /^shelf \d/)).toBe(2);
  });
  it('a drum kit: drums on stands, cymbals on stands', () => {
    const s = composeObject('a drum kit');
    physical(s);
    expect(count(s, /^drum \d/)).toBe(4);
    expect(count(s, /^cymbal \d/)).toBe(2);
  });
  it('a standing desk', () => {
    const s = composeObject('a standing desk 160 by 80');
    physical(s);
    expect(s.size.h).toBeGreaterThan(1);
    expect(s.size.w).toBeCloseTo(1.6, 3);
    expect(count(s, /^leg \d/)).toBe(2);
  });
  it('Swedish: en ekbänk med tre lådor', () => {
    const s = composeObject('en 180 cm lång ekbänk med tre lådor');
    physical(s);
    expect(s.wish.category).toBe('bench');
    expect(s.size.w).toBeCloseTo(1.8, 3);
    expect(count(s, /^drawer \d/)).toBe(3);
    expect(named(s, /^top$/)[0].material).toBe('oak');
  });
  it('Finnish: kirjahylly jossa viisi hyllyä', () => {
    const s = composeObject('valkoinen kirjahylly, 2 m korkea, jossa viisi hyllyä');
    physical(s);
    expect(s.wish.category).toBe('bookshelf');
    expect(s.size.h).toBeCloseTo(2, 3);
    expect(count(s, /^shelf \d/)).toBe(5);
  });
  it('printed words appear on the object', () => {
    const s = composeObject('a toy box with GERARD written on it');
    physical(s);
    expect(s.parts.some((p) => p.text?.value === 'GERARD')).toBe(true);
  });
  it('a nightstand with a lamp keeps a stated height', () => {
    const s = composeObject('a walnut nightstand 70 cm high with a lamp');
    physical(s);
    expect(s.size.h).toBeCloseTo(0.7, 3);
    expect(count(s, /^lamp shade/)).toBe(1);
  });
  it('wall-mounted cabinet reports its mount height', () => {
    const s = composeObject('a wall-mounted bathroom cabinet with one door');
    physical(s);
    expect(s.mount?.wall).toBe(true);
    expect(s.mount!.elevationM).toBeGreaterThan(0.8);
    expect(s.semantics.wallBacked).toBe(true);
  });
  it('unknown noun maps to the nearest archetype', () => {
    const s = composeObject('a skateboard rack');
    physical(s);
    expect(s.wish.archetype).toBe('frame');
  });
});

describe('wish parser', () => {
  it('reads counts, materials per part and features', () => {
    const w = parseWish('a sideboard with an oak top, black steel legs, glass doors, three drawers and handles');
    expect(w.counts.drawers).toBe(3);
    expect(w.looks.top?.material).toBe('oak');
    expect(w.looks.legs?.material).toBe('black-metal');
    expect(w.looks.doors?.material).toBe('glass');
    expect(w.features).toContain('handles');
  });
  it('knee height and for two people', () => {
    const w = parseWish('a knee height bench for two people');
    expect(w.size.h).toBe(0.5);
    expect(w.counts.seats).toBe(2);
  });
});
