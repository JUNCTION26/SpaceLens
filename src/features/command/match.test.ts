import { describe, expect, it } from 'vitest';
import { distance, rank } from './match';

const cmds = [
  { id: 'nav:movein', label: 'Move in', words: 'movein carry furniture door' },
  { id: 'nav:render', label: 'Render', words: 'picture image' },
  { id: 'nav:walk', label: 'Walk', words: 'first person' },
  { id: 'export:ifc', label: 'Export IFC', words: 'bim revit' },
  { id: 'export:dxf', label: 'Export DXF', words: 'cad autocad' },
  { id: 'nav:export', label: 'Export', words: 'deliver pdf' },
  { id: 'undo', label: 'Undo', words: 'back' },
  { id: 'theme:dark', label: 'Dark theme', words: 'night' },
  { id: 'theme:light', label: 'Light theme', words: 'day' },
];
const top = (q: string, recent: string[] = []) => rank(cmds, q, recent)[0]?.id;

describe('distance', () => {
  it('counts swaps as one edit', () => { expect(distance('wlak', 'walk')).toBe(1); expect(distance('abc', 'abc')).toBe(0); });
});

describe('rank', () => {
  it('finds Move in from a typo', () => { expect(top('movin')).toBe('nav:movein'); expect(top('move')).toBe('nav:movein'); });
  it('finds Export IFC from ifc', () => { expect(top('ifc')).toBe('export:ifc'); });
  it('tolerates transposed letters', () => { expect(top('wlak')).toBe('nav:walk'); expect(top('rendr')).toBe('nav:render'); });
  it('matches synonyms', () => { expect(top('autocad')).toBe('export:dxf'); expect(top('night')).toBe('theme:dark'); });
  it('prefers an exact label', () => { expect(top('export')).toBe('nav:export'); });
  it('requires every word', () => { expect(top('export zzz')).toBeUndefined(); });
  it('returns nothing for gibberish', () => { expect(rank(cmds, 'qqqxx')).toEqual([]); });
  it('puts recent commands first without a query', () => {
    expect(rank(cmds, '', ['undo', 'nav:walk']).slice(0, 2).map((c) => c.id)).toEqual(['undo', 'nav:walk']);
  });
  it('boosts recent commands on ties', () => {
    expect(top('exp', ['export:dxf'])).toBe('export:dxf');
  });
});
