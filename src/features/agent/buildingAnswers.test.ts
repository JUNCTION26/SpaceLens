import { describe, expect, it } from 'vitest';
import { door, item, model, rect, space } from '../safety/fixtures';
import { answerWithHighlight, answerFromModel } from './answer';
import type { AnswerState } from './answer';

// Living room 5 x 4 (front door, window), bedroom 3 x 4 (window), bathroom 2 x 1.4 with a 0.7 m door and no window.
const win = (id: string, spaceId: string, wall: number, off: number, w: number) => ({ ...door(id, spaceId, wall, off, w, 'none', 'window'), heightM: 1.2, sillM: 0.9 });
const plan = model(
  [space('liv', 'Living room', rect(0, 0, 5, 4)), space('bed', 'Bedroom', rect(5, 0, 3, 4)), space('bath', 'Bathroom', rect(0, 4, 2, 1.4))],
  [door('front', 'liv', 3, 2, 0.9, 'out'), door('inner', 'liv', 1, 2, 0.8, 'in'), door('bathd', 'liv', 2, 4, 0.7, 'in'),
    win('w1', 'liv', 0, 2.5, 1.5), win('w2', 'bed', 0, 1.5, 1)],
  [item('bed1', 'bed', 6.8, 1.0, 1.6, 2.0, { name: 'Double bed' }), item('desk1', 'desk', 1, 1, 1.2, 0.6, { name: 'Desk' })],
);
const st: AnswerState = { model: plan };
const text = (q: string) => answerFromModel(q, st);
const hl = (q: string) => answerWithHighlight(q, st)?.highlight;

describe('whole plan answers', () => {
  it('counts rooms', () => expect(text('how many rooms are there')).toBe('3 rooms'));
  it('counts rooms in Swedish', () => expect(text('hur många rum finns det')).toBe('3 rum'));
  it('counts rooms in Finnish', () => expect(text('montako huonetta on')).toBe('3 huonetta'));
  it('lists rooms with areas', () => expect(text('list the rooms')).toBe('3 rooms: Living room 20, Bedroom 12, Bathroom 2.8 m²'));
  it('lists rooms in Swedish', () => expect(text('vilka rum finns')).toContain('3 rum'));
  it('total area', () => expect(text('what is the total area')).toBe('34.8 m² in total, 3 rooms'));
  it('total area in Swedish', () => expect(text('hur stor yta har lägenheten')).toContain('34.8 m²'));
  it('total area in Finnish', () => expect(text('mikä on koko pinta-ala')).toContain('34.8 m²'));
  it('biggest room', () => expect(text('which is the biggest room')).toBe('20 m², Living room is the biggest room'));
  it('biggest room in Swedish', () => expect(text('vilket är det största rummet')).toContain('Living room'));
  it('biggest room in Finnish', () => expect(text('mikä on suurin huone')).toContain('Living room'));
  it('smallest room', () => expect(text('what is the smallest room')).toBe('2.8 m², Bathroom is the smallest room'));
  it('area of a named room', () => expect(text('what is the area of the bedroom')).toBe('12 m², Bedroom, 3 by 4'));
  it('area of a named room in Swedish', () => expect(text('hur stor yta har sovrummet')).toContain('12 m²'));
  it('area of a named room in Finnish', () => expect(text('mikä on makuuhuoneen pinta-ala')).toContain('12 m²'));
  it('rooms without a window', () => expect(text('which rooms have no window')).toBe('1 room without a window: Bathroom'));
  it('rooms without a window in Swedish', () => expect(text('vilka rum saknar fönster')).toContain('Bathroom'));
  it('rooms without a window in Finnish', () => expect(text('mitkä huoneet ovat ilman ikkunaa')).toContain('Bathroom'));
  it('rooms that connect', () => expect(text('which rooms connect to the living room')).toBe('2: Bedroom, Bathroom connect to Living room'));
  it('connections in Swedish', () => expect(text('vilka rum ansluter till vardagsrummet')).toContain('Bedroom'));
  it('walking route and distance', () => {
    const a = answerWithHighlight('how far is it to walk from the bedroom to the bathroom', st)!;
    expect(a.text).toMatch(/^\d+(\.\d)? m, Bedroom to Bathroom, 2 doors$/);
    expect(a.highlight?.openingIds).toEqual(['inner', 'bathd']);
    expect(a.highlight?.route?.length).toBe(5);
  });
  it('route in Swedish', () => expect(text('vägen från sovrummet till badrummet')).toContain('Bedroom till Bathroom'));
  it('route in Finnish', () => expect(text('kuinka kaukana makuuhuone on kylpyhuoneesta')).toContain('Bedroom - Bathroom'));
  it('nearest exit', () => {
    const a = answerWithHighlight('how far is the nearest exit from the bedroom', st)!;
    expect(a.text).toMatch(/^\d+(\.\d)? m from Bedroom to the nearest exit$/);
    expect(a.highlight?.openingIds).toEqual(['inner', 'front']);
  });
  it('nearest exit in Swedish', () => expect(text('hur långt är närmaste utgång från sovrummet')).toContain('från Bedroom'));
  it('nearest exit in Finnish', () => expect(text('kuinka pitkä matka makuuhuoneesta on uloskäynnille')).toContain('Bedroom'));
  it('longest escape', () => {
    const a = answerWithHighlight('what is the longest escape distance', st)!;
    expect(a.text).toMatch(/m from Bedroom to the exit$/);
    expect(a.highlight?.spaceIds).toEqual(['bed']);
  });
  it('narrowest door', () => expect(text('which is the narrowest door')).toBe('0.7 m, the Living room door'));
  it('narrowest door highlight', () => expect(hl('narrowest door')?.openingIds).toEqual(['bathd']));
  it('narrowest door in Swedish', () => expect(text('vilken är den smalaste dörren')).toContain('0.7 m'));
  it('narrowest door in Finnish', () => expect(text('mikä on kapein ovi')).toContain('0.7 m'));
  it('wheelchair doors', () => expect(text('which doors are too narrow for a wheelchair')).toBe('1 door under 0.8 m: Living room'));
  it('doors under 0.8', () => expect(hl('doors under 0.8 m')?.openingIds).toEqual(['bathd']));
  it('wheelchair in Swedish', () => expect(text('vilka dörrar är för smala för rullstol')).toContain('1 dörr'));
  it('turning circle', () => expect(text('which rooms are too small for a 1.5 m turning circle')).toBe('1 room too small for 1.5 m turning: Bathroom'));
  it('turning circle in Finnish', () => expect(hl('mitkä huoneet ovat liian pieniä kääntöympyrälle')?.spaceIds).toEqual(['bath']));
  it('people the plan suits', () => expect(text('how many people can live here')).toBe('2 persons sleep, 1 desk'));
  it('daylight of a room', () => expect(text('daylight in the living room')).toBe('9% window to floor, Living room'));
  it('daylight lowest', () => expect(text('which room has the least daylight')).toContain('Bathroom'));
  it('daylight in Swedish', () => expect(text('hur mycket dagsljus har sovrummet')).toBe('10% fönster mot golv, Bedroom'));
  it('paint area', () => expect(text('how much wall area do I need to paint')).toMatch(/^\d+(\.\d)? m² of wall to paint/));
  it('paint a named room', () => expect(text('how much to paint in the bedroom')).toBe('32.1 m² of wall to paint, openings removed'));
  it('paint in Swedish', () => expect(text('hur mycket vägg ska jag måla')).toContain('vägg att måla'));
  it('total wall length', () => expect(text('what is the total wall length')).toBe('38.8 m of wall in total'));
  it('flooring with waste', () => expect(text('how much flooring do I need to buy')).toBe('38.3 m² of flooring, with 10% waste'));
  it('flooring in Finnish', () => expect(text('paljonko lattiaa tarvitsen ostaa')).toContain('38.3 m²'));
  it('skirting of a room', () => expect(text('how much skirting for the bedroom')).toBe('13.2 m of skirting for Bedroom, doors removed'));
  it('where does a sofa fit', () => {
    const a = answerWithHighlight('where does a 2.5 m sofa fit', st)!;
    expect(a.text).toBe('2 rooms fit 2.5 m: Living room, Bedroom');
    expect(a.highlight?.spaceIds).toEqual(['liv', 'bed']);
  });
  it('a wide item fits only the living room', () => expect(text('which room fits a 4.5 x 1 m shelf')).toBe('1 room fit 4.5 by 1 m: Living room'));
  it('fit in Swedish', () => expect(text('var får en 2,5 m soffa plats')).toContain('Living room'));
  it('compare two rooms', () => expect(text('compare the living room and the bedroom')).toBe('Living room 20 m² vs Bedroom 12 m², 8 m² difference'));
  it('compare in Swedish', () => expect(text('jämför sovrummet och badrummet')).toContain('Bedroom 12 m² mot Bathroom 2.8 m²'));
  it('highlights name real ids', () => {
    const ids = new Set(plan.spaces.map((s) => s.id));
    for (const q of ['how many rooms', 'biggest room', 'rooms with no window', 'nearest exit from the bathroom']) for (const id of hl(q)?.spaceIds ?? []) expect(ids.has(id)).toBe(true);
  });
  it('answers stay within 14 words', () => {
    for (const q of ['list the rooms', 'which rooms connect to the living room', 'where does a 2.5 m sofa fit', 'compare the living room and the bedroom', 'how far from the bedroom to the bathroom'])
      expect(text(q)!.split(/\s+/).length).toBeLessThanOrEqual(14);
  });
  it('commands are not questions', () => expect(text('add a desk to the bedroom')).toBeNull());
  it('single-string wrapper matches', () => expect(answerWithHighlight('how many rooms', st)?.text).toBe(text('how many rooms')));
});
