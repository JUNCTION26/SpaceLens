// Top-down plan drawings of a layout, labelled with item names. One display list is painted either
// to SVG (tests, inspection) or to a canvas (PNG data URL for the critic and the UI).
import type { FurnitureItem, SpaceModel } from '../../core/types';
import type { P } from '../referee/geom';
import { buildRoom, toPlanOf } from './rules';

export interface RenderOptions {
  /** Output width in pixels (height follows the room). */
  width?: number;
  title?: string;
  subtitle?: string;
  /** Draw use zones (clearance) as dashed outlines. */
  clearance?: boolean;
  /** Item ids to outline in red. */
  highlight?: string[];
  background?: string;
}

type Prim =
  | { t: 'poly'; pts: P[]; fill?: string; stroke?: string; sw?: number; dash?: number[]; alpha?: number }
  | { t: 'line'; a: P; b: P; stroke: string; sw: number; dash?: number[] }
  | { t: 'arc'; c: P; r: number; a0: number; a1: number; stroke: string; sw: number; dash?: number[] }
  | { t: 'text'; p: P; s: string; size: number; fill: string; rot?: number; weight?: number; anchor?: 'start' | 'middle' };

const INK = '#2b2b2b', MUTED = '#8a8f98', WALL = '#1f2328', WINDOW = '#3d8bd4', DOOR = '#b0563c';

function shade(hex: string, k: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(c + (255 - c) * k)));
  return `#${[n >> 16, (n >> 8) & 255, n & 255].map((c) => f(c).toString(16).padStart(2, '0')).join('')}`;
}
function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0.5;
  const n = parseInt(m[1], 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

function build(model: SpaceModel, furniture: FurnitureItem[], opts: RenderOptions) {
  const room = buildRoom(model);
  const pad = 0.45, head = opts.title ? 0.55 : 0.15;
  const W = room.box.maxX - room.box.minX + pad * 2, H = room.box.maxY - room.box.minY + pad * 2 + head;
  const px = opts.width ?? 900, s = px / W, ph = Math.round(H * s);
  const T = (p: P): P => ({ x: (p.x - room.box.minX + pad) * s, y: (p.y - room.box.minY + pad + head) * s });
  const prims: Prim[] = [];
  const corners = (f: FurnitureItem, grow = { l: 0, r: 0, t: 0, b: 0 }) => [
    toPlanOf(f, -f.w / 2 - grow.l, -f.d / 2 - grow.t), toPlanOf(f, f.w / 2 + grow.r, -f.d / 2 - grow.t),
    toPlanOf(f, f.w / 2 + grow.r, f.d / 2 + grow.b), toPlanOf(f, -f.w / 2 - grow.l, f.d / 2 + grow.b),
  ].map(T);

  // Floor and grid (50 cm)
  prims.push({ t: 'poly', pts: room.poly.map(T), fill: '#fbfaf7' });
  for (let x = Math.ceil(room.box.minX * 2) / 2; x <= room.box.maxX; x += 0.5) prims.push({ t: 'line', a: T({ x, y: room.box.minY }), b: T({ x, y: room.box.maxY }), stroke: '#efece6', sw: 1 });
  for (let y = Math.ceil(room.box.minY * 2) / 2; y <= room.box.maxY; y += 0.5) prims.push({ t: 'line', a: T({ x: room.box.minX, y }), b: T({ x: room.box.maxX, y }), stroke: '#efece6', sw: 1 });

  // Rugs first, then furniture by height so tall pieces sit on top.
  const order = [...furniture].sort((a, b) => (a.category === 'rug' ? -1 : 0) - (b.category === 'rug' ? -1 : 0) || a.h - b.h);
  if (opts.clearance) for (const f of order) {
    if (f.category === 'rug' || /chair|stool|bench/.test(f.category)) continue;
    const c = f.clearance;
    if (c.front + c.back + c.left + c.right < 0.02) continue;
    prims.push({ t: 'poly', pts: corners(f, { l: c.left, r: c.right, t: c.back, b: c.front }), stroke: '#c9b9a3', sw: 1, dash: [4, 3] });
  }
  const hl = new Set(opts.highlight ?? []);
  for (const f of order) {
    const rug = f.category === 'rug';
    const pts = corners(f);
    prims.push({ t: 'poly', pts, fill: rug ? shade(f.color, 0.55) : shade(f.color, 0.25), stroke: hl.has(f.id) ? '#d23b3b' : rug ? shade(f.color, 0.1) : INK, sw: hl.has(f.id) ? 3 : rug ? 1 : 1.4, alpha: rug ? 0.8 : 1, dash: rug ? [6, 4] : undefined });
    if (!rug) {
      // Front edge marker: a thicker line along the side people use.
      const fl = T(toPlanOf(f, -f.w / 2 + 0.03, f.d / 2 - 0.03)), fr = T(toPlanOf(f, f.w / 2 - 0.03, f.d / 2 - 0.03));
      prims.push({ t: 'line', a: fl, b: fr, stroke: shade(INK, 0.15), sw: Math.max(2, s * 0.025) });
      if (/bed/.test(f.category)) {
        const q = [toPlanOf(f, -f.w / 2 + 0.08, -f.d / 2 + 0.08), toPlanOf(f, f.w / 2 - 0.08, -f.d / 2 + 0.08), toPlanOf(f, f.w / 2 - 0.08, -f.d / 2 + 0.32), toPlanOf(f, -f.w / 2 + 0.08, -f.d / 2 + 0.32)].map(T);
        prims.push({ t: 'poly', pts: q, fill: '#ffffff', stroke: MUTED, sw: 1 });
      }
    }
  }
  // Walls, windows, doors on top of the floor.
  for (const w of room.walls) prims.push({ t: 'line', a: T(w.a), b: T(w.b), stroke: WALL, sw: Math.max(4, s * 0.09) });
  for (const o of room.windows) {
    prims.push({ t: 'line', a: T(o.a), b: T(o.b), stroke: '#ffffff', sw: Math.max(4, s * 0.09) - 2 });
    prims.push({ t: 'line', a: T(o.a), b: T(o.b), stroke: WINDOW, sw: 3 });
  }
  for (const o of room.doors) {
    prims.push({ t: 'line', a: T(o.a), b: T(o.b), stroke: '#ffffff', sw: Math.max(4, s * 0.09) + 1 });
    if (o.kind === 'door' && o.o.swing !== 'none') {
      const hinge = o.o.hinge === 'start' ? o.a : o.b, other = o.o.hinge === 'start' ? o.b : o.a;
      const n = o.o.swing === 'in' ? o.inward : { x: -o.inward.x, y: -o.inward.y };
      const leafEnd = { x: hinge.x + n.x * o.o.widthM, y: hinge.y + n.y * o.o.widthM };
      prims.push({ t: 'line', a: T(hinge), b: T(leafEnd), stroke: DOOR, sw: 2 });
      const a0 = Math.atan2(other.y - hinge.y, other.x - hinge.x), a1 = Math.atan2(n.y, n.x);
      prims.push({ t: 'arc', c: T(hinge), r: o.o.widthM * s, a0, a1, stroke: DOOR, sw: 1, dash: [4, 3] });
    }
  }
  // Labels last so nothing covers them.
  for (const f of order) {
    const long = Math.max(f.w, f.d) * s, short = Math.min(f.w, f.d) * s;
    const along = f.w >= f.d ? f.rotation : f.rotation + Math.PI / 2;
    let rot = ((along % Math.PI) + Math.PI) % Math.PI;
    if (rot > Math.PI / 2 + 0.01) rot -= Math.PI;
    const label = f.name;
    let size = Math.min(14, short * 0.42, (long * 0.92) / Math.max(4, label.length * 0.56));
    let text = label;
    if (size < 8) { text = label.split(/\s+/)[0]; size = Math.min(12, short * 0.42, (long * 0.92) / Math.max(3, text.length * 0.56)); }
    if (size < 6) continue;
    let at: P = { x: f.x, y: f.y };
    if (f.category === 'rug') {
      // Put the rug's name on a stretch of rug that nothing stands on.
      const spots = [[0, f.d / 2 - 0.14], [0, -f.d / 2 + 0.14], [f.w / 2 - 0.3, f.d / 2 - 0.14], [-f.w / 2 + 0.3, f.d / 2 - 0.14], [f.w / 2 - 0.3, -f.d / 2 + 0.14], [-f.w / 2 + 0.3, -f.d / 2 + 0.14]].map(([lx, ly]) => toPlanOf(f, lx, ly));
      const covered = (p: P) => furniture.some((g) => g.category !== 'rug' && Math.abs((p.x - g.x) * Math.cos(g.rotation) + (p.y - g.y) * Math.sin(g.rotation)) < g.w / 2 + 0.25 && Math.abs(-(p.x - g.x) * Math.sin(g.rotation) + (p.y - g.y) * Math.cos(g.rotation)) < g.d / 2 + 0.08);
      const free = spots.find((p) => !covered(p));
      if (!free) continue;
      at = free;
    }
    const c = T(at);
    const fill = f.category === 'rug' ? shade(f.color, -0.2) : luminance(shade(f.color, 0.25)) < 0.45 ? '#ffffff' : INK;
    prims.push({ t: 'text', p: c, s: text, size, fill, rot: (rot * 180) / Math.PI, weight: f.category === 'rug' ? 400 : 600 });
  }
  // Scale bar and title.
  const bar = T({ x: room.box.minX, y: room.box.maxY + 0.28 });
  prims.push({ t: 'line', a: bar, b: { x: bar.x + s, y: bar.y }, stroke: MUTED, sw: 2 });
  prims.push({ t: 'text', p: { x: bar.x + s + 6, y: bar.y + 4 }, s: '1 m', size: 11, fill: MUTED, anchor: 'start' });
  if (opts.title) prims.push({ t: 'text', p: { x: pad * s, y: 0.32 * s }, s: opts.title, size: 18, fill: INK, weight: 700, anchor: 'start' });
  if (opts.subtitle) prims.push({ t: 'text', p: { x: pad * s, y: 0.32 * s + 20 }, s: opts.subtitle, size: 12, fill: MUTED, anchor: 'start' });
  return { w: px, h: ph, prims, bg: opts.background ?? '#ffffff' };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const f1 = (n: number) => n.toFixed(1);

/** SVG markup of the plan. */
export function renderPlanSvg(model: SpaceModel, furniture: FurnitureItem[], opts: RenderOptions = {}): string {
  if (!model.spaces.length) return '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>';
  const { w, h, prims, bg } = build(model, furniture, opts);
  const body = prims.map((p) => {
    const dash = 'dash' in p && p.dash ? ` stroke-dasharray="${p.dash.join(' ')}"` : '';
    if (p.t === 'poly') return `<polygon points="${p.pts.map((q) => `${f1(q.x)},${f1(q.y)}`).join(' ')}" fill="${p.fill ?? 'none'}"${p.alpha != null ? ` fill-opacity="${p.alpha}"` : ''} stroke="${p.stroke ?? 'none'}" stroke-width="${p.sw ?? 0}"${dash} stroke-linejoin="round"/>`;
    if (p.t === 'line') return `<line x1="${f1(p.a.x)}" y1="${f1(p.a.y)}" x2="${f1(p.b.x)}" y2="${f1(p.b.y)}" stroke="${p.stroke}" stroke-width="${p.sw}"${dash} stroke-linecap="square"/>`;
    if (p.t === 'arc') {
      const s0 = { x: p.c.x + p.r * Math.cos(p.a0), y: p.c.y + p.r * Math.sin(p.a0) }, s1 = { x: p.c.x + p.r * Math.cos(p.a1), y: p.c.y + p.r * Math.sin(p.a1) };
      let d = p.a1 - p.a0; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
      return `<path d="M ${f1(s0.x)} ${f1(s0.y)} A ${f1(p.r)} ${f1(p.r)} 0 0 ${d > 0 ? 1 : 0} ${f1(s1.x)} ${f1(s1.y)}" fill="none" stroke="${p.stroke}" stroke-width="${p.sw}"${dash}/>`;
    }
    const anchor = p.anchor ?? 'middle';
    const tr = p.rot ? ` transform="rotate(${p.rot.toFixed(1)} ${f1(p.p.x)} ${f1(p.p.y)})"` : '';
    return `<text x="${f1(p.p.x)}" y="${f1(p.p.y)}" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="${p.size.toFixed(1)}" font-weight="${p.weight ?? 400}" fill="${p.fill}" text-anchor="${anchor}" dominant-baseline="${anchor === 'middle' ? 'central' : 'auto'}"${tr}>${esc(p.s)}</text>`;
  }).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="${bg}"/>\n${body}\n</svg>`;
}

/** PNG data URL of the plan, drawn on a canvas (browser only). */
export function renderPlanPng(model: SpaceModel, furniture: FurnitureItem[], opts: RenderOptions = {}): string {
  if (typeof document === 'undefined' || !model.spaces.length) return '';
  const { w, h, prims, bg } = build(model, furniture, opts);
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const g = cv.getContext('2d');
  if (!g) return '';
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  g.lineJoin = 'round';
  for (const p of prims) {
    g.save();
    g.setLineDash('dash' in p && p.dash ? p.dash : []);
    if (p.t === 'poly') {
      g.beginPath(); p.pts.forEach((q, i) => (i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y))); g.closePath();
      if (p.fill) { g.globalAlpha = p.alpha ?? 1; g.fillStyle = p.fill; g.fill(); g.globalAlpha = 1; }
      if (p.stroke && p.sw) { g.strokeStyle = p.stroke; g.lineWidth = p.sw; g.stroke(); }
    } else if (p.t === 'line') {
      g.beginPath(); g.moveTo(p.a.x, p.a.y); g.lineTo(p.b.x, p.b.y); g.strokeStyle = p.stroke; g.lineWidth = p.sw; g.lineCap = 'square'; g.stroke();
    } else if (p.t === 'arc') {
      let d = p.a1 - p.a0; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
      g.beginPath(); g.arc(p.c.x, p.c.y, p.r, p.a0, p.a0 + d, d < 0); g.strokeStyle = p.stroke; g.lineWidth = p.sw; g.stroke();
    } else {
      g.translate(p.p.x, p.p.y);
      if (p.rot) g.rotate((p.rot * Math.PI) / 180);
      g.font = `${p.weight ?? 400} ${p.size}px "Segoe UI", Helvetica, Arial, sans-serif`;
      g.fillStyle = p.fill; g.textAlign = p.anchor === 'start' ? 'left' : 'center'; g.textBaseline = p.anchor === 'start' ? 'alphabetic' : 'middle';
      g.fillText(p.s, 0, 0);
    }
    g.restore();
  }
  return cv.toDataURL('image/png');
}
