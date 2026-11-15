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

const seek = (v: HTMLVideoElement, t: number) => new Promise<void>((res, rej) => {
  const done = () => { v.removeEventListener('seeked', done); v.removeEventListener('error', fail); res(); };
  const fail = () => { v.removeEventListener('seeked', done); v.removeEventListener('error', fail); rej(new Error('seek')); };
  v.addEventListener('seeked', done); v.addEventListener('error', fail);
  v.currentTime = t;
});

/** Extracts `n` evenly spaced JPEG frames (long side at most 1024 px) from a video file. */
export async function extractFrames(file: Blob, n = FRAME_COUNT): Promise<Blob[]> {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true; v.preload = 'auto'; v.playsInline = true;
  try {
    await new Promise<void>((res, rej) => { v.onloadedmetadata = () => res(); v.onerror = () => rej(new Error('video')); v.src = url; });
    const times = frameTimes(v.duration, n);
    if (!times.length || !v.videoWidth) throw new Error('video');
    const { w, h } = fitSize(v.videoWidth, v.videoHeight);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d')!;
    const out: Blob[] = [];
    for (const t of times) {
      await seek(v, t);
      ctx.drawImage(v, 0, 0, w, h);
      const b = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.85));
      if (b) out.push(b);
    }
    if (!out.length) throw new Error('video');
    return out;
  } finally { v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url); }
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
