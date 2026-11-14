/**
 * Reads the drawing operators of a PDF page (pdf.js getOperatorList) into plain paths in page
 * points, y down, origin top-left. Curves are flattened. Works in the browser and in Node.
 */

export interface P { x: number; y: number }

export interface VPath {
  paint: 'stroke' | 'fill' | 'fillStroke';
  /** Line width in page points (already scaled by the transform). */
  lw: number;
  stroke: [number, number, number];
  fill: [number, number, number];
  dashed: boolean;
  /** Sub-paths; each is a polyline. */
  subs: P[][];
  closed: boolean[];
  /** Number of curve segments that were flattened (door swings are curves). */
  curves: number;
  /** Each run of consecutive curve segments as its own polyline. */
  arcs: P[][];
}

export interface PagePaths { w: number; h: number; paths: VPath[] }

type M = [number, number, number, number, number, number];
const mul = (m: M, n: M): M => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const ap = (m: M, x: number, y: number): P => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });

interface OpList { fnArray: number[]; argsArray: unknown[] }
interface PdfPageLike {
  getViewport(o: { scale: number }): { width: number; height: number; transform: number[] };
  getOperatorList(): Promise<OpList>;
}

const gray = (v: number): [number, number, number] => { const g = Math.round(v * 255); return [g, g, g]; };
function rgbOf(args: unknown): [number, number, number] | null {
  const a = args as ArrayLike<number> | string;
  if (typeof a === 'string') {
    const m = a.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
  }
  if (a && a.length >= 3) return [Number(a[0]), Number(a[1]), Number(a[2])];
  return null;
}

/** Converts a pdf.js page into paths. `OPS` is pdfjs.OPS (passed in so this file has no pdf.js import). */
export async function readPagePaths(page: PdfPageLike, OPS: Record<string, number>, maxPaths = 60000): Promise<PagePaths> {
  const vp = page.getViewport({ scale: 1 });
  const ol = await page.getOperatorList();
  const base = vp.transform as M;
  let ctm: M = [1, 0, 0, 1, 0, 0];
  let lw = 1, stroke: [number, number, number] = [0, 0, 0], fill: [number, number, number] = [0, 0, 0], dashed = false;
  const stack: Array<{ ctm: M; lw: number; stroke: typeof stroke; fill: typeof fill; dashed: boolean }> = [];
  const paths: VPath[] = [];
  let pending: { subs: P[][]; closed: boolean[]; curves: number; arcs: P[][] } | null = null;
  const O = OPS;
  for (let i = 0; i < ol.fnArray.length && paths.length < maxPaths; i++) {
    const fn = ol.fnArray[i];
    const args = ol.argsArray[i] as unknown[];
    switch (fn) {
      case O.save: stack.push({ ctm, lw, stroke, fill, dashed }); break;
      case O.restore: { const s = stack.pop(); if (s) ({ ctm, lw, stroke, fill, dashed } = s); break; }
      case O.transform: ctm = mul(ctm, args as unknown as M); break;
      case O.setLineWidth: lw = Number(args[0]); break;
      case O.setDash: dashed = Array.isArray(args[0]) && (args[0] as number[]).length > 0; break;
      case O.setStrokeRGBColor: stroke = rgbOf(args) ?? rgbOf(args[0]) ?? stroke; break;
      case O.setFillRGBColor: fill = rgbOf(args) ?? rgbOf(args[0]) ?? fill; break;
      case O.setStrokeGray: stroke = gray(Number(args[0])); break;
      case O.setFillGray: fill = gray(Number(args[0])); break;
      case O.setStrokeCMYKColor: { const [c, m, y, k] = (args as number[]).map(Number); stroke = [255 * (1 - c) * (1 - k), 255 * (1 - m) * (1 - k), 255 * (1 - y) * (1 - k)].map(Math.round) as typeof stroke; break; }
      case O.setFillCMYKColor: { const [c, m, y, k] = (args as number[]).map(Number); fill = [255 * (1 - c) * (1 - k), 255 * (1 - m) * (1 - k), 255 * (1 - y) * (1 - k)].map(Math.round) as typeof fill; break; }
      case O.constructPath: {
        const ops = args[0] as number[], c = args[1] as ArrayLike<number>;
        const m = mul(base, ctm);
        const p: { subs: P[][]; closed: boolean[]; curves: number; arcs: P[][] } = pending ?? { subs: [], closed: [], curves: 0, arcs: [] };
        let arc: P[] | null = null;
        let cur: P[] | null = p.subs.length ? p.subs[p.subs.length - 1] : null;
        let k = 0;
        let lastUser = { x: 0, y: 0 }, startUser = { x: 0, y: 0 };
        const start = (x: number, y: number) => { arc = null; cur = [ap(m, x, y)]; p.subs.push(cur); p.closed.push(false); lastUser = { x, y }; startUser = { x, y }; };
        const line = (x: number, y: number) => { if (!cur) start(x, y); else { cur.push(ap(m, x, y)); lastUser = { x, y }; } };
        const curve = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) => {
          if (!cur) start(lastUser.x, lastUser.y);
          const x0 = lastUser.x, y0 = lastUser.y;
          if (!arc) { arc = [ap(m, x0, y0)]; p.arcs.push(arc); }
          const run = arc;
          for (let s = 1; s <= 8; s++) {
            const t = s / 8, u = 1 - t;
            line(u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3);
            run.push(cur![cur!.length - 1]);
          }
          arc = run;
          p.curves++;
        };
        for (const op of ops) {
          if (op === O.moveTo) { start(c[k], c[k + 1]); k += 2; }
          else if (op === O.lineTo) { arc = null; line(c[k], c[k + 1]); k += 2; }
          else if (op === O.curveTo) { curve(c[k], c[k + 1], c[k + 2], c[k + 3], c[k + 4], c[k + 5]); k += 6; }
          else if (op === O.curveTo2) { curve(lastUser.x, lastUser.y, c[k], c[k + 1], c[k + 2], c[k + 3]); k += 4; }
          else if (op === O.curveTo3) { curve(c[k], c[k + 1], c[k + 2], c[k + 3], c[k + 2], c[k + 3]); k += 4; }
          else if (op === O.rectangle) {
            const [x, y, w, h] = [c[k], c[k + 1], c[k + 2], c[k + 3]]; k += 4;
            start(x, y); line(x + w, y); line(x + w, y + h); line(x, y + h);
            p.closed[p.closed.length - 1] = true; cur = null;
          } else if (op === O.closePath) {
            if (p.closed.length) p.closed[p.closed.length - 1] = true;
            lastUser = startUser; cur = null; arc = null;
          }
        }
        pending = p;
        break;
      }
      case O.stroke: case O.closeStroke: case O.fill: case O.eoFill: case O.fillStroke: case O.eoFillStroke:
      case O.closeFillStroke: case O.closeEOFillStroke: {
        if (pending && pending.subs.length) {
          const isFill = fn !== O.stroke && fn !== O.closeStroke;
          const isStroke = fn !== O.fill && fn !== O.eoFill;
          const closeAll = fn === O.closeStroke || fn === O.closeFillStroke || fn === O.closeEOFillStroke || isFill;
          const m = mul(base, ctm);
          const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
          paths.push({
            paint: isFill && isStroke ? 'fillStroke' : isFill ? 'fill' : 'stroke',
            lw: lw * scale, stroke, fill, dashed,
            subs: pending.subs.filter((s) => s.length > 0), closed: pending.closed.map((c) => c || closeAll), curves: pending.curves, arcs: pending.arcs,
          });
        }
        pending = null;
        break;
      }
      case O.endPath: pending = null; break;
      default: break;
    }
  }
  return { w: vp.width, h: vp.height, paths };
}
