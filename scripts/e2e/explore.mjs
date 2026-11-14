#!/usr/bin/env node
// Explore one screen: open a deep link, run steps, then print the visible controls and take a screenshot.
// Usage: node scripts/e2e/explore.mjs "nav=layouts&sample=1" name [--size 390x844] [--nokey] [--steps '[["click","text=Generate"],["wait",2000]]']
// Step kinds: click <target>, type <target> <text>, key <name>, wait <ms|expr>, eval <js>, shot <name>.
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launch, sleep } from './cdp.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const k = args.indexOf(n); return k >= 0 ? args[k + 1] : d; };
const valued = ['--size', '--steps', '--base', '--within'];
const [query = '', name = 'explore'] = args.filter((a, i) => !a.startsWith('--') && !valued.includes(args[i - 1]));
const [width, height] = flag('--size', '1440x900').split('x').map(Number);
const base = flag('--base', process.env.SPACELENS_URL ?? 'http://localhost:5180/');
const shots = join(process.env.LOCALAPPDATA ?? tmpdir(), 'Temp', 'spacelens-shots', 'e2e');
const steps = JSON.parse(flag('--steps', '[]'));

export const controlsFn = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const out = [];
  for (const el of document.querySelectorAll('button, a[href], input, textarea, select, [role=tab], [role=radio]')) {
    if (!vis(el)) continue;
    const r = el.getBoundingClientRect();
    const t = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.title || el.value || '').replace(/\\s+/g, ' ').trim().slice(0, 50);
    out.push(el.tagName.toLowerCase() + (el.disabled ? '[disabled]' : '') + ' @' + Math.round(r.x) + ',' + Math.round(r.y) + ' ' + JSON.stringify(t));
  }
  return out.join('\\n');
})()`;

const page = await launch({ width, height, shots });
try {
  await page.goto(`${base}?coach=0&${query}`, 800);
  if (args.includes('--nokey')) await page.evaluate(`window.__spacelens.useStore.getState().setSettings({ geminiKey: '' })`);
  await page.settled();
  for (const [kind, a, b] of steps) {
    try {
      if (kind === 'click') await page.click(a, { force: b === 'force' });
      else if (kind === 'type') await page.type(a, b);
      else if (kind === 'key') await page.key(a);
      else if (kind === 'wait') typeof a === 'number' ? await sleep(a) : await page.waitFor(a, b ?? 30000);
      else if (kind === 'eval') console.log('eval:', JSON.stringify(await page.evaluate(a)).slice(0, 1500));
      else if (kind === 'shot') console.log(await page.shot(a));
    } catch (e) { console.log(`step ${kind} ${a} failed: ${e.message}`); }
  }
  await sleep(500);
  if (!args.includes('--quiet')) {
    const within = flag('--within', '');
    console.log(within ? await page.text(within) : await page.evaluate(controlsFn));
  }
  console.log(await page.shot(name));
  for (const p of page.takeProblems()) console.log(`  [${p.kind}] ${p.text}`);
} finally {
  await page.close();
}
