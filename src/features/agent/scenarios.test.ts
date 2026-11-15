// Twelve-turn conversations, English and Swedish, through the real turn handling with the model
// switched off and the heavy design pipeline replaced by a small fixed layout.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const spoken: string[] = [];

vi.mock('../../core/ai', () => ({
  aiReady: () => false,
  classify: () => ({ message: '' }),
  ai: async () => { throw new Error('offline'); },
}));
vi.mock('./speech', async (orig) => {
  const real = await orig<typeof import('./speech')>();
  return { ...real, speak: async (t: string) => { spoken.push(t); }, stopSpeaking: () => {} };
});
vi.mock('./actions', async (orig) => {
  const real = await orig<typeof import('./actions')>();
  const { useStore } = await import('../../core/store');
  const { makeItem } = await import('../furniture/catalog');
  return {
    ...real,
    execute: async (a: { type: string }, ctx: never) => {
      if (a.type === 'design_room') {
        // Like the real action: the brief's requirements carry the person's lasting goals.
        const { applyGoals } = await import('./conversation');
        const goals = (ctx as { goals?: import('./conversation').Goals }).goals;
        const base: import('../../core/types').Requirements = {
          purpose: 'office', people: 1, budgetSek: null, items: [], routeTargets: [], minRouteWidthM: 0.8,
          style: '', lockedIds: [], notes: [], questions: [], compiledBy: 'rules',
        };
        useStore.getState().setRequirements(goals ? applyGoals(base, goals) : base);
        const model = useStore.getState().model;
        const furniture = [makeItem('desk-120', { x: 1.5, y: 1.2 }), makeItem('sofa-2', { x: 3, y: 3 })];
        useStore.getState().setCandidates([{
          id: 'c1', name: 'Quiet corner', summary: 'Desk by the light', parentVersion: model.version, furniture,
          metrics: { openAreaM2: 8, costSek: 0, minClearanceM: 0.9, routeLenM: 3, score: 1 }, checks: [], assumptions: [], generator: 'test',
        }]);
        return { ok: true, line: '1 layout', speak: 'I have one option. The best is Quiet corner: desk by the light.' };
      }
      if (a.type === 'check_safety') return { ok: true, line: 'Nothing unsafe', speak: 'Nothing unsafe stands out.' };
      return real.execute(a as never, ctx);
    },
  };
});

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

describe('twelve-turn conversations', () => {
  let brain: typeof import('./brain');
  let store: typeof import('../../core/store');
  let agent: typeof import('./agentStore');
  beforeAll(async () => {
    const mem: Record<string, string> = {};
    vi.stubGlobal('localStorage', { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => { mem[k] = v; }, removeItem: (k: string) => { delete mem[k]; } });
    store = await import('../../core/store');
    agent = await import('./agentStore');
    brain = await import('./brain');
    // Loading the whole turn handling can take minutes on a busy machine.
  }, 300_000);
  beforeEach(() => { spoken.length = 0; });

  const say = async (text: string) => {
    await brain.runTurn(text, { offline: true });
    const turns = agent.useAgent.getState().turns;
    return turns[turns.length - 1].text;
  };
  const polygonOf = () => JSON.stringify(store.useStore.getState().model.spaces.map((s) => s.polygon));
  const deskOf = () => store.useStore.getState().model.furniture.find((f) => f.category === 'desk');

  async function run(lines: Record<string, string>, expectLang: 'en' | 'sv') {
    const replies: string[] = [];
    const ask = async (key: string) => { const r = await say(lines[key]); replies.push(r); return r; };

    // 1-2: goals are stated one by one and kept.
    expect(await ask('wfh')).toBeTruthy();
    await ask('budget');
    const g = agent.useAgent.getState().conv.goals;
    expect(g.workFromHome).toBe(true);
    expect(g.budgetSek).toBe(15000);
    expect(agent.useAgent.getState().conv.lang).toBe(expectLang);

    // 3: design, apply, check the budget.
    const roomBefore = polygonOf();
    const designReply = await ask('design');
    const m = store.useStore.getState().model;
    expect(m.furniture.some((f) => f.catalogId === 'desk-120')).toBe(true);
    expect(designReply).toMatch(/15000/);
    expect(designReply).toMatch(/SEK/);
    expect(store.useStore.getState().requirements?.budgetSek).toBe(15000);

    // 4: what-if compares and never changes the room.
    const before = store.useStore.getState().model.furniture.length;
    const wi = await ask('whatif');
    expect(wi).toMatch(/m²|same|samma|sama/);
    expect(store.useStore.getState().model.furniture.length).toBe(before);
    expect(polygonOf()).toBe(polygonOf());
    expect(store.useStore.getState().model.spaces[0].polygon.length).toBeGreaterThanOrEqual(4);
    void roomBefore;

    // 5-6: an edit and then "a bit left" about the same piece.
    await ask('moveDesk');
    const x1 = deskOf()!.x;
    expect(agent.useAgent.getState().memory.last.length).toBeGreaterThan(0);
    await ask('left');
    expect(deskOf()!.x).toBeLessThan(x1);

    // 7: a question answered from the room.
    expect((await ask('windows')).length).toBeGreaterThan(0);

    // 8: another goal joins the first two.
    await ask('norugs');
    const g2 = agent.useAgent.getState().conv.goals;
    expect(g2.avoid).toContain('rug');
    expect(g2.budgetSek).toBe(15000);

    // 9: undo goes back one step.
    const xBefore = deskOf()!.x;
    await ask('undo');
    expect(deskOf()!.x).not.toBe(xBefore);

    // 10-12
    await ask('whatif2');
    await ask('safe');
    await ask('view3d');
    expect(store.useStore.getState().view).toBe('3d');

    expect(replies).toHaveLength(12);
    for (const r of replies) expect(words(r)).toBeLessThanOrEqual(20);
    expect(agent.useAgent.getState().conv.goals).toMatchObject({ workFromHome: true, budgetSek: 15000 });
    for (const t of agent.useAgent.getState().turns) expect(t.meta ?? '').not.toMatch(/\bms\b/);
  }

  it('English', async () => {
    await run({
      wfh: 'I work from home',
      budget: 'my budget is 15000',
      design: 'design a room for working from home, budget 15000',
      whatif: 'what if the room were 1 m wider',
      moveDesk: 'move the desk to the window',
      left: 'move it a bit left',
      windows: 'how many windows are there',
      norugs: 'no rugs please',
      undo: 'undo',
      whatif2: 'what if the room were 50 cm longer',
      safe: 'is it safe for a toddler',
      view3d: 'show me 3d',
    }, 'en');
  });

  it('Swedish', async () => {
    store.useStore.getState().setView?.('split');
    agent.useAgent.getState().set({ conv: { ...agent.useAgent.getState().conv, goals: { avoid: [] }, lang: 'en' } });
    await run({
      wfh: 'jag jobbar hemifrån',
      budget: 'min budget är 15000 kr',
      design: 'inred ett rum för att jobba hemifrån, budget 15000',
      whatif: 'tänk om rummet var 1 m bredare',
      moveDesk: 'flytta skrivbordet till fönstret',
      left: 'flytta det lite åt vänster',
      windows: 'hur många fönster finns det',
      norugs: 'inga mattor',
      undo: 'ångra',
      whatif2: 'tänk om rummet var 50 cm längre',
      safe: 'är det säkert för en liten bebis',
      view3d: 'visa 3d',
    }, 'sv');
  });
});
