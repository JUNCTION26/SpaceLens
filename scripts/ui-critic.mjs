#!/usr/bin/env node
// UI critic: screenshots every screen in headless Edge, counts what is on screen, and asks a Gemini
// vision model to grade each one against a strict rubric drawn from Apple's Human Interface Guidelines.
//
// Usage: node scripts/ui-critic.mjs [--only home,describe,phone-home] [--nomodel] [--base http://localhost:5180/]
// Output: one compact table on stdout; full findings in <LOCALAPPDATA>/Temp/spacelens-shots/ui-critic/report.md
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launch, sleep } from './e2e/cdp.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const k = args.indexOf(n); return k >= 0 ? args[k + 1] : d; };
const base = flag('--base', process.env.SPACELENS_URL ?? 'http://localhost:5180/');
const only = flag('--only', '')?.split(',').filter(Boolean) ?? [];
const useModel = !args.includes('--nomodel');
const out = join(process.env.LOCALAPPDATA ?? tmpdir(), 'Temp', 'spacelens-shots', 'ui-critic');
mkdirSync(out, { recursive: true });

function readKey() {
  if (process.env.VITE_GEMINI_KEY) return process.env.VITE_GEMINI_KEY;
  const f = join(process.cwd(), '.env.local');
  if (!existsSync(f)) return '';
  const line = readFileSync(f, 'utf8').split(/\r?\n/).find((l) => l.startsWith('VITE_GEMINI_KEY='));
  return line ? line.slice('VITE_GEMINI_KEY='.length).trim().replace(/^["']|["']$/g, '') : '';
}
const KEY = useModel ? readKey() : '';

const NAVS = ['capture', 'drawings', 'building', 'describe', 'layouts', 'furniture', 'create', 'shop', 'inspire', 'budget', 'walk', 'safety', 'export', 'render'];
const SCREENS = [
  { name: 'home', q: 'theme=dark' },
  { name: 'home-light', q: 'theme=light' },
  { name: 'start-plan', q: 'start=plan&theme=dark', wait: 14000 },
  { name: 'start-villa', q: 'start=villa&theme=dark', wait: 14000 },
  { name: 'start-room', q: 'start=room&theme=dark', wait: 14000 },
  ...NAVS.map((n) => ({ name: n, q: `nav=${n}&sample=1&view=${n === 'walk' ? '3d' : '2d'}&theme=dark` })),
  { name: 'split-light', q: 'nav=layouts&sample=1&view=split&theme=light', wait: 6000 },
  { name: 'selected', q: 'nav=furniture&sample=1&view=2d&theme=dark',
    after: `(()=>{ const s = window.__spacelens.useStore.getState(); const f = s.model.furniture?.[0]; if (f) s.select({ kind: 'furniture', id: f.id }); return !!f; })()` },
  { name: 'problems', q: 'nav=layouts&sample=1&view=2d&theme=dark&open=checks' },
  { name: 'phone-home', q: 'theme=dark', size: [390, 844] },
  { name: 'phone-describe', q: 'nav=describe&sample=1&view=2d&theme=dark', size: [390, 844] },
  { name: 'phone-walk', q: 'nav=walk&sample=1&theme=dark', size: [390, 844] },
].filter((s) => !only.length || only.includes(s.name));

// Runs in the page: cheap density metrics without any model.
const METRICS = `(() => {
  const W = innerWidth, H = innerHeight;
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.right < 0 || r.top > H || r.left > W) return false;
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) return false;
    }
    return true;
  };
  const inter = [...document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=radio], [role=menuitem], [role=switch], [role=slider]')]
    .filter((el) => !el.disabled && vis(el));
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let texts = 0, words = 0, longest = 0, panelWords = 0, longText = ''; const seen = new Map();
  const blocks = new Map();
  for (let n; (n = walker.nextNode());) {
    const t = n.textContent.replace(/\\s+/g, ' ').trim();
    if (!t || !n.parentElement || n.parentElement.closest('script, style, [aria-hidden=true], .sr-only, .visually-hidden')) continue;
    let ok = seen.get(n.parentElement);
    if (ok === undefined) { ok = vis(n.parentElement); seen.set(n.parentElement, ok); }
    if (!ok) continue;
    const n2 = t.split(' ').length;
    texts++; words += n2;
    if (n.parentElement.closest('.panel-col, .inspector-sheet, .checks-pop')) panelWords += n2;
    // A text block is the nearest block-level ancestor: words across inline children count together.
    // Drawing labels inside an SVG are separate labels, not one paragraph.
    let b = n.parentElement;
    if (!n.parentElement.closest('svg')) while (b && b !== document.body && getComputedStyle(b).display.startsWith('inline')) b = b.parentElement;
    if (!b.matches('button, [role=button], a, label, option, select')) blocks.set(b, (blocks.get(b) ?? 0) + n2);
  }
  for (const [b, c] of blocks) if (c > longest) { longest = c; longText = (b.tagName.toLowerCase() + ': ' + (b.innerText || b.textContent || '')).replace(/\\s+/g, ' ').slice(0, 90); }
  const stage = document.querySelector('.stage');
  let overlays = 0;
  if (stage) {
    const counted = [];
    for (const el of stage.querySelectorAll('*')) {
      if (el.matches('canvas, svg *, .pane, .pane *:is(canvas)') || counted.some((c) => c.contains(el))) continue;
      const cs = getComputedStyle(el);
      if (cs.position !== 'absolute' && cs.position !== 'fixed') continue;
      if (!vis(el) || !(el.innerText || '').trim() && !el.matches('button, [role=button]')) continue;
      counted.push(el); overlays++;
    }
  }
  return { controls: inter.length, texts, words, overlays, longest, panelWords, longText };
})()`;

const RUBRIC = `You are a senior Apple Human Interface designer reviewing one screen of a web app called SpaceLens
(measure a room, design it, walk through it). Judge it the way Apple's Human Interface Guidelines would, strictly:
- Clarity: exactly one obvious primary action; text legible; purpose clear in 2 seconds.
- Deference: the content (the room plan or 3D view) is the hero; chrome, labels and panels recede.
- Depth: clear hierarchy and layering; secondary things are tucked behind disclosure.
- Density: count every visible control and text block. More than ~25 controls or ~120 words on one screen is clutter.
- Redundant labels, repeated information, competing accent colours, stacked statistic cards, chip rows, helper paragraphs.
- Misalignment, inconsistent control heights or spacing, truncated, clipped or overlapping text.
- Developer detail shown to a normal person (timings, token counts, model ids, rule ids, raw numbers).
- Empty states: one short line and one button is ideal.
- HARD RULE, this app must be usable by anyone, including people who struggle to read: no sentences and no paragraphs anywhere.
  Headings 1-3 words, buttons 1-2 words, use icons, ticks, colour and numbers instead of prose. Any text block over 8 words,
  or more than about 40 visible words in a side panel, is a top problem and caps the score at 60.
Score 0-100 where 90+ means it could ship in an Apple product, 70 is decent but busy, under 50 is cluttered.
Return only JSON: {"score": number, "visibleControlCount": number, "topProblems": [{"what": string, "where": string, "fix": string}] (max 5, most important first),
"remove": [string] (elements to delete outright), "hide": [string] (move behind More/Details/hover), "keep": [string] (what works)}.
Be concrete: name elements by their visible text.`;

const MODELS = ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'];
let firstModel = 0; // a model that answers 404/400 is skipped for the rest of the run
let lastError = '';
async function critique(png, screen) {
  if (!KEY) return null;
  for (let mi = firstModel; mi < MODELS.length; mi++) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODELS[mi]}:generateContent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: `${RUBRIC}\nScreen: ${screen}.` }, { inlineData: { mimeType: 'image/png', data: png } }] }],
            generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
          }),
        });
        if (res.status === 404) { firstModel = Math.max(firstModel, mi + 1); break; }
        if (!res.ok) {
          lastError = `${res.status} ${(await res.text()).slice(0, 160)}`;
          if (res.status === 400) break;
          // An exhausted daily quota will not recover within this run: move to the next model.
          // Per-minute limits clear after a pause; a daily quota does not, so after three pauses try the next model.
          if (res.status === 429) { if (attempt >= 2) { firstModel = Math.max(firstModel, mi + 1); break; } await sleep(20000); continue; }
          await sleep(4000 * (attempt + 1)); continue;
        }
        const j = await res.json();
        const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
        const parsed = JSON.parse(text.replace(/^```json|```$/g, '').trim());
        return { ...parsed, model: MODELS[mi] };
      } catch (e) { lastError = String(e.message ?? e).slice(0, 160); await sleep(2000); }
    }
  }
  return { error: `no vision model answered (${lastError})` };
}

const rows = [];
let queue = Promise.resolve();
const pending = [];
let page = null, pageSize = '';
try {
  for (const s of SCREENS) {
    const [w, h] = s.size ?? [1280, 800];
    if (pageSize !== `${w}x${h}`) {
      if (page) await page.close();
      page = await launch({ width: w, height: h });
      pageSize = `${w}x${h}`;
    }
    let cancelled = false;
    const pg = page;
    const run = async () => {
      const page = pg;
      await page.goto(`${base}?coach=0&${s.q}`, 800);
      await sleep(s.wait ?? 3500);
      if (s.after) { await page.evaluate(s.after).catch(() => {}); await sleep(800); }
      await page.settled(20000);
      const m = await page.evaluate(METRICS).catch(() => ({ controls: -1, texts: -1, words: -1, overlays: -1 }));
      await page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))').catch(() => {});
      const shot = await page.send('Page.captureScreenshot', { format: 'png' }, 120000).catch(() => null);
      const errors = page.takeProblems().map((p) => `[${p.kind}] ${p.text.slice(0, 160)}`);
      if (cancelled) return;
      const row = { name: s.name, q: s.q, size: pageSize, ...m, errors, critic: null };
      rows.push(row);
      if (shot) {
        writeFileSync(join(out, `${s.name}.png`), Buffer.from(shot.data, 'base64'));
        // One request at a time keeps the free tier's per-minute limit happy.
      queue = queue.then(() => critique(shot.data, `${s.name} (${pageSize})`)).then((c) => { row.critic = c; });
      pending.push(queue);
      }
    };
    // A screen that hangs (a stuck 3D page) is recorded as such and the browser is replaced.
    const timedOut = await Promise.race([run().then(() => false).catch((e) => { process.stderr.write(`! ${s.name}: ${e.message}\n`); return false; }), sleep(Number(flag('--timeout', '90000'))).then(() => true)]);
    if (timedOut) {
      cancelled = true;
      rows.push({ name: s.name, q: s.q, size: pageSize, controls: -1, texts: -1, words: -1, overlays: -1, longest: -1, panelWords: -1, longText: '', errors: ['[hang] screen did not finish in time'], critic: null });
      await page.close(); page = null; pageSize = '';
    }
    process.stderr.write(`. ${s.name}\n`);
  }
} finally {
  if (page) await page.close();
}
await Promise.all(pending);

const pad = (v, n) => String(v).padEnd(n);
console.log(`${pad('screen', 16)}${pad('score', 7)}${pad('ctrls', 7)}${pad('words', 7)}${pad('panelW', 8)}${pad('longest', 9)}${pad('over', 6)}${pad('err', 5)}rule`);
for (const r of rows) {
  const fail = r.longest > 8 || r.panelWords > 40;
  console.log(`${pad(r.name, 16)}${pad(r.critic?.score ?? '-', 7)}${pad(r.controls, 7)}${pad(r.words, 7)}${pad(r.panelWords, 8)}${pad(r.longest, 9)}${pad(r.overlays, 6)}${pad(r.errors.length, 5)}${fail ? 'FAIL' : 'ok'}`);
}
const scored = rows.filter((r) => typeof r.critic?.score === 'number');
if (scored.length) console.log(`mean score ${Math.round(scored.reduce((a, r) => a + r.critic.score, 0) / scored.length)}, mean controls ${Math.round(rows.reduce((a, r) => a + r.controls, 0) / rows.length)}`);

const md = [`# UI critic report`, `${new Date().toISOString()}`, ''];
for (const r of rows) {
  const c = r.critic ?? {};
  md.push(`## ${r.name}  score ${c.score ?? '-'}  (${r.size}, ?${r.q})`);
  md.push(`DOM: ${r.controls} controls, ${r.texts} text nodes, ${r.words} words (${r.panelWords} in panels), longest block ${r.longest} words ("${r.longText}"), ${r.overlays} overlays on canvas. Model says ${c.visibleControlCount ?? '-'} controls.${c.error ? ` Critic error: ${c.error}` : ''}`);
  if (r.errors.length) md.push(`Page errors:\n${r.errors.map((e) => `- ${e}`).join('\n')}`);
  for (const p of c.topProblems ?? []) md.push(`- PROBLEM ${p.what} @ ${p.where} -> ${p.fix}`);
  if (c.remove?.length) md.push(`- REMOVE: ${c.remove.join('; ')}`);
  if (c.hide?.length) md.push(`- HIDE: ${c.hide.join('; ')}`);
  if (c.keep?.length) md.push(`- KEEP: ${c.keep.join('; ')}`);
  md.push('');
}
writeFileSync(join(out, 'report.md'), md.join('\n'));
writeFileSync(join(out, 'report.json'), JSON.stringify(rows, null, 1));
console.log(`report: ${join(out, 'report.md')}`);
