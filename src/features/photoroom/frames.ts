// A short clip becomes a few still frames, in the browser, with a hidden <video> and a canvas.

export const FRAME_COUNT = 5;
export const FRAME_MAX_PX = 1024;

/** `n` seek times spread evenly over a clip, each in the middle of its slice so the first and last frames are never black or cut. */
export function frameTimes(duration: number, n = FRAME_COUNT): number[] {
  if (!Number.isFinite(duration) || duration <= 0 || n < 1) return [];
  const count = Math.floor(n);
  return Array.from({ length: count }, (_, i) => +(((i + 0.5) / count) * duration).toFixed(3));
}

/** Output size that fits `max` pixels on the long side without enlarging. */
export function fitSize(w: number, h: number, max = FRAME_MAX_PX): { w: number; h: number } {
  const k = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

const SEEK_TIMEOUT_MS = 4000;
const LOAD_TIMEOUT_MS = 10_000;

/** Waits for one event (or an error, or the timeout) on the video. */
const once = (v: HTMLVideoElement, ev: string, ms: number, act?: () => void) => new Promise<void>((res, rej) => {
  const timer = setTimeout(() => { off(); rej(new Error('video timeout')); }, ms);
  const ok = () => { off(); res(); };
  const fail = () => { off(); rej(new Error('video')); };
  const off = () => { clearTimeout(timer); v.removeEventListener(ev, ok); v.removeEventListener('error', fail); };
  v.addEventListener(ev, ok); v.addEventListener('error', fail);
  act?.();
});

/** Seeks and waits for `seeked`; a seek to the time the video is already at never fires, so it is nudged. */
const seek = (v: HTMLVideoElement, t: number) => once(v, 'seeked', SEEK_TIMEOUT_MS, () => {
  v.currentTime = Math.abs(v.currentTime - t) < 0.001 ? t + 0.01 : t;
});

/** Some recorded clips report an infinite duration until the end has been reached once. */
async function knownDuration(v: HTMLVideoElement): Promise<number> {
  if (Number.isFinite(v.duration) && v.duration > 0) return v.duration;
  await once(v, 'durationchange', SEEK_TIMEOUT_MS, () => { v.currentTime = 1e101; }).catch(() => undefined);
  const d = v.duration;
  if (Number.isFinite(d) && d > 0) { await seek(v, 0).catch(() => undefined); return d; }
  return 0;
}

/** Extracts `n` evenly spaced JPEG frames (long side at most 1024 px) from a video file. */
export async function extractFrames(file: Blob, n = FRAME_COUNT): Promise<Blob[]> {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  // Muted and inline, or phones refuse to decode it without a tap.
  v.muted = true; v.defaultMuted = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.setAttribute('muted', '');
  v.preload = 'auto'; v.crossOrigin = 'anonymous';
  try {
    await once(v, 'loadedmetadata', LOAD_TIMEOUT_MS, () => { v.src = url; v.load(); });
    const times = frameTimes(await knownDuration(v), n);
    // videoWidth/videoHeight already follow the rotation flag, so portrait clips come out upright.
    if (!times.length || !v.videoWidth || !v.videoHeight) throw new Error('video');
    const { w, h } = fitSize(v.videoWidth, v.videoHeight);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('video');
    const out: Blob[] = [];
    for (const t of times) {
      try { await seek(v, t); } catch { continue; } // a frame that will not load is skipped, not fatal
      ctx.drawImage(v, 0, 0, w, h);
      const b = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.85));
      if (b) out.push(b);
    }
    if (!out.length) throw new Error('video');
    return out;
  } finally { v.pause(); v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url); }
}

/** At most `max` items, evenly spread, order kept. */
export function evenPick<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  return Array.from({ length: max }, (_, i) => items[Math.floor(((i + 0.5) / max) * items.length)]);
}

/** Photos stay as they are; every video becomes its frames; the lot is thinned to `max` images. */
export async function gatherImages(files: File[], max: number): Promise<Blob[]> {
  const images: Blob[] = [];
  for (const f of files) {
    if (f.type.startsWith('video/')) images.push(...await extractFrames(f));
    else if (f.type.startsWith('image/')) images.push(f);
  }
  return evenPick(images, max);
}
