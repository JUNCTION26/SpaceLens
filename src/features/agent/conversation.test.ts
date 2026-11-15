import { describe, expect, it } from 'vitest';
import {
  applyGoals, budgetVerdict, compareFacts, D, emptyConversation, goalsBrief, hasGoals, mergeGoals, parseGoals, parseWhatIf,
  planFor, planTurn, remember, sayParts, stretchPolygon, tidy,
} from './conversation';
import type { Requirements } from '../../core/types';

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const req = (over: Partial<Requirements> = {}): Requirements => ({ items: [], notes: [], minRouteWidthM: 0.8, ...over } as Requirements);

describe('goals', () => {
  it('reads a budget in three languages and units', () => {
    expect(parseGoals('budget 15000').budgetSek).toBe(15000);
    expect(parseGoals('budget 15 000 kr').budgetSek).toBe(15000);
    expect(parseGoals('jag har en budget på 12k').budgetSek).toBe(12000);
    expect(parseGoals('enintään 8000 euroa').budgetSek).toBe(8000);
    expect(parseGoals('put the lamp under the window').budgetSek).toBeUndefined();
  });
  it('reads work from home, wheelchair and avoided items', () => {
    expect(parseGoals('I work from home').workFromHome).toBe(true);
    expect(parseGoals('jag jobbar hemifrån').workFromHome).toBe(true);
    expect(parseGoals('I use a wheelchair').wheelchair).toBe(true);
    expect(parseGoals('no rugs please').avoid).toContain('rug');
  });
  it('goals accumulate across turns and never shrink', () => {
    let g = mergeGoals({ avoid: [] }, parseGoals('budget 9000'));
    g = mergeGoals(g, parseGoals('I work from home'));
    g = mergeGoals(g, parseGoals('no rugs'));
    g = mergeGoals(g, parseGoals('what colour is the sofa'));
    expect(g).toMatchObject({ budgetSek: 9000, workFromHome: true, avoid: ['rug'] });
    expect(hasGoals(g)).toBe(true);
    expect(goalsBrief(g)).toMatch(/budget 9000 SEK.*work from home.*no rug/);
    expect(mergeGoals(g, { budgetSek: 7000 }).budgetSek).toBe(7000);
  });
  it('applies goals to requirements without loosening them', () => {
    const r = applyGoals(req({ budgetSek: 5000, items: [{ catalogId: 'rug-200', qty: 1 }, { catalogId: 'desk-120', qty: 1 }] }), { budgetSek: 15000, avoid: ['rug'], wheelchair: true });
    expect(r.budgetSek).toBe(5000);
    expect(r.items.map((i) => i.catalogId)).toEqual(['desk-120']);
    expect(r.minRouteWidthM).toBeGreaterThanOrEqual(0.9);
    expect(applyGoals(req(), { budgetSek: 15000, avoid: [] }).budgetSek).toBe(15000);
  });
});

describe('plans', () => {
  const g = { avoid: [] };
  it('design then check becomes a plan, one step alone does not', () => {
    const p = planFor('furnish this as a guest room and check a wheelchair can turn', g)!;
    expect(p.checks).toEqual(['turn']);
    expect(p.purpose).toMatch(/guest/);
    expect(planFor('furnish this as a guest room', g)).toBeNull();
    expect(planFor('check the room and add a desk', g)).toBeNull();
  });
  it('a design request with a budget gets a budget check, even in one clause', () => {
    const p = planTurn('design a room for working from home, budget 15000', g)!;
    expect(p.checks).toContain('budget');
    expect(p.brief).toMatch(/budget 15000/);
    expect(planTurn('design a room', g)).toBeNull();
    expect(planTurn('design a room', { avoid: [], budgetSek: 9000 })!.checks).toEqual(['budget']);
  });
  it('plans in Swedish and Finnish', () => {
    expect(planFor('inred som gästrum och kontrollera att en rullstol kan vända', g)?.checks).toContain('turn');
    expect(planTurn('sisusta huone, budjetti 9000', g)?.checks).toContain('budget');
  });
});

describe('what if', () => {
  it('reads the direction and amount in three languages', () => {
    expect(parseWhatIf('what if the room were 1 m wider')).toEqual({ axis: 'x', deltaM: 1 });
    expect(parseWhatIf('what if it was 50 cm longer')).toEqual({ axis: 'y', deltaM: 0.5 });
    expect(parseWhatIf('tänk om rummet var 1,5 m bredare')).toEqual({ axis: 'x', deltaM: 1.5 });
    expect(parseWhatIf('entä jos huone olisi 2 m pidempi')).toEqual({ axis: 'y', deltaM: 2 });
    expect(parseWhatIf('make the room wider')).toBeNull();
  });
  it('stretches the far side only', () => {
    const poly = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }];
    expect(stretchPolygon(poly, 'x', 1)).toEqual([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 3 }, { x: 0, y: 3 }]);
    expect(poly[1].x).toBe(4);
  });
  it('compares in a sentence that says the room is unchanged', () => {
    const s = compareFacts('en', { openM2: 6, fails: 2 }, { openM2: 9, fails: 1 });
    expect(s).toMatch(/3 m² more open floor/);
    expect(s).toMatch(/1 checks fail instead of 2/);
    expect(words(s)).toBeLessThanOrEqual(20);
    expect(compareFacts('sv', { openM2: 6, fails: 0 }, { openM2: 5, fails: 0 })).toMatch(/1 m² mindre fri golvyta/);
  });
});

describe('short replies', () => {
  const long = 'I looked at the whole room and found that the desk sits close to the door, the sofa blocks the window, and the rug is too small for the seating area.';
  it('cuts to 20 words at a sentence, never mid-way through a list', () => {
    expect(words(tidy(long))).toBeLessThanOrEqual(20);
    expect(tidy('First thing. Second thing is here. Third thing follows after that for many, many words more than twenty in total, really.')).toBe('First thing. Second thing is here.');
    expect(tidy('- one\n- two\n- three')).toBe('one. two. three');
    expect(tidy('Short.')).toBe('Short.');
  });
  it('sayParts drops whole later parts instead of cutting them', () => {
    const out = sayParts(['Designing it now.', 'The best is the quiet corner layout with the desk by the window facing north.', 'Check the budget too.'], 12);
    expect(words(out)).toBeLessThanOrEqual(12);
    expect(out.startsWith('Designing it now.')).toBe(true);
  });
  it('every template stays under 20 words in all three languages', () => {
    for (const lang of ['en', 'sv', 'fi'] as const) {
      const lines = [D(lang, 'designing'), budgetVerdict(lang, 14200, 15000), budgetVerdict(lang, 17000, 15000), D(lang, 'turnNo'), D(lang, 'goalSaved')];
      for (const l of lines) { expect(l.length).toBeGreaterThan(0); expect(words(l)).toBeLessThanOrEqual(20); }
    }
  });
});

describe('budget verdict and memory of referred things', () => {
  it('says within and over budget', () => {
    expect(budgetVerdict('en', 14200, 15000)).toBe('14200 SEK of 15000');
    expect(budgetVerdict('en', 17000, 15000)).toMatch(/over budget by 2000/);
    expect(budgetVerdict('sv', 17000, 15000)).toMatch(/2000 över budget/);
    expect(budgetVerdict('fi', 100)).toBe('100 SEK');
  });
  it('remembers the latest things first, at most six', () => {
    let c = emptyConversation();
    c = remember(c, { items: ['a', 'b'] });
    c = remember(c, { items: ['c', 'a'] });
    expect(c.items.slice(0, 3)).toEqual(['c', 'a', 'b']);
    c = remember(c, { items: ['d', 'e', 'f', 'g'] });
    expect(c.items).toHaveLength(6);
  });
});
