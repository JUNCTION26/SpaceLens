import { describe, expect, it } from 'vitest';
import { sampleRoom } from '../../core/sample';
import type { FurnitureItem, SpaceModel } from '../../core/types';
import { STEPS, arrowPath, moveStep, snapOf, stepDone, type Snap } from './steps';

const extras = { drills: 0, viewPokes: 0, walkStops: 0 };
const base = (): SpaceModel => ({ ...sampleRoom(), furniture: [] });
const piece = (id: string, x = 1, y = 1, custom = false) =>
  ({ id, catalogId: 'desk', name: 'Desk', category: 'desk', x, y, rotation: 0, w: 1, d: 0.6, h: 0.75, ...(custom ? { custom: { parts: [] } } : {}) }) as unknown as FurnitureItem;
const snap = (m: SpaceModel, x: Partial<typeof extras> = {}): Snap => snapOf(m, { ...extras, ...x });

describe('guide steps', () => {
  it('has eight steps and a final Done', () => {
    expect(STEPS).toHaveLength(9);
    expect(STEPS.at(-1)).toMatchObject({ id: 'done', text: 'Done', target: [] });
    expect(STEPS.slice(0, -1).every((s) => s.section && s.target.length)).toBe(true);
  });

  it('size: moves on once the room size changes', () => {
    const m = base();
    const start = snap(m);
    expect(stepDone('size', start, snap(m))).toBe(false);
    const bigger = { ...m, spaces: m.spaces.map((s) => ({ ...s, polygon: s.polygon.map((p) => ({ ...p, x: p.x * 1.1 })) })) };
    expect(stepDone('size', start, snap(bigger))).toBe(true);
  });

  it('describe: needs new furniture, not the pieces already there', () => {
    const m = { ...base(), furniture: [piece('a')] };
    const start = snap(m);
    expect(stepDone('describe', start, snap(m))).toBe(false);
    expect(stepDone('describe', snap(base()), snap(base()))).toBe(false);
    expect(stepDone('describe', start, snap({ ...m, furniture: [piece('b'), piece('c')] }))).toBe(true);
  });

  it('view: two drags or scrolls on the views', () => {
    const m = base();
    const start = snap(m, { viewPokes: 3 });
    expect(stepDone('view', start, snap(m, { viewPokes: 4 }))).toBe(false);
    expect(stepDone('view', start, snap(m, { viewPokes: 5 }))).toBe(true);
  });

  it('follow-up: a piece moving counts, the same layout does not', () => {
    const m = { ...base(), furniture: [piece('a', 1, 1)] };
    const start = snap(m);
    expect(stepDone('followup', start, snap({ ...m, furniture: [piece('a', 1.001, 1)] }))).toBe(false);
    expect(stepDone('followup', start, snap({ ...m, furniture: [piece('a', 2.5, 0.4)] }))).toBe(true);
  });

  it('create: a custom piece placed', () => {
    const m = { ...base(), furniture: [piece('a')] };
    const start = snap(m);
    expect(stepDone('create', start, snap({ ...m, furniture: [piece('a'), piece('b')] }))).toBe(false);
    expect(stepDone('create', start, snap({ ...m, furniture: [piece('a'), piece('c', 1, 1, true)] }))).toBe(true);
  });

  it('walk and drill: a walk that stopped, a drill that ran', () => {
    const m = base();
    expect(stepDone('walk', snap(m), snap(m, { walkStops: 1 }))).toBe(true);
    expect(stepDone('drill', snap(m, { drills: 2 }), snap(m, { drills: 2 }))).toBe(false);
    expect(stepDone('drill', snap(m, { drills: 2 }), snap(m, { drills: 3 }))).toBe(true);
  });

  it('share and done never move on by themselves', () => {
    const m = base();
    const busy = snap({ ...m, furniture: [piece('z', 3, 3, true)] }, { drills: 9, viewPokes: 9, walkStops: 9 });
    expect(stepDone('share', snap(m), busy)).toBe(false);
    expect(stepDone('done', snap(m), busy)).toBe(false);
  });

  it('Back and Next stay inside the tour', () => {
    expect(moveStep(0, -1)).toBe(0);
    expect(moveStep(3, 1)).toBe(4);
    expect(moveStep(STEPS.length - 1, 1)).toBe(STEPS.length - 1);
  });
});

describe('guide arrow', () => {
  const card = { left: 60, top: 60, right: 340, bottom: 140 };
  it('points down at a control below the card', () => {
    const d = arrowPath(card, { left: 80, top: 200, right: 300, bottom: 232 })!;
    expect(d.startsWith('M190 140')).toBe(true);
    expect(d.endsWith('190 192')).toBe(true);
  });
  it('points right at the view beside the card', () => {
    const d = arrowPath(card, { left: 700, top: 48, right: 1200, bottom: 800 })!;
    expect(d.startsWith('M340 ')).toBe(true);
    expect(d.endsWith('692 128')).toBe(true);
  });
  it('turns up into a top-bar button to the right', () => {
    const d = arrowPath(card, { left: 900, top: 8, right: 932, bottom: 40 })!;
    expect(d).toBe('M340 72 Q916 72 916 48');
  });
  it('draws nothing when the target sits under the card', () => {
    expect(arrowPath(card, { left: 100, top: 80, right: 200, bottom: 120 })).toBeNull();
  });
});
