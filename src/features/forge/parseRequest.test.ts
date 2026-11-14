import { describe, expect, it } from 'vitest';
import { hasCustomDetail, isCreateCommand, parseEdit, parseRequest, resolveSize } from './parseRequest';

describe('parseRequest', () => {
  it('reads "160 by 80" and features with a side', () => {
    const p = parseRequest('walnut desk 160 by 80 with drawers on the right');
    expect(p.kind?.id).toBe('desk');
    expect(p.w).toBe(1.6);
    expect(p.d).toBe(0.8);
    expect(p.h).toBeUndefined();
    expect(p.materials).toContain('walnut');
    expect(p.features).toContain('drawers');
    expect(p.side).toBe('right');
  });

  it('reads tagged widths and the low modifier', () => {
    const p = parseRequest('low oak TV bench 180 wide');
    expect(p.kind?.id).toBe('tv-unit');
    expect(p.w).toBe(1.8);
    expect(p.low).toBe(true);
    expect(p.materials).toEqual(['oak']);
    const s = resolveSize(p);
    expect(s.w).toBe(1.8);
    expect(s.h).toBeLessThan(0.45);
  });

  it('sizes a round table for six', () => {
    const p = parseRequest('round marble table for six');
    expect(p.kind?.template).toBe('table');
    expect(p.round).toBe(true);
    expect(p.seats).toBe(6);
    expect(p.materials).toContain('marble');
    const s = resolveSize(p);
    expect(s.w).toBe(s.d);
    expect(s.w).toBeGreaterThanOrEqual(1.2);
  });

  it('handles metres, millimetres and chains with one trailing unit', () => {
    expect(parseRequest('sofa 2.4 m wide').w).toBe(2.4);
    expect(parseRequest('cabinet 600 mm wide 1200 mm high')).toMatchObject({ w: 0.6, h: 1.2 });
    expect(parseRequest('desk 160x80x75 cm')).toMatchObject({ w: 1.6, d: 0.8, h: 0.75 });
    expect(parseRequest('bookshelf 1.2 by 0.35 by 2 m')).toMatchObject({ w: 1.2, d: 0.35, h: 2 });
    expect(parseRequest('table 75 cm high, 140 long').h).toBe(0.75);
  });

  it('treats "long" as depth for beds and rugs', () => {
    expect(parseRequest('bed 140 wide 200 long')).toMatchObject({ w: 1.4, d: 2 });
  });

  it('takes a diameter for round things', () => {
    const p = parseRequest('round rug 200 cm');
    expect(p).toMatchObject({ w: 2, d: 2, round: true });
    expect(parseRequest('table diameter 120')).toMatchObject({ w: 1.2, d: 1.2, round: true });
  });

  it('reads quantity before the noun', () => {
    expect(parseRequest('two oak chairs').qty).toBe(2);
    expect(parseRequest('3 stools 65 high')).toMatchObject({ qty: 3, h: 0.65 });
  });

  it('reads colours separately from materials', () => {
    const p = parseRequest('green velvet sofa with black metal legs');
    expect(p.materials).toEqual(expect.arrayContaining(['velvet', 'black-metal']));
    expect(p.colors.map((c) => c.word)).toContain('green');
    expect(p.colors.map((c) => c.word)).not.toContain('black');
  });

  it('understands basic Swedish', () => {
    const p = parseRequest('ett skrivbord i ek 160 gånger 80 med lådor till höger');
    expect(p.kind?.id).toBe('desk');
    expect(p).toMatchObject({ w: 1.6, d: 0.8, side: 'right' });
    expect(p.materials).toContain('oak');
    expect(p.features).toContain('drawers');
    const q = parseRequest('rund matta 2 meter');
    expect(q).toMatchObject({ w: 2, d: 2, round: true });
    expect(q.kind?.id).toBe('rug');
    expect(parseRequest('soffbord 120 bred 45 hög')).toMatchObject({ w: 1.2, h: 0.45 });
    expect(parseRequest('matbord för sex').seats).toBe(6);
  });

  it('prefers the most specific kind', () => {
    expect(parseRequest('desk chair').kind?.id).toBe('desk-chair');
    expect(parseRequest('coffee table').kind?.id).toBe('coffee-table');
    expect(parseRequest('bedside table').kind?.id).toBe('nightstand');
    expect(parseRequest('built-in fold-down wall bed 140').kind?.id).toBe('wall-bed');
  });
});

describe('routing helpers', () => {
  it('recognises create commands but not edits', () => {
    expect(isCreateCommand('add a walnut desk')).toBe(true);
    expect(isCreateCommand('make a round marble table')).toBe(true);
    expect(isCreateCommand('skapa ett skrivbord')).toBe(true);
    expect(isCreateCommand('make it 20 cm wider')).toBe(false);
    expect(isCreateCommand('make the sofa bigger')).toBe(false);
    expect(isCreateCommand('move the sofa to the window')).toBe(false);
  });

  it('flags custom detail', () => {
    expect(hasCustomDetail(parseRequest('add a sofa'))).toBe(false);
    expect(hasCustomDetail(parseRequest('add a walnut desk with drawers'))).toBe(true);
    expect(hasCustomDetail(parseRequest('add a hammock'))).toBe(true);
  });

  it('reads relative edits', () => {
    const size = { w: 1.6, d: 0.8, h: 0.74 };
    expect(parseEdit('make it 20 cm wider', size)).toEqual({ w: 1.8 });
    expect(parseEdit('10 cm lower and 5 cm deeper', size)).toEqual({ h: 0.64, d: 0.85 });
    expect(parseEdit('in walnut', size)).toEqual({});
  });
});
