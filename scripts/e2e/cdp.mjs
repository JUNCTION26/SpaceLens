// Minimal headless-browser driver over the Chrome DevTools Protocol (Edge or Chrome).
// No dependencies: Node 22+ ships WebSocket and fetch.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = [
  process.env.EDGE,
  process.env.CHROME,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ width = 1440, height = 900, shots } = {}) {
  const exe = CANDIDATES.find((p) => existsSync(p));
  if (!exe) throw new Error('No Edge or Chrome found. Set EDGE=<path to browser>.');
  const profile = mkdtempSync(join(tmpdir(), 'spacelens-e2e-'));
  const port = 9400 + Math.floor(Math.random() * 400);
  const proc = spawn(exe, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--hide-scrollbars', '--mute-audio',
    '--no-first-run', '--no-default-browser-check', `--window-size=${width},${height}`, 'about:blank',
  ], { stdio: 'ignore' });

  let wsUrl;
  for (let i = 0; i < 100 && !wsUrl; i++) {
    try {
      const pages = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((t) => t.type === 'page');
      if (pages.length) wsUrl = pages[0].webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    if (!wsUrl) await sleep(150);
  }
  if (!wsUrl) { proc.kill(); throw new Error('browser did not start'); }

  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });
  let seq = 0;
  const pending = new Map();
  const listeners = new Map();
  const problems = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    for (const fn of listeners.get(m.method) ?? []) fn(m.params);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const k = ++seq;
    const t = setTimeout(() => { pending.delete(k); reject(new Error(`CDP timeout: ${method}`)); }, 60000);
    pending.set(k, (m) => { clearTimeout(t); m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result); });
    ws.send(JSON.stringify({ id: k, method, params }));
  });
  const on = (method, fn) => { listeners.set(method, [...(listeners.get(method) ?? []), fn]); };

  const IGNORE = [/Download the React DevTools/, /\[vite\]/, /THREE\.WebGLRenderer: Context Lost/, /GPU stall due to ReadPixels/, /WebGL.*performance/i];
  on('Runtime.exceptionThrown', (p) => problems.push({ kind: 'exception', text: (p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? '').slice(0, 600) }));
  on('Runtime.consoleAPICalled', (p) => {
    if (p.type !== 'error') return;
    const text = p.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 600);
    if (!IGNORE.some((r) => r.test(text))) problems.push({ kind: 'console', text });
  });
  const reqUrl = new Map();
  on('Network.requestWillBeSent', (p) => reqUrl.set(p.requestId, p.request.url));
  on('Network.loadingFailed', (p) => {
    const url = reqUrl.get(p.requestId) ?? '';
    if (p.canceled || /net::ERR_ABORTED/.test(p.errorText)) return;
    problems.push({ kind: 'network', text: `${p.errorText} ${url.slice(0, 200)}` });
  });
  on('Network.responseReceived', (p) => {
    const { status, url } = p.response;
    if (status >= 400 && !/generativelanguage|favicon/.test(url)) problems.push({ kind: 'http', text: `${status} ${url.slice(0, 200)}` });
  });

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  if (width < 600) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

  const evaluate = async (expression, { awaitPromise = true } = {}) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}\n  in: ${expression.slice(0, 200)}`);
    return r.result.value;
  };

  const page = {
    send, on, evaluate, problems,
    async goto(url, settle = 1500) {
      await send('Page.navigate', { url });
      await page.waitFor('document.readyState === "complete" && !!window.__spacelens', 30000);
      await sleep(settle);
    },
    async waitFor(expr, timeout = 15000, every = 200) {
      const t0 = Date.now();
      let last;
      while (Date.now() - t0 < timeout) {
        try { last = await evaluate(`(()=>{ try { return (${expr}); } catch (e) { return false; } })()`); } catch { last = false; }
        if (last) return last;
        await sleep(every);
      }
      throw new Error(`timed out after ${timeout} ms waiting for: ${expr.slice(0, 160)}`);
    },
    /** Find a visible element by CSS selector, or by its visible text with `text=`; returns its centre. */
    async locate(target, { within } = {}) {
      return evaluate(`(${locateFn})(${JSON.stringify(target)}, ${JSON.stringify(within ?? null)})`);
    },
    async click(target, opts = {}) {
      const hit = await page.locate(target, opts);
      if (!hit) throw new Error(`not found: ${target}`);
      if (hit.covered && !opts.force) throw new Error(`covered by ${hit.covered}: ${target}`);
      await page.mouse(hit.x, hit.y);
      await sleep(opts.settle ?? 250);
      return hit;
    },
    async mouse(x, y, { button = 'left', clickCount = 1 } = {}) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: 1, clickCount });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount });
    },
    async drag(x0, y0, x1, y1, steps = 12) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0 });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', buttons: 1, clickCount: 1 });
      for (let i = 1; i <= steps; i++) {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + ((x1 - x0) * i) / steps, y: y0 + ((y1 - y0) * i) / steps, button: 'left', buttons: 1 });
        await sleep(16);
      }
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: 'left', buttons: 0, clickCount: 1 });
    },
    /** Focus an input/textarea, clear it, and type text as real key input. */
    async type(target, text, { clear = true } = {}) {
      const hit = await page.click(target);
      if (clear) {
        await evaluate(`(()=>{ const el = document.activeElement; if (el && 'select' in el) el.select(); })()`);
        await page.key('Backspace');
      }
      await send('Input.insertText', { text });
      await sleep(100);
      return hit;
    },
    async key(key, { modifiers = 0 } = {}) {
      const map = { Enter: [13, '\r'], Backspace: [8, ''], Escape: [27, ''], Tab: [9, ''], Delete: [46, ''], ArrowLeft: [37, ''], ArrowRight: [39, ''], ArrowUp: [38, ''], ArrowDown: [40, ''] };
      const [code, txt] = map[key] ?? [key.toUpperCase().charCodeAt(0), key];
      const base = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers };
      await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: modifiers ? undefined : txt || undefined });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      await sleep(80);
    },
    async text(selector = 'body') {
      return evaluate(`(document.querySelector(${JSON.stringify(selector)})?.innerText ?? '')`);
    },
    async state(path) {
      return evaluate(`(()=>{ const s = window.__spacelens.useStore.getState(); return ${path}; })()`);
    },
    async shot(name) {
      if (!shots) return null;
      mkdirSync(shots, { recursive: true });
      const r = await send('Page.captureScreenshot', { format: 'png' });
      const file = join(shots, `${name}.png`);
      writeFileSync(file, Buffer.from(r.data, 'base64'));
      return file;
    },
    takeProblems() { return problems.splice(0, problems.length); },
    async close() {
      try { ws.close(); } catch { /* closed */ }
      proc.kill();
      await sleep(300);
      try { rmSync(profile, { recursive: true, force: true }); } catch { /* still locked */ }
    },
  };
  return page;
}

// Runs in the page. Finds the first visible match and reports whether something else covers its centre.
const locateFn = function (target, within) {
  const root = within ? document.querySelector(within) : document;
  if (!root) return null;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  };
  let els;
  if (target.startsWith('text=') || target.startsWith('text~')) {
    const exact = target.startsWith('text=');
    const want = target.slice(5).trim().toLowerCase();
    const pool = [...root.querySelectorAll('button, a, [role=button], [role=tab], [role=radio], [role=menuitem], [role=option], summary, label, li, [tabindex]')];
    const norm = (el) => (el.innerText || el.getAttribute('aria-label') || el.title || '').replace(/\s+/g, ' ').trim().toLowerCase();
    els = pool.filter((el) => (exact ? norm(el) === want : norm(el).includes(want)));
    // Prefer the innermost match.
    els = els.filter((el) => !els.some((o) => o !== el && el.contains(o)));
  } else {
    els = [...root.querySelectorAll(target)];
  }
  const el = els.find(visible);
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  const x = Math.round(r.left + r.width / 2);
  const y = Math.round(r.top + r.height / 2);
  const top = document.elementFromPoint(x, y);
  const covered = top && top !== el && !el.contains(top) && !top.contains(el)
    ? `${top.tagName.toLowerCase()}${top.className && typeof top.className === 'string' ? '.' + top.className.split(' ').join('.') : ''}`
    : null;
  return { x, y, w: Math.round(r.width), h: Math.round(r.height), covered, label: (el.innerText || el.getAttribute('aria-label') || '').slice(0, 60) };
}.toString();
