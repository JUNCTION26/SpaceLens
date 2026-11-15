// Live checks for every Gemini call site, outside the browser. Skipped unless UNIVERSAL_LIVE=1,
// so a plain test run never touches the network.
//   UNIVERSAL_PART  schemas | sites | rooms | objects   (default: sites)
//   UNIVERSAL_OUT   output directory (default universal-live-out)
//   UNIVERSAL_ONLY  comma-separated indices for rooms / objects
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const penv = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const live = penv.UNIVERSAL_LIVE === '1';
const part = penv.UNIVERSAL_PART ?? 'sites';
const out = resolve(penv.UNIVERSAL_OUT ?? 'universal-live-out');
const only = penv.UNIVERSAL_ONLY ? new Set(penv.UNIVERSAL_ONLY.split(',').map(Number)) : null;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

function devKey(): string {
  if (penv.VITE_GEMINI_KEY) return penv.VITE_GEMINI_KEY;
  const f = resolve('.env.local');
  if (!existsSync(f)) return '';
  return readFileSync(f, 'utf8').match(/^\s*VITE_GEMINI_KEY\s*=\s*"?([^"\r\n]+)"?/m)?.[1]?.trim() ?? '';
}

async function setup() {
  const key = devKey();
  expect(key, 'VITE_GEMINI_KEY missing').not.toBe('');
  const { getState } = await import('../src/core/store');
  getState().setSettings({ geminiKey: key });
  mkdirSync(out, { recursive: true });
  return key;
}

export const ROOMS = [
  'a recording studio for a podcast duo', 'a ramen bar for 10', 'a nursery with a jungle theme', 'a Viking longhouse hall',
  "a dentist's waiting room", "a teenager's K-pop room", 'a yoga studio', "a wizard's library", 'a tiny home office in a closet',
  'a dog groomer', 'a board-game cafe', 'a 1970s lounge', 'a wheelchair-friendly studio flat', 'a Formula 1 fan cave', 'a greenhouse reading room',
];

export const OBJECTS = [
  'a drum kit', 'a telescope on a tripod', 'a barber chair', 'a pinball machine', 'a rocking horse', 'an espresso machine on a counter',
  'a harp', 'a fish tank on a stand', 'a pizza oven', 'a dentist chair', 'a foosball table', 'a spinning wheel', 'a throne',
  'a canoe on a rack', 'a treadmill', 'a vending machine', "a ship's wheel wall decor", 'a bonsai on a stand', 'a guitar on a stand',
  'a dragon statue',
];

/** Runs one call site and records model, time and outcome. */
async function site<T>(name: string, rows: unknown[], fn: () => Promise<T>, check: (r: T) => { ok: boolean; model?: string; detail?: string }) {
  if (penv.UNIVERSAL_SITES && !penv.UNIVERSAL_SITES.split(',').some((w) => name.includes(w))) return;
  const { onAiActivity } = await import('../src/core/ai');
  const errs: string[] = [];
  const models: string[] = [];
  const off = onAiActivity((e) => { if (e.phase === 'error' && e.error) errs.push(e.error.slice(0, 200)); if (e.phase === 'done' && e.model) models.push(e.model.replace(/^gemini-/, '')); });
  const t0 = performance.now();
  try {
    const r = await fn();
    const c = check(r);
    rows.push({ site: name, ok: c.ok, model: c.model ?? models.join('+'), ms: Math.round(performance.now() - t0), detail: c.detail, errors: errs });
  } catch (e) {
    rows.push({ site: name, ok: false, model: models.join('+'), ms: Math.round(performance.now() - t0), detail: `threw: ${(e as Error).message.slice(0, 200)}`, errors: errs });
  } finally { off(); }
  console.log(JSON.stringify(rows.at(-1)));
}

describe.skipIf(!live || part !== 'sites')('call sites live', () => {
  it('runs every call site for real', async () => {
    await setup();
    const { probeModels } = await import('../src/core/ai');
    const { sampleRoom } = await import('../src/core/sample');
    const probe = await probeModels({ force: true });
    console.log('probe', probe.map((p) => `${p.model}:${p.ok ? `${p.totalMs}ms` : p.error}`).join(' | '));
    const room = sampleRoom();
    const rows: unknown[] = [];
    const { compileIntent } = await import('../src/features/intent/compile');
    const plainAsk = 'an office for 4 people with a route to the window';
    let req = await (async () => { let r: Awaited<ReturnType<typeof compileIntent>> | null = null; await site('room brief compile', rows, async () => (r = await compileIntent(plainAsk, room)), (x) => ({ ok: x.compiledBy === 'gemini', detail: `${x.compiledBy}: ${x.purpose}, ${x.items.map((i) => `${i.qty}x${i.catalogId}`).join(' ')}` })); return r!; })();
    const { refineIntent } = await import('../src/features/intent/refine');
    await site('room refine', rows, () => refineIntent(req, 'add a plant and make the route 1 m wide', [plainAsk], room), (x) => ({ ok: x.meta.by === 'gemini', detail: `${x.meta.by}: ${x.reply}` }));
    const { themeBrief } = await import('../src/features/themes/brief');
    await site('themed brief', rows, () => themeBrief('a ramen bar for 10'), (b) => ({ ok: b.by === 'gemini', model: b.model, detail: `${b.title}: ${b.objects.map((o) => o.name).join(', ')} | ${b.notes.join(' ')}` }));
    const { buildDesignItems } = await import('../src/features/design/pipeline');
    const { planConcepts } = await import('../src/features/design/planner');
    const items = buildDesignItems(room, req);
    let concept: Awaited<ReturnType<typeof planConcepts>>[0] | undefined;
    await site('design planner concepts', rows, async () => { const c = await planConcepts(room, items, req, 3, { brief: plainAsk }); concept = c[0]; return c; }, (c) => ({ ok: c[0]?.by === 'gemini', model: c[0]?.model, detail: `${c.length}: ${c.map((x) => x.name).join(', ')} ${c[0]?.notes.slice(0, 2).join(' ')}` }));
    const { solveProgram } = await import('../src/features/design/solve');
    const { evaluateRules } = await import('../src/features/design/rules');
    const { compileRules } = await import('../src/features/intent/compile');
    const { rulesConcept } = await import('../src/features/design/planner');
    const small = compileRules('a bedroom with a bed, a wardrobe and a desk', room);
    const smallItems = buildDesignItems(room, small);
    const smallConcept = rulesConcept(room, smallItems, small);
    const solved = await solveProgram(room, smallItems, smallConcept, { variants: 1, seed: 1, req: small });
    const cand = solved.candidates[0];
    if (cand) {
      const { critique } = await import('../src/features/design/critic');
      const report = { candidateId: cand.id, program: smallConcept, verdicts: evaluateRules(room, cand.furniture, small) };
      await site('critic', rows, () => critique(room, cand, report, { brief: plainAsk }), (c) => ({ ok: c.by !== 'rules', model: c.by, detail: `score ${c.score}, ${c.decisions.length} decisions, ${c.ops?.length ?? 0} fixes` }));
    } else rows.push({ site: 'critic', ok: false, detail: 'no layout to judge' });
    const { generateObject, editObject, generateFromImage } = await import('../src/features/forge/generate');
    let first: number | null = null;
    const t1 = performance.now();
    let spec: Awaited<ReturnType<typeof generateObject>> | null = null;
    await site('object generation', rows, async () => (spec = await generateObject('a telescope on a tripod', { onPartial: (s) => { if (first === null && s.parts.length) first = Math.round(performance.now() - t1); } })), (s) => ({ ok: s.model !== 'rules', model: s.model, detail: `${s.parts.length} parts, first parts ${first} ms, passes ${s.gen?.passes}, fixes ${s.gen?.fixes.join(',')}` }));
    if (spec) await site('object refine', rows, () => editObject(spec!, 'make it brass and add a small finder scope'), (s) => ({ ok: s.model !== 'rules', model: s.model, detail: `${s.parts.length} parts` }));
    if (penv.UNIVERSAL_IMAGE && existsSync(penv.UNIVERSAL_IMAGE)) {
      const b64 = readFileSync(penv.UNIVERSAL_IMAGE).toString('base64');
      await site('generate from image', rows, () => generateFromImage(`data:image/png;base64,${b64}`, { name: 'Sofa' }), (s) => ({ ok: s.model !== 'rules', model: s.model, detail: `${s.parts.length} parts, ${s.name}` }));
    }
    const { runTurn } = await import('../src/features/agent/brain');
    const { useAgent } = await import('../src/features/agent/agentStore');
    for (const ask of ['make me a cosy reading corner', 'can you order pizza for me']) {
      await site(`agent brain turn: ${ask}`, rows, async () => { await runTurn(ask); return useAgent.getState(); }, (a) => { const last = a.turns.at(-1); return { ok: !!last?.meta?.startsWith('Gemini'), detail: `${last?.meta}: ${last?.text} ${a.error ?? ''}` }; });
    }
    writeFileSync(join(out, 'sites.json'), JSON.stringify(rows, null, 1));
  }, 600_000);
});

describe.skipIf(!live || part !== 'schemas')('schemas live', () => {
  it('every responseSchema is accepted', async () => {
    const key = await setup();
    const schemas: Record<string, object> = {
      themeBrief: (await import('../src/features/themes/brief')).BRIEF_SCHEMA,
      compile: (await import('../src/features/intent/compile')).SCHEMA,
      refinePatch: (await import('../src/features/intent/refine')).PATCH_SCHEMA,
      planner: (await import('../src/features/design/planner')).CONCEPTS_SCHEMA,
      critic: (await import('../src/features/design/critic')).CRITIC_SCHEMA,
      forge: (await import('../src/features/forge/spec')).SPEC_JSON_SCHEMA,
      brain: (await import('../src/features/agent/brain')).SCHEMA,
    };
    const rows: string[] = [];
    for (const model of (penv.UNIVERSAL_MODELS ?? 'gemini-3.5-flash-lite,gemini-4-hydrogen').split(',')) {
      for (const [name, schema] of Object.entries(schemas)) {
        const t0 = performance.now();
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Return a tiny valid example.' }] }], generationConfig: { responseMimeType: 'application/json', responseSchema: schema, maxOutputTokens: 400, thinkingConfig: { thinkingLevel: 'low' } } }),
        });
        const body = await res.text();
        const row = `${model} ${name}: ${res.status} ${Math.round(performance.now() - t0)} ms ${res.ok ? '' : body.match(/"message":\s*"([^"]*)"/)?.[1]?.slice(0, 300) ?? body.slice(0, 200)}`;
        rows.push(row);
        console.log(row);
      }
    }
    writeFileSync(join(out, 'schemas.txt'), rows.join('\n'));
  }, 300_000);
});
