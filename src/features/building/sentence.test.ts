import { describe, expect, it } from 'vitest';
import { demoBuilding } from './demo';
import { programmeArea } from './programme';
import { editRoom, refurnishRoom } from './refurnish';
import { programmeFromSentence, shellForArea } from './sentence';

const count = (s: string, purpose: string) => programmeFromSentence(s).programme.rooms.filter((r) => r.purpose === purpose).length;

describe('programmeFromSentence', () => {
  it('villa with bedrooms, area and an open kitchen', () => {
    const r = programmeFromSentence('a 120 m² villa with 3 bedrooms and an open kitchen');
    expect(r.areaM2).toBe(120);
    expect(r.programme.rooms.filter((x) => x.purpose === 'bedroom')).toHaveLength(3);
    expect(r.programme.rooms.some((x) => x.name === 'Living & kitchen')).toBe(true);
    expect(r.programme.rooms.some((x) => x.id === 'kitchen')).toBe(false);
    expect(programmeArea(r.programme)).toBeLessThanOrEqual(120);
  });
  it('office for 20 people with 2 meeting rooms and a kitchen', () => {
    const r = programmeFromSentence('an office for 20 people with 2 meeting rooms and a kitchen');
    expect(r.programme.kind).toBe('office');
    expect(r.programme.rooms.filter((x) => /^meeting-\d+$/.test(x.id))).toHaveLength(2);
    expect(r.programme.rooms.some((x) => x.purpose === 'kitchen')).toBe(true);
    expect(r.programme.rooms.reduce((n, x) => n + (x.purpose === 'workspace' ? x.people ?? 0 : 0), 0)).toBe(20);
  });
  it('two-room flat 55 m²', () => {
    const r = programmeFromSentence('a two-room flat 55 m²');
    expect(r.areaM2).toBe(55);
    expect(r.programme.kind).toBe('home');
    expect(r.programme.rooms.filter((x) => x.purpose === 'bedroom')).toHaveLength(1);
    expect(programmeArea(r.programme)).toBeLessThanOrEqual(55);
  });
  it('studio flat', () => expect(count('studio apartment', 'bedroom')).toBe(0));
  it('house with five bedrooms', () => expect(count('house with five bedrooms', 'bedroom')).toBe(5));
  it('4-bedroom home with a study and 2 bathrooms', () => {
    const r = programmeFromSentence('4-bedroom home with a study and 2 bathrooms');
    expect(r.programme.rooms.some((x) => x.id === 'study')).toBe(true);
    expect(r.programme.rooms.filter((x) => x.purpose === 'bathroom')).toHaveLength(2);
  });
  it('cafe with 40 seats', () => expect(programmeFromSentence('a cafe with 40 seats').programme.kind).toBe('cafe'));
  it('clinic with 4 exam rooms', () => expect(count('a clinic with 4 exam rooms', 'clinic')).toBe(4));
  it('large office by area only', () => {
    const r = programmeFromSentence('office 300 m2');
    expect(r.programme.kind).toBe('office');
    expect(programmeArea(r.programme)).toBeLessThanOrEqual(300);
  });
  it('unknown text still gives a usable programme', () => {
    const r = programmeFromSentence('something nice');
    expect(r.recognised).toBe(false);
    expect(r.programme.rooms.length).toBeGreaterThan(2);
  });
  it('ids are unique and adjacency points at real rooms', () => {
    for (const s of ['an office for 40 people with 3 meeting rooms', 'a 90 m² house with 2 bedrooms and open kitchen']) {
      const p = programmeFromSentence(s).programme;
      const ids = p.rooms.map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const r of p.rooms) for (const a of r.adjacentTo) expect(ids).toContain(a);
    }
  });
  it('shell holds the area', () => {
    const { w, d } = shellForArea(120);
    expect(w * d).toBeGreaterThanOrEqual(115);
  });
});

describe('per-room refurnish reducer', () => {
  const model = demoBuilding('villa')!;
  const [a, b] = model.spaces;
  const centre = (s: typeof a) => ({ x: s.polygon.reduce((n, p) => n + p.x, 0) / s.polygon.length, y: s.polygon.reduce((n, p) => n + p.y, 0) / s.polygon.length });
  const piece = (id: string, s: typeof a) => ({ id, catalogId: 'x', category: 'chair', name: id, ...centre(s), width: 0.4, depth: 0.4, height: 0.9, rotation: 0 }) as unknown as typeof model.furniture[number];
  const base = { ...model, furniture: [piece('p1', a), piece('p2', b)] };

  it('replaces only the chosen room', () => {
    const next = refurnishRoom(base, a.id, [piece('n1', a), piece('n2', a)]);
    expect(next.furniture.map((f) => f.id).sort()).toEqual(['n1', 'n2', 'p2']);
    expect(base.furniture).toHaveLength(2);
  });
  it('unknown room leaves the model alone', () => expect(refurnishRoom(base, 'nope', [])).toBe(base));
  it('renaming keeps the furniture', () => {
    const next = editRoom(base, a.id, { name: 'Den' });
    expect(next.spaces[0].name).toBe('Den');
    expect(next.furniture).toHaveLength(2);
  });
  it('a new use clears that room only', () => {
    const next = editRoom(base, a.id, { purpose: 'office' });
    expect(next.spaces[0].purpose).toBe('office');
    expect(next.furniture.map((f) => f.id)).toEqual(['p2']);
  });
});
