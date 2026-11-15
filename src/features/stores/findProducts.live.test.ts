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
    const { findProductsReport } = await import('./findProducts');
    const { ai } = await import('../../core/ai');
    let raw = '';
    const { readListing } = await import('./read');
    const jobs = [
      { name: 'Desk', category: 'desk', win: { w: 1.5, d: 0.8, h: 1.2 } },
      { name: 'Bed', category: 'bed', win: { w: 1.7, d: 2.2, h: 1.2 } },
      { name: 'Sofa', category: 'sofa', win: { w: 2.4, d: 1.0, h: 1.0 } },
      { name: 'Bookshelf', category: 'bookshelf', win: { w: 1.2, d: 0.4, h: 2.2 } },
      { name: 'Desk (Finland)', category: 'desk', win: { w: 1.5, d: 0.8, h: 1.2 }, country: 'fi' as const },
    ];
    let md = `# Shop the room live run ${new Date().toISOString()}\n\n`;
    for (const j of jobs) {
      const ask = (prompt: string) => ai<string>({ task: 'fast', parts: [{ text: prompt }], tools: [{ google_search: {} }], temperature: 0.1, thinking: 'low' }).then((r) => (raw = r.data));
      const { matches: ok, report } = await findProductsReport(j, j.win, { deps: { ask, read: readListing }, country: (j as { country?: 'fi' }).country });
      const okLines = ok.map((m) => `  - OK ${m.listing.title} | ${m.listing.price} ${m.listing.currency} | ${JSON.stringify(m.listing.stated)}${m.heightUnconfirmed ? ' height unconfirmed' : ''} | photo ${m.image ? 'yes' : 'no'} | ${m.listing.url}`);
      const dropLines = report.dropped.map((d) => `  - dropped: ${d.reason} ${d.detail ?? ''} | ${d.url}`);
      md += [`## ${j.name} (window ${j.win.w} x ${j.win.d} x ${j.win.h} m)`, `- found (asked): ${report.asked} | verified: ${report.verified} | fits: ${ok.length}`, ...okLines, ...dropLines, '', ''].join('\n');
      expect(ok.every((m) => m.listing.price! > 0 && m.listing.url.startsWith('https://www.ikea.com/'))).toBe(true);
    }
    if (penv.SHOP_OUT) fs.writeFileSync(penv.SHOP_OUT, md);
  }, 540_000);
});
