#!/usr/bin/env node
// Drives the real app in headless Edge and records each demo scene as timestamped frames.
// Usage: node scripts/video/capture.mjs [scene ...] [--base http://localhost:5180/]
// Frames go to %TEMP%/spacelens-shots/video/frames/<scene>/ with a manifest.json per scene.
// Footage clock: rec.pause() cuts a wait out, rec.rate(r < 1) fast-forwards it, and slow(r) also
// slows the page clock so 3D motion that renders at a frame a second still plays back smoothly.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, sleep } from '../e2e/cdp.mjs';
import { recorder } from './recorder.mjs';
import { FRAMES, BOARD_STATUS } from './paths.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const k = args.indexOf(n); return k >= 0 ? args[k + 1] : d; };
const BASE = flag('--base', process.env.SPACELENS_URL ?? 'http://localhost:5180/');
const CSS = { w: 1280, h: 720 }; // 3D is drawn on the CPU in headless Edge; 720p keeps the machine usable
const AI_MS = 180000;

// Runs before the app: a page clock that can be slowed, and no dev-server reloads mid-take
// (other work on the repo would otherwise hot-reload the page during a recording).
const INIT = `(() => {
  const real = performance.now.bind(performance);
  let k = 1, r0 = real(), v0 = r0;
  const vnow = () => v0 + (real() - r0) * k;
  performance.now = vnow;
  window.__videoRate = (x) => { v0 = vnow(); r0 = real(); k = x; };
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf(() => cb(vnow()));
  const WS = window.WebSocket;
  window.WebSocket = function (url, proto) {
    if (String(proto ?? '').includes('vite-hmr')) {
      return { readyState: 0, addEventListener() {}, removeEventListener() {}, send() {}, close() {} };
    }
    return proto === undefined ? new WS(url) : new WS(url, proto);
  };
  window.WebSocket.prototype = WS.prototype;
  Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {}, readText: async () => '' } }); } catch {}
  window.open = () => ({ document: { write() {}, close() {}, open() {} }, closed: false, close() {}, focus() {}, print() {}, addEventListener() {} });
})();`;

const xpathBtn = (txt) => `!!document.evaluate("//button[contains(., '${txt}')]", document, null, 9, null).singleNodeValue`;
const S = (expr) => `(() => { const L = window.__spacelens; const s = L.useStore.getState(); return (${expr}); })()`;

async function open(page, query) {
  await page.evaluate('try { localStorage.clear(); } catch {}').catch(() => {});
  await page.goto(`${BASE}?coach=0&theme=light${query ? `&${query}` : ''}`, 1500);
  await page.settled();
}

/** Type text key by key so it reads as typing on camera. */
async function typeSlow(page, target, text, delay = 35) {
  await page.click(target);
  await page.evaluate(`(() => { const el = document.activeElement; if (el && 'select' in el) el.select(); })()`);
  await page.key('Backspace');
  const chunk = 3; // a few characters per insert keeps it quick on a busy machine
  for (let i = 0; i < text.length; i += chunk) { await page.send('Input.insertText', { text: text.slice(i, i + chunk) }); await sleep(delay); }
}

const canvasReady = (page, t = 90000) => page.waitFor(`(() => { const cv = document.querySelector('.pane-3d canvas'); return !!cv && cv.width > 0 && !document.querySelector('.stage-skel'); })()`, t);

/** Slow the page clock and the footage clock together. */
async function slow(page, rec, k) {
  await page.evaluate(`window.__videoRate(${k})`).catch(() => {});
  rec.rate(k);
}

// ---------- scenes ----------

const SCENES = {
  /** A real floor plan becomes a 3D flat with named rooms. */
  async plan({ page, rec }) {
    await open(page, 'nav=drawings&sample=1&view=split');
    await page.waitFor(`!!document.querySelector('.drawings-sample')`, 60000);
    await rec.start('plan');
    await rec.focus('.panel-col', { pad: 10 });
    await rec.hold(700);
    await page.click('.drawings-sample');
    rec.pause();
    await page.waitFor(`!!document.querySelector('.drawings-sheet img')`, 90000);
    await sleep(1500);
    await rec.resume();
    await rec.hold(1200);
    await page.hover('text~Build 3D from this plan');
    await page.click('text~Build 3D from this plan');
    rec.pause();
    await page.waitFor(`!!document.querySelector('.drawings-stats') && !!document.querySelector('.drawings-room')`, 90000);
    await sleep(1200);
    await rec.resume();
    await rec.hold(1500);
    await rec.focus('.drawings-build', { pad: 30 });
    // Pick a room with a printed area so the card shows printed vs computed.
    const pick = await page.evaluate(`(() => { const b = [...document.querySelectorAll('.drawings-room')].filter((x) => x.querySelector('.drawings-ok'))[1]; if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    if (pick) { await page.hover(pick); await page.mouse(pick.x, pick.y); }
    await rec.hold(2500);
    await rec.focus(null);
    await page.click('text=Open in 3D', { within: '.drawings-build' });
    rec.pause();
    await canvasReady(page);
    await sleep(4000);
    await rec.resume();
    await rec.hold(800);
    await rec.focus('.pane-3d', { pad: 0 });
    await rec.hold(3000);
    return rec.stop();
  },

  /** Ask the drawing a question; the evidence lights up on the sheet. */
  async ask({ page, rec }) {
    await open(page, 'nav=drawings&sample=1&view=split');
    await page.waitFor(`!!document.querySelector('.drawings-sample')`, 60000);
    await page.click('.drawings-sample');
    await page.waitFor(`!!document.querySelector('.drawings-sheet img')`, 90000);
    await sleep(1500);
    await rec.start('ask');
    await rec.focus('.panel-col', { pad: 10 });
    await rec.hold(500);
    await typeSlow(page, '.drawings-q', 'How many rooms?');
    await rec.hold(300);
    await page.key('Enter');
    await page.waitFor(`document.querySelectorAll('.drawings-answer').length > 0`, AI_MS);
    await sleep(700);
    await rec.snap();
    await rec.hold(2500);
    const chips = await page.evaluate(`[...document.querySelectorAll('.drawings-sugg .chip')].map((b) => b.innerText)`);
    const q = chips.find((x) => /Area of/.test(x));
    if (q) {
      await page.click(`text=${q}`, { within: '.drawings-sugg' });
      await page.waitFor(`document.querySelectorAll('.drawings-answer').length > 1`, AI_MS).catch(() => {});
      await sleep(700);
      await rec.snap();
      await rec.hold(2800);
    }
    return rec.stop();
  },

  /** An empty shell becomes a planned, furnished villa you can walk through. */
  async villa({ page, rec }) {
    await open(page, 'nav=building&sample=1&view=2d');
    await page.waitFor(xpathBtn('Propose plans'), 60000);
    await rec.start('villa');
    await rec.focus('.panel-col', { pad: 10 });
    await rec.hold(900);
    await page.click('text~Propose plans');
    rec.pause();
    await page.waitFor(`document.querySelectorAll('.bld-card').length > 0`, 120000);
    await sleep(800);
    await rec.resume();
    await rec.hold(1500);
    await page.click('text~Use this plan');
    await rec.focus(null);
    await sleep(1000);
    await rec.snap();
    await rec.hold(1500);
    await page.click('text~Furnish every room');
    rec.rate(0.05);
    await page.waitFor(`!/Furnishing/.test(document.querySelector('.bld')?.innerText ?? '')`, 360000);
    rec.pause();
    await page.evaluate(`window.__spacelens.useStore.getState().setView('3d')`);
    await canvasReady(page).catch(() => {});
    await sleep(4000);
    await rec.resume();
    await rec.hold(2000);
    // Eye-level auto tour through the doors, recorded on a slowed clock.
    await page.evaluate(`window.dispatchEvent(new Event('spacelens:auto-tour'))`);
    await slow(page, rec, 0.15);
    const t0 = rec.time;
    while (rec.time - t0 < 9000) {
      await sleep(1000);
      if (!(await page.evaluate(`/Touring/.test(document.body.innerText)`).catch(() => true))) break;
    }
    await slow(page, rec, 1);
    return rec.stop();
  },

  /** One sentence becomes scored layouts with reasons; apply one. */
  async describe({ page, rec }) {
    await open(page, 'nav=describe&sample=1&view=split');
    await page.waitFor(`!!document.querySelector('[aria-label="Describe your space"]')`, 60000);
    await rec.start('describe');
    await rec.focus('.panel-col', { pad: 10 });
    await rec.hold(500);
    await typeSlow(page, '[aria-label="Describe your space"]', 'Home office for two, keep my desk, clear route to the window');
    await rec.hold(500);
    await page.click('[aria-label="Design it"]');
    rec.rate(0.25);
    await page.waitFor(S('s.candidates.length > 0'), AI_MS);
    await sleep(2500);
    rec.rate(1);
    await rec.snap();
    await rec.focus(null);
    await rec.hold(2200);
    await rec.focus('.panel-col', { pad: 10 });
    const why = await page.locate('text~Why this layout');
    if (why) { await page.click('text~Why this layout'); await sleep(600); await rec.snap(); await rec.hold(2500); }
    await page.click('text=Apply').catch(() => {});
    await sleep(800);
    await rec.focus(null);
    await rec.snap();
    await rec.hold(2200);
    return rec.stop();
  },

  /** Describe an object; it assembles at true size and goes into the room. */
  async create({ page, rec }) {
    await open(page, 'nav=create&sample=1&view=split');
    await page.waitFor(`!!document.querySelector('[aria-label^="Describe any object"]')`, 60000);
    await rec.start('create');
    await rec.focus('.panel-col', { pad: 10 });
    const make = async (text) => {
      await typeSlow(page, '[aria-label^="Describe any object"]', text);
      await rec.hold(300);
      await page.click('[aria-label="Build"]');
      rec.rate(0.3);
      await page.waitFor(xpathBtn('Place in room'), AI_MS);
      await sleep(1500);
      rec.rate(1);
      await rec.snap();
      await rec.hold(1500);
      await page.click('text~Place in room');
      await sleep(900);
      await rec.snap();
      await rec.hold(1500);
    };
    await make('pink princess bed with a heart headboard');
    await make('walnut desk 160 by 80 with a three-drawer pedestal');
    await rec.focus('.pane-3d', { pad: 0 });
    await rec.hold(2500);
    return rec.stop();
  },

  /** A problem shows on hover and is fixed in one click; then the safety check and evacuation. */
  async fix({ page, rec }) {
    await open(page, 'nav=layouts&sample=1&view=split');
    // Push the desk into the door swing so a check fails.
    await page.evaluate(S(`(() => { const d = s.model.openings.find((o) => o.kind === 'door'); const sp = s.model.spaces[0];
      const a = sp.polygon[d.wallIndex], b = sp.polygon[(d.wallIndex + 1) % sp.polygon.length]; const L = Math.hypot(b.x - a.x, b.y - a.y);
      const t = (d.offsetM) / L; const px = a.x + (b.x - a.x) * t, py = a.y + (b.y - a.y) * t;
      const cx = sp.polygon.reduce((q, p) => q + p.x, 0) / sp.polygon.length, cy = sp.polygon.reduce((q, p) => q + p.y, 0) / sp.polygon.length;
      const k = 0.45 / Math.hypot(cx - px, cy - py);
      s.dispatch({ type: 'UPDATE_OBJECT', id: s.model.furniture[0].id, patch: { x: px + (cx - px) * k, y: py + (cy - py) * k } }); })()`));
    await page.waitFor(`/to fix/.test(document.querySelector('.status-pill')?.innerText ?? '')`, 30000).catch(() => {});
    await sleep(1000);
    const id = await page.evaluate(S('s.model.furniture[0].id'));
    const box = await page.locate(`[data-hit="f:${id}"]`);
    await rec.start('fix');
    await rec.focus('.pane-2d', { pad: 0 });
    await rec.hold(900);
    if (box) {
      await page.hover(box, { settle: 300 });
      await page.waitFor(`!!document.querySelector('.pb-card')`, 10000).catch(() => {});
      await sleep(400);
      await rec.snap();
      await rec.hold(2200);
      const fx = await page.locate('.pb-card .pb-fix');
      if (fx) {
        await page.hover(fx, { settle: 500 });
        await rec.snap();
        await rec.hold(1000);
        await page.click('.pb-card .pb-fix');
        await sleep(1200);
        await rec.snap();
        await rec.hold(1800);
      }
    }
    await page.evaluate(`window.__spacelens.useUi.getState().openSection('safety')`);
    rec.pause();
    await page.waitFor(`!!document.querySelector('.safety-headline')`, 60000).catch(() => {});
    await sleep(1500);
    await rec.resume();
    await rec.focus(null);
    await rec.hold(2000);
    await page.click('text~Evacuate').catch(() => {});
    await rec.hold(5000);
    await rec.focus('.panel-col', { pad: 10 });
    await rec.hold(2000);
    return rec.stop();
  },

  /** A product link becomes a true-size object with its price. */
  async shop({ page, rec }) {
    await open(page, 'nav=shop&sample=1&view=split');
    await page.waitFor(`!!document.querySelector('[aria-label="Product link"]')`, 60000);
    await rec.start('shop');
    await rec.focus('.panel-col', { pad: 10 });
    await rec.hold(500);
    await page.type('[aria-label="Product link"]', 'https://www.ikea.com/se/sv/p/lack-soffbord-svart-00449908/');
    await rec.snap();
    await rec.hold(700);
    await page.click('text=Read');
    rec.rate(0.25);
    await page.waitFor(`document.querySelectorAll('.shop-card').length > 0`, AI_MS);
    rec.rate(1);
    await sleep(800);
    await rec.snap();
    await rec.hold(2000);
    const before = await page.evaluate(S('s.model.furniture.length'));
    await page.click('text~Add to room', { within: '.shop-card' });
    rec.rate(0.3);
    await sleep(1500);
    if (await page.locate('[aria-label="Width in cm"]')) {
      await page.type('[aria-label="Width in cm"]', '90');
      await page.type('[aria-label="Depth in cm"]', '55');
      await page.type('[aria-label="Height in cm"]', '45');
      await page.click('text~Add at this size');
    }
    if (await page.locate('text~Build from title')) await page.click('text~Build from title');
    await page.waitFor(S(`s.model.furniture.length > ${before}`), AI_MS);
    rec.rate(1);
    await sleep(1500);
    await rec.focus(null);
    await rec.snap();
    await rec.hold(2500);
    return rec.stop();
  },

  /** The handover sheet. */
  async export({ page, rec }) {
    await open(page, 'nav=export&sample=1&view=split');
    await page.waitFor(`!!document.querySelector('.export-list')`, 60000);
    await rec.start('export');
    await rec.focus('.panel-col', { pad: 10 });
    await rec.hold(1500);
    await page.hover('text~Download PDF').catch(() => {});
    await rec.hold(2500);
    return rec.stop();
  },
};

// ---------- main ----------

const pick = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--base');
const names = pick.length ? pick : Object.keys(SCENES);
mkdirSync(FRAMES, { recursive: true });
// Other work on this machine pauses its browser passes while the status file starts with RECORDING.
const status = (on) => {
  try {
    const cur = existsSync(BOARD_STATUS) ? readFileSync(BOARD_STATUS, 'utf8').replace(/^RECORDING\r?\n/, '') : '';
    writeFileSync(BOARD_STATUS, (on ? 'RECORDING\n' : '') + cur);
  } catch { /* board not present on this machine */ }
};
status(true);
process.on('exit', () => status(false));
process.on('SIGINT', () => process.exit(130));
const report = {};
for (const name of names) {
  const fn = SCENES[name];
  if (!fn) { console.log(`unknown scene ${name}`); continue; }
  console.log(`== ${name}`);
  const t0 = Date.now();
  const page = await launch({ width: CSS.w, height: CSS.h });
  await page.init(INIT);
  const rec = recorder(page, FRAMES, { css: CSS });
  try {
    const m = await fn({ page, rec });
    rmSync(join(FRAMES, name), { recursive: true, force: true });
    renameSync(join(FRAMES, `${name}.take`), join(FRAMES, name));
    report[name] = { ok: true, frames: m.frames.length, dur: m.dur };
    console.log(`   ok: ${m.frames.length} frames, ${(m.dur / 1000).toFixed(1)} s of footage, ${((Date.now() - t0) / 1000).toFixed(0)} s wall`);
  } catch (e) {
    report[name] = { ok: false, error: e.message.split('\n')[0] };
    console.log(`   FAILED ${e.message.split('\n')[0]}`);
    const shot = await page.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
    if (shot) writeFileSync(join(FRAMES, `${name}-error.png`), Buffer.from(shot.data, 'base64'));
    // A failed take is thrown away; an earlier good take of the scene, if any, stays in use.
    await rec.stop().catch(() => {});
    rmSync(join(FRAMES, `${name}.take`), { recursive: true, force: true });
  }
  const errs = page.takeProblems().filter((p) => p.kind === 'exception');
  for (const p of errs) console.log(`   [exception] ${p.text.slice(0, 200)}`);
  await page.close();
}
writeFileSync(join(FRAMES, 'capture-report.json'), JSON.stringify(report, null, 1));
