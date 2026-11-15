// The model-piece upgrade window closes after UPGRADE_LIMIT_MS: late pieces are dropped and the kit room stays.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { opening, rect, room } from '../referee/fixtures';

vi.mock('../../core/ai', async (orig) => {
  const real = await orig<typeof import('../../core/ai')>();
  return {
    ...real,
    aiReady: () => true,
    aiRoute: () => ['gemini-lite'],
    ai: vi.fn(async () => ({
      data: {
        title: 'Cat haven', purpose: 'cat room', forWhom: 'Gerard the cat', names: ['Gerard'], palette: ['#eedd99', '#aa5533', '#ffffff'], mood: 'cosy', realProducts: false,
        objects: ['Cat tree tower', 'Sisal scratcher', 'Cave bed', 'Hammock', 'Tunnel', 'Climbing wall', 'Feather stand'].map((name) => ({ source: 'custom', name, prompt: `${name}, 50 x 50 x 60 cm, cosy`, sizeCm: [50, 50, 60], catalogId: 'plant', mount: 'floor' })),
      },
      model: 'gemini-lite', ms: 5, inputTokens: 0, outputTokens: 0, cached: false,
    })),
  };
});
const slowMs = 30000;
vi.mock('../forge/generate', async (orig) => {
  const real = await orig<typeof import('../forge/generate')>();
  const { rulesObject } = await import('../forge/rulesFallback');
  return {
    ...real,
    generateObject: vi.fn(async (prompt: string) => {
      await new Promise((r) => setTimeout(r, slowMs));
      return { ...rulesObject(prompt), model: 'gemini-lite', name: 'Late piece' };
    }),
  };
});

const { designThemedRoom, UPGRADE_LIMIT_MS } = await import('./designThemed');
const model = room(rect(4.2, 3.6), [opening('door', 'door', 0, 0.7, 0.85, 'in'), opening('win', 'window', 2, 2.1, 1.4)]);

afterEach(() => { vi.useRealTimers(); });

describe('upgrade cutoff', () => {
  it('closes at 20 s: the late model piece is dropped, the kit room is returned complete', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
    let done = false, result: Awaited<ReturnType<typeof designThemedRoom>> | undefined;
    const t0 = Date.now();
    void designThemedRoom(model, 'a room for my cat named Gerard').then((r) => { result = r; done = true; });
    let early = false;
    for (let i = 0; i < 80 && !done; i++) {
      await vi.advanceTimersByTimeAsync(500);
      if (Date.now() - t0 < UPGRADE_LIMIT_MS - 1000 && done) early = true;
    }
    expect(done).toBe(true);
    expect(early, 'must not finish before the model pieces had their time').toBe(false);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(UPGRADE_LIMIT_MS - 500);
    expect(elapsed).toBeLessThan(UPGRADE_LIMIT_MS + 2000);
    expect(result!.partial).toBe(false);
    expect(result!.contract?.complete, JSON.stringify(result!.contract)).toBe(true);
    expect(result!.candidates[0].furniture.every((f) => f.custom?.name !== 'Late piece')).toBe(true);
    expect(result!.brief.notes.join(' ')).toMatch(/ready-made/);
  });
});
