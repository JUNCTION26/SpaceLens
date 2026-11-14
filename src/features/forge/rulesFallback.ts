// Parametric templates: a decent custom object from the parsed request alone, so the feature
// works without a model key or when the model fails. Every template fills its target size
// exactly: the bounding box of the parts equals { w, d, h }.
// Local frame: origin at the floor centre of the footprint, +y up, front faces +z.

import { uid } from '../../core/geometry';
import type { MaterialId, ObjectPart, ObjectSemantics, ObjectSpec, PartShape } from '../../core/types';
import { kindById, parseRequest, resolveSize, titleFor, type Kind, type ParsedRequest, type TemplateId } from './parseRequest';

type V3 = [number, number, number];
interface Size { w: number; d: number; h: number }

const r4 = (v: number) => Math.round(v * 10000) / 10000;
const part = (name: string, shape: PartShape, size: V3, pos: V3, material: MaterialId, color?: string): ObjectPart => {
  const p: ObjectPart = { name, shape, size: size.map((v) => r4(Math.max(0.002, v))) as V3, pos: pos.map(r4) as V3, material };
  if (color) p.color = color;
  if (shape === 'rounded' || shape === 'cushion') p.radius = r4(Math.min(0.04, Math.min(...size) / 3));
  return p;
};

interface Look {
  /** Main body material (wood, laminate, stone...). */
  body: MaterialId;
  /** Legs and frame. */
  frame: MaterialId;
  /** Upholstery for soft goods. */
  soft: MaterialId;
  /** Tint for the main body or upholstery when a colour was said. */
  tint?: string;
}

const WOODS = new Set<MaterialId>(['oak', 'walnut', 'pine', 'birch', 'white-laminate', 'black-laminate', 'marble', 'glass', 'concrete', 'ceramic', 'plastic', 'rattan']);
const METALS = new Set<MaterialId>(['black-metal', 'steel', 'brass', 'chrome']);
const SOFTS = new Set<MaterialId>(['fabric', 'linen', 'velvet', 'leather', 'wool']);

function lookFor(p: ParsedRequest, t: TemplateId): Look {
  const body = p.materials.find((m) => WOODS.has(m));
  const frame = p.materials.find((m) => METALS.has(m));
  const soft = p.materials.find((m) => SOFTS.has(m));
  const colour = p.colors[0];
  let b: MaterialId = body ?? (t === 'rug' ? 'wool' : 'oak');
  // A plain colour on a wooden thing means a painted/laminate finish.
  if (!body && colour && t !== 'sofa' && t !== 'rug') b = colour.word.match(/^(white|vit)/) ? 'white-laminate' : colour.word.match(/^(black|svart)/) ? 'black-laminate' : 'white-laminate';
  const tint = colour && !(b === 'white-laminate' && /^(white|vit)/.test(colour.word)) && !(b === 'black-laminate' && /^(black|svart)/.test(colour.word)) ? colour.hex : undefined;
  return { body: b, frame: frame ?? (body && WOODS.has(body) && !['marble', 'glass', 'concrete'].includes(body) ? body : 'black-metal'), soft: soft ?? (t === 'rug' ? 'wool' : 'fabric'), tint };
}

// ---- templates ---------------------------------------------------------------------------

function desk(s: Size, p: ParsedRequest, L: Look): ObjectPart[] {
  const t = Math.min(0.035, s.h * 0.06), lh = s.h - t, leg = Math.min(0.05, s.w / 10, s.d / 6);
  const out: ObjectPart[] = [part('Top', 'box', [s.w, t, s.d], [0, s.h - t / 2, 0], L.body, L.tint)];
  const drawers = p.features.includes('drawers') || p.features.includes('storage');
  const pw = Math.min(0.42, s.w * 0.33), side = p.side === 'left' ? -1 : 1;
  const legXs = [-1, 1].filter((sx) => !(drawers && sx === side));
  for (const sx of legXs) for (const sz of [-1, 1]) {
    out.push(part(`Leg ${sx < 0 ? 'left' : 'right'} ${sz < 0 ? 'back' : 'front'}`, 'leg', [leg, lh, leg], [sx * (s.w / 2 - leg / 2), lh / 2, sz * (s.d / 2 - leg / 2)], L.frame));
  }
  if (drawers) {
    const cx = side * (s.w / 2 - pw / 2), n = lh > 0.5 ? 3 : 2, gap = 0.006, fh = (lh - 0.02) / n;
    out.push(part('Drawer pedestal', 'box', [pw, lh, s.d - 0.02], [cx, lh / 2, -0.01], L.body, L.tint));
    for (let i = 0; i < n; i++) {
      const y = 0.02 + fh * i + fh / 2;
      out.push(part(`Drawer front ${i + 1}`, 'panel', [pw - 0.01, fh - gap, 0.02], [cx, y, s.d / 2 - 0.01], L.body, L.tint));
      out.push(part(`Drawer handle ${i + 1}`, 'box', [Math.min(0.14, pw * 0.4), 0.012, 0.012], [cx, y + fh * 0.25, s.d / 2 - 0.022], METALS.has(L.frame) ? L.frame : 'black-metal'));
    }
  }
  const legSpan = s.w - 2 * leg - (drawers ? pw - leg : 0);
  const mx = drawers ? -side * (pw - leg) / 2 : 0;
  out.push(part('Modesty panel', 'panel', [legSpan, Math.min(0.3, lh * 0.4), 0.018], [mx, lh - Math.min(0.3, lh * 0.4) / 2, -s.d / 2 + leg / 2], L.body, L.tint));
  if (p.features.includes('shelf')) out.push(part('Shelf', 'panel', [legSpan, 0.018, s.d * 0.5], [mx, lh * 0.22, -s.d / 4 + leg / 2], L.body, L.tint));
  return out;
}

function table(s: Size, p: ParsedRequest, L: Look, kind: Kind | null): ObjectPart[] {
  const t = Math.min(kind?.id === 'coffee-table' ? 0.04 : 0.035, s.h * 0.12), lh = s.h - t;
  const round = p.round;
  const out: ObjectPart[] = [part('Top', round ? 'cylinder' : 'box', [s.w, t, s.d], [0, s.h - t / 2, 0], L.body, L.tint)];
  const pedestal = p.features.includes('pedestal') || (round && Math.max(s.w, s.d) <= 1.4 && !p.features.includes('hairpin'));
  if (pedestal) {
    const base = Math.min(s.w, s.d) * 0.55, col = Math.max(0.08, Math.min(s.w, s.d) * 0.14);
    out.push(part('Column', 'cylinder', [col, lh - 0.03, col], [0, 0.03 + (lh - 0.03) / 2, 0], L.frame));
    out.push(part('Base', 'cylinder', [base, 0.03, base], [0, 0.015, 0], L.frame));
    if (base < Math.min(s.w, s.d)) { /* top defines the footprint */ }
    return out;
  }
  const leg = Math.min(0.06, Math.min(s.w, s.d) / 8);
  const ix = round ? s.w / 2 * 0.62 : s.w / 2 - leg / 2 - Math.min(0.06, s.w * 0.04), iz = round ? s.d / 2 * 0.62 : s.d / 2 - leg / 2 - Math.min(0.06, s.d * 0.04);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) out.push(part(`Leg ${sx < 0 ? 'left' : 'right'} ${sz < 0 ? 'back' : 'front'}`, 'leg', [leg, lh, leg], [sx * ix, lh / 2, sz * iz], L.frame));
  if (!round && lh > 0.3) {
    const ah = 0.08;
    out.push(part('Apron front', 'panel', [2 * ix - leg, ah, 0.02], [0, lh - ah / 2, iz], L.body, L.tint));
    out.push(part('Apron back', 'panel', [2 * ix - leg, ah, 0.02], [0, lh - ah / 2, -iz], L.body, L.tint));
    out.push(part('Apron left', 'panel', [0.02, ah, 2 * iz - leg], [-ix, lh - ah / 2, 0], L.body, L.tint));
    out.push(part('Apron right', 'panel', [0.02, ah, 2 * iz - leg], [ix, lh - ah / 2, 0], L.body, L.tint));
  }
  if (p.features.includes('shelf') || kind?.id === 'coffee-table') out.push(part('Lower shelf', 'panel', [2 * ix + leg, 0.02, 2 * iz + leg], [0, Math.min(0.12, lh * 0.3), 0], L.body, L.tint));
  return out;
}

function sofa(s: Size, p: ParsedRequest, L: Look, kind: Kind | null): ObjectPart[] {
  const legH = Math.min(0.1, s.h * 0.12), arms = !p.features.includes('no arms');
  const armW = arms ? Math.min(0.18, s.w * 0.12) : 0, backD = Math.min(0.22, s.d * 0.25), seatH = Math.min(0.45, s.h * 0.55);
  const baseH = seatH - 0.14 - legH, armH = Math.min(s.h - legH, Math.max(seatH + 0.15, s.h * 0.75) - legH);
  const innerW = s.w - 2 * armW, seats = kind?.id === 'armchair' ? 1 : Math.max(1, Math.min(4, Math.round(innerW / 0.65)));
  const c = L.soft, tint = L.tint;
  const out: ObjectPart[] = [part('Base', 'rounded', [s.w, baseH, s.d], [0, legH + baseH / 2, 0], c, tint)];
  out.push(part('Backrest', 'cushion', [innerW + (arms ? 0 : 0), s.h - legH - baseH, backD], [0, legH + baseH + (s.h - legH - baseH) / 2, -s.d / 2 + backD / 2], c, tint));
  if (arms) for (const sx of [-1, 1]) out.push(part(`Arm ${sx < 0 ? 'left' : 'right'}`, 'rounded', [armW, armH, s.d], [sx * (s.w / 2 - armW / 2), legH + armH / 2, 0], c, tint));
  const cw = innerW / seats, cd = s.d - backD - 0.02;
  for (let i = 0; i < seats; i++) {
    const x = -innerW / 2 + cw * i + cw / 2;
    out.push(part(`Seat cushion ${i + 1}`, 'cushion', [cw - 0.01, 0.14, cd], [x, legH + baseH + 0.07, s.d / 2 - cd / 2], c, tint));
    out.push(part(`Back cushion ${i + 1}`, 'cushion', [cw - 0.02, Math.max(0.1, (s.h - legH - baseH - 0.14) * 0.85), 0.14], [x, legH + baseH + 0.14 + Math.max(0.1, (s.h - legH - baseH - 0.14) * 0.85) / 2, -s.d / 2 + backD + 0.07 - 0.02], c, tint));
  }
  const lx = s.w / 2 - 0.05, lz = s.d / 2 - 0.05;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) out.push(part(`Leg ${sx < 0 ? 'left' : 'right'} ${sz < 0 ? 'back' : 'front'}`, 'leg', [0.04, legH, 0.04], [sx * lx, legH / 2, sz * lz], WOODS.has(L.body) && !['white-laminate', 'black-laminate'].includes(L.body) ? L.body : L.frame));
  return out;
}

function chair(s: Size, p: ParsedRequest, L: Look, kind: Kind | null): ObjectPart[] {
  const stool = kind?.id === 'stool' || p.features.includes('backless');
  const seatH = stool ? s.h : Math.min(0.47, s.h * 0.56), st = 0.035, leg = Math.min(0.04, s.w / 10);
  const lh = seatH - st, seatD = stool ? s.d : s.d;
  const soft = p.materials.some((m) => SOFTS.has(m));
  const out: ObjectPart[] = [part('Seat', soft ? 'cushion' : stool && p.round ? 'cylinder' : 'box', [s.w, st, seatD], [0, seatH - st / 2, 0], soft ? L.soft : L.body, L.tint)];
  const ix = s.w / 2 - leg / 2, iz = s.d / 2 - leg / 2;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) out.push(part(`Leg ${sx < 0 ? 'left' : 'right'} ${sz < 0 ? 'back' : 'front'}`, 'leg', [leg, lh, leg], [sx * ix, lh / 2, sz * iz], L.frame));
  out.push(part('Stretcher front', 'tube', [s.w - 2 * leg, 0.02, 0.02], [0, Math.min(0.25, lh * 0.35), iz], L.frame));
  out.push(part('Stretcher back', 'tube', [s.w - 2 * leg, 0.02, 0.02], [0, Math.min(0.25, lh * 0.35), -iz], L.frame));
  if (!stool) {
    const bh = s.h - seatH;
    for (const sx of [-1, 1]) out.push(part(`Back post ${sx < 0 ? 'left' : 'right'}`, 'leg', [leg, bh, leg], [sx * ix, seatH + bh / 2, -iz], L.frame));
    out.push(part('Backrest', soft ? 'cushion' : 'panel', [s.w, Math.min(0.22, bh * 0.55), 0.025], [0, s.h - Math.min(0.22, bh * 0.55) / 2, -s.d / 2 + 0.0125], soft ? L.soft : L.body, L.tint));
    if (p.features.includes('armrests')) for (const sx of [-1, 1]) out.push(part(`Armrest ${sx < 0 ? 'left' : 'right'}`, 'box', [0.04, 0.03, s.d * 0.7], [sx * (s.w / 2 - 0.02), seatH + 0.2, -s.d * 0.15], L.frame));
  }
  return out;
}

/** Built-in fold-down bed, closed: a tall cabinet with the platform standing inside (group 'bed'). */
function wallBed(s: Size, p: ParsedRequest, L: Look): ObjectPart[] {
  const t = 0.022, legH = 0.06, inner = s.w - 2 * t, platD = Math.min(0.3, s.d - 0.06);
  const pz = s.d / 2 - platD / 2 - 0.005;
  const platH = s.h - legH - t - 0.02;
  const g = (q: ObjectPart) => ({ ...q, group: 'bed' });
  return [
    part('Side left', 'panel', [t, s.h, s.d], [-s.w / 2 + t / 2, s.h / 2, 0], L.body, L.tint),
    part('Side right', 'panel', [t, s.h, s.d], [s.w / 2 - t / 2, s.h / 2, 0], L.body, L.tint),
    part('Top', 'panel', [inner, t, s.d], [0, s.h - t / 2, 0], L.body, L.tint),
    part('Back', 'panel', [inner, s.h - t, 0.012], [0, (s.h - t) / 2, -s.d / 2 + 0.006], L.body, L.tint),
    part('Plinth', 'panel', [inner, legH, s.d - 0.04], [0, legH / 2, -0.02], L.body, L.tint),
    g(part('Bed front panel', 'panel', [inner - 0.01, platH, 0.02], [0, legH + platH / 2, s.d / 2 - 0.01], L.body, L.tint)),
    g(part('Platform frame', 'box', [inner - 0.03, platH - 0.02, platD - 0.04], [0, legH + platH / 2, pz - 0.01], L.body, L.tint)),
    g(part('Mattress', 'cushion', [inner - 0.08, platH - 0.1, 0.2], [0, legH + platH / 2, pz - platD / 2 + 0.1], 'mattress')),
    g(part('Handle', 'box', [0.3, 0.02, 0.02], [0, legH + platH - 0.1, s.d / 2 - 0.01], METALS.has(L.frame) ? L.frame : 'black-metal')),
    g(part('Fold-out leg', 'panel', [inner - 0.1, 0.03, 0.02], [0, legH + platH - 0.03, s.d / 2 - 0.035], METALS.has(L.frame) ? L.frame : 'black-metal')),
  ];
}

function bed(s: Size, p: ParsedRequest, L: Look): ObjectPart[] {
  const legH = 0.1, frameH = 0.22, mattH = 0.2, hbD = 0.08, frameD = s.d - hbD;
  const out: ObjectPart[] = [
    part('Headboard', p.materials.some((m) => SOFTS.has(m)) ? 'cushion' : 'panel', [s.w, s.h, hbD], [0, s.h / 2, -s.d / 2 + hbD / 2], p.materials.some((m) => SOFTS.has(m)) ? L.soft : L.body, L.tint),
    part('Frame', 'box', [s.w, frameH, frameD], [0, legH + frameH / 2, -s.d / 2 + hbD + frameD / 2], L.body, L.tint),
    part('Mattress', 'cushion', [s.w - 0.04, mattH, frameD - 0.03], [0, legH + frameH + mattH / 2 - 0.04, -s.d / 2 + hbD + (frameD - 0.03) / 2], 'mattress'),
  ];
  const pillows = s.w >= 1.2 ? 2 : 1, pw = (s.w - 0.2) / pillows;
  for (let i = 0; i < pillows; i++) out.push(part(`Pillow ${i + 1}`, 'cushion', [pw - 0.06, 0.12, 0.38], [-s.w / 2 + 0.1 + pw * i + pw / 2, legH + frameH + mattH - 0.04 + 0.06, -s.d / 2 + hbD + 0.24], 'linen', '#f4f1ea'));
  out.push(part('Duvet', 'cushion', [s.w - 0.02, 0.06, frameD * 0.62], [0, legH + frameH + mattH - 0.04 + 0.03, s.d / 2 - frameD * 0.31 - 0.01], 'linen', L.tint && L.body !== 'oak' ? undefined : '#e9e4da'));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) out.push(part(`Leg ${sx < 0 ? 'left' : 'right'} ${sz < 0 ? 'back' : 'front'}`, 'leg', [0.06, legH, 0.06], [sx * (s.w / 2 - 0.05), legH / 2, sz < 0 ? -s.d / 2 + hbD + 0.05 : s.d / 2 - 0.05], L.frame === 'black-metal' && WOODS.has(L.body) ? L.body : L.frame));
  if (p.features.includes('drawers') || p.features.includes('storage')) {
    for (const sx of [-1, 1]) out.push(part(`Storage drawer ${sx < 0 ? 'left' : 'right'}`, 'panel', [0.02, frameH - 0.04, frameD * 0.6], [sx * (s.w / 2 - 0.01), legH + frameH / 2, 0.1], L.body, L.tint));
  }
  return out;
}

function shelf(s: Size, p: ParsedRequest, L: Look): ObjectPart[] {
  const t = 0.018, inner = s.w - 2 * t, plinth = 0.06;
  const out: ObjectPart[] = [
    part('Side left', 'panel', [t, s.h, s.d], [-s.w / 2 + t / 2, s.h / 2, 0], L.body, L.tint),
    part('Side right', 'panel', [t, s.h, s.d], [s.w / 2 - t / 2, s.h / 2, 0], L.body, L.tint),
    part('Top', 'panel', [inner, t, s.d], [0, s.h - t / 2, 0], L.body, L.tint),
    part('Bottom', 'panel', [inner, t, s.d - 0.01], [0, plinth + t / 2, 0.005], L.body, L.tint),
    part('Plinth', 'panel', [inner, plinth, t], [0, plinth / 2, s.d / 2 - t / 2 - 0.01], L.body, L.tint),
  ];
  if (!p.features.includes('open')) out.push(part('Back panel', 'panel', [inner, s.h - t - plinth, 0.006], [0, plinth + (s.h - t - plinth) / 2, -s.d / 2 + 0.003], L.body, L.tint));
  const n = Math.max(1, Math.round((s.h - plinth - t) / 0.36) - 1);
  const pitch = (s.h - plinth - 2 * t) / (n + 1);
  for (let i = 1; i <= n; i++) out.push(part(`Shelf ${i}`, 'panel', [inner, t, s.d - 0.02], [0, plinth + t + pitch * i, 0.004], L.body, L.tint));
  if (inner > 1.0) out.push(part('Divider', 'panel', [t, s.h - plinth - 2 * t, s.d - 0.02], [0, plinth + t + (s.h - plinth - 2 * t) / 2, 0.004], L.body, L.tint));
  return out;
}

function cabinet(s: Size, p: ParsedRequest, L: Look, kind: Kind | null): ObjectPart[] {
  const legs = kind?.id === 'tv-unit' || kind?.id === 'sideboard' || kind?.id === 'nightstand' || s.h < 0.9;
  const legH = legs ? Math.min(0.14, s.h * 0.2) : 0.05, ft = 0.02;
  const bodyH = s.h - legH, bodyD = s.d - ft;
  const out: ObjectPart[] = [part('Carcass', 'box', [s.w, bodyH, bodyD], [0, legH + bodyH / 2, -ft / 2], L.body, L.tint)];
  if (legs) for (const sx of [-1, 1]) for (const sz of [-1, 1]) out.push(part(`Leg ${sx < 0 ? 'left' : 'right'} ${sz < 0 ? 'back' : 'front'}`, 'leg', [0.035, legH, 0.035], [sx * (s.w / 2 - 0.05), legH / 2, sz * (s.d / 2 - 0.05)], L.frame));
  else out.push(part('Plinth', 'box', [s.w - 0.04, legH, bodyD - 0.04], [0, legH / 2, -ft / 2], L.body, L.tint));
  const handle: MaterialId = METALS.has(L.frame) ? L.frame : 'brass';
  const wantDrawers = p.features.includes('drawers') || kind?.id === 'dresser' || kind?.id === 'nightstand';
  const wantDoors = p.features.includes('doors') || kind?.id === 'wardrobe' || kind?.id === 'cabinet' || kind?.id === 'sideboard' || (kind?.id === 'tv-unit' && !wantDrawers);
  const fz = s.d / 2 - ft / 2, g = 0.005;
  // Front split: drawers stack on one side (or full width), doors fill the rest.
  const cols = Math.max(1, Math.round(s.w / (kind?.id === 'wardrobe' ? 0.5 : 0.6)));
  const colW = s.w / cols;
  let drawerCols: number[] = [];
  if (wantDrawers && wantDoors && cols > 1) drawerCols = [p.side === 'left' ? 0 : cols - 1];
  else if (wantDrawers) drawerCols = Array.from({ length: cols }, (_, i) => i);
  for (let c = 0; c < cols; c++) {
    const x = -s.w / 2 + colW * c + colW / 2;
    if (drawerCols.includes(c)) {
      const n = Math.max(2, Math.min(6, Math.round(bodyH / 0.2))), fh = bodyH / n;
      for (let i = 0; i < n; i++) {
        const y = legH + fh * i + fh / 2;
        out.push(part(`Drawer ${c + 1}.${i + 1}`, 'panel', [colW - g, fh - g, ft], [x, y, fz], L.body, L.tint));
        out.push(part(`Drawer pull ${c + 1}.${i + 1}`, 'box', [Math.min(0.12, colW * 0.35), 0.012, 0.012], [x, y + fh * 0.2, fz + ft / 2 - 0.006], handle));
      }
    } else if (wantDoors || !wantDrawers) {
      const glass = p.features.includes('glass-doors');
      out.push(part(`Door ${c + 1}`, 'panel', [colW - g, bodyH - g, ft], [x, legH + bodyH / 2, fz], glass ? 'glass' : L.body, glass ? undefined : L.tint));
      const hx = x + (c % 2 === 0 ? colW / 2 - 0.04 : -colW / 2 + 0.04);
      out.push(part(`Door handle ${c + 1}`, 'box', [0.012, Math.min(0.18, bodyH * 0.25), 0.012], [hx, legH + bodyH * (s.h > 1.4 ? 0.5 : 0.75), fz + ft / 2 - 0.006], handle));
    }
  }
  return out;
}

function bench(s: Size, p: ParsedRequest, L: Look): ObjectPart[] {
  const t = Math.min(0.04, s.h * 0.1), lh = s.h - t, leg = Math.min(0.05, s.d / 5);
  const soft = p.materials.some((m) => SOFTS.has(m));
  const out: ObjectPart[] = [part('Seat', soft ? 'cushion' : 'box', [s.w, t, s.d], [0, s.h - t / 2, 0], soft ? L.soft : L.body, L.tint)];
  const ix = s.w / 2 - leg / 2 - Math.min(0.08, s.w * 0.06), iz = s.d / 2 - leg / 2;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) out.push(part(`Leg ${sx < 0 ? 'left' : 'right'} ${sz < 0 ? 'back' : 'front'}`, 'leg', [leg, lh, leg], [sx * ix, lh / 2, sz * iz], L.frame));
  out.push(part('Stretcher', 'box', [2 * ix - leg, 0.03, 0.03], [0, lh * 0.3, 0], L.frame));
  if (p.features.includes('shelf') || p.features.includes('storage')) out.push(part('Lower shelf', 'panel', [2 * ix + leg, 0.018, s.d - 0.02], [0, Math.min(0.12, lh * 0.3), 0], L.body, L.tint));
  return out;
}

function lamp(s: Size, p: ParsedRequest, L: Look): ObjectPart[] {
  const shadeH = Math.min(0.35, s.h * 0.22), baseD = Math.min(s.w, s.d) * 0.8, pole = 0.022;
  const metal: MaterialId = METALS.has(L.frame) ? L.frame : p.materials.includes('brass') ? 'brass' : 'black-metal';
  return [
    part('Base', 'cylinder', [baseD, 0.025, baseD], [0, 0.0125, 0], metal),
    part('Pole', 'tube', [pole, s.h - shadeH * 0.6 - 0.025, pole], [0, 0.025 + (s.h - shadeH * 0.6 - 0.025) / 2, 0], metal),
    part('Shade', 'cone', [s.w, shadeH, s.d], [0, s.h - shadeH / 2, 0], p.materials.find((m) => SOFTS.has(m)) ?? 'linen', L.tint ?? '#efe6d2'),
    part('Bulb', 'sphere', [0.07, 0.07, 0.07], [0, s.h - shadeH * 0.55, 0], 'glass', '#fff7e0'),
  ];
}

function rug(s: Size, p: ParsedRequest, L: Look): ObjectPart[] {
  const h = s.h, shape: PartShape = p.round ? 'cylinder' : 'box';
  const mat = p.materials.find((m) => SOFTS.has(m)) ?? 'wool';
  return [
    part('Rug', shape, [s.w, h * 0.6, s.d], [0, h * 0.3, 0], mat, L.tint ?? '#b7a58f'),
    part('Inner field', shape, [s.w * 0.86, h * 0.4, s.d * 0.86], [0, h * 0.8, 0], mat, shade(L.tint ?? '#b7a58f', -0.12)),
    part('Centre motif', p.round ? 'cylinder' : 'box', [Math.min(s.w, s.d) * 0.32, h * 0.2, Math.min(s.w, s.d) * 0.32], [0, h * 0.9, 0], mat, shade(L.tint ?? '#b7a58f', 0.25)),
  ];
}

function shade(hex: string, k: number): string {
  const n = parseInt(hex.replace('#', '').padEnd(6, '0').slice(0, 6), 16);
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(c + (k < 0 ? c * k : (255 - c) * k))));
  return `#${[n >> 16, (n >> 8) & 255, n & 255].map((c) => f(c).toString(16).padStart(2, '0')).join('')}`;
}

// ---- semantics ---------------------------------------------------------------------------

const SEM: Record<string, Omit<ObjectSemantics, 'category' | 'description' | 'tall'>> = {
  desk: { role: 'surface', wallBacked: true, frontClearanceM: 0.9, sideClearanceM: 0, pairsWith: ['office-chair', 'chair', 'lamp'], faces: 'room' },
  table: { role: 'surface', wallBacked: false, frontClearanceM: 0.75, sideClearanceM: 0.75, pairsWith: ['chair', 'bench', 'lamp'], faces: 'none' },
  'coffee-table': { role: 'surface', wallBacked: false, frontClearanceM: 0.4, sideClearanceM: 0, pairsWith: ['sofa', 'armchair', 'rug'], faces: 'none' },
  'side-table': { role: 'surface', wallBacked: false, frontClearanceM: 0, sideClearanceM: 0, pairsWith: ['sofa', 'armchair'], faces: 'none' },
  sofa: { role: 'seating', wallBacked: true, frontClearanceM: 0.45, sideClearanceM: 0, pairsWith: ['coffee-table', 'rug', 'tv-unit', 'lamp'], faces: 'screen' },
  armchair: { role: 'seating', wallBacked: false, frontClearanceM: 0.4, sideClearanceM: 0, pairsWith: ['side-table', 'lamp', 'coffee-table'], faces: 'room' },
  chair: { role: 'seating', wallBacked: false, frontClearanceM: 0.6, sideClearanceM: 0, pairsWith: ['table', 'desk'], faces: 'table' },
  'office-chair': { role: 'seating', wallBacked: false, frontClearanceM: 0.75, sideClearanceM: 0, pairsWith: ['desk'], faces: 'table' },
  stool: { role: 'seating', wallBacked: false, frontClearanceM: 0.45, sideClearanceM: 0, pairsWith: ['counter', 'table'], faces: 'table' },
  bed: { role: 'sleeping', wallBacked: true, frontClearanceM: 0.6, sideClearanceM: 0.6, pairsWith: ['nightstand', 'rug', 'wardrobe'], faces: 'room' },
  bookshelf: { role: 'storage', wallBacked: true, frontClearanceM: 0.6, sideClearanceM: 0, pairsWith: ['armchair', 'desk'], faces: 'room' },
  wardrobe: { role: 'storage', wallBacked: true, frontClearanceM: 0.75, sideClearanceM: 0, pairsWith: ['bed', 'dresser'], faces: 'room' },
  dresser: { role: 'storage', wallBacked: true, frontClearanceM: 0.6, sideClearanceM: 0, pairsWith: ['bed', 'lamp'], faces: 'room' },
  nightstand: { role: 'storage', wallBacked: true, frontClearanceM: 0.3, sideClearanceM: 0, pairsWith: ['bed', 'lamp'], faces: 'room' },
  'storage-cabinet': { role: 'storage', wallBacked: true, frontClearanceM: 0.6, sideClearanceM: 0, pairsWith: [], faces: 'room' },
  'tv-unit': { role: 'storage', wallBacked: true, frontClearanceM: 0.5, sideClearanceM: 0, pairsWith: ['sofa', 'rug'], faces: 'room' },
  bench: { role: 'seating', wallBacked: false, frontClearanceM: 0.45, sideClearanceM: 0, pairsWith: ['table'], faces: 'table' },
  lamp: { role: 'lighting', wallBacked: false, frontClearanceM: 0, sideClearanceM: 0, pairsWith: ['sofa', 'armchair', 'desk'], faces: 'none' },
  rug: { role: 'floor', wallBacked: false, frontClearanceM: 0, sideClearanceM: 0, pairsWith: ['sofa', 'coffee-table', 'bed'], faces: 'none' },
};

/** Sensible semantics for a category; the model's values are checked against these. */
export function defaultSemantics(category: string, size: Size, description = ''): ObjectSemantics {
  const base = SEM[category] ?? { role: 'decor' as const, wallBacked: false, frontClearanceM: 0.4, sideClearanceM: 0, pairsWith: [], faces: 'room' as const };
  return { category, ...base, pairsWith: [...base.pairsWith], tall: size.h > 1.2, description };
}

/** "Desk · wall-backed · needs 90 cm in front" */
export function semanticLine(s: ObjectSemantics): string {
  const parts = [s.category.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase())];
  if (s.wallBacked) parts.push('wall-backed');
  if (s.frontClearanceM >= 0.05) parts.push(`needs ${Math.round(s.frontClearanceM * 100)} cm in front`);
  if (s.tall) parts.push('tall');
  return parts.join(' · ');
}

// ---- entry -------------------------------------------------------------------------------

export function buildTemplate(template: TemplateId, size: Size, p: ParsedRequest, kind: Kind | null = p.kind): ObjectPart[] {
  const L = lookFor(p, template);
  switch (template) {
    case 'desk': return desk(size, p, L);
    case 'table': return table(size, p, L, kind);
    case 'sofa': return sofa(size, p, L, kind);
    case 'chair': return chair(size, p, L, kind);
    case 'bed': return kind?.id === 'wall-bed' ? wallBed(size, p, L) : bed(size, p, L);
    case 'shelf': return shelf(size, p, L);
    case 'cabinet': return cabinet(size, p, L, kind);
    case 'bench': return bench(size, p, L);
    case 'lamp': return lamp(size, p, L);
    case 'rug': return rug(size, p, L);
  }
}

/** A complete custom object from words alone. `size` overrides the parsed/default size. */
export function rulesObject(prompt: string, opts: { parsed?: ParsedRequest; size?: Size; t0?: number } = {}): ObjectSpec {
  const t0 = opts.t0 ?? now();
  const p = opts.parsed ?? parseRequest(prompt);
  const kind = p.kind ?? kindById('cabinet')!;
  const size = opts.size ?? resolveSize({ ...p, kind });
  const parts = buildTemplate(kind.template, size, p, kind);
  const name = p.kind ? titleFor(p) : prompt.trim().slice(0, 40) || 'Object';
  const mat = p.materials[0] ? `${p.materials[0].replace('-', ' ')} ` : '';
  const desc = `${(mat + kind.label.toLowerCase()).replace(/^./, (c) => c.toUpperCase())}, ${cmTxt(size.w)} wide, ${cmTxt(size.d)} deep and ${cmTxt(size.h)} high.`;
  const extra: Partial<ObjectSpec> = {};
  if (kind.id === 'wall-bed') {
    // Hinge at the floor line of the front: the platform swings 90 degrees down into the room.
    extra.motions = [{ group: 'bed', label: 'Fold down', kind: 'hinge', pivot: [0, 0.06, size.d / 2], axis: [1, 0, 0], open: Math.PI / 2 }];
    extra.openSize = { w: size.w, d: r4(size.d + size.h - 0.06 - 0.022 - 0.02), h: size.h };
  }
  return {
    ...extra,
    id: uid('obj'), name, prompt, size: { ...size }, parts,
    semantics: defaultSemantics(kind.category, size, desc),
    model: 'rules', latencyMs: Math.round(now() - t0), createdAt: Date.now(),
  };
}

const cmTxt = (m: number) => `${Math.round(m * 100)} cm`;
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Axis-aligned bounds of the parts (rotations ignored; templates do not rotate parts). */
export function partsBounds(parts: ObjectPart[]): { min: V3; max: V3 } {
  const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const q of parts) for (let i = 0; i < 3; i++) {
    min[i] = Math.min(min[i], q.pos[i] - q.size[i] / 2);
    max[i] = Math.max(max[i], q.pos[i] + q.size[i] / 2);
  }
  return { min, max };
}
