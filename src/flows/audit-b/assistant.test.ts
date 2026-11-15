// Assistant dock: typed turns with the model switched off, through the real turn handling and the real
// design pipeline, plus the voice paths when there is no microphone.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../core/ai', async (orig) => {
  const real = await orig<typeof import('../../core/ai')>();
  return { ...real, aiReady: () => false, ai: async () => { throw new Error('offline'); } };
});

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

describe('Assistant dock, offline', () => {
  let brain: typeof import('../../features/agent/brain');
  let agent: typeof import('../../features/agent/agentStore');
  let h: typeof import('../helpers');
  let catalog: typeof import('../../features/furniture/catalog');
  beforeAll(async () => {
    const mem: Record<string, string> = {};
    vi.stubGlobal('localStorage', { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => { mem[k] = v; }, removeItem: (k: string) => { delete mem[k]; } });
    h = await import('../helpers');
    agent = await import('../../features/agent/agentStore');
    brain = await import('../../features/agent/brain');
    catalog = await import('../../features/furniture/catalog');
    h.resetStore();
  }, 300_000);

  const say = async (text: string) => {
    await brain.runTurn(text, { offline: true });
    const turns = agent.useAgent.getState().turns;
    return turns[turns.length - 1].text;
  };

  it('a typed question gets a short answer from the room', async () => {
    const r = await say('how many windows are there');
    expect(r.length).toBeGreaterThan(0);
    expect(words(r)).toBeLessThanOrEqual(20);
  });

  it('"design a room for working from home, budget 15000" designs, applies and states the budget', async () => {
    const r = await say('design a room for working from home, budget 15000');
    const st = h.st();
    expect(words(r)).toBeLessThanOrEqual(20);
    expect(st.model.furniture.some((f) => f.category === 'desk' || /desk/.test(f.catalogId ?? ''))).toBe(true);
    expect(st.requirements?.budgetSek).toBe(15000);
    expect(r).toMatch(/15000/);
    expect(agent.useAgent.getState().conv.goals).toMatchObject({ workFromHome: true, budgetSek: 15000 });
  }, 120000);

  it('"what if the room were 1 m wider" compares on a copy and never changes the room', async () => {
    const before = JSON.stringify(h.st().model);
    const r = await say('what if the room were 1 m wider');
    expect(r).toMatch(/m²|same/);
    expect(words(r)).toBeLessThanOrEqual(20);
    expect(JSON.stringify(h.st().model)).toBe(before);
  });

  it('"why is the bed there" explains in at most 20 words', async () => {
    const m = h.st().model;
    if (!m.furniture.some((f) => f.category === 'bed')) {
      h.st().dispatch({ type: 'PLACE_OBJECT', item: catalog.makeItem('bed-single', { x: 1.2, y: 1.4 }) });
    }
    const r = await say('why is the bed there');
    expect(r.length).toBeGreaterThan(0);
    expect(words(r)).toBeLessThanOrEqual(20);
    expect(r.toLowerCase()).toMatch(/bed/);
  });

  it('the budget stays a goal on later turns', async () => {
    await say('no rugs please');
    expect(agent.useAgent.getState().conv.goals).toMatchObject({ budgetSek: 15000, avoid: ['rug'] });
  });
});

describe('Voice with no microphone', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('no recognition in the browser: the ear says so and the turn can still be typed', async () => {
    const { Ear, recognitionSupported } = await import('../../features/agent/speech');
    expect(recognitionSupported()).toBe(false);
    const errors: string[] = [];
    new Ear({ onInterim: () => {}, onFinal: () => {}, onState: () => {}, onError: (e) => errors.push(e) }).start(true);
    expect(errors).toHaveLength(1);
  });

  it('speaking without a speech engine resolves quietly', async () => {
    const { speak, isSpeaking } = await import('../../features/agent/speech');
    await expect(speak('Hello there.')).resolves.toBeUndefined();
    expect(isSpeaking()).toBe(false);
  });

  it('hands-free with no microphone stops with one error instead of restarting forever', async () => {
    let made = 0;
    class FakeRec {
      onresult: unknown; onerror: ((e: { error: string }) => void) | null = null; onend: (() => void) | null = null;
      lang = ''; interimResults = false; continuous = false;
      constructor() { made++; }
      start() { queueMicrotask(() => { this.onerror?.({ error: 'audio-capture' }); this.onend?.(); }); }
      stop() { this.onend?.(); }
      abort() {}
    }
    vi.stubGlobal('window', { SpeechRecognition: FakeRec });
    vi.resetModules();
    const { Ear } = await import('../../features/agent/speech');
    const errors: string[] = [];
    const states: boolean[] = [];
    new Ear({ onInterim: () => {}, onFinal: () => {}, onState: (s) => states.push(s), onError: (e) => errors.push(e) }).start(true);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(made).toBe(1);
    expect(errors).toHaveLength(1);
    expect(states.at(-1)).toBe(false);
  });
});
