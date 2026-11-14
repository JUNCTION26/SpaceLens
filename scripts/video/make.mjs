#!/usr/bin/env node
// One command for the pitch video: record the app, voice the narration, compose and encode, verify.
//   node scripts/video/make.mjs              record every scene, then build the video
//   node scripts/video/make.mjs --reuse      build from the frames already recorded
//   node scripts/video/make.mjs --only villa,shop   re-record these scenes, reuse the rest
//   --no-voice   captions only     --webm-only   skip the MP4 pass
// Needs the dev server (npm run dev, http://localhost:5180). Output: Desktop/SpaceLens-deck/.
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, createReadStream } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from '../e2e/cdp.mjs';
import { AUDIO, CHECK, FRAMES, OUT } from './paths.mjs';
import { LIMIT_S, story } from './story.mjs';
import { narrate, readKey } from './tts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const flag = (n, d) => { const k = args.indexOf(n); return k >= 0 ? args[k + 1] : d; };
const NAME = flag('--name', 'SpaceLens-demo');

const scenes = story(ROOT);

// 1. Record.
if (!has('--reuse')) {
  const only = flag('--only', '');
  const ids = only ? only.split(',') : scenes.filter((s) => s.kind === 'clip').map((s) => s.id);
  console.log(`recording: ${ids.join(', ')}`);
  spawnSync(process.execPath, [join(HERE, 'capture.mjs'), ...ids], { stdio: 'inherit', cwd: ROOT });
}

// 2. Narration.
const key = has('--no-voice') ? null : readKey(ROOT);
const voice = key ? await narrate(Object.fromEntries(scenes.map((s) => [s.id, s.narration])), AUDIO, key) : {};
console.log(`voice: ${Object.values(voice).filter(Boolean).length} of ${scenes.length} lines`);

// 3. Edit decision list.
const cut = [];
const plan = [];
for (const s of scenes) {
  if (s.kind === 'clip') {
    const mf = join(FRAMES, s.id, 'manifest.json');
    const m = existsSync(mf) ? JSON.parse(readFileSync(mf, 'utf8')) : null;
    if (!m || m.frames.length < 2 || m.dur < 1500) { cut.push(s.id); continue; }
    plan.push({ ...s, manifest: m });
  } else plan.push(s);
}
const AUDIO_AT = 0.4;
for (const s of plan) {
  const v = voice[s.id];
  s.voiceDur = v ? v.seconds : 0;
  s.floor = v ? v.seconds + AUDIO_AT + 0.5 : 3;
  s.dur = Math.max(s.minDur, s.floor);
}
let total = plan.reduce((a, s) => a + s.dur, 0);
if (total > LIMIT_S) {
  // Take the overrun out of the slack above each narration, proportionally.
  const slack = plan.reduce((a, s) => a + (s.dur - s.floor), 0);
  const k = Math.max(0, 1 - (total - LIMIT_S) / Math.max(slack, 1e-6));
  for (const s of plan) s.dur = s.floor + (s.dur - s.floor) * k;
  total = plan.reduce((a, s) => a + s.dur, 0);
}
let t = 0, n = 0;
const edlScenes = plan.map((s) => {
  const e = { id: s.id, kind: s.kind, start: t, dur: s.dur, chapter: s.chapter, card: s.card };
  t += s.dur;
  if (voice[s.id]) e.audio = { url: `/a/${encodeURIComponent(voice[s.id].file.split(/[\\/]/).pop())}`, at: AUDIO_AT };
  if (s.kind === 'clip') {
    e.n = ++n;
    const m = s.manifest;
    const rawDur = m.dur / 1000;
    const speed = Math.max(0.7, rawDur / s.dur);
    const sx = 1 / m.css.w, sy = 1 / m.css.h;
    e.clip = {
      rawDur, speed,
      frames: m.frames.map((f) => ({ t: f.t / 1000, url: `/f/${s.id}/${f.f}` })),
      focus: m.marks.filter((k) => k.kind === 'focus').map((k) => ({
        t: k.t / 1000 / speed,
        rect: k.rect ? [k.rect[0] * sx, k.rect[1] * sy, k.rect[2] * sx, k.rect[3] * sy] : null,
      })),
    };
    const caps = s.captions ?? [];
    e.captions = caps.map((c, i) => ({
      text: c.text, sub: c.sub,
      t0: Math.max(0.35, c.at * s.dur),
      t1: i + 1 < caps.length ? caps[i + 1].at * s.dur - 0.05 : s.dur - 0.25,
    }));
  }
  return e;
});
const outputs = [{ name: `${NAME}.webm` }];
if (!has('--webm-only')) outputs.push({ name: `${NAME}.mp4` });
const edl = {
  w: 1920, h: 1080, fps: 30, videoBps: 9_000_000, total: Math.min(t, Number(flag('--max', t))), // --max N: quick test of the first N seconds
 
  scenes: edlScenes, webm: `${NAME}.webm`, mp4: has('--webm-only') ? null : `${NAME}.mp4`, posterName: `${NAME}-poster.png`, posterScene: 'villa', posterAt: 0.42,
};
console.log(`edit: ${edlScenes.map((s) => `${s.id} ${s.dur.toFixed(1)}s${s.clip ? ` x${s.clip.speed.toFixed(2)}` : ''}`).join(', ')}; total ${t.toFixed(1)} s${cut.length ? `; cut: ${cut.join(', ')}` : ''}`);

// 4. Local server for the compositor.
mkdirSync(OUT, { recursive: true });
mkdirSync(CHECK, { recursive: true });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.wav': 'audio/wav', '.webm': 'video/webm', '.mp4': 'video/mp4' };
const serveFile = (res, file) => {
  if (!existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Content-Length': statSync(file).size, 'Cache-Control': 'no-store' });
  createReadStream(file).pipe(res);
};
const safe = (s) => s.replace(/[^\w.-]/g, '');
const done = new Set();
const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = decodeURIComponent(u.pathname);
  if (req.method === 'POST') {
    const bufs = [];
    req.on('data', (d) => bufs.push(d));
    req.on('end', () => {
      const body = Buffer.concat(bufs);
      if (p === '/log') console.log(`   [page] ${body.toString()}`);
      else if (p === '/upload') { const name = safe(u.searchParams.get('name')); writeFileSync(join(OUT, name), body); done.add(name); console.log(`   saved ${join(OUT, name)} (${(body.length / 1e6).toFixed(1)} MB)`); }
      else if (p === '/check') { writeFileSync(join(CHECK, safe(u.searchParams.get('name'))), body); }
      res.writeHead(200); res.end('ok');
    });
    return;
  }
  if (p === '/edl.json') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(edl)); return; }
  if (p === '/' || p === '/compose.html') return serveFile(res, join(HERE, 'compose.html'));
  if (p === '/webm-mux.js' || p === '/mp4-mux.js') return serveFile(res, join(HERE, p.slice(1)));
  if (p.startsWith('/f/')) { const [, , scene, file] = p.split('/'); return serveFile(res, join(FRAMES, safe(scene), safe(file))); }
  if (p.startsWith('/a/')) return serveFile(res, join(AUDIO, safe(p.slice(3))));
  if (p.startsWith('/out/')) return serveFile(res, join(OUT, safe(p.slice(5))));
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// 5. Compose and encode in headless Edge, frame by frame (WebCodecs), so load only slows it down.
const page = await launch({ width: 1280, height: 720 });
const evalLong = async (expr, ms) => {
  const r = await page.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }, ms);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
await page.send('Page.navigate', { url: `${base}/compose.html` });
await page.waitFor('!!window.__compose', 60000);
if (flag('--stills', '')) {
  // --stills 1,12.5,40: render those moments to PNG in the check folder and stop.
  await evalLong(`window.__compose.stills([${flag('--stills', '')}])`, 600000);
  console.log(`stills: ${CHECK}`);
  await page.close(); server.close(); process.exit(0);
}
if (has('--verify-only')) { for (const o of outputs) if (existsSync(join(OUT, o.name))) done.add(o.name); }
else {
  console.log(`composing ${outputs.map((o) => o.name).join(' + ')}`);
  await evalLong('window.__compose.run()', 90 * 60 * 1000);
}

// 6. Verify: duration, audio, and six frames across each file for a visual check.
const report = [];
for (const o of outputs) {
  if (!done.has(o.name)) { report.push(`${o.name}: not saved`); continue; }
  const info = await evalLong(`(async () => {
    const v = document.createElement('video'); v.muted = true; v.preload = 'auto'; v.src = '/out/${o.name}'; document.body.appendChild(v);
    const once = (ev, ms) => new Promise((r) => { const f = () => { v.removeEventListener(ev, f); r(true); }; v.addEventListener(ev, f); setTimeout(() => r(false), ms); });
    await new Promise((r, j) => { v.onloadeddata = r; v.onerror = () => j(new Error('cannot load')); });
    let d = v.duration;
    if (!isFinite(d)) { v.currentTime = 1e9; await once('durationchange', 4000); d = v.duration; }
    const c = document.createElement('canvas'); c.width = 960; c.height = 540; const g = c.getContext('2d');
    const marks = [0.03, 0.2, 0.37, 0.55, 0.72, 0.92];
    for (let i = 0; i < marks.length; i++) {
      const p = once('seeked', 20000);
      v.currentTime = d * marks[i];
      await p;
      await new Promise((r) => (v.requestVideoFrameCallback ? v.requestVideoFrameCallback(() => r()) : r(), setTimeout(r, 1500)));
      g.drawImage(v, 0, 0, 960, 540);
      const b = await new Promise((r) => c.toBlob(r, 'image/png'));
      await fetch('/check?name=${o.name.replace(/\W+/g, '-')}-' + i + '.png', { method: 'POST', body: b });
    }
    let audio = 'none';
    try {
      const ac = new OfflineAudioContext(1, 48000, 48000);
      const buf = await ac.decodeAudioData(await (await fetch('/out/${o.name}')).arrayBuffer());
      const ch = buf.getChannelData(0); let s = 0; for (let i = 0; i < ch.length; i += 50) s += ch[i] * ch[i];
      audio = buf.duration.toFixed(1) + ' s, rms ' + Math.sqrt(s / (ch.length / 50)).toFixed(3);
    } catch (e) { audio = 'decode failed: ' + e.message; }
    return { duration: d, w: v.videoWidth, h: v.videoHeight, audio };
  })()`, 120000).catch((e) => ({ error: e.message }));
  const size = statSync(join(OUT, o.name)).size;
  report.push(`${o.name}: ${info.error ?? `${info.duration?.toFixed(2)} s, ${info.w}x${info.h}, ${(size / 1e6).toFixed(1)} MB, audio ${info.audio}`}`);
}
await page.close();
server.close();
const summary = [`video: ${OUT}`, ...report, `cut: ${cut.join(', ') || 'nothing'}`, `check frames: ${CHECK}`];
writeFileSync(join(OUT, `${NAME}-report.txt`), summary.join('\n') + '\n');
console.log(summary.join('\n'));
