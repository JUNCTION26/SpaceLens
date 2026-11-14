#!/usr/bin/env node
// Performance probe: first load, 3D frame times in the sample room and a furnished villa, heap growth over a long session.
// Usage: node scripts/e2e/perf.mjs [--base http://localhost:5180/] [--loops 40]
// Frame times come from requestAnimationFrame in headless Edge with software WebGL, so compare runs with each other,
// not with a real GPU.
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileSync, mkdirSync } from 'node:fs';
import { launch, sleep } from './cdp.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const k = args.indexOf(n); return k >= 0 ? args[k + 1] : d; };
const BASE = flag('--base', process.env.SPACELENS_URL ?? 'http://localhost:5180/');
const LOOPS = Number(flag('--loops', '40'));
const OUT = join(process.env.LOCALAPPDATA ?? tmpdir(), 'Temp', 'spacelens-shots', 'e2e', 'perf');
mkdirSync(OUT, { recursive: true });

const frames = (ms) => `new Promise((done) => {
  const t = []; let last = performance.now(); const end = last + ${ms};
  const tick = (now) => { t.push(now - last); last = now; if (now < end) requestAnimationFrame(tick); else {
    t.shift(); t.sort((a, b) => a - b);
    const q = (p) => t[Math.min(t.length - 1, Math.floor(p * t.length))];
    done({ frames: t.length, fps: +(1000 * t.length / ${ms}).toFixed(1), p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), max: +t.at(-1).toFixed(1) });
  } };
  requestAnimationFrame(tick);
})`;
const heapMb = async (page) => { await page.send('HeapProfiler.collectGarbage').catch(() => {}); const h = await page.send('Runtime.getHeapUsage'); return +(h.usedSize / 1048576).toFixed(1); };
// Orbit the 3D view a little so frames are actually rendered, not idle.
const orbit = async (page) => {
  const c = await page.locate('.pane-3d canvas');
  if (c) await page.drag(c.x, c.y, c.x + 200, c.y + 30, 30);
};

const report = { at: new Date().toISOString(), base: BASE };
const page = await launch({ width: 1440, height: 900, shots: OUT });
try {
  await page.send('Performance.enable');
  // 1. First load, cold profile.
  const t0 = Date.now();
  await page.goto(`${BASE}?coach=0&sample=1&nav=describe&view=split`, 0);
  const handle = Date.now() - t0;
  await page.waitFor(`(() => { const cv = document.querySelector('.pane-3d canvas'); return !!cv && !document.querySelector('.stage-skel'); })()`, 120000).catch(() => {});
  const to3d = Date.now() - t0;
  const nav = await page.evaluate(`(() => { const n = performance.getEntriesByType('navigation')[0]; const r = performance.getEntriesByType('resource');
    const js = r.filter((x) => /\\.(m?js|tsx?)(\\?|$)/.test(x.name));
    return { domContentLoaded: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd), requests: r.length, jsRequests: js.length,
      transferKB: Math.round(r.reduce((t, x) => t + (x.transferSize || 0), 0) / 1024), decodedKB: Math.round(r.reduce((t, x) => t + (x.decodedBodySize || 0), 0) / 1024) }; })()`);
  report.load = { ...nav, appReadyMs: handle, firstFrame3dMs: to3d };
  console.log('load', JSON.stringify(report.load));

  // 2. Frame times in the sample room.
  await sleep(1500);
  const orbitP = orbit(page);
  report.sampleRoom = await page.evaluate(frames(4000));
  await orbitP;
  report.sampleRoom.idle = await page.evaluate(frames(3000));
  console.log('sample room', JSON.stringify(report.sampleRoom));
  report.heapStartMb = await heapMb(page);

  // 3. Long session: switch sections, add and move pieces, undo and redo.
  const sections = ['describe', 'layouts', 'furniture', 'walk', 'safety', 'export', 'create', 'shop'];
  const heap = [report.heapStartMb];
  for (let i = 0; i < LOOPS; i++) {
    await page.evaluate(`(() => { const L = window.__spacelens; L.useUi.getState().openSection('${sections[i % sections.length]}');
      const s = L.useStore.getState(); const f = s.model.furniture[0];
      if (f) s.dispatch({ type: 'UPDATE_OBJECT', id: f.id, patch: { x: f.x + (${i} % 2 ? 0.05 : -0.05) } });
      if (${i} % 3 === 0) { s.undo(); s.redo(); } })()`);
    await sleep(700);
    if (i % 10 === 9) { heap.push(await heapMb(page)); console.log(`loop ${i + 1}: heap ${heap.at(-1)} MB`); }
  }
  report.heapMb = heap;
  report.heapGrowthMb = +(heap.at(-1) - heap[0]).toFixed(1);
  const dom = await page.evaluate('document.getElementsByTagName("*").length');
  const gl = await page.evaluate(`document.querySelectorAll('canvas').length`);
  report.domNodes = dom; report.canvases = gl;

  // 4. Furnished villa.
  await page.evaluate(`window.__spacelens.useUi.getState().openSection('building')`);
  await sleep(2500);
  await page.click('text~Propose plans');
  await page.waitFor(`document.querySelectorAll('.bld-card').length > 0`, 120000);
  await page.click('text~Use this plan');
  await sleep(1000);
  await page.click('text~Furnish every room');
  const tf = Date.now();
  await page.waitFor(`/Furnish every room/.test(document.querySelector('.bld')?.innerText ?? '')`, 360000).catch(() => {});
  report.villaFurnishMs = Date.now() - tf;
  report.villaItems = await page.evaluate(`window.__spacelens.useStore.getState().model.furniture.length`);
  await page.evaluate(`window.__spacelens.useStore.getState().setView('3d')`);
  await sleep(4000);
  const o2 = orbit(page);
  report.villa = await page.evaluate(frames(4000));
  await o2;
  report.villa.idle = await page.evaluate(frames(3000));
  report.heapVillaMb = await heapMb(page);
  console.log('villa', report.villaItems, 'items', JSON.stringify(report.villa));
  await page.shot('villa-3d');
  const p = await page.send('Performance.getMetrics');
  report.metrics = Object.fromEntries(p.metrics.filter((m) => /JSHeap|Nodes|LayoutCount|RecalcStyleCount|ScriptDuration|TaskDuration/.test(m.name)).map((m) => [m.name, Math.round(m.value * 100) / 100]));
  const errs = page.takeProblems().filter((x) => x.kind === 'exception');
  report.exceptions = errs.map((e) => e.text.slice(0, 200));
} finally {
  writeFileSync(join(OUT, 'perf.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await page.close();
}
