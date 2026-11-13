import * as pdfjs from 'pdfjs-dist';
import { classify, mergeSplitAreas, joinLineFragments, type TextItem, type TextKind } from './textCore';

export { classify, parseDimension } from './textCore';
export type { TextItem, TextKind } from './textCore';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

export interface DrawingPage {
  index: number;
  dataUrl: string;
  pxW: number;
  pxH: number;
  /** Page size in PDF points (null for images). */
  ptW: number | null;
  ptH: number | null;
}

export interface DrawingDoc {
  name: string;
  pages: DrawingPage[];
  items: TextItem[];
}

const MAX_PX = 2000;

async function canvasFor(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = Math.round(w); c.height = Math.round(h);
  return c;
}

export async function loadPdf(data: ArrayBuffer, name: string, onProgress?: (p: string) => void): Promise<DrawingDoc> {
  const pdf = await pdfjs.getDocument({ data }).promise;
  const pages: DrawingPage[] = [];
  const items: TextItem[] = [];
  let id = 0;
  const n = Math.min(pdf.numPages, 30);
  for (let p = 1; p <= n; p++) {
    onProgress?.(`Reading page ${p} of ${n}`);
    const page = await pdf.getPage(p);
    const base = page.getViewport({ scale: 1 });
    const scale = MAX_PX / Math.max(base.width, base.height);
    const vp = page.getViewport({ scale });
    const canvas = await canvasFor(vp.width, vp.height);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    pages.push({ index: p - 1, dataUrl: canvas.toDataURL('image/jpeg', 0.85), pxW: canvas.width, pxH: canvas.height, ptW: base.width, ptH: base.height });
    const tc = await page.getTextContent();
    for (const raw of tc.items) {
      if (!('str' in raw) || !raw.str.trim()) continue;
      const t = pdfjs.Util.transform(vp.transform, raw.transform);
      const fh = Math.hypot(t[2], t[3]) || 8;
      const w = Math.max(raw.width * scale, fh * 0.5);
      const vertical = Math.abs(t[1]) > Math.abs(t[0]);
      const bx = vertical ? t[4] - fh : t[4];
      const by = vertical ? t[5] - w : t[5] - fh;
      const bw = vertical ? fh : w;
      const bh = vertical ? w : fh;
      const c = classify(raw.str);
      items.push({ id: id++, page: p - 1, str: raw.str.trim(), x: bx / vp.width, y: by / vp.height, w: bw / vp.width, h: bh / vp.height, ...c });
    }
  }
  return { name, pages, items: mergeSplitAreas(joinLineFragments(items)) };
}

export async function loadImage(file: Blob, name: string): Promise<DrawingDoc> {
  const url = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result as string); r.onerror = rej; r.readAsDataURL(file); });
  const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
  return { name, pages: [{ index: 0, dataUrl: url, pxW: img.naturalWidth, pxH: img.naturalHeight, ptW: null, ptH: null }], items: [] };
}

export function indexStats(doc: DrawingDoc) {
  const c = (k: TextKind) => doc.items.filter((i) => i.kind === k).length;
  return { text: doc.items.length, dimensions: c('dimension'), rooms: c('room'), areas: c('area'), tags: c('tag'), scales: c('scale') };
}

export function saveSummary(doc: DrawingDoc) {
  try {
    const s = indexStats(doc);
    localStorage.setItem(`spacelens.drawing.${doc.name}`, JSON.stringify({ ...s, pages: doc.pages.length, at: Date.now(), rooms: doc.items.filter((i) => i.kind === 'room').map((i) => i.str).slice(0, 50) }));
  } catch { /* storage blocked */ }
}

/** Crops a normalised region from a page image, with padding. */
export async function cropRegion(dataUrl: string, r: { x: number; y: number; w: number; h: number }, pad = 0.02, maxSide = 240): Promise<string> {
  const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = dataUrl; });
  const W = img.naturalWidth, H = img.naturalHeight;
  const x = Math.max(0, (r.x - pad) * W), y = Math.max(0, (r.y - pad) * H);
  const w = Math.min(W - x, (r.w + pad * 2) * W), h = Math.min(H - y, (r.h + pad * 2) * H);
  const s = Math.min(1, maxSide / Math.max(w, h, 1)) * 2;
  const c = await canvasFor(Math.max(1, w * s), Math.max(1, h * s));
  c.getContext('2d')!.drawImage(img, x, y, w, h, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}

export async function downscale(dataUrl: string, max = 1600): Promise<string> {
  const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = dataUrl; });
  const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = await canvasFor(img.naturalWidth * s, img.naturalHeight * s);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85);
}
