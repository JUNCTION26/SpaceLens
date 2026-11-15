// Live and offline must send a sentence down the same pipeline.
import { describe, expect, it, vi } from 'vitest';

let live = false;
vi.mock('../../core/gemini', async (orig) => {
  const real = await orig<typeof import('../../core/gemini')>();
  return { ...real, hasGemini: () => live };
});

const { opening, rect, room } = await import('../referee/fixtures');
const { wantsBrief } = await import('./compile');

const base = () => room(rect(4.5, 4), [opening('door', 'door', 0, 0.3, 0.9, 'in'), opening('win', 'window', 2, 1.6, 1.4)]);

describe('wantsBrief routing', () => {
  for (const s of ['double bedroom', 'home office for two', 'living room with a TV']) {
    it(`"${s}" goes to designRoom with and without Gemini`, () => {
      live = false;
      expect(wantsBrief(s, base())).toBe(false);
      live = true;
      expect(wantsBrief(s, base())).toBe(false);
      live = false;
    });
  }

  it('a themed request still goes to the themed pipeline live', () => {
    live = true;
    expect(wantsBrief('a ramen bar for 10', base())).toBe(true);
    live = false;
  });
});
