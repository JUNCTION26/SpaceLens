#!/usr/bin/env node
// One-command smoke test: proves the product works before shipping.
//
// Usage:
//   node scripts/e2e/smoke.mjs [--base <url>] [--only a,b,c] [--size WxH] [--timeout <s>] [--list]
//
//   --base     App URL. Default http://localhost:5180/ (also env SPACELENS_URL).
//              Works against the live site: --base https://junction26.github.io/SpaceLens/
//   --only     Comma-separated flow names to run (see --list). Default: all.
//   --size     Browser size for desktop flows. Default 1440x900. The phone flow always uses 390x844.
//   --timeout  Hard timeout per flow in seconds. Default 90 (flows that wait for the planner get more).
//   --list     Print flow names and exit.
//
// How it runs: one headless browser, flows one at a time. Before each flow localStorage and
// sessionStorage are cleared through the page and the app is opened fresh. Console errors and
// unhandled rejections during a flow fail that flow (allowlist: favicon, ResizeObserver loop notices).
// Every flow passes on the production build using the DOM only; the development handle
// window.__spacelens is used for extra state checks when it exists.
// Screenshots go to <temp>/spacelens-shots/smoke/<flow>.png. The last output is one table
// (flow, result, ms, screenshot). Exit code is 1 when any flow failed, 0 otherwise.
// Run it when the machine is quiet: the 3D view renders in software and is slow under load.
import { inflateSync } from 'node:zlib';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launch, sleep } from './cdp.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const k = args.indexOf(n); return k >= 0 ? args[k + 1] : d; };
const BASE = new URL(flag('--base', process.env.SPACELENS_URL ?? 'http://localhost:5180/')).toString();
const [W, H] = flag('--size', '1440x900').split('x').map(Number);
const DEFAULT_TIMEOUT = Number(flag('--timeout', '90')) * 1000;
const ONLY = flag('--only', '')?.split(',').map((s) => s.trim()).filter(Boolean);
const SHOTS = join(process.env.LOCALAPPDATA ?? tmpdir(), 'Temp', 'spacelens-shots', 'smoke');

const ALLOW = [/favicon/i, /ResizeObserver loop/i, /Download the React DevTools/i];

// Records Blob downloads without saving files, so export clicks can be checked.
const INIT = `(() => {
  const rec = window.__smoke = { blobs: [], downloads: [] };
  const mk = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (o) => { try { rec.blobs.push({ size: o.size, type: o.type }); } catch {} return mk(o); };
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { if (this.download) rec.downloads.push(this.download); return click.call(this); };
})();`;

// ---------- PNG pixels (no dependencies) ----------
function decodePng(buf) {
  let p = 8, w = 0, h = 0, ct = 6; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8);
    if (type === 'IHDR') { w = buf.readUInt32BE(p + 8); h = buf.readUInt32BE(p + 12); ct = buf[p + 17]; }
    if (type === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const bpp = ct === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp, out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[dst + x - bpp] : 0, b = y ? out[dst - stride + x] : 0, c = x >= bpp && y ? out[dst - stride + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[dst + x] = v & 255;
    }
  }
  return { w, h, bpp, data: out };
}

// ---------- runner ----------
const sh = (o) => JSON.stringify(o);
const page = await launch({ width: W, height: H, shots: SHOTS });
await page.init(INIT);
await page.send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => {});

const origin = new URL(BASE).origin;
const urlFor = (query) => {
  const u = new URL(BASE);
  const q = new URLSearchParams(query);
  if (!q.has('coach')) q.set('coach', '0');
  u.search = q.toString();
  return u.toString();
};

function ctxFor(name, timeoutMs) {
  const c = {
    name, page, dead: false, deadline: Date.now() + timeoutMs, note: '',
    fail(msg) { throw new Error(msg); },
    ok(cond, msg) { if (!cond) throw new Error(msg); },
    async eval(expr) { if (c.dead) throw new Error('flow timed out'); return page.evaluate(expr); },
    /** Poll a page expression until truthy. */
    async until(expr, ms = 20000, label = expr) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (c.dead) throw new Error('flow timed out');
        let v = false;
        try { v = await page.evaluate(`(()=>{ try { return (${expr}); } catch { return false; } })()`); } catch { /* navigating */ }
        if (v) return v;
        await sleep(200);
      }
      throw new Error(`timed out (${Math.round(ms / 1000)} s) waiting for ${label.slice(0, 120)}`);
    },
    /** Open the app fresh (storage cleared through the page first). */
    async open(query = '') {
      const here = await page.evaluate('location.origin').catch(() => '');
      if (here !== origin) {
        await page.send('Page.navigate', { url: urlFor('') });
        await c.until(`document.readyState === 'complete'`, 60000, 'first load');
      }
      await page.evaluate('try { localStorage.clear(); sessionStorage.clear(); } catch {}').catch(() => {});
      await page.send('Page.navigate', { url: urlFor(query) });
      await sleep(300);
      await c.until(`document.readyState === 'complete' && (document.querySelector('#root')?.children.length ?? 0) > 0`, 60000, 'app to load');
      await sleep(600);
    },
    /** Click by CSS selector, or `text=Label` / `text~part`, using a DOM click on the first visible match. */
    async click(target, ms = 15000) {
      await c.until(`(${findFn})(${sh(target)})`, ms, `visible ${target}`);
      const done = await c.eval(`(()=>{ const el = (${findFn})(${sh(target)}); if (!el) return false; el.scrollIntoView({block:'center'}); el.click(); return true; })()`);
      if (!done) c.fail(`could not click ${target}`);
      await sleep(250);
    },
    has(target) { return c.eval(`!!(${findFn})(${sh(target)})`); },
    count(sel) { return c.eval(`document.querySelectorAll(${sh(sel)}).length`); },
    dev() { return c.eval('!!(window.__spacelens && window.__spacelens.useStore)'); },
    store(expr) { return c.eval(`(()=>{ const s = window.__spacelens.useStore.getState(); return (${expr}); })()`); },
    async overflow() { return c.eval('document.documentElement.scrollWidth - window.innerWidth'); },
    async canvasReady(ms = 90000) {
      await c.until(`(()=>{ const cv = document.querySelector('.pane-3d canvas'); return !!cv && cv.width > 0 && !document.querySelector('.stage-skel'); })()`, ms, '3D canvas');
      await sleep(1500);
    },
    /** Fraction of pixels in the canvas centre that differ from its background corner, from a real screenshot. */
    async canvasInk() {
      const r = await c.eval(`(()=>{ const b = document.querySelector('.pane-3d canvas')?.getBoundingClientRect(); return b && { x: b.left, y: b.top, w: b.width, h: b.height }; })()`);
      if (!r || r.w < 10 || r.h < 10) return 0;
      const shot = await page.send('Page.captureScreenshot', { format: 'png', clip: { x: r.x, y: r.y, width: r.w, height: r.h, scale: 1 } }, 120000);
      const img = decodePng(Buffer.from(shot.data, 'base64'));
      const px = (x, y) => { const i = (y * img.w + x) * img.bpp; return [img.data[i], img.data[i + 1], img.data[i + 2]]; };
      const bg = px(4, 4);
      let diff = 0, n = 0;
      for (let y = Math.floor(img.h * 0.3); y < img.h * 0.7; y += 2) {
        for (let x = Math.floor(img.w * 0.3); x < img.w * 0.7; x += 2) {
          const p = px(x, y); n++;
          if (Math.max(Math.abs(p[0] - bg[0]), Math.abs(p[1] - bg[1]), Math.abs(p[2] - bg[2])) > 10) diff++;
        }
      }
      return n ? diff / n : 0;
    },
    async itemRect(sel = '.plan2d-item:not(.is-locked) .plan2d-item-body') {
      return c.eval(`(()=>{ for (const el of document.querySelectorAll(${sh(sel)})) { const b = el.getBoundingClientRect(); if (b.width < 6 || b.height < 6) continue; const x = b.left + b.width / 2, y = b.top + b.height / 2; if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue; const top = document.elementFromPoint(x, y); if (top === el || el.contains(top)) return { id: el.getAttribute('data-hit'), x, y, w: b.width, h: b.height, left: b.left, top: b.top }; } return null; })()`);
    },
  };
  return c;
}

// Finds the first visible element: CSS selector, text=exact label, text~partial label.
const findFn = function (target) {
  // Visible means rendered: it has a layout box and is not hidden by display or visibility. Being scrolled out of a
  // scrolling panel (or off the window) does not matter; click() scrolls the element into view first.
  const vis = (el) => { const cs = getComputedStyle(el); return el.getClientRects().length > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  if (target.startsWith('text=') || target.startsWith('text~')) {
    const exact = target.startsWith('text=');
    const want = target.slice(5).trim().toLowerCase();
    const norm = (el) => (el.innerText || el.getAttribute('aria-label') || el.title || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const pool = [...document.querySelectorAll('button, a, [role=button], [role=tab], [role=radio], [role=menuitem], [role=option], summary, label')];
    const hits = pool.filter((el) => (exact ? norm(el) === want : norm(el).includes(want)) && vis(el));
    return hits.find((el) => !hits.some((o) => o !== el && el.contains(o))) ?? null;
  }
  return [...document.querySelectorAll(target)].find(vis) ?? null;
}.toString();

async function typeInto(c, selector, text) {
  await c.click(selector);
  await c.eval(`(()=>{ const el = document.querySelector(${sh(selector)}); el.focus(); if ('select' in el) el.select(); })()`);
  await page.send('Input.insertText', { text });
  await sleep(150);
}

const SAMPLE = 'sample=1';

// ---------- flows ----------
const flows = [];
const flow = (name, fn, timeout = DEFAULT_TIMEOUT) => flows.push({ name, fn, timeout });

flow('home', async (c) => {
  await c.open('');
  await c.until(`!!document.querySelector('input.home-ask-input[aria-label]')`, 20000, 'the describe field on home');
  c.ok(await c.has('.home-quick-card'), 'home shows the one-click starts');
});

flow('describe-home', async (c) => {
  await c.open('');
  await typeInto(c, 'input.home-ask-input', 'a quiet home office for two with a window desk');
  await page.key('Enter');
  await c.until(`!document.querySelector('.home')`, 15000, 'leaving home after Enter');
  const before = await c.count('.plan2d-item');
  await c.until(`document.querySelectorAll('.layout-card').length > 0 || document.querySelectorAll('.plan2d-item').length !== ${before}`, 40000, 'layouts or a furnished room within 40 s');
  c.note = `${await c.count('.layout-card')} layouts`;
}, 120000);

flow('sample-split', async (c) => {
  await c.open(`${SAMPLE}&view=split`);
  await c.until(`!!document.querySelector('.pane-2d svg') && !!document.querySelector('.pane-3d')`, 30000, 'plan and 3D panes');
  c.ok((await c.count('.plan2d-floor')) >= 1, 'plan shows a room');
  c.ok((await c.count('.plan2d-item')) >= 1, 'plan shows furniture');
  await c.canvasReady();
});

flow('library-add', async (c) => {
  await c.open(`${SAMPLE}&nav=furniture&view=2d`);
  await c.until(`document.querySelectorAll('.plan2d-item').length > 0`, 20000, 'sample furniture');
  const before = await c.count('.plan2d-item');
  await c.click('.furniture-card[title*=" cm,"]', 30000);
  await c.until(`document.querySelectorAll('.plan2d-item').length > ${before}`, 10000, 'a new item on the plan');
});

flow('layout-apply', async (c) => {
  await c.open(`${SAMPLE}&nav=describe&view=split`);
  await c.until(`!!document.querySelector('textarea[aria-label="Describe your space"]')`, 30000, 'the describe panel');
  await c.eval(`window.dispatchEvent(new CustomEvent('spacelens:request', { detail: 'home office for two' }))`);
  await c.until(`document.querySelectorAll('.layout-card').length > 0`, 60000, 'layouts');
  await c.until(`!!document.querySelector('.layout-card .btn-primary')`, 30000, 'an Apply button');
  await c.click('.layout-card .btn-primary');
  await c.until(`!!document.querySelector('[aria-label="Applied"]')`, 10000, 'the Applied mark');
}, 150000);

flow('undo-redo', async (c) => {
  await c.open(`${SAMPLE}&nav=furniture&view=2d`);
  await c.until(`document.querySelectorAll('.plan2d-item').length > 0`, 20000, 'sample furniture');
  const n = await c.count('.plan2d-item');
  await c.click('.furniture-card[title*=" cm,"]', 30000);
  await c.until(`document.querySelectorAll('.plan2d-item').length === ${n + 1}`, 10000, 'item added');
  await c.until(`!document.querySelector('[aria-label="Undo"]')?.disabled`, 5000, 'Undo enabled');
  await c.click('[aria-label="Undo"]');
  await c.until(`document.querySelectorAll('.plan2d-item').length === ${n}`, 8000, 'Undo to remove the item');
  await c.until(`!document.querySelector('[aria-label="Redo"]')?.disabled`, 5000, 'Redo enabled');
  await c.click('[aria-label="Redo"]');
  await c.until(`document.querySelectorAll('.plan2d-item').length === ${n + 1}`, 8000, 'Redo to bring it back');
});

flow('drag-2d', async (c) => {
  await c.open(`${SAMPLE}&view=2d`);
  await c.until(`document.querySelectorAll('.plan2d-item').length > 0`, 20000, 'sample furniture');
  await sleep(1200);
  const a = await c.itemRect();
  c.ok(a, 'a draggable item is visible on the plan');
  await page.drag(a.x, a.y, a.x + 70, a.y + 45, 14);
  await sleep(500);
  const b = await c.eval(`(()=>{ const el = document.querySelector('[data-hit=${sh(a.id)}]'); const r = el?.getBoundingClientRect(); return r && { left: r.left, top: r.top }; })()`);
  c.ok(b, 'the dragged item is still on the plan');
  const moved = Math.hypot(b.left - a.left, b.top - a.top);
  c.ok(moved > 8, `item moved on screen (${moved.toFixed(1)} px)`);
  if (await c.dev()) c.ok(await c.eval(`!document.querySelector('[aria-label="Undo"]')?.disabled`), 'the move can be undone');
});

flow('canvas-3d', async (c) => {
  await c.open(`${SAMPLE}&view=3d`);
  await c.canvasReady();
  const ink = await c.canvasInk();
  c.ok(ink > 0.02, `3D canvas is not blank (${(ink * 100).toFixed(1)}% of the centre differs from the background)`);
  c.note = `${(ink * 100).toFixed(0)}% ink`;
}, 150000);

flow('wheel-3d', async (c) => {
  await c.open(`${SAMPLE}&view=3d`);
  await c.canvasReady();
  const before = await c.canvasInk();
  c.ok(before > 0.02, `3D canvas drawn before the wheel (${(before * 100).toFixed(1)}%)`);
  const r = await c.eval(`(()=>{ const b = document.querySelector('.pane-3d canvas').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  for (const dy of [-300, -300, -300, 300, 300, 300, 600, -200]) {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: r.x, y: r.y, deltaX: 0, deltaY: dy });
    await sleep(120);
  }
  await sleep(2000);
  c.ok(await c.has('.app'), 'the app is still on screen after the wheel');
  c.ok(await c.has('.pane-3d canvas'), 'the 3D canvas is still mounted after the wheel');
  const after = await c.canvasInk();
  c.ok(after > 0.02, `3D canvas is not blank after the wheel (${(after * 100).toFixed(1)}%)`);
  c.note = `${(before * 100).toFixed(0)}% to ${(after * 100).toFixed(0)}%`;
}, 150000);

flow('walk', async (c) => {
  await c.open(`${SAMPLE}&view=split`);
  await c.canvasReady();
  await c.click('[aria-label="Walk"]');
  await c.until(`document.querySelector('[aria-label="Walk"]')?.getAttribute('aria-pressed') === 'true'`, 8000, 'walk mode on');
  await sleep(800);
  await c.click('[aria-label="Walk"]');
  await c.until(`document.querySelector('[aria-label="Walk"]')?.getAttribute('aria-pressed') === 'false'`, 8000, 'walk mode off');
  c.ok(await c.has('.pane-3d canvas'), 'the 3D view is still there after leaving walk mode');
}, 150000);

for (const [name, query, minRooms] of [
  ['demo-villa', 'demo=villa&view=split', 2],
  ['demo-office', 'demo=office&view=2d', 2],
  ['demo-lshape', 'demo=lshape&view=split', 2],
]) {
  flow(name, async (c) => {
    await c.open(query);
    await c.until(`document.querySelectorAll('.plan2d-floor').length >= ${minRooms}`, 60000, `more than one room on the plan`);
    c.note = `${await c.count('.plan2d-floor')} rooms`;
  });
}

flow('safety', async (c) => {
  await c.open(`${SAMPLE}&nav=safety&view=2d`);
  await c.until(`!!document.querySelector('select[aria-label="Country"]')`, 40000, 'the country dropdown');
  await c.until(`!!document.querySelector('.drill-go')`, 20000, 'the Drill button');
  await c.click('.drill-go');
  await c.until(`!!document.querySelector('.drill-chips .safety-chip')`, 20000, 'the drill result chips');
  c.ok(/fire/i.test(await c.eval(`document.querySelector('.safety-tabs [role=tab][aria-selected=true]')?.innerText ?? ''`)), 'the Fire tab is selected first');
  await c.click('.safety-tabs [role=tab]:nth-child(2)');
  await c.until(`/access/i.test(document.querySelector('.safety-tabs [role=tab][aria-selected=true]')?.innerText ?? '')`, 5000, 'the Access tab');
  await c.click('.safety-tabs [role=tab]:nth-child(1)');
  await c.until(`!!document.querySelector('select[aria-label="Country"]')`, 5000, 'the country dropdown again');
  const snap = () => c.eval(`(document.querySelector('.panel-col')?.innerText ?? '') + '|' + [...document.querySelectorAll('.panel-col input[type=number]')].map((i) => i.value + '/' + i.placeholder).join(',')`);
  const before = await snap();
  const opts = await c.eval(`[...document.querySelector('select[aria-label="Country"]').options].map((o) => o.value)`);
  c.ok(opts.length >= 2, 'the country dropdown offers more than one country');
  const cur = await c.eval(`document.querySelector('select[aria-label="Country"]').value`);
  const next = opts.find((v) => v !== cur);
  await c.eval(`(()=>{ const s = document.querySelector('select[aria-label="Country"]'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, ${sh(next)}); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await c.until(`document.querySelector('select[aria-label="Country"]').value === ${sh(next)}`, 5000, 'the dropdown to keep the new country');
  await sleep(1500);
  const after = await snap();
  c.ok(after !== before, 'changing the country changes the values on screen');
});

flow('movein', async (c) => {
  await c.open(`${SAMPLE}&nav=movein&view=2d`);
  await c.until(`document.querySelectorAll('.movein-main').length > 0`, 40000, 'items listed in Move in');
  c.note = `${await c.count('.movein-main')} items`;
  c.ok(await c.has('.movein-bar button[aria-label="Play"]'), 'Play comes first in Move in');
  await c.click('text=4x');
  await c.click('.movein-bar button[aria-label="Play"]');
  await c.until(`!!document.querySelector('.movein-row.now, .movein-row.landed')`, 20000, 'the move-in to start carrying items');
});

flow('export', async (c) => {
  await c.open(`${SAMPLE}&nav=export&view=2d`);
  await c.until(`!!document.querySelector('.export-block[aria-label="Files"] .export-file[title="IFC"]')`, 40000, 'the Files grid with IFC');
  c.ok(await c.has('.export-block[aria-label="Files"] .export-file[title="DXF"]'), 'the Files grid has DXF');
  c.ok(await c.has('.export-block[aria-label="List"]'), 'the Export panel has the list section');
  await c.eval(`window.__smoke.blobs.length = 0`);
  await c.click('.export-file[title="IFC"]');
  await c.until(`window.__smoke.blobs.some((b) => b.size > 200)`, 15000, 'the IFC download');
  c.ok((await c.eval(`window.__smoke.downloads.some((n) => /\\.ifc$/i.test(n))`)), 'the download is named .ifc');
});

flow('search', async (c) => {
  await c.open(`${SAMPLE}&view=2d`);
  await c.until(`!!document.querySelector('.app')`, 20000, 'the workspace');
  await sleep(800);
  c.ok(await c.has('.search-field input[aria-label="Search commands"]'), 'the top bar has the search field');
  await page.key('k', { modifiers: 2 });
  await c.until(`document.activeElement?.matches('.search-field input') && !!document.querySelector('#cmd-list')`, 8000, 'Ctrl+K to focus the search field and show results in the panel');
  c.ok(!(await c.has('[role=dialog][aria-label="Command palette"]')), 'search is not a modal');
  await typeInto(c, '.search-field input', 'ifc');
  await c.until(`[...document.querySelectorAll('#cmd-list [role=option]')].some((o) => /export/i.test(o.innerText) && /ifc/i.test(o.innerText))`, 8000, 'the IFC export in the results');
});

flow('assistant', async (c) => {
  await c.open(`${SAMPLE}&view=split`);
  await c.until(`!!document.querySelector('.agent-dock')`, 40000, 'the assistant dock');
  if (await c.has('.ad-ask')) await c.click('.ad-ask');
  await c.until(`!!document.querySelector('.ad-input')`, 10000, 'the assistant input');
  if (await c.has('[aria-label="Show conversation"]')) await c.click('[aria-label="Show conversation"]');
  const read = `(document.querySelector('.agent-dock')?.innerText ?? '') + '\\n' + (document.querySelector('[role=log]')?.innerText ?? '')`;
  const before = await c.eval(read);
  await typeInto(c, '.ad-input', 'what is the room size');
  await page.key('Enter');
  const got = await c.until(`(()=>{ const t = ${read}; const fresh = t.split('\\n').filter((l) => !${sh(before)}.includes(l)).join(' '); return /\\d/.test(fresh.replace(/what is the room size/i, '')) && fresh; })()`, 45000, 'an answer with digits');
  c.note = String(got).slice(0, 40);
}, 120000);

flow('phone', async (c) => {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  try {
    const check = async (label) => { const o = await c.overflow(); c.ok(o <= 0, `${label} overflows horizontally by ${o} px at 390 wide`); };
    await c.open('');
    await c.until(`!!document.querySelector('input.home-ask-input')`, 20000, 'home');
    await sleep(500);
    await check('home');
    await c.open(`${SAMPLE}&nav=describe`);
    await c.until(`!!document.querySelector('textarea[aria-label="Describe your space"]')`, 30000, 'the describe panel');
    await sleep(500);
    await check('describe');
    await c.open(`${SAMPLE}&nav=layouts`);
    await c.until(`!!document.querySelector('.panel-col')`, 30000, 'the layouts panel');
    await sleep(1000);
    await check('layouts');
    await c.open(`${SAMPLE}&view=2d`);
    await c.until(`document.querySelectorAll('.plan2d-item').length > 0`, 30000, 'the plan');
    await sleep(1200);
    const a = await c.itemRect('.plan2d-item .plan2d-item-body');
    if (a) await page.mouse(a.x, a.y);
    if (!(await c.until(`!!document.querySelector('.inspector-section')`, 4000).catch(() => false)) && await c.dev()) {
      await c.eval(`(()=>{ try { const s = window.__spacelens.useStore.getState(); const f = s.model.furniture?.[0] ?? s.model.spaces?.[0]?.furniture?.[0]; if (f) s.select({ kind: 'furniture', id: f.id }); } catch {} })()`);
    }
    await c.until(`!!document.querySelector('.inspector-section')`, 8000, 'the inspector section');
    await sleep(800);
    await check('inspector section');
  } finally {
    await page.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {});
  }
});

flow('show', async (c) => {
  await c.open('show=1');
  await c.until(`!!document.querySelector('[role=progressbar][aria-label="Film"]')`, 30000, 'the show to start');
  await sleep(1500);
  c.ok(!(await c.has('.status-msg, .demo-caption, .search-results, .settings-panel')), 'nothing else is on screen while the film plays');
  await page.key('Escape');
  await c.until(`!document.querySelector('[role=progressbar][aria-label="Film"]')`, 10000, 'Esc to stop the show');
}, 120000);

flow('show-from-settings', async (c) => {
  await c.open(`${SAMPLE}&open=settings`);
  await c.until(`!!document.querySelector('.settings-panel')`, 20000, 'Settings as a panel');
  await c.click('text=More');
  await c.click('text=Demo');
  await c.until(`!!document.querySelector('[role=progressbar][aria-label="Film"]')`, 30000, 'the film to start from Settings');
  await sleep(1500);
  c.ok(!(await c.has('.settings-panel')), 'Settings is closed while the film plays');
  c.ok(!(await c.has('.demo-caption')), 'no floating caption while the film plays');
  await page.key('Escape');
  await c.until(`!document.querySelector('[role=progressbar][aria-label="Film"]')`, 10000, 'Esc to stop the film');
}, 120000);

flow('show-from-search', async (c) => {
  await c.open(`${SAMPLE}&view=2d`);
  await c.until(`!!document.querySelector('.search-field input')`, 20000, 'the search field');
  await typeInto(c, '.search-field input', 'demo');
  await c.until(`[...document.querySelectorAll('#cmd-list [role=option]')].some((o) => /demo/i.test(o.innerText))`, 8000, 'the demo command in the results');
  await c.click('text~Guided demo');
  await c.until(`!!document.querySelector('[role=progressbar][aria-label="Film"]')`, 30000, 'the film to start from search');
  await sleep(1500);
  c.ok(!(await c.has('.search-results')), 'the search results are closed while the film plays');
  await page.key('Escape');
  await c.until(`!document.querySelector('[role=progressbar][aria-label="Film"]')`, 10000, 'Esc to stop the film');
}, 120000);

flow('room-size', async (c) => {
  await c.open(`${SAMPLE}&nav=capture&view=2d`);
  const W = 'input[aria-label="Width in metres"]';
  await c.until(`!!document.querySelector('${W}')`, 20000, 'the W field in Measure');
  c.ok((await c.has('input[aria-label="Depth in metres"]')) && (await c.has('input[aria-label="Height in metres"]')), 'the size row has W, D and H');
  const width = () => c.eval(`(()=>{ const s = window.__spacelens?.useStore?.getState(); const p = s?.model?.spaces?.[0]?.polygon; if (!p) return null; const xs = p.map((v) => v.x); return Math.max(...xs) - Math.min(...xs); })()`);
  const before = await c.eval(`document.querySelector('${W}').value`);
  const w0 = await width();
  await typeInto(c, W, '5');
  await page.key('Enter');
  await c.until(`document.querySelector('${W}').value === '5.00'`, 8000, 'the W field to show 5.00 after Enter');
  c.ok(before !== '5.00', `the width changed (was ${before})`);
  const w1 = await width();
  if (w1 !== null) c.ok(Math.abs(w1 - 5) < 0.02, `the room is 5 m wide (was ${w0 === null ? '?' : w0.toFixed(2)}, now ${w1.toFixed(2)})`);
  c.note = `${before} to 5.00`;
});

flow('status-line', async (c) => {
  await c.open(`${SAMPLE}&view=2d`);
  await c.until(`!!document.querySelector('.status-line')`, 20000, 'the status line');
  await c.click('[aria-label="Share"]');
  await c.until(`!!document.querySelector('.status-line .status-msg')`, 15000, 'a message on the status line');
  c.ok(!(await c.has('.toast, .toasts')), 'no floating toasts');
});

flow('theme', async (c) => {
  await c.open(`${SAMPLE}&theme=dark&open=settings`);
  await c.until(`!!document.querySelector('[role=radiogroup][aria-label="Theme"]')`, 20000, 'the theme control');
  await c.click('[role=radiogroup][aria-label="Theme"] [role=radio]:last-child');
  await c.until(`document.documentElement.getAttribute('data-theme') === 'light'`, 5000, 'data-theme to become light');
  await c.click('text=Dark');
  await c.until(`document.documentElement.getAttribute('data-theme') === 'dark'`, 5000, 'data-theme to go back to dark');
  await c.click('text=Light');
  await c.until(`document.documentElement.getAttribute('data-theme') === 'light'`, 5000, 'light again');
});

// ---------- main ----------
if (args.includes('--list')) { console.log(flows.map((f) => f.name).join('\n')); await page.close(); process.exit(0); }
const unknown = (ONLY ?? []).filter((n) => !flows.some((f) => f.name === n));
if (unknown.length) { console.error(`unknown flow(s): ${unknown.join(', ')}\navailable: ${flows.map((f) => f.name).join(', ')}`); await page.close(); process.exit(2); }

const rows = [];
console.log(`smoke: ${BASE} at ${W}x${H}`);
try {
  for (const f of flows.filter((x) => !ONLY?.length || ONLY.includes(x.name))) {
    const c = ctxFor(f.name, f.timeout);
    page.takeProblems();
    const t0 = Date.now();
    let error = '';
    let timer;
    try {
      await Promise.race([
        f.fn(c),
        new Promise((_, rej) => { timer = setTimeout(() => { c.dead = true; rej(new Error(`flow timed out after ${Math.round(f.timeout / 1000)} s`)); }, f.timeout); }),
      ]);
    } catch (e) { error = String(e.message ?? e).split('\n')[0]; }
    clearTimeout(timer);
    c.dead = true;
    const problems = page.takeProblems().filter((p) => (p.kind === 'exception' || p.kind === 'console') && !ALLOW.some((r) => r.test(p.text)));
    if (!error && problems.length) error = `${problems[0].kind}: ${problems[0].text.split('\n')[0].slice(0, 160)}${problems.length > 1 ? ` (+${problems.length - 1} more)` : ''}`;
    const ms = Date.now() - t0;
    const shot = await page.shot(f.name).catch((e) => `(screenshot failed: ${e.message})`);
    rows.push({ name: f.name, pass: !error, ms, shot: shot ?? '', note: error || c.note });
    console.log(`  ${error ? 'FAIL' : 'ok  '} ${f.name} ${ms} ms${error ? `\n       ${error}` : ''}`);
    await sleep(200);
  }
} finally {
  await page.close();
}

const pad = (s, n) => String(s).padEnd(n);
const wName = Math.max(4, ...rows.map((r) => r.name.length));
console.log(`\n${pad('flow', wName)}  ${pad('result', 6)}  ${pad('ms', 7)}  screenshot`);
for (const r of rows) console.log(`${pad(r.name, wName)}  ${pad(r.pass ? 'pass' : 'FAIL', 6)}  ${pad(r.ms, 7)}  ${r.shot}${r.note ? `\n${pad('', wName)}  ${r.pass ? 'note' : 'why '}: ${r.note}` : ''}`);
const failed = rows.filter((r) => !r.pass).length;
console.log(`\n${rows.length - failed}/${rows.length} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
