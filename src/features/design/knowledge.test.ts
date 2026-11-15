import { describe, expect, it } from 'vitest';
import type { FurnitureItem } from '../../core/types';
import { makeItem } from '../furniture/catalog';
import { opening, rect, room } from '../referee/fixtures';
import { critiqueKnowledge, evaluateKnowledge, inferUse, PROGRAMMES, programmeFor, RELATION_DEFS, repairRelations, type RoomUse } from './knowledge';

const ids = (p: { items: Array<[string, number]> }) => Object.fromEntries(p.items);
const put = (id: string, x: number, y: number, rotation = 0, key = id): FurnitureItem => ({ ...makeItem(id, { x, y, rotation }), id: key });

describe('room programmes', () => {
  it('covers every room use with essentials and chips stay 1-3 words', () => {
    const uses: RoomUse[] = ['bedroom-single', 'bedroom-double', 'bedroom-kids', 'bedroom-guest', 'living', 'home-office', 'studio', 'dining', 'kitchen-dining', 'hallway', 'bathroom', 'nursery', 'teen', 'gaming', 'reading', 'open-office', 'meeting', 'reception', 'cafe', 'shop', 'classroom', 'clinic-waiting'];
    for (const u of uses) expect(PROGRAMMES[u].essentials.length).toBeGreaterThan(0);
    for (const d of RELATION_DEFS) for (const c of [d.okChip, d.badChip]) expect(c.split(' ').length).toBeLessThanOrEqual(3);
    expect(RELATION_DEFS.filter((d) => d.hard).map((d) => d.id)).toEqual(expect.arrayContaining(['door-swing', 'bed-headboard', 'desk-pullback', 'dining-pullout']));
  });

  it('a 6 m² single bedroom gets only the essentials', () => {
    const p = programmeFor('bedroom-single', 6);
    expect(ids(p)).toEqual({ 'bed-single': 1, nightstand: 1, 'wardrobe-100': 1 });
    expect(p.band).toBe('tiny');
    expect(p.compromises.some((c) => c.kind === 'dropped' && c.id === 'desk-120')).toBe(true);
  });

  it('a 9 m² double bedroom swaps to the narrow wardrobe and says so', () => {
    const p = programmeFor('bedroom-double', 9);
    expect(ids(p)['wardrobe-100']).toBe(1);
    expect(ids(p)['wardrobe-150']).toBeUndefined();
    expect(ids(p).nightstand).toBe(2);
    expect(p.compromises).toContainEqual(expect.objectContaining({ kind: 'swapped', id: 'wardrobe-150', to: 'wardrobe-100' }));
  });

  it('a small living room takes a 2-seat sofa and never a bookshelf with the armchair', () => {
    const p = programmeFor('living', 12);
    expect(ids(p)['sofa-2']).toBe(1);
    expect(ids(p)['sofa-3']).toBeUndefined();
    expect(ids(p).bookshelf).toBeUndefined();
    const big = programmeFor('living', 26);
    expect(ids(big)['sofa-3']).toBe(1);
    expect(ids(big)['rug-200']).toBe(1);
    expect(ids(big).armchair).toBeGreaterThanOrEqual(1);
  });

  it('seats scale with people and are capped by floor area', () => {
    expect(ids(programmeFor('dining', 12, 4))).toMatchObject({ 'dining-4': 1, chair: 4 });
    expect(ids(programmeFor('dining', 16, 6))).toMatchObject({ 'dining-6': 1, chair: 6 });
    const office = programmeFor('open-office', 40, 9);
    expect(ids(office)['desk-140']).toBe(6);
    expect(office.compromises).toContainEqual(expect.objectContaining({ kind: 'capped', wanted: 9, given: 6 }));
    expect(ids(programmeFor('cafe', 30, 16))).toMatchObject({ 'cafe-4': 4, chair: 16, counter: 1 });
    expect(ids(programmeFor('classroom', 56, 20))).toMatchObject({ 'desk-120': 10, chair: 20, 'desk-140': 1, 'tv-unit': 1 });
  });

  it('a studio under 24 m² uses the table as the desk', () => {
    const p = programmeFor('studio', 20);
    expect(ids(p)['bed-single']).toBe(1);
    expect(ids(p)['desk-120']).toBeUndefined();
    expect(ids(p)['desk-chair']).toBeUndefined();
  });

  it('a 5 m² bathroom never gets both shower and bath; a too-small room is flagged', () => {
    expect(ids(programmeFor('bathroom', 5)).bathtub).toBeUndefined();
    expect(programmeFor('classroom', 20).compromises.some((c) => c.kind === 'too-small')).toBe(true);
  });

  it('guesses the use from the furniture', () => {
    const f = (...c: string[]) => c.map((id) => makeItem(id));
    expect(inferUse(f('bed-double', 'nightstand'), 12)).toBe('bedroom-double');
    expect(inferUse(f('sofa-3', 'tv-unit'), 20)).toBe('living');
    expect(inferUse(f('desk-140', 'office-chair'), 8)).toBe('home-office');
    expect(inferUse(f('crib', 'dresser'), 7)).toBe('nursery');
  });
});

describe('measurable relations on hand-placed layouts', () => {
  // 3.4 x 4 m bedroom, door on the bottom wall near the left corner (swings in), window top centre.
  const m = room(rect(3.4, 4), [opening('door', 'door', 2, 2.9, 0.8, 'in'), opening('win', 'window', 0, 1.7, 1.2)]);

  it('a good bedroom: headboard on the side wall, nightstands flanking, all hard relations hold', () => {
    // Bed head on the right wall (x = 3.4), facing -x.
    const rot = Math.PI / 2; // front = (-1, 0)
    const f = [put('bed-double', 3.4 - 1.0, 2.0, rot, 'bed'), put('nightstand', 3.4 - 0.2, 2.0 - 0.7 - 0.245, rot, 'n1'), put('nightstand', 3.4 - 0.2, 2.0 + 0.7 + 0.245, rot, 'n2')];
    const r = evaluateKnowledge(m, f, 'bedroom-double');
    expect(r.hardBroken.map((v) => v.id)).toEqual([]);
    expect(r.good).toEqual(expect.arrayContaining(['Headboard on wall', 'Nightstands flank']));
    expect(r.verdicts.find((v) => v.id === 'pair-symmetry')?.pass).toBe(true);
  });

  it('a bed floating in the door swing breaks hard relations and the critic says what to move where', () => {
    const f = [put('bed-double', 0.75, 2.6, 0, 'bed')];
    const r = evaluateKnowledge(m, f, 'bedroom-double');
    expect(r.hardBroken.map((v) => v.id)).toEqual(expect.arrayContaining(['bed-headboard']));
    expect(r.score).toBeLessThanOrEqual(30);
    const crit = critiqueKnowledge(m, f, 'bedroom-double');
    expect(crit[0].hard).toBe(true);
    expect(crit[0].repair?.itemId).toBe('bed');
    const rels = repairRelations(crit);
    expect(rels.length).toBe(1);
    expect(['against-wall', 'apart-from', 'centered-on']).toContain(rels[0].kind);
  });

  it('desk facing the window reads as glare; turned side-on it reads as side-lit', () => {
    const office = room(rect(3, 3), [opening('door', 'door', 2, 2.5, 0.8, 'in'), opening('win', 'window', 0, 1.5, 1.2)]);
    // Back to the window wall, sitter looks at the window: front faces +y.
    const facing = evaluateKnowledge(office, [put('desk-120', 1.5, 0.3, 0, 'd'), put('office-chair', 1.5, 0.95, Math.PI, 'c')], 'home-office');
    expect(facing.verdicts.find((v) => v.id === 'desk-light')?.chip).toBe('Faces window');
    // Against the left wall, front facing +x: window to the side.
    const side = evaluateKnowledge(office, [put('desk-120', 0.3, 1.0, -Math.PI / 2, 'd')], 'home-office');
    const v = side.verdicts.find((x) => x.id === 'desk-light')!;
    expect(v.pass).toBe(true);
    expect(v.chip).toBe('Desk side-lit');
  });

  it('coffee table at 45 cm passes, at 1 m it asks to pull it in by about 55 cm', () => {
    const lr = room(rect(4, 5), [opening('door', 'door', 2, 3.5, 0.9, 'in'), opening('win', 'window', 1, 2.5, 1.6)]);
    const sofa = put('sofa-3', 2, 0.46, 0, 's'); // back on the top wall, facing +y
    const near = evaluateKnowledge(lr, [sofa, put('coffee-table', 2, 0.92 + 0.45 + 0.3, 0, 'c')], 'living');
    expect(near.verdicts.find((v) => v.id === 'coffee-reach')?.pass).toBe(true);
    const far = critiqueKnowledge(lr, [sofa, put('coffee-table', 2, 0.92 + 1.0 + 0.3, 0, 'c')], 'living');
    const fix = far.find((c) => c.relation === 'coffee-reach')!;
    expect(fix.repair?.action).toBe('pull-in');
    expect(fix.repair?.byM).toBeCloseTo(0.55, 1);
    expect(fix.repair?.relation).toMatchObject({ kind: 'in-front-of', subject: 'c', target: 's', distanceM: [0.4, 0.5] });
  });

  it('a wardrobe in front of the window and a chair against the wall are both hard failures', () => {
    const dr = room(rect(3, 4), [opening('door', 'door', 2, 2.5, 0.8, 'in'), opening('win', 'window', 0, 1.5, 1.2)]);
    const r = evaluateKnowledge(dr, [put('wardrobe-100', 1.5, 0.3, 0, 'w'), put('dining-4', 1.5, 2.6, 0, 't'), put('chair', 1.5, 3.75, Math.PI, 'ch')], 'dining');
    const hard = r.hardBroken.map((v) => v.id);
    expect(hard).toContain('tall-window');
    expect(hard).toContain('dining-pullout');
  });
});
