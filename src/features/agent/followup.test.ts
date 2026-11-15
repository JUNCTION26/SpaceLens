import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const aiCalls: unknown[] = [];
const spoken: string[] = [];
const edit = {
  ok: true as const, by: 'rules' as const, notes: [], label: 'Moved desk',
  ops: [{ type: 'UPDATE_OBJECT' as const, id: 'f-desk', patch: { x: 2.2, y: 0.6 } }],
};

vi.mock('../../core/ai', () => ({
  aiReady: () => true,
  classify: () => ({ message: '' }),
  ai: async () => {
    aiCalls.push(1);
    const data = { say: 'Here is a room.', sketch: [], actions: [] };
    return { data, model: 'gemini-test', ms: 1, inputTokens: 0, outputTokens: 0, cached: false };
  },
}));
vi.mock('../intent/refine', () => ({
  refineRoom: async () => edit,
  refineRoomOffline: () => edit,
}));
vi.mock('./speech', async (orig) => {
  const real = await orig<typeof import('./speech')>();
  return { ...real, speak: async (t: string) => { spoken.push(t); }, stopSpeaking: () => {} };
});

describe('follow-up edits', () => {
  let brain: typeof import('./brain');
  let store: typeof import('../../core/store');
  let actions: typeof import('./actions');
  beforeAll(async () => {
    const mem: Record<string, string> = {};
    vi.stubGlobal('localStorage', { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => { mem[k] = v; }, removeItem: (k: string) => { delete mem[k]; } });
    store = await import('../../core/store');
    actions = await import('./actions');
    brain = await import('./brain');
    const cat = await import('../furniture/catalog');
    const desk = { ...cat.makeItem('desk-120', { x: 1, y: 1 }), id: 'f-desk' };
    store.useStore.getState().dispatch({ type: 'PLACE_OBJECT', item: desk });
  });
  beforeEach(() => { aiCalls.length = 0; spoken.length = 0; });

  it('applies the ops as one undo step', () => {
    const pastBefore = store.useStore.getState().past.length;
    actions.applyRoomOps(edit.ops, edit.label);
    const s = store.useStore.getState();
    expect(s.past.length).toBe(pastBefore + 1);
    expect(s.model.furniture.find((f) => f.id === 'f-desk')?.x).toBe(2.2);
  });

  it('an edit-like spoken sentence changes the room without the AI call', async () => {
    await brain.runTurn('move the desk to the window');
    expect(aiCalls.length).toBe(0);
    expect(spoken[0]).toBe('Moved desk');
  });

  it('a whole-new-room sentence still reaches the AI call', async () => {
    await brain.runTurn('design a room for two kids');
    expect(aiCalls.length).toBe(1);
  });

  it('tells new rooms from edits', () => {
    expect(actions.wantsNewRoom('a room for my cat')).toBe(true);
    expect(actions.wantsNewRoom('make me a gaming room')).toBe(true);
    expect(actions.wantsNewRoom('move the desk left')).toBe(false);
    expect(actions.looksLikeEdit('make it cozier')).toBe(true);
    expect(actions.looksLikeEdit('how big is the room')).toBe(false);
  });
});
