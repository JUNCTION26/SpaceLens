// The demo story: one entry per scene, in order. Every clip scene is recorded from the running app
// by capture.mjs under the same id. Durations follow the narration; footage is time-fitted to them.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const LIMIT_S = 110; // the pitch video must stay under 2:00; 1:50 leaves margin

export function story(root) {
  // Benchmark numbers come from the published results file, so the caption always matches the app.
  let bench = { plans: 65, converted: 63, medianMsPerPlan: 201, modelCalls: 0 };
  const f = join(root, 'public', 'samples', 'stoa', 'build-results.json');
  if (existsSync(f)) { try { bench = { ...bench, ...JSON.parse(readFileSync(f, 'utf8')).summary }; } catch { /* keep defaults */ } }
  const sec = (bench.medianMsPerPlan / 1000).toFixed(1);

  return [
    {
      id: 'title', kind: 'card', minDur: 4,
      narration: 'SpaceLens. Measure a room, design it, and walk through it.',
      card: { title: 'SpaceLens', lines: ['Measure a room, design it, walk through it.'] },
    },
    {
      id: 'plan', kind: 'clip', minDur: 17, chapter: 'Floor plan to 3D',
      narration: `Drop in a real floor plan. SpaceLens reads every room, checks its area against the printed one, and builds the whole flat in 3D. On ${bench.plans} real plans it built ${bench.converted}, with no AI calls, in about ${sec === '0.2' ? 'a fifth of a second' : `${sec} seconds`} each.`,
      captions: [
        { at: 0, text: 'Drop in a real floor plan' },
        { at: 0.3, text: 'Rooms found, printed vs computed area' },
        { at: 0.62, text: `${bench.converted} of ${bench.plans} plans built in 3D`, sub: `${bench.modelCalls} model calls · ${sec} s per plan` },
      ],
    },
    {
      id: 'ask', kind: 'clip', minDur: 8, chapter: 'Ask the drawing',
      narration: 'Ask the drawing a question. The answer comes with its evidence highlighted on the sheet.',
      captions: [{ at: 0, text: 'Ask the drawing a question' }, { at: 0.45, text: 'Evidence highlighted on the sheet' }],
    },
    {
      id: 'villa', kind: 'clip', minDur: 19, chapter: 'Plan a building',
      narration: 'Or start from an empty shell. It proposes the internal walls, furnishes every room, and walks you through the doors at eye height.',
      captions: [
        { at: 0, text: 'Start from an empty shell' },
        { at: 0.18, text: 'Internal walls proposed' },
        { at: 0.36, text: 'Every room furnished' },
        { at: 0.6, text: 'Walk through at eye height' },
      ],
    },
    {
      id: 'describe', kind: 'clip', minDur: 12, chapter: 'Describe a room',
      narration: 'Describe a room in one sentence. You get scored layouts, each with the reasons behind it. Apply the one you like.',
      captions: [{ at: 0, text: 'Describe a room in one sentence' }, { at: 0.35, text: 'Scored layouts, with reasons' }, { at: 0.75, text: 'Apply in one click' }],
    },
    {
      id: 'create', kind: 'clip', minDur: 14, chapter: 'Create any object',
      narration: 'Need a piece that does not exist yet? Describe it, and it assembles live, at true size. A pink princess bed with a heart headboard. A walnut desk with a three-drawer pedestal.',
      captions: [{ at: 0, text: '"Pink princess bed with a heart headboard"' }, { at: 0.55, text: '"Walnut desk 160 by 80, three-drawer pedestal"' }],
    },
    {
      id: 'fix', kind: 'clip', minDur: 12, chapter: 'Fix and stay safe',
      narration: 'Hover a problem to see what is wrong, and fix it in one click. Safety checks the escape route and estimates the evacuation time.',
      captions: [{ at: 0, text: 'Hover a problem, fix it in one click' }, { at: 0.5, text: 'Escape route and evacuation time' }],
    },
    {
      id: 'shop', kind: 'clip', minDur: 9, chapter: 'Shop real products',
      narration: 'Paste a product link, and the real piece appears at true size, with its price.',
      captions: [{ at: 0, text: 'Paste a product link' }, { at: 0.5, text: 'True-size 3D object, with its price' }],
    },
    {
      id: 'export', kind: 'clip', minDur: 5, chapter: 'Hand it over',
      narration: 'Then export a sheet for the builder.',
      captions: [{ at: 0, text: 'Export a sheet for the builder' }],
    },
    {
      id: 'end', kind: 'card', minDur: 6,
      narration: 'SpaceLens. Built at Junction twenty twenty-six, by Shafir Khajo, Julius Hänninen and Kalle Pentikäinen. Try it live.',
      card: {
        title: 'SpaceLens',
        lines: ['junction26.github.io/SpaceLens', 'github.com/JUNCTION26/SpaceLens'],
        small: ['Shafir Khajo · Julius Hänninen · Kalle Pentikäinen', 'Built at Junction 2026'],
      },
    },
  ];
}
