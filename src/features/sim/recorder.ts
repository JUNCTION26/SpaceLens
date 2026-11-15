// Recording the 3D view: canvas captureStream plus MediaRecorder, in the best format the browser has.
export interface Format { mime: string; ext: 'mp4' | 'webm' }

const CANDIDATES: Format[] = [
  { mime: 'video/mp4;codecs=avc1', ext: 'mp4' },
  { mime: 'video/mp4', ext: 'mp4' },
  { mime: 'video/webm;codecs=vp9', ext: 'webm' },
  { mime: 'video/webm', ext: 'webm' },
];

/** First supported of mp4, webm vp9, webm; null when recording is not possible here. */
export function bestFormat(isSupported: (m: string) => boolean): Format | null {
  return CANDIDATES.find((c) => { try { return isSupported(c.mime); } catch { return false; } }) ?? null;
}

type Capturable = HTMLCanvasElement & { captureStream?: (fps?: number) => MediaStream };

/** Whether this browser can record a canvas at all; hide the record button when false. */
export function canRecord(): boolean {
  return typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement !== 'undefined'
    && 'captureStream' in HTMLCanvasElement.prototype && bestFormat((m) => MediaRecorder.isTypeSupported(m)) !== null;
}

export interface CanvasRecorder { stop: () => void; readonly active: boolean }

/**
 * Start recording at 30 fps. `stop` is safe to call any number of times; the recording also stops
 * by itself after `maxSeconds`, on page hide and on unload, so it can never be left running.
 * `onFile` gets the finished video and the right file extension.
 */
export function recordCanvas(canvas: HTMLCanvasElement, onFile: (blob: Blob, ext: Format['ext']) => void, opts: { maxSeconds?: number; onEnd?: () => void } = {}): CanvasRecorder | null {
  const fmt = typeof MediaRecorder !== 'undefined' ? bestFormat((m) => MediaRecorder.isTypeSupported(m)) : null;
  const cap = canvas as Capturable;
  if (!fmt || !cap.captureStream) return null;
  let stream: MediaStream;
  let rec: MediaRecorder;
  try {
    stream = cap.captureStream(30);
    rec = new MediaRecorder(stream, { mimeType: fmt.mime, videoBitsPerSecond: 6_000_000 });
  } catch { return null; }
  const chunks: Blob[] = [];
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (!active) return;
    active = false;
    if (timer) clearTimeout(timer);
    window.removeEventListener('pagehide', stop);
    try { if (rec.state !== 'inactive') rec.stop(); } catch { /* already stopped */ }
    stream.getTracks().forEach((t) => t.stop());
  };
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.onstop = () => {
    active = false;
    opts.onEnd?.();
    if (chunks.length) onFile(new Blob(chunks, { type: fmt.mime.split(';')[0] }), fmt.ext);
  };
  rec.onerror = stop;
  window.addEventListener('pagehide', stop);
  timer = setTimeout(stop, (opts.maxSeconds ?? 300) * 1000);
  try { rec.start(500); } catch { stop(); return null; }
  return { stop, get active() { return active; } };
}

/** Save a blob under a name with the right extension. */
export function download(blob: Blob, base: string, ext: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${base.replace(/[^\w-]+/g, '-').toLowerCase() || 'tour'}.${ext}`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
