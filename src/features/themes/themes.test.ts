import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ObjectSpec } from '../../core/types';
import { opening, rect, room } from '../referee/fixtures';
import { validateLayout } from '../referee/validate';

const aiState = { ready: false, reply: null as unknown };
vi.mock('../../core/ai', async (orig) => {
  const real = await orig<typeof import('../../core/ai')>();
  return {
    ...real,
    aiReady: () => aiState.ready,
    aiRoute: () => ['gemini-lite'],
    ai: vi.fn(async () => { if (!aiState.reply) throw new Error('offline'); return { data: aiState.reply, model: 'gemini-lite', ms: 900, inputTokens: 0, outputTokens: 0, cached: false }; }),
  };
});
vi.mock('../forge/generate', async (orig) => {
  const real = await orig<typeof import('../forge/generate')>();
  const { rulesObject } = await import('../forge/rulesFallback');
  return { ...real, generateObject: vi.fn(async (prompt: string) => { await new Promise((r) => setTimeout(r, 20)); return { ...rulesObject(prompt), model: 'gemini-lite', name: `Model ${prompt.split(',')[0]}` }; }) };
});

const { rulesBrief, cleanBrief, isThemedRequest, findNames } = await import('./brief');
const { designThemedRoom } = await import('./designThemed');
const { refineThemed } = await import('./refine');

const model = room(rect(4.2, 3.6), [opening('door', 'door', 0, 0.7, 0.85, 'in'), opening('win', 'window', 2, 2.1, 1.4)]);
const textOf = (s: ObjectSpec) => s.parts.map((p) => p.text?.value).filter(Boolean);

beforeEach(() => { aiState.ready = false; aiState.reply = null; });

describe('theme briefs from words', () => {
  it('reads the examples', () => {
    expect(['make a room for my cat named Gerard', 'build me a Barbie room', 'a gaming room for two', 'a calm reading nook', 'a home office with real IKEA products'].every(isThemedRequest)).toBe(true);
    expect(isThemedRequest('a living room for four with a sofa and a TV')).toBe(false);
    expect(findNames('make a room for my cat named Gerard')).toEqual(['Gerard']);

    const cat = rulesBrief('make a room for my cat named Gerard');
    const recipes = cat.objects.map((o) => o.recipe);
    for (const r of ['cat-tree', 'pet-bed', 'scratching-post', 'pet-bowls', 'toy-basket', 'litter-box', 'window-perch', 'poster', 'sign']) expect(recipes, r).toContain(r);
    expect(cat.objects.find((o) => o.recipe === 'poster')).toMatchObject({ text: 'GERARD', style: 'paw', mount: 'wall' });
    expect(cat.objects.find((o) => o.recipe === 'litter-box')?.place).toBe('corner');
    expect(cat.objects.find((o) => o.recipe === 'window-perch')?.place).toBe('window');

    const pink = rulesBrief('build me a Barbie room');
    expect(pink.objects.find((o) => /canopy bed/i.test(o.name))?.prompt).toMatch(/heart headboard/);
    expect(pink.objects.find((o) => o.recipe === 'poster')?.style).toBe('star');
    expect(pink.objects.find((o) => o.recipe === 'poster')?.text).toBeUndefined();
    expect(pink.notes.join(' ')).toMatch(/no logos/);
    expect(pink.palette).toContain('#ff4fa3');

    const game = rulesBrief('a gaming room for two');
    expect(game.objects.filter((o) => o.qty === 2).map((o) => o.name)).toEqual(['Gaming desk', 'Gaming chair']);
    expect(rulesBrief('a calm reading nook').objects.some((o) => /armchair/i.test(o.name))).toBe(true);
    const office = rulesBrief('a home office with real IKEA products');
    expect(office.realProducts).toBe(true);
    expect(office.objects.filter((o) => o.source === 'store').every((o) => /IKEA/.test(o.query ?? ''))).toBe(true);
  });

  it('cleans a model brief and keeps the asked-for name printed', () => {
    const b = cleanBrief({
      title: 'Cat haven', purpose: 'cat room', forWhom: 'Gerard the cat', names: ['Gerard'], palette: ['#eedd99', 'not a colour', '#aa5533'], mood: 'cosy', realProducts: false,
      objects: [
        { source: 'custom', name: 'Cat tree', recipe: 'cat-tree', sizeCm: [60, 60, 150], mount: 'floor' },
        { source: 'catalogue', name: 'Rug', catalogId: 'rug-160', mount: 'floor' },
        { source: 'catalogue', name: 'Mystery', catalogId: 'no-such-id', mount: 'floor' },
        { source: 'custom', name: 'Paw poster', recipe: 'poster', style: 'paw', mount: 'floor' },
        { source: 'store', name: 'Lamp', catalogId: 'floor-lamp', query: 'lamp', mount: 'floor' },
      ],
    }, 'make a room for my cat named Gerard', 800, 'gemini-lite');
    expect(b.by).toBe('gemini');
    expect(b.palette).toEqual(['#eedd99', '#aa5533']);
    expect(b.objects.find((o) => o.recipe === 'poster')).toMatchObject({ text: 'GERARD', mount: 'wall' });
    expect(b.objects.find((o) => o.name === 'Mystery')?.source).toBe('custom');
    expect(b.objects.find((o) => o.name === 'Lamp')?.source).toBe('catalogue');
  });
});

describe('designThemedRoom', () => {
  it('builds the Gerard room without a key: poster reads GERARD, wall items pass the referee', async () => {
    const seen: string[] = [];
    const res = await designThemedRoom(model, 'make a room for my cat named Gerard', { onObject: (s) => seen.push(s.name) });
    expect(res.candidates.length, JSON.stringify(res.infeasibility)).toBeGreaterThan(0);
    const best = res.candidates[0].furniture;
    const poster = best.find((f) => f.custom && textOf(f.custom).includes('GERARD') && f.category === 'poster');
    expect(poster?.mount).toBe('wall');
    expect(best.some((f) => f.custom && textOf(f.custom).includes('Gerard'))).toBe(true);
    expect(best.filter((f) => f.custom?.semantics.category === 'cat-tree')).toHaveLength(1);
    expect(seen.length).toBeGreaterThanOrEqual(9);
    const rs = validateLayout(model, best);
    const hung = best.filter((f) => f.mount === 'wall');
    expect(hung.length).toBeGreaterThanOrEqual(3);
    for (const f of hung) expect(rs.find((r) => r.id === `wall:${f.id}`)?.result, f.name).toBe('pass');
    expect(rs.filter((r) => r.result === 'fail' && r.subjectIds.some((id) => hung.some((f) => f.id === id)))).toEqual([]);
    expect(res.timings.totalMs).toBeLessThan(10000);
  });

  it('with a key: one brief call, custom pieces made in parallel and swapped in at the same size', async () => {
    aiState.ready = true;
    aiState.reply = { title: 'Pink dream', purpose: 'bedroom', forWhom: 'a doll fan', names: [], palette: ['#ff4fa3', '#ffc1dc', '#ffffff'], mood: 'bright', realProducts: false,
      objects: [
        { source: 'custom', name: 'Pink canopy bed', prompt: 'Hot-pink canopy bed with heart headboard, 140 x 200 x 210 cm', sizeCm: [140, 200, 210], catalogId: 'bed-double', mount: 'floor', place: 'wall' },
        { source: 'custom', name: 'Vanity with mirror', recipe: 'vanity', mount: 'floor' },
        { source: 'custom', name: 'Star poster', recipe: 'poster', style: 'star', mount: 'wall' },
        { source: 'catalogue', name: 'Nightstand', catalogId: 'nightstand', mount: 'floor' },
        { source: 'catalogue', name: 'Lamp', catalogId: 'floor-lamp', mount: 'floor' },
      ] };
    const phases: string[] = [];
    const res = await designThemedRoom(model, 'build me a Barbie room', { onProgress: (_, ph) => phases.push(ph) });
    expect(res.brief.by).toBe('gemini');
    expect(res.timings.models).toBe(1); // the bed; the vanity and poster are finished in code
    expect(phases[0]).toBe('rules');
    const bed = res.candidates[0].furniture.find((f) => /canopy/i.test(f.custom?.prompt ?? ''))!;
    expect(bed.custom!.model).toBe('gemini-lite');
    expect(bed.custom!.size).toEqual({ w: bed.w, d: bed.d, h: bed.h });
  });

  it('refines: a second poster that says GOOD BOY, and a bigger cat bed', async () => {
    const first = await designThemedRoom(model, 'make a room for my cat named Gerard');
    const next = await refineThemed(model, first, 'add a second poster that says GOOD BOY');
    const best = next.candidates[0].furniture;
    expect(best.some((f) => f.custom && textOf(f.custom).includes('GOOD BOY'))).toBe(true);
    expect(best.some((f) => f.custom && textOf(f.custom).includes('GERARD'))).toBe(true);
    const bedBefore = first.brief.objects.find((o) => o.recipe === 'pet-bed')!;
    const bigger = await refineThemed(model, next, 'make the bed bigger');
    const bedAfter = bigger.brief.objects.find((o) => o.recipe === 'pet-bed')!;
    expect(bedAfter.sizeCm![0]).toBeGreaterThan((bedBefore.sizeCm ?? [55])[0]);
  });

  it('Describe and the agent route a themed sentence here, and follow-ups edit the same room', async () => {
    const { compileIntent } = await import('../intent/compile');
    const { refineIntent } = await import('../intent/refine');
    const { designRoom } = await import('../design/pipeline');
    const { offlineReply } = await import('../agent/offline');
    expect(offlineReply('make a room for my cat named Gerard', false).actions?.[0]).toMatchObject({ type: 'design_room', brief: 'make a room for my cat named Gerard' });
    const text = 'make a room for my cat named Gerard';
    const req = await compileIntent(text, model);
    expect(req.style).toBe('theme');
    expect(req.items.length).toBeGreaterThan(0);
    const res = await designRoom(model, req, { brief: text });
    expect(res.candidates[0].furniture.some((f) => f.custom && textOf(f.custom).includes('GERARD'))).toBe(true);
    const { next } = await refineIntent(req, 'add a second poster that says GOOD BOY', [], model);
    const res2 = await designRoom(model, next, { brief: text });
    expect(res2.candidates[0].furniture.some((f) => f.custom && textOf(f.custom).includes('GOOD BOY'))).toBe(true);
  });
});

describe('junk filter and fallback', () => {
  it('drops layouts with no items or a zero score', async () => {
    const { dropJunk } = await import('./designThemed');
    const mk = (id: string, n: number, score: number) => ({ id, name: id, summary: '', parentVersion: 1, furniture: Array.from({ length: n }, (_, i) => ({ id: `${id}${i}` })), metrics: { score }, checks: [], assumptions: [], generator: 'theme' });
    const r = dropJunk({ candidates: [mk('a', 0, 50), mk('b', 3, 0), mk('c', 3, 60)], reports: [{ candidateId: 'a' }, { candidateId: 'c' }], infeasibility: null, stages: [] } as never);
    expect(r.candidates.map((c) => c.id)).toEqual(['c']);
    expect(r.reports).toHaveLength(1);
  });

  it('caps floor items at 12 and keeps wall decor', async () => {
    const { capFloorItems } = await import('./brief');
    const big = rulesBrief('a ramen bar for 30');
    const capped = capFloorItems([...big.objects, { ...big.objects[0], qty: 12 }]);
    expect(capped.filter((o) => o.mount !== 'wall').reduce((s, o) => s + (o.qty ?? 1), 0)).toBeLessThanOrEqual(12);
    expect(capped.filter((o) => o.mount === 'wall').length).toBe(big.objects.filter((o) => o.mount === 'wall').length);
  });

  it('always has the name poster, and a furnished room when the model brief times out', async () => {
    expect(rulesBrief('a room for my cat named Gerard').objects.some((o) => o.text === 'GERARD')).toBe(true);
    expect(rulesBrief('a room for my dog named Rex').objects.some((o) => o.text?.toUpperCase() === 'REX')).toBe(true);
    aiState.ready = true; // model brief fails (ai mock throws)
    const res = await designThemedRoom(model, 'a room for my cat named Gerard');
    expect(res.candidates.length).toBeGreaterThan(0);
    expect(res.candidates.every((c) => c.furniture.length > 0 && c.metrics.score > 0)).toBe(true);
    expect(res.brief.objects.some((o) => o.text === 'GERARD')).toBe(true);
  });
});
