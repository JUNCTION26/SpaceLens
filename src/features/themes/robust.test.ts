// Scenario tests for the completeness contract, with the AI layer stubbed: a themed room is complete
// whatever the server does (rate limits, refusals, a rejected brief, late answers).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesignResult } from '../design/pipeline';
import { opening, rect, room } from '../referee/fixtures';

const st = {
  ready: false,
  brief: null as unknown,
  gen: 'ok' as 'ok' | 'limited' | 'refused' | 'late',
  delayMs: 30,
  calls: [] as string[],
};
vi.mock('../../core/ai', async (orig) => {
  const real = await orig<typeof import('../../core/ai')>();
  return {
    ...real,
    aiReady: () => st.ready,
    aiRoute: () => ['gemini-lite'],
    ai: vi.fn(async () => { if (!st.brief) throw new Error('rejected'); return { data: st.brief, model: 'gemini-lite', ms: 50, inputTokens: 0, outputTokens: 0, cached: false }; }),
  };
});
vi.mock('../forge/generate', async (orig) => {
  const real = await orig<typeof import('../forge/generate')>();
  const { rulesObject } = await import('../forge/rulesFallback');
  return {
    ...real,
    generateObject: vi.fn(async (prompt: string) => {
      st.calls.push(prompt);
      await new Promise((r) => setTimeout(r, st.gen === 'late' ? st.delayMs : 10));
      if (st.gen === 'limited') throw new Error('429 rate limit');
      if (st.gen === 'refused') return { ...rulesObject(prompt), model: 'rules' };
      return { ...rulesObject(prompt), model: 'gemini-lite', name: `Model ${prompt.split(',')[0]}` };
    }),
  };
});

const { designThemedRoom, matchUpgrades } = await import('./designThemed');
const { minPiecesFor } = await import('./contract');

const door = opening('door', 'door', 0, 0.7, 0.85, 'in');
const win = opening('win', 'window', 2, 2.1, 1.4);
const big = room(rect(4.2, 3.6), [door, win]);
const tiny = room(rect(2.5, 2.4), [opening('door', 'door', 0, 0.3, 0.8, 'in'), opening('win', 'window', 2, 0.8, 1.0)]);
const SENTENCE = 'a room for my cat named Gerard';

/** An AI brief with hero pieces that do not exist in the kit, plus duplicates. */
const hero = (name: string) => ({ source: 'custom', name, prompt: `${name}, 50 x 50 x 60 cm, cosy`, sizeCm: [50, 50, 60], catalogId: 'plant', mount: 'floor' });
const aiBrief = (extra: unknown[] = []) => ({
  title: 'Cat haven', purpose: 'cat room', forWhom: 'Gerard the cat', names: ['Gerard'], palette: ['#eedd99', '#aa5533', '#ffffff'], mood: 'cosy', realProducts: false,
  objects: [hero('Cat tree tower'), hero('Sisal scratcher'), hero('Cat tree tower'), hero('Cave bed'), hero('Hammock'), hero('Tunnel'), hero('Climbing wall'), hero('Feather stand'), ...extra],
});

const names = (r: DesignResult & { pieces?: Array<{ id: string; o: { name: string } }> }) => {
  const byId = new Map((r.pieces ?? []).map((p) => [p.id, p.o.name]));
  return r.candidates[0].furniture.map((f) => byId.get(f.id) ?? f.name);
};
const CAT_ESSENTIALS = ['Cat tree', 'Cat bed', 'Litter box', 'Scratching post', 'Armchair for you'];
const posterText = (r: Awaited<ReturnType<typeof designThemedRoom>>) => r.candidates[0].furniture.filter((f) => f.category === 'poster').map((f) => f.custom?.parts.map((p) => p.text?.value).join(' ') ?? '').join('|');

beforeEach(() => { st.ready = false; st.brief = null; st.gen = 'ok'; st.delayMs = 30; st.calls = []; });

describe('completeness contract', () => {
  it('all object calls rate-limited still gives a complete cat room with the GERARD poster', async () => {
    st.ready = true; st.brief = aiBrief(); st.gen = 'limited';
    const emitted: Array<DesignResult & { partial?: boolean }> = [];
    const res = await designThemedRoom(big, SENTENCE, { onProgress: (r) => emitted.push(r) });
    expect(res.contract?.complete, JSON.stringify(res.contract)).toBe(true);
    const have = names(res);
    for (const e of CAT_ESSENTIALS) expect(have, e).toContain(e);
    expect(have.some((n) => /bowls/i.test(n))).toBe(true);
    expect(res.candidates[0].furniture.length).toBeGreaterThanOrEqual(8);
    expect(posterText(res)).toContain('GERARD');
    expect(res.roomName).toBe("Gerard's room");
    expect(res.candidates[0].name).toBe("Gerard's room");
    expect(res.partial).toBe(false);
    expect(emitted.length).toBeGreaterThan(1);
    expect(emitted.at(-1)!.partial).toBe(false);
    expect(emitted.slice(0, -1).every((e) => e.partial === true)).toBe(true);
    expect(res.timings.fallbacks).toBeGreaterThan(0);
    expect(res.brief.notes.join(' ')).toMatch(/ready-made/);
  });

  it('a refused (server fell back to rules) call keeps the kit piece too', async () => {
    st.ready = true; st.brief = aiBrief(); st.gen = 'refused';
    const res = await designThemedRoom(big, SENTENCE);
    expect(res.contract?.complete, JSON.stringify(res.contract)).toBe(true);
    expect(res.candidates[0].furniture.every((f) => !f.custom || f.custom.model === 'rules')).toBe(true);
  });

  it('a rejected brief gives the kit room', async () => {
    st.ready = true; st.brief = null;
    const res = await designThemedRoom(big, SENTENCE);
    expect(res.contract?.complete, JSON.stringify(res.contract)).toBe(true);
    expect(st.calls).toHaveLength(0);
    for (const e of CAT_ESSENTIALS) expect(names(res)).toContain(e);
    expect(posterText(res)).toContain('GERARD');
  });

  it('late model pieces upgrade in place: same position, rotation and footprint', async () => {
    st.ready = true; st.brief = aiBrief(); st.gen = 'late'; st.delayMs = 150;
    const emitted: Array<DesignResult & { partial?: boolean }> = [];
    const res = await designThemedRoom(big, SENTENCE, { onProgress: (r) => emitted.push(JSON.parse(JSON.stringify(r))) });
    const plain = emitted.filter((e) => e.candidates[0]?.furniture.length && e.candidates[0].furniture.every((f) => f.custom?.model !== 'gemini-lite'));
    const first = plain[plain.length - 1];
    const before = new Map(first.candidates[0].furniture.map((f) => [f.id, f]));
    const after = res.candidates[0].furniture;
    expect(after.map((f) => f.id).sort()).toEqual([...before.keys()].sort());
    for (const f of after) {
      const b = before.get(f.id)!;
      expect([f.x, f.y, f.rotation, f.w, f.d, f.h]).toEqual([b.x, b.y, b.rotation, b.w, b.d, b.h]);
      if (f.custom?.model === 'gemini-lite') expect(f.custom.size).toEqual({ w: f.w, d: f.d, h: f.h });
    }
    const upgraded = after.filter((f) => f.custom?.model === 'gemini-lite');
    expect(upgraded.length).toBeGreaterThan(0);
    expect(res.contract?.complete, JSON.stringify(res.contract)).toBe(true);
  });

  it('at most 6 model objects, one call per object, no duplicates', async () => {
    st.ready = true; st.brief = aiBrief(); st.gen = 'ok';
    await designThemedRoom(big, SENTENCE);
    expect(st.calls.length).toBeLessThanOrEqual(6);
    expect(new Set(st.calls).size).toBe(st.calls.length);
  });

  it('a 6 m2 room gets a scaled-down complete set', async () => {
    const res = await designThemedRoom(tiny, SENTENCE);
    expect(res.contract?.scaled).toBe(true);
    expect(res.contract?.minPieces).toBe(minPiecesFor(6));
    expect(res.contract?.minPieces).toBeLessThan(8);
    expect(res.contract?.complete, JSON.stringify(res.contract)).toBe(true);
    expect(res.candidates[0].furniture.length).toBeGreaterThanOrEqual(res.contract!.minPieces);
    expect(res.contract!.compromises.join(' ')).toMatch(/small room/i);
    expect(posterText(res)).toContain('GERARD');
    expect(res.partial).toBe(false);
  });

  it('piece count scales with room size', () => {
    expect([minPiecesFor(30), minPiecesFor(10), minPiecesFor(6), minPiecesFor(2)]).toEqual([8, 8, 5, 4]);
  });

  it('matches model heroes to the kit piece they resemble, capped at 6, without duplicates', () => {
    const pieces = [
      { id: 'a', key: 'cat tree#0', o: { source: 'custom', name: 'Cat tree', mount: 'floor', essential: true } },
      { id: 'b', key: 'toy basket#0', o: { source: 'custom', name: 'Toy basket', mount: 'floor' } },
      { id: 'c', key: 'gerard poster#0', o: { source: 'custom', name: 'Gerard poster', text: 'GERARD', recipe: 'poster', mount: 'wall' } },
    ] as unknown as Parameters<typeof matchUpgrades>[1];
    const m = matchUpgrades(aiBrief().objects as never, pieces);
    expect(m.find((x) => x.piece.id === 'a')?.ai.name).toBe('Cat tree tower');
    expect(m.find((x) => x.piece.id === 'b')).toBeTruthy();
    expect(m.find((x) => x.piece.id === 'c')).toBeUndefined();
    expect(new Set(m.map((x) => x.ai.name)).size).toBe(m.length);
  });
});
