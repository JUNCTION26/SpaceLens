#!/usr/bin/env node
// Screenshots generated objects with headless Edge (or Chrome) against the running dev server,
// driving the browser over the DevTools protocol so page errors are printed too.
// Usage: node scripts/forge-shot.mjs [0,1,2 | all | grid] [--open] [--out dir] [--port 5180] [--size 1.6,0.8,0.75]
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (n, d) => { const k = args.indexOf(n); return k >= 0 ? args[k + 1] : d; };
const valued = new Set(['--out', '--port', '--size', '--wait']);
const which = args.find((a, i) => !a.startsWith('--') && !valued.has(args[i - 1])) ?? 'all';
const out = resolve(flag('--out', 'forge-shots'));
const port = flag('--port', '5180');
const wait = Number(flag('--wait', '6000'));
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
