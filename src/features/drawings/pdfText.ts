import { classify, joinLineFragments, mergeSplitAreas, type TextItem } from './textCore';

interface RawItem { str?: string; transform: number[]; width: number }
const mul = (m: number[], n: number[]) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];

/**
 * Turns pdf.js text content into classified items with normalised boxes. `vp` is the viewport at
 * `scale` (its transform maps PDF space to viewport pixels). Shared by the app and the benchmark.
 */
export function textItemsFrom(raw: unknown[], vp: { width: number; height: number; transform: number[] }, scale: number, page: number, startId = 0): TextItem[] {
  const items: TextItem[] = [];
  let id = startId;
  for (const r of raw as RawItem[]) {
    if (!r || typeof r.str !== 'string' || !r.str.trim()) continue;
    const t = mul(vp.transform, r.transform);
    const fh = Math.hypot(t[2], t[3]) || 8;
    const w = Math.max(r.width * scale, fh * 0.5);
    const vertical = Math.abs(t[1]) > Math.abs(t[0]);
    const bx = vertical ? t[4] - fh : t[4];
    const by = vertical ? t[5] - w : t[5] - fh;
    const bw = vertical ? fh : w;
    const bh = vertical ? w : fh;
    items.push({ id: id++, page, str: r.str.trim(), x: bx / vp.width, y: by / vp.height, w: bw / vp.width, h: bh / vp.height, ...classify(r.str) });
  }
  return items;
}

export const finishItems = (items: TextItem[]) => mergeSplitAreas(joinLineFragments(items));
