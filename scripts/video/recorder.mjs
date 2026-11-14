// Records what a headless page shows as timestamped JPEG frames (CDP screencast).
// Frames are stamped on a footage clock that runs at an adjustable rate: 0 pauses it (slow steps
// are cut out), 1 is real time, and a small rate pairs with a slowed page clock so animations that
// render at one frame per second still play back smoothly.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function recorder(page, root, { css, minGapMs = 30 } = {}) {
  let scene = null;
  let rate = 0;
  let base = 0; // footage ms at lastWall
  let lastWall = 0;
  let latest = null;
  let lastT = -1e9;
  let n = 0;
  let manifest = null;
  let dir = '';

  const now = () => base + (Date.now() - lastWall) * rate;
  const setRate = (r) => { base = now(); lastWall = Date.now(); rate = r; };

  const store = (data) => {
    const t = Math.round(now());
    // Frames can arrive in bursts; keep at most one per minGapMs of footage by replacing the last one.
    if (t - lastT < minGapMs && manifest.frames.length) {
      writeFileSync(join(dir, manifest.frames[manifest.frames.length - 1].f), Buffer.from(data, 'base64'));
      return;
    }
    const f = `${String(++n).padStart(5, '0')}.jpg`;
    writeFileSync(join(dir, f), Buffer.from(data, 'base64'));
    manifest.frames.push({ t, f });
    lastT = t;
  };

  page.on('Page.screencastFrame', (p) => {
    page.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
    if (!scene) return;
    latest = p.data;
    if (rate > 0) store(p.data);
  });

  const api = {
    get time() { return now(); },
    async start(name) {
      scene = name;
      dir = join(root, `${name}.take`); // the caller promotes a finished take over the previous one
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      manifest = { scene: name, css, frames: [], marks: [], dur: 0 };
      n = 0; lastT = -1e9; base = 0; lastWall = Date.now(); rate = 0; latest = null;
      await page.send('Page.startScreencast', { format: 'jpeg', quality: 88, everyNthFrame: 1, maxWidth: css.w, maxHeight: css.h });
      // A still page sends no frames: take one picture, then start the clock.
      const r = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 88 }, 60000).catch(() => null);
      setRate(1);
      if (r) store(r.data);
    },
    /** Store the current screen now (static screens produce no screencast frames). */
    async snap() {
      const r = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 88 }, 60000).catch(() => null);
      if (r && scene && rate > 0) store(r.data);
    },
    rate(r) { setRate(r); },
    pause() { setRate(0); },
    async resume() {
      if (rate > 0) return;
      setRate(1);
      if (latest) store(latest);
      await api.snap();
    },
    /** Keep recording for ms of wall time. */
    async hold(ms) { await new Promise((r) => setTimeout(r, ms)); },
    /** Mark something on the footage timeline. */
    mark(m) { manifest.marks.push({ t: Math.round(now()), ...m }); },
    /** Zoom the edit toward an element (CSS selector) or a [x, y, w, h] CSS rect; null returns to the full frame. */
    async focus(target, { pad = 24 } = {}) {
      if (!target) return api.mark({ kind: 'focus', rect: null });
      const rect = Array.isArray(target) ? target : await page.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(target)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return [r.left, r.top, r.width, r.height];
      })()`).catch(() => null);
      if (!rect) return;
      api.mark({ kind: 'focus', rect: [rect[0] - pad, rect[1] - pad, rect[2] + pad * 2, rect[3] + pad * 2] });
    },
    async stop() {
      if (rate === 0) setRate(1);
      await api.snap();
      await page.send('Page.stopScreencast').catch(() => {});
      manifest.dur = Math.round(now());
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 1));
      const out = manifest;
      scene = null;
      rate = 0;
      return out;
    },
  };
  return api;
}
