#!/usr/bin/env node
// Screenshots generated objects with headless Edge (or Chrome) against the running dev server,
// driving the browser over the DevTools protocol so page errors are printed too.
// Usage: node scripts/forge-shot.mjs [0,1,2 | all | grid] [--open] [--out dir] [--port 5180] [--size 1.6,0.8,0.75]
//        node scripts/forge-shot.mjs --specs <dir | a.json,b.json> [--out dir]   any saved ObjectSpec JSON
//        (objects with moving parts also get a <name>-open.png)
//        node scripts/forge-shot.mjs --sheet <dir> [--cols 3] [--per 6]   contact sheets of the PNGs in dir
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (n, d) => { const k = args.indexOf(n); return k >= 0 ? args[k + 1] : d; };
const valued = new Set(['--out', '--port', '--size', '--wait', '--specs', '--sheet', '--cols', '--per']);
const which = args.find((a, i) => !a.startsWith('--') && !valued.has(args[i - 1])) ?? 'all';
const out = resolve(flag('--out', 'forge-shots'));
const port = flag('--port', '5180');
const specsArg = flag('--specs', '');
const wait = Number(flag('--wait', specsArg ? '3500' : '6000'));
const open = args.includes('--open');
const size = flag('--size', '');
const browser = process.env.EDGE ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
mkdirSync(out, { recursive: true });

const list = which === 'all' ? Array.from({ length: 11 }, (_, i) => String(i)) : which === 'grid' ? ['all'] : which.split(',');
const profile = mkdtempSync(join(tmpdir(), 'forge-shot-'));
const dbg = 9300 + Math.floor(Math.random() * 500);
const proc = spawn(browser, ['--headless=new', `--remote-debugging-port=${dbg}`, `--user-data-dir=${profile}`, '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--hide-scrollbars', '--window-size=1200,900', 'about:blank'], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function target() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${dbg}/json/list`);
      const pages = (await r.json()).filter((t) => t.type === 'page');
      if (pages.length) return pages[0].webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('browser did not start');
}

const ws = new WebSocket(await target());
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
    console.log(`  [${m.params.type}]`, m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 400));
  }
  if (m.method === 'Runtime.exceptionThrown') console.log('  [exception]', m.params.exceptionDetails?.exception?.description?.slice(0, 600) ?? m.params.exceptionDetails?.text);
});
const send = (method, params = {}) => new Promise((r) => { const k = ++id; pending.set(k, r); ws.send(JSON.stringify({ id: k, method, params })); });
await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });

const sheetDir = flag('--sheet', '');
if (sheetDir) {
  // Centre crops of every render with its file name, several per page, for reviewing a run at a glance.
  const cols = Number(flag('--cols', '3')), per = Number(flag('--per', '6'));
  const pngs = readdirSync(sheetDir).filter((n) => n.endsWith('.png') && !n.startsWith('sheet')).sort();
  const cw = 600, ch = 450, rows = Math.ceil(per / cols);
  await send('Emulation.setDeviceMetricsOverride', { width: cw * cols, height: ch * rows, deviceScaleFactor: 1, mobile: false });
  for (let k = 0; k * per < pngs.length; k++) {
    const cells = pngs.slice(k * per, (k + 1) * per).map((n) => `<figure><img src="data:image/png;base64,${readFileSync(join(sheetDir, n)).toString('base64')}"><figcaption>${n.replace(/\.png$/, '')}</figcaption></figure>`).join('');
    const html = `<html><body style="margin:0;display:grid;grid-template-columns:repeat(${cols},${cw}px);background:#ece9e4;font:13px sans-serif">${cells}<style>figure{margin:0;width:${cw}px;height:${ch}px;overflow:hidden;position:relative;outline:1px solid #ccc}img{position:absolute;left:-60px;top:-45px;width:720px}figcaption{position:absolute;left:6px;top:4px;background:#fffc;padding:2px 4px}</style></body></html>`;
    const tree = await send('Page.getFrameTree');
    await send('Page.setDocumentContent', { frameId: tree.result.frameTree.frame.id, html });
    await sleep(600);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const png = resolve(out, `sheet-${k + 1}.png`);
    writeFileSync(png, Buffer.from(shot.result.data, 'base64'));
    console.log(`saved ${png}`);
  }
  list.length = 0;
}

if (specsArg) {
  const files = specsArg.split(',').flatMap((f) => (statSync(f).isDirectory() ? readdirSync(f).filter((n) => n.endsWith('.json') && n !== 'results.json').map((n) => join(f, n)) : [f]));
  let injected;
  for (const f of files) {
    const spec = JSON.parse(readFileSync(f, 'utf8'));
    if (!Array.isArray(spec.parts)) continue;
    if (injected) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: injected });
    injected = (await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__FORGE_SPEC = ${JSON.stringify(spec)};` })).result.identifier;
    for (const o of spec.motions?.length ? [0, 1] : [0]) {
      await send('Page.navigate', { url: `http://localhost:${port}/scripts/forge-shot.html?inject=1${o ? '&open=1' : ''}` });
      await sleep(wait);
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      const png = resolve(out, `${basename(f, '.json')}${o ? '-open' : ''}.png`);
      writeFileSync(png, Buffer.from(shot.result.data, 'base64'));
      console.log(`saved ${png}`);
    }
  }
  list.length = 0;
}

for (const i of list) {
  const [w, d, h] = size ? size.split(',') : [];
  const url = `http://localhost:${port}/scripts/forge-shot.html?i=${i}${open ? '&open=1' : ''}${size ? `&w=${w}&d=${d}&h=${h}` : ''}`;
  console.log(url);
  await send('Page.navigate', { url });
  await sleep(wait);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const png = resolve(out, `forge-${i}${open ? '-open' : ''}.png`);
  writeFileSync(png, Buffer.from(shot.result.data, 'base64'));
  console.log(`saved ${png}`);
}
ws.close();
proc.kill();
