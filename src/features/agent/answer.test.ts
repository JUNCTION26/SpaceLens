import { describe, expect, it } from 'vitest';
import { sampleRoom } from '../../core/sample';
import type { FurnitureItem, LayoutCandidate, SpaceModel } from '../../core/types';
import { answerFromModel, type AnswerState } from './answer';
import { offlineReply } from './offline';

const item = (id: string, name: string, over: Partial<FurnitureItem> = {}): FurnitureItem => ({
  id, catalogId: `${name.toLowerCase()}-1`, name, category: name.toLowerCase(), x: 1, y: 1, rotation: 0, w: 1, d: 1, h: 0.8,
  clearance: { front: 0, back: 0, left: 0, right: 0 }, locked: false, owned: false, priceSek: 1000, priceStatus: 'catalog',
  color: '#fff', sourceKind: 'catalog', ...over,
});

function room(furniture: FurnitureItem[] = [], extra: Partial<AnswerState> = {}): AnswerState {
  const model: SpaceModel = { ...sampleRoom(), furniture };
  return { model, requirements: null, candidates: [], activeCandidateId: null, ...extra };
}

const sofa = item('a', 'Sofa', { x: 1.5, y: 3, w: 2, d: 0.9, priceSek: 5000 });
const desk = item('b', 'Desk', { x: 0.4, y: 1.4, w: 1.4, d: 0.7, rotation: -Math.PI / 2, priceSek: 2000 });
const bed = item('c', 'Bed', { x: 2.5, y: 1, w: 1.6, d: 2.0, priceSek: 8000 });
const full = room([sofa, desk, bed]);

describe('answerFromModel', () => {
  it('room size', () => expect(answerFromModel('what is the room size?', full)).toBe('14.3 m², 3.4 by 4.2'));
  it('area only', () => expect(answerFromModel('what is the area', full)).toBe('14.3 m²'));
  it('ceiling height', () => expect(answerFromModel('how high is the ceiling', full)).toBe('2.5 m ceiling'));
  it('perimeter', () => expect(answerFromModel('what is the perimeter', full)).toBe('15.2 m around'));
  it('doors', () => expect(answerFromModel('how many doors are there', full)).toBe('1 door, 0.8 m wide'));
  it('windows', () => expect(answerFromModel('how wide is the window', full)).toBe('1 window, 1.4 m wide'));
  it('item count', () => expect(answerFromModel('how many items are in the room', full)).toBe('3 items'));
  it('item list', () => expect(answerFromModel('what furniture is in the room', full)).toBe('3 items: sofa, desk, bed'));
  it('total price', () => expect(answerFromModel('what is the total price', full)).toBe('15 000 SEK in total'));
  it('budget left', () => {
    const s = room([sofa, desk], { requirements: { budgetSek: 10000 } as never });
    expect(answerFromModel('how much budget is left', s)).toBe('3 000 SEK left of 10 000 SEK');
  });
  it('no budget set', () => expect(answerFromModel('budget left?', full)).toContain('No budget set'));
  it('largest item', () => expect(answerFromModel('what is the largest item', full)).toBe('Bed, 3.2 m²'));
  it('free floor percent', () => expect(answerFromModel('how much free floor space is left', room([bed]))).toBe('78% free floor'));
  it('facing direction', () => expect(answerFromModel('what is the sofa facing', full)).toBe('South, the sofa'));
  it('facing of rotated item', () => expect(answerFromModel('which way is the desk facing', full)).toBe('East, the desk'));
  it('next to an item', () => expect(answerFromModel('what is next to the sofa', full)).toMatch(/^(Desk|Bed), [\d.]+ m away$/));
  it('distance between items', () => expect(answerFromModel('distance between the sofa and the desk', full)).toBe('1.9 m centre to centre, 0.5 m gap'));
  it('fits through door', () => expect(answerFromModel('does the sofa fit through the door?', full)).toBe('No, 0.9 m side, door 0.8 m'));
  it('fits when narrow', () => expect(answerFromModel('will the desk fit through the door', full)).toBe('Yes, 0.7 m side, door 0.8 m'));
  it('failed checks', () => {
    const cand = { id: 'c1', checks: [{ result: 'fail' }, { result: 'pass' }, { result: 'fail' }] } as unknown as LayoutCandidate;
    expect(answerFromModel('how many checks fail', room([], { candidates: [cand], activeCandidateId: 'c1' }))).toBe('2 of 3 checks fail');
  });
  it('no checks yet', () => expect(answerFromModel('any problems?', full)).toBe('No checks run yet.'));
  it('Swedish size', () => expect(answerFromModel('hur stor är rummets storlek?', full)).toBe('14.3 m², 3.4 by 4.2'));
  it('Swedish area', () => expect(answerFromModel('hur stor yta har rummet', full)).toContain('14.3 m²'));
  it('Swedish ceiling', () => expect(answerFromModel('hur hög är takhöjden', full)).toBe('2.5 m ceiling'));
  it('Finnish size', () => expect(answerFromModel('mikä on huoneen koko', full)).toBe('14.3 m², 3.4 by 4.2'));
  it('Finnish area', () => expect(answerFromModel('mikä on pinta-ala', full)).toBe('14.3 m²'));
  it('Finnish doors', () => expect(answerFromModel('montako ovea on', full)).toBe('1 door, 0.8 m wide'));
  it('Swedish item count', () => expect(answerFromModel('hur många möbler finns det', full)).toBe('3 items'));
  it('unknown falls through', () => {
    expect(answerFromModel('add a desk by the window', full)).toBeNull();
    expect(answerFromModel('make a ramen bar for 10', full)).toBeNull();
    expect(answerFromModel('', full)).toBeNull();
  });
  it('answers stay under 12 words', () => {
    for (const q of ['what is the room size', 'what furniture is in the room', 'distance between the sofa and the desk']) {
      expect(answerFromModel(q, full)!.split(/\s+/).length).toBeLessThan(12);
    }
  });
});

describe('offline path', () => {
  it('answers the room size without a key', () => {
    const r = offlineReply('what is the room size?', false, () => false, full);
    expect(r.say).toBe('14.3 m², 3.4 by 4.2');
    expect(r.actions).toEqual([]);
  });
  it('still handles commands', () => {
    expect(offlineReply('add a desk by the window', false, () => false, full).actions.length).toBe(1);
  });
});
