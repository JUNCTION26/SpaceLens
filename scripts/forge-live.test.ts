// Live quality run for the forge generator: real Gemini calls, outside the browser.
// Skipped unless FORGE_LIVE=1, so plain `npx vitest run` never touches the network.
// Driven by scripts/forge-live.mjs, which renders the saved specs afterwards.
//   FORGE_OUT      directory for <slug>.json specs and results.json
//   FORGE_PROMPTS  optional JSON file with an array of prompts
//   FORGE_ONLY     optional comma-separated indices into the prompt list
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { aiStats, onAiActivity, probeModels } from '../src/core/ai';
import { getState } from '../src/core/store';
import { generateObject } from '../src/features/forge/generate';
import { validateSpec } from '../src/features/forge/validate';

const penv = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const live = penv.FORGE_LIVE === '1';

export const DEFAULT_PROMPTS = [
  'pink Barbie dream bed 90x200 with a heart headboard',
  'built-in fold-down wall bed 160 wide',
  'walnut desk 160x80 with a three-drawer pedestal on the right',
  'curved green velvet sofa 240',
  'round marble dining table 140 for six with a brass pedestal',
  'kids bunk bed with a slide',
  'black and red gaming chair',
  'kitchen island 200x90',
  'low oak TV bench 180 with sliding doors',
  'curved white reception desk 300',
  'arcade machine',
  'grand piano',
  'office phone booth',
  'hospital bed',
  'bar counter',
  'baby cot',
  'standing desk',
  'bookshelf wall with a ladder',
];

function devKey(): string {
  if (penv.VITE_GEMINI_KEY) return penv.VITE_GEMINI_KEY;
  const f = resolve('.env.local');
  if (!existsSync(f)) return '';
  const m = readFileSync(f, 'utf8').match(/^\s*VITE_GEMINI_KEY\s*=\s*"?([^"\r\n]+)"?/m);
  return m?.[1]?.trim() ?? '';
}

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);

describe.skipIf(!live)('forge live', () => {
  it('generates every prompt with timings', async () => {
    const key = devKey();
    expect(key, 'VITE_GEMINI_KEY missing').not.toBe('');
    getState().setSettings({ geminiKey: key });
    const out = resolve(penv.FORGE_OUT ?? 'forge-live-out');
    mkdirSync(out, { recursive: true });
    let prompts: string[] = penv.FORGE_PROMPTS ? JSON.parse(readFileSync(penv.FORGE_PROMPTS, 'utf8')) : DEFAULT_PROMPTS;
    const idx = prompts.map((_, i) => i);
    const only = penv.FORGE_ONLY ? penv.FORGE_ONLY.split(',').map(Number) : idx;

    const probe = await probeModels({ force: true });
    console.log('probe', probe.map((p) => `${p.model}:${p.ok ? `${p.firstTokenMs}ms` : p.error}`).join(' | '));

    const rows: unknown[] = [];
    const run = async (i: number) => {
      const prompt = prompts[i];
      const events: Array<{ id: number; phase: string; model?: string; ms: number }> = [];
      const off = onAiActivity((e) => events.push({ id: e.id, phase: e.phase, model: e.model, ms: e.ms }));
      const before = aiStats();
      const t0 = performance.now();
      let firstPartsMs: number | null = null, firstPartsN = 0, partials = 0, draftParts: number | null = null;
      const spec = await generateObject(prompt, {
        detail: penv.FORGE_DETAIL !== '0', onDraft: (d) => { draftParts = d.parts.length; },
        onPartial: (s) => { partials++; if (firstPartsMs === null && s.parts.length) { firstPartsMs = Math.round(performance.now() - t0); firstPartsN = s.parts.length; } },
      });
      const totalMs = Math.round(performance.now() - t0);
      off();
      const after = aiStats();
      let inTok = 0, outTok = 0, calls = 0;
      for (const [m, s] of Object.entries(after)) {
        const b = before[m] ?? { inputTokens: 0, outputTokens: 0, calls: 0 };
        inTok += s.inputTokens - b.inputTokens; outTok += s.outputTokens - b.outputTokens; calls += s.calls - b.calls;
      }
      const firstToken = events.find((e) => e.phase === 'streaming');
      const v = validateSpec(spec);
      const gen = (spec as { gen?: Record<string, unknown> }).gen ?? {};
      const row = {
        i, prompt, slug: `${String(i).padStart(2, '0')}-${slug(prompt)}`, model: spec.model, name: spec.name,
        firstTokenMs: firstToken?.ms ?? null, firstPartsMs, firstPartsN, totalMs, parts: spec.parts.length,
        motions: spec.motions?.length ?? 0, calls, inTok, outTok, partials,
        size: spec.size, issuesAfter: v.issues.length, draftMs: gen.draftMs ?? null, detailMs: gen.detailMs ?? null, detailModel: gen.detailModel ?? null, draftParts,  tier: gen.tier, items: gen.items, passes: gen.passes, fixes: gen.fixes,
        stages: events.filter((e) => e.phase === 'done' || e.phase === 'error').map((e) => `${e.id}:${e.phase}:${e.model ?? ''}:${e.ms}`),
      };
      writeFileSync(join(out, `${row.slug}.json`), JSON.stringify(spec, null, 1));
      console.log(JSON.stringify(row));
      return row;
    };
    const conc = Number(penv.FORGE_CONC ?? 1);
    const queue = [...only];
    await Promise.all(Array.from({ length: conc }, async () => {
      while (queue.length) rows.push(await run(queue.shift()!));
    }));
    rows.sort((a, b) => (a as { i: number }).i - (b as { i: number }).i);
    writeFileSync(join(out, 'results.json'), JSON.stringify(rows, null, 1));
  }, 900_000);
});

// FORGE_DUMP=<dir>: write the few-shot examples and the no-key templates for all prompts as spec
// JSON (no network), so scripts/forge-shot.mjs --specs <dir> can render them.
describe.skipIf(!penv.FORGE_DUMP)('forge dump', () => {
  it('writes example and template specs', async () => {
    const { KIT_EXAMPLES } = await import('../src/features/forge/kitExamples');
    const { forgeSpec } = await import('../src/features/forge/validate');
    const { rulesObject } = await import('../src/features/forge/rulesFallback');
    const out = resolve(penv.FORGE_DUMP!);
    mkdirSync(out, { recursive: true });
    KIT_EXAMPLES.forEach((e, i) => writeFileSync(join(out, `ex-${String(i).padStart(2, '0')}-${slug(e.prompt)}.json`), JSON.stringify(forgeSpec(e.json, { prompt: e.prompt }).fixed)));
    DEFAULT_PROMPTS.forEach((pr, i) => writeFileSync(join(out, `rules-${String(i).padStart(2, '0')}-${slug(pr)}.json`), JSON.stringify(rulesObject(pr))));
  });
});
