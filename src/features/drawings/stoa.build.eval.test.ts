// @ts-nocheck -- Node-only benchmark; the app tsconfig has no Node types.
/**
 * Plan-to-building benchmark on the Stoa swiss_dwellings PDFs. Skipped unless STOA_BUILD=1
 * (run via scripts/stoa-build.mjs). Same extraction code as the app; no model calls.
 */
import { describe, it } from 'vitest';

const RUN = process.env.STOA_BUILD === '1';

describe.skipIf(!RUN)('stoa plan-to-building benchmark', () => {
  it('converts plans and scores rooms, areas, doors and windows', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { readPagePaths } = await import('./pdfPaths');
    const { textItemsFrom, finishItems } = await import('./pdfText');
    const { buildFromPaths } = await import('./toBuilding');
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const DATA = process.env.STOA_DATA || '../stoa-data/ds/junction-dataset-preview';
    const LIMIT = Number(process.env.STOA_LIMIT || 1000);
    const ONLY = process.env.STOA_ONLY || '';
    const OVER = process.env.STOA_OVERLAYS || '';
    const OUT = path.resolve('public/samples/stoa/build-results.json');
    const dir = path.join(DATA, 'data/swiss_dwellings');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.pdf') && f.includes(ONLY)).sort().slice(0, LIMIT);
    const qs = fs.readFileSync(path.join(DATA, 'questions.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      .filter((q) => q.path.includes('/swiss_dwellings/') && /^(How many|What is the net floor area of room)/.test(q.question));
    const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
    const rows = [];
    const areaErrs = [];
    const fillErrs = []; // independent check: the space enclosed by walls, doors and windows vs the printed area
    const score = { labelCount: [0, 0], doors: [0, 0], windows: [0, 0], roomArea: [0, 0] };
    for (const f of files) {
      const t0 = performance.now();
      let rep, plan, err = null;
      try {
        const pdf = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(path.join(dir, f))), verbosity: 0 }).promise;
        const page = await pdf.getPage(1);
        const vp = page.getViewport({ scale: 1 });
        const pp = await readPagePaths(page, pdfjs.OPS);
        const items = finishItems(textItemsFrom((await page.getTextContent()).items, vp, 1, 0));
        const out = buildFromPaths(pp, items, 0, { name: f, now: 0 });
        rep = out.report; plan = out.plan;
        if (OVER) writeOverlay(fs, path, OVER, f, out, path.join(dir, f.replace(/\.pdf$/, '.png')));
      } catch (e) { err = String(e?.message ?? e); }
      const ms = performance.now() - t0;
      const numbered = rep ? rep.rooms.filter((r) => r.no).length + rep.failed.filter((x) => x.no).length : 0;
      const closed = rep ? rep.rooms.filter((r) => r.no).length : 0;
      const converted = !!rep?.ok && numbered > 0 && closed / numbered >= 0.8;
      if (rep) for (const r of rep.rooms) if (r.errorPct != null) areaErrs.push(Math.abs(r.errorPct));
      if (plan?.mPerPt) for (const r of plan.rooms) if (r.printedArea && r.rasterPt2 > 0) fillErrs.push(Math.abs((r.rasterPt2 * plan.mPerPt ** 2 - r.printedArea) / r.printedArea) * 100);
      // questions about this plan
      const mine = qs.filter((q) => q.path.endsWith('/' + f));
      const res = [];
      for (const q of mine) {
        const exp = Number(q.answer);
        let got = null, kind = null;
        const lab = q.question.match(/rooms labelled '([^']+)'/);
        if (lab) { kind = 'labelCount'; got = rep ? rep.rooms.filter((r) => r.no && norm(r.name.replace(/\s+\S+$/, '')) === norm(lab[1])).length : null; }
        else if (/^How many doors/.test(q.question)) { kind = 'doors'; got = rep?.doorSwings ?? null; }
        else if (/^How many windows/.test(q.question)) { kind = 'windows'; got = rep?.windows ?? null; }
        else { const no = q.question.match(/room (\S+) \(/)?.[1]; if (no) { kind = 'roomArea'; const r = rep?.rooms.find((x) => x.no === no); got = r ? r.computedArea : null; } }
        if (!kind) continue;
        const ok = got != null && (kind === 'roomArea' ? Math.abs(got - exp) <= exp * 0.02 : got === exp);
        score[kind][1]++; if (ok) score[kind][0]++;
        res.push({ kind, exp, got, ok });
      }
      rows.push({ file: f, ok: !!rep?.ok, converted, reason: rep?.reason ?? err, rooms: rep?.rooms.length ?? 0, numbered, closed, failed: rep?.failed.length ?? 0, doors: rep?.doors ?? 0, doorSwings: rep?.doorSwings ?? 0, windows: rep?.windows ?? 0, medianAreaErrorPct: rep?.medianAreaErrorPct ?? null, verified: rep?.verified ?? 0, withPrintedArea: rep?.withPrintedArea ?? 0, scale: rep?.scale, ms: Math.round(ms), wrong: res.filter((x) => !x.ok) });
      console.log(`${f} ${converted ? 'OK ' : 'BAD'} rooms ${closed}/${numbered} failed ${rep?.failed.length ?? '-'} med ${rep?.medianAreaErrorPct?.toFixed?.(2)}% doors ${rep?.doorSwings} win ${rep?.windows} ${Math.round(ms)}ms ${rep?.reason ?? err ?? ''}`);
    }
    const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
    const sorted = [...areaErrs].sort((a, b) => a - b);
    const med = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
    const times = rows.map((r) => r.ms).sort((a, b) => a - b);
    const summary = {
      dataset: 'junction-dataset-preview / swiss_dwellings (vector PDF plans)',
      plans: rows.length,
      converted: rows.filter((r) => r.converted).length,
      convertedPct: pct(rows.filter((r) => r.converted).length, rows.length),
      roomsClosed: rows.reduce((s, r) => s + r.closed, 0), roomsNumbered: rows.reduce((s, r) => s + r.numbered, 0),
      roomsClosedPct: pct(rows.reduce((s, r) => s + r.closed, 0), rows.reduce((s, r) => s + r.numbered, 0)),
      roomsWithPrintedArea: sorted.length,
      medianAreaErrorPct: med != null ? Math.round(med * 100) / 100 : null,
      within2PctPct: pct(sorted.filter((e) => e <= 2).length, sorted.length),
      wallFillCheck: (() => { const f = [...fillErrs].sort((a, b) => a - b); return { rooms: f.length, medianErrorPct: f.length ? Math.round(f[Math.floor(f.length / 2)] * 100) / 100 : null, within2PctPct: pct(f.filter((e) => e <= 2).length, f.length) }; })(),
      questions: Object.fromEntries(Object.entries(score).map(([k, [ok, n]]) => [k, { correct: ok, asked: n, accuracy: pct(ok, n) }])),
      medianMsPerPlan: times[Math.floor(times.length / 2)] ?? null,
      modelCalls: 0,
      ranAt: new Date().toISOString(),
    };
    if (!ONLY) fs.writeFileSync(OUT, JSON.stringify({ summary, plans: rows.map(({ wrong, ...r }) => r) }, null, 2));
    console.log(JSON.stringify(summary, null, 2));
    for (const r of rows.filter((x) => !x.converted).slice(0, 25)) console.log('NOT CONVERTED', r.file, r.reason ?? '', `${r.closed}/${r.numbered}`);
  }, 3_600_000);
});

function writeOverlay(fs, path, outDir, file, out, png) {
  fs.mkdirSync(outDir, { recursive: true });
  const { plan, report } = out;
  const W = plan.pageW, H = plan.pageH;
  const pts = (ps) => ps.map((p) => `${(p.x * W).toFixed(1)},${(p.y * H).toFixed(1)}`).join(' ');
  const bg = fs.existsSync(png) ? `<image href="data:image/png;base64,${fs.readFileSync(png).toString('base64')}" width="${W}" height="${H}" opacity="0.45"/>` : '';
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W * 2}" height="${H * 2}"><rect width="100%" height="100%" fill="white"/>${bg}`;
  for (const r of report.rooms) svg += `<polygon points="${pts(r.outline)}" fill="${r.status === 'verified' ? 'rgba(40,160,90,0.35)' : r.printedArea ? 'rgba(220,60,40,0.35)' : 'rgba(200,140,20,0.3)'}" stroke="#176" stroke-width="0.4"/>`;
  for (const w of report.wallsNorm) svg += `<polygon points="${pts(w)}" fill="rgba(30,60,220,0.45)"/>`;
  for (const d of plan.doors) svg += `<line x1="${d.hinge.x}" y1="${d.hinge.y}" x2="${d.jamb.x}" y2="${d.jamb.y}" stroke="red" stroke-width="1"/>`;
  for (const w of plan.windows) svg += `<line x1="${w.a.x}" y1="${w.a.y}" x2="${w.b.x}" y2="${w.b.y}" stroke="magenta" stroke-width="1.5"/>`;
  for (const f of report.failed) svg += `<rect x="${f.box[0] * W}" y="${f.box[1] * H}" width="${f.box[2] * W}" height="${f.box[3] * H}" fill="none" stroke="red" stroke-width="1.2"/>`;
  svg += '</svg>';
  fs.writeFileSync(path.join(outDir, file.replace(/\.pdf$/, '.svg')), svg);
}
