// @ts-nocheck -- Node-only benchmark; the app tsconfig has no Node types.
/**
 * Benchmark against the Stoa questions.jsonl. Skipped unless STOA_EVAL=1 (run via scripts/stoa-eval.mjs).
 * Uses the same classify + answerFromIndex code as the app; no model calls.
 */
import { describe, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { classify, joinLineFragments, mergeSplitAreas, type TextItem } from './textCore';
import { answerFromIndex } from './answer';
import type { DrawingDoc } from './drawingIndex';

const RUN = process.env.STOA_EVAL === '1';
const DATA = process.env.STOA_DATA || 'C:/Users/shafe/Desktop/projects/stoa-data/ds/junction-dataset-preview';
const SOURCE = process.env.STOA_SOURCE || 'swiss_dwellings';
const LIMIT = Number(process.env.STOA_LIMIT || 300);
const OUT = path.resolve('public/samples/stoa/eval-results.json');

interface Q { path: string; question: string; answer: number | string; unit: string; type: string }

async function extract(file: string): Promise<DrawingDoc> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), verbosity: 0 }).promise;
  const items: TextItem[] = [];
  let id = 0;
  for (let p = 1; p <= Math.min(pdf.numPages, 30); p++) {
    const page = await pdf.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    for (const raw of tc.items as Array<{ str?: string; transform: number[]; width: number }>) {
      if (!raw.str || !raw.str.trim()) continue;
      const t = pdfjs.Util.transform(vp.transform, raw.transform);
      const fh = Math.hypot(t[2], t[3]) || 8;
      const w = Math.max(raw.width, fh * 0.5);
      items.push({ id: id++, page: p - 1, str: raw.str.trim(), x: t[4] / vp.width, y: (t[5] - fh) / vp.height, w: w / vp.width, h: fh / vp.height, ...classify(raw.str) });
    }
  }
  return { name: path.basename(file), pages: [], items: mergeSplitAreas(joinLineFragments(items)) };
}

function correct(q: Q, got: number | undefined): boolean {
  if (got == null) return false;
  const exp = Number(q.answer);
  if (!Number.isFinite(exp)) return false;
  if (q.type === 'count') return Math.round(got) === exp && Math.abs(got - exp) < 1e-9;
  return Math.abs(got - exp) <= Math.abs(exp) * 0.02;
}

describe.skipIf(!RUN)('stoa benchmark', () => {
  it('scores the index answerer', async () => {
    const lines = fs.readFileSync(path.join(DATA, 'questions.jsonl'), 'utf8').split('\n').filter(Boolean);
    const qs: Q[] = lines.map((l) => JSON.parse(l) as Q)
      .filter((q) => q.path.includes(`/${SOURCE}/`) && q.path.endsWith('.pdf') && fs.existsSync(path.join(DATA, q.path)))
      .slice(0, LIMIT);
    const cache = new Map<string, DrawingDoc>();
    const per: Record<string, { attempted: number; answered: number; correct: number }> = {};
    const rows: Array<{ question: string; expected: unknown; got: string | null; value: number | null; correct: boolean; type: string; file: string }> = [];
    let ms = 0;
    for (const q of qs) {
      const t0 = performance.now();
      let doc = cache.get(q.path);
      if (!doc) { doc = await extract(path.join(DATA, q.path)); cache.set(q.path, doc); }
      const a = answerFromIndex(doc, q.question, 0);
      ms += performance.now() - t0;
      const val = a?.value;
      const ok = a ? correct(q, val) : false;
      const s = (per[q.type] ??= { attempted: 0, answered: 0, correct: 0 });
      s.attempted++; if (a && val != null) s.answered++; if (ok) s.correct++;
      rows.push({ question: q.question, expected: q.answer, got: a?.answer ?? null, value: val ?? null, correct: ok, type: q.type, file: path.basename(q.path) });
    }
    const tot = Object.values(per).reduce((t, s) => ({ attempted: t.attempted + s.attempted, answered: t.answered + s.answered, correct: t.correct + s.correct }), { attempted: 0, answered: 0, correct: 0 });
    const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);
    const summary = {
      dataset: `junction-dataset-preview / ${SOURCE} (PDF plans, first ${qs.length} questions)`,
      files: cache.size,
      questions: tot.attempted, answered: tot.answered, correct: tot.correct, abstained: tot.attempted - tot.answered,
      accuracyOnAnswered: pct(tot.correct, tot.answered), coverage: pct(tot.answered, tot.attempted), overallAccuracy: pct(tot.correct, tot.attempted),
      perType: Object.fromEntries(Object.entries(per).map(([k, s]) => [k, { ...s, accuracyOnAnswered: pct(s.correct, s.answered) }])),
      meanMsPerQuestion: Math.round((ms / Math.max(1, qs.length)) * 10) / 10,
      modelCalls: 0, geminiCalls: 0,
      scoring: 'counts exact; area/length/volume within 2%',
      ranAt: new Date().toISOString(),
    };
    const answered = rows.filter((r) => r.value != null);
    const examples = [...answered.filter((r) => r.correct).slice(0, 12), ...answered.filter((r) => !r.correct).slice(0, 4), ...rows.filter((r) => r.value == null).slice(0, 4)];
    fs.writeFileSync(OUT, JSON.stringify({ summary, examples }, null, 2));
    console.log(JSON.stringify(summary, null, 2));
    for (const r of answered.filter((r) => !r.correct).slice(0, 15)) console.log('WRONG', r.file, r.question, '| exp', r.expected, '| got', r.got);
  }, 600000);
});
