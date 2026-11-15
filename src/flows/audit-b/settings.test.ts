// Settings: every control in the Settings panel, through the store actions and helpers it calls.
import { beforeAll, describe, expect, it, vi } from 'vitest';

const mem: Record<string, string> = {};
vi.stubGlobal('localStorage', { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => { mem[k] = v; }, removeItem: (k: string) => { delete mem[k]; } });

describe('Settings panel', () => {
  let h: typeof import('../helpers');
  beforeAll(async () => { h = await import('../helpers'); h.resetStore(); });

  it('Theme: system, dark and light are kept in this browser', () => {
    for (const t of ['dark', 'light', 'system'] as const) {
      h.st().setSettings({ theme: t });
      expect(h.st().settings.theme).toBe(t);
      expect(JSON.parse(mem['spacelens.settings.v1']).theme).toBe(t);
    }
  });

  it('Key: a pasted key is trimmed by the field and saved', () => {
    h.st().setSettings({ geminiKey: ' abc '.trim() });
    expect(JSON.parse(mem['spacelens.settings.v1']).geminiKey).toBe('abc');
    h.st().setSettings({ geminiKey: '' });
    expect(h.st().settings.geminiKey).toBe('');
  });

  it('Voice: Browser always works; Gemini without a key falls back to the browser voice', async () => {
    const { applyVoicePreference, neuralVoiceWanted } = await import('../../features/agent/neuralVoice');
    expect((await applyVoicePreference(false)).engine).toBe('browser');
    expect(neuralVoiceWanted()).toBe(false);
    const g = await applyVoicePreference(true);
    expect(g.engine).toBe('browser');
    expect(neuralVoiceWanted()).toBe(true);
    await applyVoicePreference(false);
  });

  it('Speed test without a key or server returns nothing and does not throw', async () => {
    const { probeModels, aiProbeResults } = await import('../../core/ai');
    await expect(probeModels({ force: true })).resolves.toEqual([]);
    expect(aiProbeResults()).toEqual([]);
  });

  it('Models: a per-task choice is kept and Auto clears it', async () => {
    const { candidatesFor, getOverrides, setOverride } = await import('../../core/ai');
    const m = candidatesFor('fast')[0];
    setOverride('fast', m);
    expect(getOverrides().fast).toBe(m);
    setOverride('fast', '');
    expect(getOverrides().fast).toBeUndefined();
  });

  it('More: My room and Empty replace the model as one undo step', async () => {
    const { showcaseRoom } = await import('../../core/showcase');
    const { emptyModel } = await import('../../core/sample');
    h.resetStore();
    const start = h.st().model;
    h.st().dispatch({ type: 'REPLACE_MODEL', model: showcaseRoom() });
    expect(h.st().model.spaces.length).toBeGreaterThan(0);
    expect(h.st().model.furniture.length).toBeGreaterThan(0);
    h.st().dispatch({ type: 'REPLACE_MODEL', model: emptyModel('My room') });
    expect(h.st().model.furniture).toHaveLength(0);
    expect(h.st().model.name).toBe('My room');
    h.st().undo(); h.st().undo();
    expect(h.st().model.spaces).toEqual(start.spaces);
  });
});
