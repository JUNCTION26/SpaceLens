// Live run for themed rooms: real Gemini calls, outside the browser. Skipped unless THEMES_LIVE=1.
//   THEMES_OUT  directory for <room>/<object>.json specs and timings.json
// Render afterwards: node scripts/forge-shot.mjs --specs <THEMES_OUT>/<room> --grid 12 --out <dir>
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getState } from '../src/core/store';
import { sampleRoom } from '../src/core/sample';
import { designThemedRoom } from '../src/features/themes/designThemed';

const penv = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const live = penv.THEMES_LIVE === '1';
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

function devKey(): string {
  if (penv.VITE_GEMINI_KEY) return penv.VITE_GEMINI_KEY;
  const f = resolve('.env.local');
  if (!existsSync(f)) return '';
  return readFileSync(f, 'utf8').match(/^\s*VITE_GEMINI_KEY\s*=\s*"?([^"\r\n]+)"?/m)?.[1]?.trim() ?? '';
}

describe.skipIf(!live)('themes live', () => {
  it('builds the cat and pink rooms with timings', async () => {
    const key = devKey();
    expect(key, 'VITE_GEMINI_KEY missing').not.toBe('');
    getState().setSettings({ geminiKey: key });
    const out = resolve(penv.THEMES_OUT ?? 'themes-live-out');
    const rows: unknown[] = [];
    for (const text of (penv.THEMES_TEXTS ?? 'make a room for my cat named Gerard|build me a Barbie room').split('|')) {
      const t0 = performance.now();
      let first: number | null = null;
      const arrivals: number[] = [];
      const res = await designThemedRoom(sampleRoom(), text, {
        onObject: () => { const ms = Math.round(performance.now() - t0); first ??= ms; arrivals.push(ms); },
      });
      const dir = join(out, slug(text));
      mkdirSync(dir, { recursive: true });
      const best = res.candidates[0]?.furniture ?? [];
      for (const f of best) if (f.custom) writeFileSync(join(dir, `${slug(f.name)}.json`), JSON.stringify(f.custom));
      rows.push({
        text, brief: { by: res.brief.by, model: res.brief.model, title: res.brief.title, notes: res.brief.notes }, timings: { ...res.timings, firstObjectMs: first, lastArrivalMs: arrivals.at(-1) },
        pieces: best.map((f) => ({ name: f.name, mount: f.mount ?? 'floor', model: f.custom?.model ?? 'catalogue', text: f.custom?.parts.map((p) => p.text?.value).filter(Boolean) })),
        score: res.candidates[0]?.metrics.score,
      });
      console.log(JSON.stringify(rows.at(-1)));
    }
    writeFileSync(join(out, 'timings.json'), JSON.stringify(rows, null, 2));
  }, 120000);
});
