import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyStroke, markGeometry, refersToSketch } from './deixis';
import { isEcho, takeSentences, voiceScore } from './speech';
import { offlineReply } from './offline';
import { cleanReply } from './actions';

// ---------- pure parts ----------

describe('deixis', () => {
  const loop = Array.from({ length: 25 }, (_, i) => ({ x: 2 + Math.cos((i / 24) * Math.PI * 2) * 0.5, y: 3 + Math.sin((i / 24) * Math.PI * 2) * 0.5 }));
  it('a drawn loop is closed and centred on its middle', () => {
    const g = markGeometry({ kind: 'stroke', points: loop })!;
    expect(g.closed).toBe(true);
    expect(g.centroid.x).toBeCloseTo(2, 1);
    expect(g.centroid.y).toBeCloseTo(3, 1);
    expect(classifyStroke(loop)).toBe('circle');
  });
  it('a straight stroke has a direction and length (a wall line)', () => {
    const pts = [{ x: 1, y: 1 }, { x: 2, y: 1.02 }, { x: 3, y: 1 }];
    const g = markGeometry({ kind: 'stroke', points: pts })!;
    expect(g.straight).toBe(true);
    expect(g.lengthM).toBeCloseTo(2, 1);
    expect(Math.abs(g.angle)).toBeLessThan(0.05);
    expect(classifyStroke(pts)).toBe('stroke');
  });
  it('spots words that point at a sketch', () => {
    expect(refersToSketch('put the sofa here')).toBe(true);
    expect(refersToSketch('a wall there please')).toBe(true);
    expect(refersToSketch('add a desk by the window')).toBe(false);
  });
});

describe('speech helpers', () => {
  it('releases sentences as they finish while streaming', () => {
    let r = takeSentences('Putting the desk', 0);
    expect(r.sentences).toEqual([]);
    r = takeSentences('Putting the desk under the window. It gets', r.next);
    expect(r.sentences).toEqual(['Putting the desk under the window.']);
    const r2 = takeSentences('Putting the desk under the window. It gets the light.', r.next, true);
    expect(r2.sentences).toEqual(['It gets the light.']);
  });
  it('does not split decimals', () => {
    const r = takeSentences('The gap is 1.5 m wide. Good.', 0, true);
    expect(r.sentences).toEqual(['The gap is 1.5 m wide.', 'Good.']);
  });
  it('waits when a trailing period might be a decimal', () => {
    expect(takeSentences('It is 2.', 0).sentences).toEqual([]);
  });
  it('treats the agent hearing itself as echo, not barge-in', () => {
    expect(isEcho('putting the desk under', 'Putting the desk under the window.')).toBe(true);
    expect(isEcho('no stop that', 'Putting the desk under the window.')).toBe(false);
  });
  it('prefers a natural voice in the same language', () => {
    const a = voiceScore({ name: 'Microsoft Aria Online (Natural)', lang: 'en-US' }, 'en-US');
    const b = voiceScore({ name: 'eSpeak English', lang: 'en-GB' }, 'en-US');
    const c = voiceScore({ name: 'Alva', lang: 'sv-SE' }, 'en-US');
    expect(a).toBeGreaterThan(b);
    expect(c).toBe(-1);
  });
});

describe('offline replies', () => {
  it('"put the sofa here" with a sketch and a sofa in the room moves it there', () => {
    const r = offlineReply('put the sofa here', true, (c) => c === 'sofa');
    expect(r.actions).toEqual([{ type: 'move', id: 'sofa', place: 'here' }]);
    expect(r.say).toMatch(/sofa/);
  });
  it('adds to a named wall', () => {
    const r = offlineReply('add a desk by the window', false);
    expect(r.actions[0]).toMatchObject({ type: 'add_catalog', place: 'window' });
  });
  it('"wall here" follows the drawn line', () => {
    expect(offlineReply('put a wall here', true).actions[0]).toMatchObject({ type: 'add_wall' });
  });
  it('handles undo, views, safety and why', () => {
    expect(offlineReply('undo', false).actions[0].type).toBe('undo');
    expect(offlineReply('show me 3d', false).actions[0]).toMatchObject({ type: 'set_view', view: '3d' });
    expect(offlineReply('is this safe for a toddler', false).actions[0].type).toBe('check_safety');
    expect(offlineReply('why is the sofa so expensive', false).actions[0]).toMatchObject({ type: 'explain', topic: 'price' });
  });
  it('asks instead of guessing', () => {
    const r = offlineReply('hmm', false);
    expect(r.actions).toEqual([]);
    expect(r.say.length).toBeGreaterThan(0);
  });
});

describe('reply cleaning', () => {
  it('drops unknown actions, bad points and markdown', () => {
    const r = cleanReply({
      say: '**Sure.** Moving it.',
      sketch: [{ kind: 'zone', points: [{ x: 1, y: 1 }, { x: 2, y: 2 }], text: 'Work' }, { kind: 'laser', points: [] }, { kind: 'arrow', points: [{ x: 'a' }] }],
      actions: [{ type: 'move', id: 'i1', place: 'here' }, { type: 'format_disk' }],
    });
    expect(r.say).toBe('Sure. Moving it.');
    expect(r.sketch).toHaveLength(1);
    expect(r.actions).toEqual([{ type: 'move', id: 'i1', place: 'here' }]);
  });
});

// ---------- a whole turn, model mocked ----------

const spoken: string[] = [];
const reply = {
  say: 'Putting a desk under the window. It gets the morning light.',
  sketch: [{ kind: 'label', at: 'window', text: 'Daylight' }],
  actions: [{ type: 'add_catalog', catalogId: 'desk-120', place: 'window' }],
};

vi.mock('../../core/ai', () => ({
  aiReady: () => true,
  ai: async (call: { onPartial?: (t: string) => void }) => {
    const raw = JSON.stringify(reply);
    for (let i = 20; i < raw.length; i += 20) call.onPartial?.(raw.slice(0, i));
    return { data: reply, model: 'gemini-test-flash', ms: 900, inputTokens: 0, outputTokens: 0, cached: false };
  },
}));
vi.mock('./speech', async (orig) => {
  const real = await orig<typeof import('./speech')>();
  return { ...real, speak: async (t: string) => { spoken.push(t); }, stopSpeaking: () => {} };
});

describe('runTurn', () => {
  let brain: typeof import('./brain');
  let store: typeof import('../../core/store');
  let sketch: typeof import('./sketchStore');
  let agent: typeof import('./agentStore');
  beforeAll(async () => {
    const mem: Record<string, string> = {};
    vi.stubGlobal('localStorage', { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => { mem[k] = v; }, removeItem: (k: string) => { delete mem[k]; } });
    store = await import('../../core/store');
    sketch = await import('./sketchStore');
    agent = await import('./agentStore');
    brain = await import('./brain');
  });
  beforeEach(() => { spoken.length = 0; sketch.useSketch.getState().clear(); });

  it('speaks sentence by sentence, sketches, then places the desk', async () => {
    const before = store.useStore.getState().model.furniture.length;
    const seen: number[] = [];
    const unsub = store.useStore.subscribe((s) => seen.push(sketch.useSketch.getState().marks.length));
    await brain.runTurn('put a desk by the window');
    unsub();
    expect(spoken.slice(0, 2)).toEqual(['Putting a desk under the window.', 'It gets the morning light.']);
    const after = store.useStore.getState().model;
    expect(after.furniture.length).toBe(before + 1);
    const desk = after.furniture[after.furniture.length - 1];
    expect(desk.catalogId).toBe('desk-120');
    // The ghost and label were on the plan before the model changed.
    expect(seen[0]).toBeGreaterThanOrEqual(2);
    const turns = agent.useAgent.getState().turns;
    expect(turns[turns.length - 1].meta).toMatch(/^Gemini · test-flash · \d+\.\d s$/);
    expect(turns[turns.length - 1].done?.[0]).toMatch(/Added Desk 120/);
  });

  it('resolves "here" to the person\'s latest sketch in offline mode', async () => {
    const m = store.useStore.getState().model;
    const sofa = m.furniture.find((f) => f.category === 'sofa') ?? null;
    if (!sofa) store.useStore.getState().dispatch({ type: 'PLACE_OBJECT', item: (await import('../furniture/catalog')).makeItem('sofa-2', { x: 1.2, y: 1.2 }) });
    const target = { x: 2.5, y: 2.2 };
    const loop = Array.from({ length: 21 }, (_, i) => ({ x: target.x + Math.cos((i / 20) * Math.PI * 2) * 0.4, y: target.y + Math.sin((i / 20) * Math.PI * 2) * 0.4 }));
    sketch.useSketch.getState().add({ id: 'me1', by: 'you', kind: 'circle', points: loop, createdAt: Date.now() });
    await brain.runTurn('put the sofa here', { offline: true });
    const moved = store.useStore.getState().model.furniture.filter((f) => f.category === 'sofa').pop()!;
    expect(Math.hypot(moved.x - target.x, moved.y - target.y)).toBeLessThan(0.8);
    expect(spoken[0]).toMatch(/sofa/i);
  });
});
