import { describe, expect, it } from 'vitest';
import { catalogEntry } from '../furniture/catalog';
import { rulesBrief, WALL_RECIPES } from './brief';
import { apply603010, colourShares, countOf, EYE_MAX, EYE_MIN, eyeCentre, fitOnWall, heroWall, hitsOpening, kitBrief, KITS, matchKit, namesIn, pairAround, STYLES } from './kits';

const SENTENCES: Array<[string, string]> = [
  ['a room for my cat named Gerard', 'cat'], ['kattrum åt Pelle', 'cat'], ['kissan huone', 'cat'],
  ['a cosy dog room for a puppy', 'dog'], ['rum för min hund', 'dog'], ['koiran huone', 'dog'],
  ['nursery for a newborn', 'nursery'], ['barnkammare för en bebis', 'nursery'], ['vauvan huone', 'nursery'],
  ['kids room for two kids', 'kids'], ['ett barnrum', 'kids'], ['lastenhuone kahdelle lapselle', 'kids'],
  ['teen room with a desk', 'teen'], ['tonårsrum', 'teen'], ['nuoren huone', 'teen'],
  ['gaming room for two', 'gaming'], ['ett spelrum', 'gaming'], ['pelihuone', 'gaming'],
  ['home office for two', 'office'], ['hemmakontor', 'office'], ['kotitoimisto', 'office'],
  ['podcast studio', 'podcast'], ['music studio with a piano', 'music'], ['musikstudio', 'music'], ['art studio for painting', 'art'], ['ateljé för målning', 'art'],
  ['reading nook by the window', 'nook'], ['lukunurkka', 'nook'], ['a small library', 'library'], ['bibliotek hemma', 'library'],
  ['home gym', 'gym'], ['kuntosali', 'gym'], ['yoga room', 'yoga'], ['yogarum', 'yoga'],
  ['home cinema', 'cinema'], ['biorum', 'cinema'], ['ramen bar for 10', 'ramen'], ['coffee shop', 'coffee'], ['kahvila', 'coffee'],
  ['cocktail bar', 'cocktail'], ['a pub', 'cocktail'], ['bakery', 'bakery'], ['bakeri med fika', 'bakery'], ['leipomo', 'bakery'],
  ['dentist waiting room', 'dentist'], ['tandläkare väntrum', 'dentist'], ['a clinic', 'clinic'], ['klassrum', 'classroom'], ['school classroom', 'classroom'],
  ['small shop', 'shop'], ['butik', 'shop'], ['hotel room', 'hotel'], ['hotellrum', 'hotel'], ['wizard library', 'library'], ['pink princess bedroom', 'bedroom'],
  ['space room', 'kids'], ['jungle kids room', 'kids'], ['1970s living room', 'living'],
];

describe('room kits', () => {
  it('has at least 24 worlds and 10 style layers', () => {
    expect(KITS.length).toBeGreaterThanOrEqual(24);
    expect(STYLES.length).toBeGreaterThanOrEqual(10);
  });

  it('every kit builds a valid brief with a hero, a palette and a light mood', () => {
    for (const k of KITS) {
      const b = kitBrief(k.id, { kit: k, styles: [] }, []);
      expect(b.palette, k.id).toHaveLength(5);
      expect(b.palette.every((c) => /^#[0-9a-f]{6}$/i.test(c)), k.id).toBe(true);
      expect(['warm', 'cool', 'neon']).toContain(b.light);
      const heroes = b.objects.filter((o) => o.hero);
      expect(heroes, k.id).toHaveLength(1);
      expect(heroes[0].mount).toBe('wall');
      expect(b.objects.filter((o) => o.mount !== 'wall').length, k.id).toBeGreaterThanOrEqual(4);
      expect(b.objects.filter((o) => o.mount === 'wall').length, k.id).toBeGreaterThanOrEqual(3);
      expect(b.objects.some((o) => o.text), k.id).toBe(true);
      for (const o of b.objects) {
        expect(o.name).toBeTruthy();
        if (o.source === 'catalogue') expect(catalogEntry(o.catalogId!), `${k.id}/${o.name}`).toBeTruthy();
        if (o.source === 'custom') {
          expect(o.sizeCm!.every((v) => v > 0), o.name).toBe(true);
          expect(o.prompt).toMatch(/[\d.]+ x [\d.]+ x [\d.]+ cm/);
          expect(o.catalogId ? !!catalogEntry(o.catalogId) : true, o.name).toBe(true);
        }
        if (o.mount === 'wall') {
          expect(WALL_RECIPES.has(o.recipe!), o.name).toBe(true);
          expect(o.eyeM!).toBeGreaterThanOrEqual(EYE_MIN);
          expect(o.eyeM!).toBeLessThanOrEqual(EYE_MAX);
        }
      }
    }
  });

  it('the matcher picks the right kit for sample sentences in three languages', () => {
    expect(SENTENCES.length).toBeGreaterThanOrEqual(40);
    for (const [s, id] of SENTENCES) expect(matchKit(s)?.kit.id, s).toBe(id);
  });

  it('style layers combine with any room', () => {
    const m = matchKit('wizard library')!;
    expect(m.styles.map((s) => s.id)).toContain('wizard');
    const b = kitBrief('a Japanese ramen bar', matchKit('a Japanese ramen bar')!, []);
    expect(b.objects.some((o) => o.text === 'ZEN')).toBe(true);
    expect(b.palette).toEqual(STYLES.find((s) => s.id === 'japanese')!.palette);
    expect(matchKit('industrial loft coffee shop')!.kit.id).toBe('coffee');
    expect(matchKit('1970s')!.styles[0].id).toBe('seventies');
  });

  it('prints names and multiplies beds for a number', () => {
    expect(namesIn('a room for my cat named Gerard')).toEqual(['Gerard']);
    expect(namesIn('rum som heter Lisa')).toEqual(['Lisa']);
    expect(namesIn('huone nimeltä Aino')).toEqual(['Aino']);
    expect(namesIn("Lily's reading nook")).toEqual(['Lily']);
    for (const s of ['bakery called Sunrise', 'ramen bar named Kenji', 'kids room for Max']) {
      const b = rulesBrief(s);
      expect(b.objects.some((o) => /^(SUNRISE|KENJI|MAX)$/i.test(o.text ?? '')), s).toBe(true);
      expect(b.objects.find((o) => o.hero)?.text, s).toMatch(/^(SUNRISE|KENJI|MAX)$/);
    }
    expect(countOf('a kids room for two kids')).toBe(2);
    expect(countOf('för två barn')).toBe(2);
    expect(countOf('kolme lasta')).toBe(3);
    expect(countOf('a room')).toBe(1);
    expect(rulesBrief('kids room for two kids').objects.find((o) => o.catalogId === 'bed-single')?.qty).toBe(2);
    expect(rulesBrief('kids room for two kids').objects.find((o) => o.catalogId === 'desk-120')?.qty).toBe(2);
  });
});

describe('art direction', () => {
  it('hangs decor at eye height', () => {
    expect(eyeCentre(2.2)).toBe(EYE_MAX);
    expect(eyeCentre(0.8)).toBe(EYE_MIN);
    expect(eyeCentre(1.5)).toBe(1.5);
  });
  it('puts the hero on the wall facing the door', () => {
    expect(heroWall(0, 4)).toBe(2);
    expect(heroWall(3, 4)).toBe(1);
    expect(heroWall(1, 6)).toBe(4);
  });
  it('keeps clear of windows and doors, with symmetric pairs', () => {
    const spans = [{ from: 1, to: 2, kind: 'window' as const }, { from: 3.2, to: 4, kind: 'door' as const }];
    expect(hitsOpening(1.5, 0.5, spans)).toBe(true);
    const x = fitOnWall(5, 0.5, spans, 1.5)!;
    expect(hitsOpening(x, 0.5, spans, 0.099)).toBe(false);
    expect(fitOnWall(1, 2, [], 0.5)).toBeNull();
    const p = pairAround(2.5, 0.9, 0.5, 5)!;
    expect(2.5 - p[0]).toBeCloseTo(p[1] - 2.5);
    expect(pairAround(0.6, 0.9, 0.5, 5)).toBeNull();
  });
  it('splits colour 60/30/10', () => {
    for (const k of KITS) {
      const b = kitBrief(k.id, { kit: k, styles: [] }, []);
      const s = colourShares(b.objects, b.palette);
      expect(s.dominant, k.id).toBeGreaterThanOrEqual(s.secondary);
      expect(s.dominant, k.id).toBeGreaterThan(0.3);
      expect(b.objects.find((o) => o.hero)!.color).toBe(b.palette[4]);
      expect(b.objects.filter((o) => o.mount === 'wall' && !o.hero && o.recipe !== 'neon').every((o) => o.color === b.palette[3])).toBe(true);
    }
    const out = apply603010([{ source: 'catalogue', name: 'a', catalogId: 'sofa-3' }, { source: 'catalogue', name: 'b', catalogId: 'armchair' }], ['#111111', '#222222', '#333333', '#444444', '#555555']);
    expect(out[0].color).toBe('#111111');
  });
});
