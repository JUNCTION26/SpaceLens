// Opt-in live check: a desk and a bed through grounded search, then verified against real pages.
// Run with SHOP_LIVE=1. Writes what was found and verified to SHOP_OUT (a markdown file) if set.
import { describe, expect, it } from 'vitest';

const penv = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const live = penv.SHOP_LIVE === '1';

describe.skipIf(!live)('findProducts live', () => {
  it('finds and verifies a desk and a bed', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nodeMod = (name: string): Promise<any> => import(/* @vite-ignore */ `node:${name}`);
    const fs = await nodeMod('fs');
    const path = await nodeMod('path');
    const key = penv.VITE_GEMINI_KEY || (fs.readFileSync(path.resolve('.env.local'), 'utf8').match(/^\s*VITE_GEMINI_KEY\s*=\s*"?([^"\r\n]+)"?/m)?.[1] ?? '').trim();
    const { getState } = await import('../../core/store');
    getState().setSettings({ geminiKey: key });
    const { findProducts, parseCandidates, promptFor } = await import('./findProducts');
    const { ai } = await import('../../core/ai');
    const { readListing } = await import('./read');
    const jobs = [
      { name: 'Desk', category: 'desk', win: { w: 1.5, d: 0.8, h: 1.2 } },
      { name: 'Bed', category: 'bed', win: { w: 1.7, d: 2.2, h: 1.2 } },
    ];
    let md = `# Shop the room live run ${new Date().toISOString()}\n\n`;
    for (const j of jobs) {
      let raw = '';
      const ask = (prompt: string) => ai<string>({ task: 'fast', parts: [{ text: prompt }], tools: [{ google_search: {} }], temperature: 0.1, thinking: 'low' }).then((r) => (raw = r.data));
      const ok = await findProducts(j, j.win, { deps: { ask, read: readListing } });
      const cands = parseCandidates(raw);
      md += `## ${j.name} (window ${j.win.w} x ${j.win.d} x ${j.win.h} m)\n- proposed by model (IKEA SE/FI product urls): ${cands.length}\n${cands.map((c) => `  - ${c.url} claimed ${c.price ?? '?'} ${c.currency}`).join('\n')}\n- verified from page: ${ok.length}\n${ok.map((m) => `  - ${m.listing.title} | ${m.listing.price} ${m.listing.currency} | ${JSON.stringify(m.listing.stated)} | ${m.listing.url}`).join('\n')}\n\n`;
      expect(ok.every((m) => m.listing.price! > 0 && m.listing.url.startsWith('https://www.ikea.com/'))).toBe(true);
    }
    if (penv.SHOP_OUT) fs.writeFileSync(penv.SHOP_OUT, md);
  }, 240_000);
});
