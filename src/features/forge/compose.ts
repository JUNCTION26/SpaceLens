// A sensible object for any furniture-like description, built offline from a wish list by
// composing parametric pieces: carcasses with compartments, drawers, doors and shelves; slabs
// on legs, trestles, pedestals, hairpins or sleds; seats; frames; columns with platforms; discs;
// panels with printed words; and attachments (wheels, handles, cushions, a lamp or plant on top).
// Every count, material and printed word in the wish appears in the parts, named so it can be
// counted ("drawer 2", "shelf 4", "leg 3").

import { uid } from '../../core/geometry';
import type { MaterialId, ObjectPart, ObjectSpec } from '../../core/types';
import { defaultSemantics } from './rulesFallback';
import { fitSpec } from './fit';
import { validateSpec } from './validate';
import { parseWish, type Look, type Role, type Wish } from './wish';

type V3 = [number, number, number];
const r4 = (v: number) => Math.round(v * 10000) / 10000;
const WOODS: MaterialId[] = ['oak', 'walnut', 'pine', 'birch', 'white-laminate', 'black-laminate'];
const METALS: MaterialId[] = ['black-metal', 'steel', 'brass', 'chrome'];
const SOFT: MaterialId[] = ['fabric', 'linen', 'velvet', 'leather', 'wool'];

class Parts {
  list: ObjectPart[] = [];
  constructor(private wish: Wish) {}
  add(name: string, shape: ObjectPart['shape'], size: V3, pos: V3, look: Look, extra: Partial<ObjectPart> = {}): ObjectPart {
    const p: ObjectPart = { name, shape, size: size.map(r4) as V3, pos: pos.map(r4) as V3, material: look.material ?? 'oak', ...extra };
    if (look.color) p.color = look.color;
    if (shape === 'box' && this.wish.features.includes('round-corners') && Math.min(...size) > 0.015) { p.shape = 'rounded'; p.radius = r4(Math.min(0.03, Math.min(...size) / 3)); }
    this.list.push(p);
    return p;
  }
  box(name: string, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, look: Look, extra: Partial<ObjectPart> = {}) {
    return this.add(name, 'box', [x1 - x0, y1 - y0, z1 - z0], [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], look, extra);
  }
}

/** The look for a part role: what the words pinned to it, else a sensible default for the object. */
function looks(w: Wish) {
  const main = w.looks.main ?? {};
  const soft = (m?: MaterialId) => !!m && SOFT.includes(m);
  const structural: Look = main.material && (WOODS.includes(main.material) || METALS.includes(main.material)) ? main
    : { material: w.style.includes('industrial') || w.category === 'desk' && w.support === 'trestle' ? 'black-metal' : main.material && !soft(main.material) ? 'black-metal' : 'oak' };
  const body: Look = soft(main.material) ? { material: 'oak' } : { material: main.material ?? (w.style.includes('industrial') ? 'black-metal' : 'oak'), color: main.color };
  const fabric: Look = soft(main.material) ? main : { material: 'fabric', color: w.looks.main?.color && !main.material ? main.color : undefined };
  const of = (role: Role, fallback: Look): Look => ({ ...fallback, ...stripUndef(w.looks[role]) });
  return {
    body, fabric,
    top: of('top', body), legs: of('legs', w.looks.legs ? {} : w.archetype === 'slab' || w.archetype === 'seat' || w.archetype === 'disc' ? structural : body),
    frame: of('frame', w.archetype === 'seat' ? structural : body), doors: of('doors', body), drawers: of('drawers', body), shelves: of('shelves', body),
    seat: of('seat', fabric), back: of('back', of('seat', fabric)), cushions: of('cushions', of('seat', fabric)),
    handles: of('handles', { material: body.material && METALS.includes(body.material) ? 'steel' : 'brass' }), wheels: of('wheels', { material: 'black-laminate' }),
    post: of('post', w.features.includes('rope') ? { material: 'linen', color: '#c8b48a' } : body), platforms: of('platforms', w.archetype === 'column' && !w.looks.main?.material ? { material: 'fabric', color: main.color } : body),
  };
}
const stripUndef = (l?: Look): Look => { const o: Look = {}; if (l?.material) o.material = l.material; if (l?.color) o.color = l.color; return o; };

type L = ReturnType<typeof looks>;

// ---- pieces ------------------------------------------------------------------------------

/** Wheels under a footprint; returns their height. */
function wheels(P: Parts, L: L, n: number, W: number, D: number, ix = 0.06, iz = 0.06): number {
  const r = 0.04;
  const pts: Array<[number, number]> = n <= 3 ? [[-W / 2 + ix, D / 2 - iz], [W / 2 - ix, D / 2 - iz], [0, -D / 2 + iz]]
    : Array.from({ length: n }, (_, i) => { const a = (i / n) * Math.PI * 2 + Math.PI / 4; return [Math.max(-1, Math.min(1, Math.cos(a) * 1.42)) * (W / 2 - ix), Math.max(-1, Math.min(1, Math.sin(a) * 1.42)) * (D / 2 - iz)] as [number, number]; });
  pts.slice(0, n).forEach(([x, z], i) => P.add(`wheel ${i + 1}`, 'cylinder', [2 * r, 0.03, 2 * r], [x, r, z], L.wheels, { rot: [0, 0, Math.PI / 2] }));
  return 2 * r;
}

/** Legs or other support under a slab footprint from y0 to y1. Returns nothing; names "leg N". */
function support(P: Parts, w: Wish, L: L, W: number, D: number, y1: number, apron = false) {
  const kind = w.support ?? 'legs';
  const t = Math.min(0.06, Math.max(0.035, Math.min(W, D) * 0.07));
  if (kind === 'pedestal') {
    const baseH = 0.03, dia = Math.min(W, D) * 0.6;
    P.add('pedestal base', 'cylinder', [dia, baseH, dia], [0, baseH / 2, 0], L.legs);
    P.add('pedestal column', 'cylinder', [0.09, y1 - baseH, 0.09], [0, baseH + (y1 - baseH) / 2, 0], L.legs);
    return;
  }
  if (kind === 'trestle' || kind === 'sled') {
    const xs = [-W / 2 + Math.max(t, W * 0.08), W / 2 - Math.max(t, W * 0.08)];
    xs.forEach((x, i) => {
      P.box(`leg ${i + 1}`, x - t / 2, x + t / 2, 0.03, y1, -t / 2, t / 2, L.legs);
      P.box(`foot ${i + 1}`, x - t / 2, x + t / 2, 0, 0.03, -D / 2, D / 2, L.legs);
      P.box(`leg rail ${i + 1}`, x - t / 2, x + t / 2, y1 - 0.03, y1, -D / 2 + 0.02, D / 2 - 0.02, L.legs);
    });
    P.box('stretcher', xs[0], xs[1], y1 * 0.35, y1 * 0.35 + 0.04, -t / 2, t / 2, L.legs);
    if (w.category === 'desk' && w.support === 'trestle') P.box('control panel', W / 2 - 0.2, W / 2 - 0.08, y1 - 0.04, y1, D / 2 - 0.06, D / 2, { material: 'black-laminate' });
    return;
  }
  const n = Math.max(2, Math.min(8, w.counts.legs ?? 4));
  const lt = kind === 'hairpin' ? 0.014 : t;
  const pts: Array<[number, number]> = n === 3
    ? [[-W / 2 + lt, D / 2 - lt], [W / 2 - lt, D / 2 - lt], [0, -D / 2 + lt]]
    : n === 2 ? [[-W / 2 + lt, 0], [W / 2 - lt, 0]]
    : Array.from({ length: n }, (_, i) => { const half = Math.ceil(n / 2); const col = i % half; const row = Math.floor(i / half); const x = half === 1 ? 0 : -W / 2 + lt + (col * (W - 2 * lt)) / (half - 1); return [x, row === 0 ? D / 2 - lt : -D / 2 + lt] as [number, number]; });
  const round = w.round || kind === 'hairpin';
  pts.forEach(([x, z], i) => P.add(`leg ${i + 1}`, round ? 'cylinder' : 'box', [lt, y1, lt], [x, y1 / 2, z], L.legs));
  if (n === 2) pts.forEach(([x], i) => P.box(`foot ${i + 1}`, x - lt / 2, x + lt / 2, 0, 0.03, -D / 2, D / 2, L.legs));
  if (apron) P.box('apron', -W / 2 + lt, W / 2 - lt, y1 - 0.08, y1, -D / 2 + lt / 2, D / 2 - lt / 2, L.frame);
}

/** A row or stack of drawers filling a front zone. */
function drawerFronts(P: Parts, L: L, n: number, x0: number, x1: number, y0: number, y1: number, zf: number, side: boolean, handles: boolean) {
  const gap = 0.004;
  for (let i = 0; i < n; i++) {
    const [a, b, c, d] = side ? [x0 + ((x1 - x0) * i) / n, x0 + ((x1 - x0) * (i + 1)) / n, y0, y1] : [x0, x1, y0 + ((y1 - y0) * i) / n, y0 + ((y1 - y0) * (i + 1)) / n];
    P.box(`drawer ${i + 1}`, a + gap, b - gap, c + gap, d - gap, zf - 0.02, zf, L.drawers, { group: `drawer${i + 1}` });
    if (handles) { const cx = (a + b) / 2, cy = side ? d - Math.min(0.05, (d - c) / 3) : (c + d) / 2; const hw = Math.min(0.12, (b - a) * 0.4); P.box(`handle ${P.list.filter((p) => p.name.startsWith('handle')).length + 1}`, cx - hw / 2, cx + hw / 2, cy - 0.008, cy + 0.008, zf, zf + 0.02, L.handles, { group: `drawer${i + 1}` }); }
  }
}

/** Sliding doors: alternate panels on a front and a back track, overlapping where they meet. */
function slidingFronts(P: Parts, L: L, n: number, x0: number, x1: number, y0: number, y1: number, zf: number) {
  const lap = Math.min(0.04, (x1 - x0) / n / 4), w = (x1 - x0) / n;
  for (let i = 0; i < n; i++) {
    const a = Math.max(x0, x0 + w * i - (i > 0 ? lap / 2 : 0)), b = Math.min(x1, x0 + w * (i + 1) + (i < n - 1 ? lap / 2 : 0));
    const z1 = i % 2 === 0 ? zf : zf - 0.02;
    P.box(`door ${i + 1}`, a, b, y0 + 0.002, y1 - 0.002, z1 - 0.018, z1, L.doors, { group: `door${i + 1}` });
    const px = i === 0 ? a + 0.04 : i === n - 1 ? b - 0.04 : (a + b) / 2;
    P.box(`pull ${i + 1}`, px - 0.01, px + 0.01, (y0 + y1) / 2 - 0.12, (y0 + y1) / 2 + 0.12, z1 - 0.004, z1, L.handles, { group: `door${i + 1}` });
  }
}

function doorFronts(P: Parts, L: L, n: number, x0: number, x1: number, y0: number, y1: number, zf: number, handles: boolean) {
  const gap = 0.003;
  for (let i = 0; i < n; i++) {
    const a = x0 + ((x1 - x0) * i) / n, b = x0 + ((x1 - x0) * (i + 1)) / n;
    P.box(`door ${i + 1}`, a + gap, b - gap, y0 + gap, y1 - gap, zf - 0.018, zf, L.doors, { group: `door${i + 1}` });
    if (handles) { const x = n === 1 ? b - 0.05 : i % 2 === 0 ? b - 0.04 : a + 0.04; const hh = Math.min(0.15, (y1 - y0) * 0.3); const cy = y1 - (y1 - y0) * 0.25 > y0 + hh ? (y0 + y1) / 2 : (y0 + y1) / 2; P.box(`handle ${P.list.filter((p) => p.name.startsWith('handle')).length + 1}`, x - 0.008, x + 0.008, cy - hh / 2, cy + hh / 2, zf, zf + 0.02, L.handles, { group: `door${i + 1}` }); }
  }
}

// ---- archetypes --------------------------------------------------------------------------

function carcass(P: Parts, w: Wish, L: L, W: number, D: number, H: number) {
  const c = w.counts, dr = c.drawers ?? 0, doors = c.doors ?? 0, sh = c.shelves ?? 0;
  const fronts = dr + doors > 0;
  const sliding = doors > 0 && dr === 0 && w.features.includes('sliding');
  const handles = fronts && !sliding && (w.features.includes('handles') || !/\bpush|handleless\b/.test(w.text.toLowerCase()));
  const zf = fronts ? D / 2 - (handles ? 0.02 : 0) : D / 2;
  const zb = -D / 2, bodyFront = sliding ? zf - 0.04 : fronts ? zf - 0.02 : zf;
  let y0 = 0;
  if (w.support === 'wheels') y0 = wheels(P, L, c.wheels ?? 4, W, D);
  else if (w.support === 'legs' || (c.legs ?? 0) > 0 || w.support === 'hairpin') { y0 = Math.min(0.15, H * 0.15); support(P, { ...w, round: false }, L, W, bodyFront - zb, y0); P.list.forEach((p) => { if (/^(leg|foot)/.test(p.name)) p.pos[2] = r4(p.pos[2] + (zb + bodyFront) / 2); }); }
  else if (!w.wallMounted) { y0 = Math.min(0.08, H * 0.1); P.box('plinth', -W / 2 + 0.03, W / 2 - 0.03, 0, y0, zb + 0.02, bodyFront - 0.03, L.body); }
  const t = Math.min(0.022, W / 20);
  P.box('side left', -W / 2, -W / 2 + t, y0, H, zb, bodyFront, L.frame);
  P.box('side right', W / 2 - t, W / 2, y0, H, zb, bodyFront, L.frame);
  P.box('top', -W / 2, W / 2, H - t, H, zb, bodyFront, w.looks.top ? L.top : L.frame);
  P.box('bottom', -W / 2 + t, W / 2 - t, y0, y0 + t, zb, bodyFront, L.frame);
  P.box('back', -W / 2 + t, W / 2 - t, y0 + t, H - t, zb, zb + 0.008, L.frame);
  if (w.wallMounted) P.box('wall cleat', -W / 2 + t, W / 2 - t, H - t - 0.06, H - t, zb + 0.008, zb + 0.026, { material: 'pine' });
  const ix0 = -W / 2 + t, ix1 = W / 2 - t, iy0 = y0 + t, iy1 = H - t;
  // Vertical zones: drawers on top of doors; doors at the bottom of an open shelf unit.
  const comps = Math.max(1, c.compartments ?? (W > 1.3 && doors === 0 && dr === 0 ? Math.round(W / 0.8) : 1));
  for (let i = 1; i < comps; i++) { const x = ix0 + ((ix1 - ix0) * i) / comps; P.box(`divider ${i}`, x - t / 2, x + t / 2, iy0, iy1, zb + 0.008, bodyFront, L.frame); }
  if (dr + doors === 0 && sh === 0 && comps === 1) P.box('front', ix0, ix1, iy0, iy1, bodyFront - 0.018, bodyFront, L.frame);
  const atBottom = doors > 0 && sh > 0 && (/\b(at the bottom|below|lower|underneath|nederst|alhaalla)\b/.test(w.text.toLowerCase()) || w.category === 'bookshelf');
  let openY0 = iy0, openY1 = iy1;
  if (dr > 0 && doors > 0) {
    const split = iy1 - Math.min(0.2 * Math.ceil(dr / Math.max(1, Math.floor(W / 0.5))), (iy1 - iy0) * 0.4);
    const side = W / dr >= 0.35;
    drawerFronts(P, L, dr, ix0, ix1, side ? split : iy0 + (iy1 - iy0) * 0.45, iy1, zf, side, handles);
    doorFronts(P, L, doors, ix0, ix1, iy0, side ? split : iy0 + (iy1 - iy0) * 0.45, zf, handles);
    openY1 = side ? split : iy0 + (iy1 - iy0) * 0.45;
  } else if (dr > 0) {
    const side = (H - y0) < 0.6 && W / dr >= 0.35;
    drawerFronts(P, L, dr, ix0, ix1, iy0, iy1, zf, side, handles);
  } else if (sliding) {
    P.box('track top', -W / 2, W / 2, H - 0.03, H, bodyFront, zf, L.frame);
    P.box('track bottom', -W / 2, W / 2, y0, y0 + 0.03, bodyFront, zf, L.frame);
    slidingFronts(P, L, doors, -W / 2, W / 2, y0 + 0.03, H - 0.03, zf);
  } else if (doors > 0) {
    const top = atBottom ? iy0 + Math.min(0.75, Math.max(0.35, (iy1 - iy0) * 0.3)) : iy1;
    doorFronts(P, L, doors, ix0, ix1, iy0, top, zf, handles);
    if (atBottom) { P.box('door zone shelf', ix0, ix1, top, top + t, zb + 0.008, bodyFront, L.frame); openY0 = top + t; } else openY1 = top;
  }
  // Shelves: evenly spaced boards in the open (or behind-doors) zone.
  if (sh > 0 && dr === 0) {
    const span = openY1 - openY0;
    for (let i = 1; i <= sh; i++) { const y = openY0 + (span * i) / (sh + 1); P.box(`shelf ${i}`, ix0, ix1, y - t / 2, y + t / 2, zb + 0.008, bodyFront - 0.005, L.shelves); }
  } else if (sh > 0) {
    for (let i = 1; i <= sh; i++) { const y = openY0 + ((openY1 - openY0) * i) / (sh + 1); P.box(`shelf ${i}`, ix0, ix1, y - t / 2, y + t / 2, zb + 0.008, bodyFront - 0.005, L.shelves); }
  }
}

function slab(P: Parts, w: Wish, L: L, W: number, D: number, H: number) {
  const tt = w.category === 'bench' ? 0.04 : Math.min(0.04, Math.max(0.018, H * 0.05));
  let y0 = 0;
  if (w.support === 'wheels') y0 = wheels(P, L, w.counts.wheels ?? 4, W, D, 0.02, 0.04);
  const dr = w.counts.drawers ?? 0;
  const legH = H - tt;
  if (w.round) P.add('top', 'cylinder', [W, tt, D], [0, H - tt / 2, 0], L.top);
  else P.box('top', -W / 2, W / 2, H - tt, H, -D / 2, D / 2, L.top);
  if (w.support === 'wheels') {
    const t = 0.04;
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([sx, sz], i) => P.box(`leg ${i + 1}`, sx < 0 ? -W / 2 : W / 2 - t, sx < 0 ? -W / 2 + t : W / 2, y0, legH, sz < 0 ? -D / 2 : D / 2 - t, sz < 0 ? -D / 2 + t : D / 2, L.legs));
  } else support(P, w, L, W, D, legH, !w.round && dr === 0 && w.support !== 'trestle' && w.support !== 'pedestal' && w.category !== 'bench');
  const lt = Math.min(0.06, Math.max(0.035, Math.min(W, D) * 0.07));
  if (dr > 0) {
    const ah = Math.min(0.2, legH * 0.4), x0 = -W / 2 + lt, x1 = W / 2 - lt;
    P.box('drawer case', x0, x1, legH - ah, legH, -D / 2 + lt, D / 2 - 0.02, L.frame);
    drawerFronts(P, L, dr, x0, x1, legH - ah, legH, D / 2, true, false);
  }
  const sh = w.counts.shelves ?? 0;
  for (let i = 1; i <= sh; i++) {
    const y = Math.max(y0 + 0.08, (legH * 0.35 * i) / sh);
    P.box(`shelf ${i}`, -W / 2 + (w.round ? W * 0.2 : 0), W / 2 - (w.round ? W * 0.2 : 0), y - 0.009, y + 0.009, -D / 2 + (w.support === 'trestle' ? D * 0.2 : 0), D / 2 - (w.support === 'trestle' ? D * 0.2 : 0), L.shelves);
  }
}

function seat(P: Parts, w: Wish, L: L, W: number, D: number, H: number) {
  const sofa = w.category === 'sofa' || w.category === 'armchair';
  const seatH = sofa ? 0.43 : w.category === 'office-chair' ? 0.48 : 0.46;
  const arms = w.features.includes('armrests'), back = w.features.includes('backrest');
  const armW = arms ? (sofa ? Math.min(0.18, W * 0.12) : 0.05) : 0;
  const backD = back ? (sofa ? Math.min(0.2, D * 0.22) : 0.04) : 0;
  const baseY = sofa ? 0.12 : seatH - 0.06;
  if (w.category === 'office-chair' || w.support === 'pedestal') {
    const n = w.counts.wheels ?? 5;
    for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; const R = Math.min(W, D) / 2 - 0.03; P.add(`wheel ${i + 1}`, 'cylinder', [0.05, 0.05, 0.05], [r4(Math.sin(a) * R), 0.025, r4(Math.cos(a) * R)], L.wheels); P.add(`base arm ${i + 1}`, 'box', [0.04, 0.03, R], [r4(Math.sin(a) * R / 2), 0.065, r4(Math.cos(a) * R / 2)], L.legs, { rot: [0, a, 0] }); }
    P.add('gas lift', 'cylinder', [0.05, baseY - 0.05, 0.05], [0, 0.05 + (baseY - 0.05) / 2, 0], L.legs);
  } else if (w.support === 'sled') {
    [-1, 1].forEach((s, i) => { P.box(`runner ${i + 1}`, s * (W / 2 - armW / 2 - 0.02) - 0.02, s * (W / 2 - armW / 2 - 0.02) + 0.02, 0, 0.04, -D / 2, D / 2, L.legs); P.box(`leg ${i + 1}`, s * (W / 2 - armW / 2 - 0.02) - 0.02, s * (W / 2 - armW / 2 - 0.02) + 0.02, 0.04, baseY, -0.02, 0.02, L.legs); });
  } else {
    const legH = baseY, lt = sofa ? 0.04 : 0.035;
    [[-1, 1], [1, 1], [-1, -1], [1, -1]].slice(0, Math.max(3, Math.min(4, w.counts.legs ?? 4))).forEach(([sx, sz], i) => P.box(`leg ${i + 1}`, sx < 0 ? -W / 2 + 0.02 : W / 2 - 0.02 - lt, sx < 0 ? -W / 2 + 0.02 + lt : W / 2 - 0.02, 0, legH, sz < 0 ? -D / 2 + 0.02 : D / 2 - 0.02 - lt, sz < 0 ? -D / 2 + 0.02 + lt : D / 2 - 0.02, L.legs));
  }
  const frameLook = sofa ? L.fabric : L.frame;
  P.box('seat frame', -W / 2 + armW, W / 2 - armW, baseY, seatH - (sofa ? 0.14 : 0.03), -D / 2 + backD, D / 2, frameLook);
  const n = sofa ? Math.max(1, w.counts.seats ?? 1) : 1;
  const sx0 = -W / 2 + armW, sx1 = W / 2 - armW;
  for (let i = 0; i < n; i++) {
    const a = sx0 + ((sx1 - sx0) * i) / n, b = sx0 + ((sx1 - sx0) * (i + 1)) / n;
    P.box(`seat cushion ${i + 1}`, a + 0.003, b - 0.003, seatH - (sofa ? 0.14 : 0.03), seatH, -D / 2 + backD, D / 2, sofa || w.features.includes('cushions') || w.features.includes('tufted') ? L.cushions : L.seat, { shape: sofa ? 'cushion' : 'box' });
    if (back && sofa) P.box(`back cushion ${i + 1}`, a + 0.003, b - 0.003, seatH, Math.min(H, seatH + 0.4), -D / 2 + backD, -D / 2 + backD + 0.16, L.back, { shape: 'cushion' });
  }
  if (back) P.box('backrest', -W / 2 + (sofa ? 0 : armW), W / 2 - (sofa ? 0 : armW), sofa ? baseY : seatH - 0.03, H, -D / 2, -D / 2 + backD, sofa ? L.fabric : (w.looks.back ? L.back : L.frame), w.features.includes('tufted') ? { shape: 'cushion' } : {});
  if (arms) [-1, 1].forEach((s, i) => P.box(`armrest ${i + 1}`, s < 0 ? -W / 2 : W / 2 - armW, s < 0 ? -W / 2 + armW : W / 2, sofa ? baseY : seatH - 0.03, Math.min(H, seatH + (sofa ? 0.2 : 0.22)), -D / 2 + (sofa ? 0 : backD), D / 2, sofa ? L.fabric : L.frame));
}

function disc(P: Parts, w: Wish, L: L, W: number, D: number, H: number) {
  const pouf = w.category === 'pet' || /pouf|ottoman|footstool|hassock|rahi|puff/.test(w.text.toLowerCase());
  if (pouf) {
    P.add('body', w.round ? 'cylinder' : 'cushion', [W, H * 0.85, D], [0, H * 0.425, 0], L.fabric);
    P.add(w.category === 'pet' ? 'rim' : 'top cushion', 'cushion', [W, H * 0.15, D], [0, H * 0.925, 0], L.cushions);
    return;
  }
  const st = 0.05;
  P.add('seat', w.round || !w.looks.main ? 'cylinder' : 'box', [W, st, D], [0, H - st / 2 - (w.features.includes('backrest') ? H * 0.3 : 0), 0], w.looks.seat ? L.seat : L.top);
  const seatY = H - st - (w.features.includes('backrest') ? H * 0.3 : 0);
  if (w.support === 'pedestal') { P.add('base', 'cylinder', [W * 0.9, 0.03, D * 0.9], [0, 0.015, 0], L.legs); P.add('column', 'cylinder', [0.06, seatY - 0.03, 0.06], [0, 0.03 + (seatY - 0.03) / 2, 0], L.legs); }
  else {
    const n = Math.max(3, Math.min(4, w.counts.legs ?? (W < 0.42 ? 3 : 4))), R = Math.min(W, D) / 2 - 0.03;
    for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2 + Math.PI / 4; P.add(`leg ${i + 1}`, 'cylinder', [0.035, seatY, 0.035], [r4(Math.cos(a) * R), seatY / 2, r4(Math.sin(a) * R)], L.legs); }
    if (H > 0.6) P.add('footrest', 'box', [2 * R + 0.035, 0.02, 2 * R + 0.035], [0, seatY * 0.4, 0], L.legs, { shape: 'tube', radius: 0.01 });
  }
  if (w.features.includes('backrest')) P.box('backrest', -W / 2 + 0.05, W / 2 - 0.05, seatY + st, H, -D / 2, -D / 2 + 0.03, L.back);
}

function bed(P: Parts, w: Wish, L: L, W: number, D: number, H: number) {
  const crib = w.category === 'crib';
  const frameH = crib ? 0.35 : 0.3, matH = crib ? 0.1 : 0.2, lt = 0.06;
  [[-1, 1], [1, 1], [-1, -1], [1, -1]].forEach(([sx, sz], i) => P.box(`leg ${i + 1}`, sx < 0 ? -W / 2 : W / 2 - lt, sx < 0 ? -W / 2 + lt : W / 2, 0, crib ? H : frameH, sz < 0 ? -D / 2 : D / 2 - lt, sz < 0 ? -D / 2 + lt : D / 2, L.frame));
  P.box('side rail left', -W / 2, -W / 2 + 0.03, frameH - 0.15, frameH, -D / 2 + lt, D / 2 - lt, L.frame);
  P.box('side rail right', W / 2 - 0.03, W / 2, frameH - 0.15, frameH, -D / 2 + lt, D / 2 - lt, L.frame);
  P.box('base', -W / 2 + 0.03, W / 2 - 0.03, frameH - 0.03, frameH, -D / 2 + lt, D / 2 - lt, L.frame);
  P.box('mattress', -W / 2 + 0.03, W / 2 - 0.03, frameH, frameH + matH, -D / 2 + lt, D / 2 - lt, { material: 'mattress', color: '#f2efe8' });
  if (crib || w.features.includes('slatted')) {
    const n = Math.max(6, Math.round(D / 0.08));
    for (let i = 0; i < Math.min(n, 12); i++) { const z = -D / 2 + lt + ((D - 2 * lt) * (i + 0.5)) / Math.min(n, 12); [-1, 1].forEach((s) => P.box(`slat ${P.list.filter((p) => p.name.startsWith('slat')).length + 1}`, s < 0 ? -W / 2 + 0.01 : W / 2 - 0.03, s < 0 ? -W / 2 + 0.03 : W / 2 - 0.01, frameH, H - 0.04, z - 0.012, z + 0.012, L.frame)); }
    [-1, 1].forEach((s, i) => P.box(`top rail ${i + 1}`, s < 0 ? -W / 2 : W / 2 - 0.04, s < 0 ? -W / 2 + 0.04 : W / 2, H - 0.04, H, -D / 2 + lt, D / 2 - lt, L.frame));
  } else {
    P.box('headboard', -W / 2, W / 2, frameH - 0.15, H, -D / 2, -D / 2 + lt, w.looks.back ? L.back : w.features.includes('tufted') ? L.fabric : L.frame, w.features.includes('tufted') ? { shape: 'cushion' } : {});
    const pw = W > 1.2 ? 2 : 1;
    for (let i = 0; i < pw; i++) P.box(`pillow ${i + 1}`, -W / 2 + 0.06 + ((W - 0.12) * i) / pw, -W / 2 + 0.06 + ((W - 0.12) * (i + 1)) / pw - 0.02, frameH + matH, Math.min(H, frameH + matH + 0.12), -D / 2 + lt, -D / 2 + lt + 0.4, L.cushions, { shape: 'cushion' });
  }
}

function bunk(P: Parts, w: Wish, L: L, W: number, D: number, H: number) {
  const slide = w.features.includes('slide');
  const bw = slide ? Math.min(W - 0.6, Math.max(0.9, W * 0.42)) : W;
  const x0 = -W / 2, x1 = x0 + bw, pt = 0.06;
  const deckY = Math.max(1.0, H - 0.55);
  [[x0, -D / 2], [x1 - pt, -D / 2], [x0, D / 2 - pt], [x1 - pt, D / 2 - pt]].forEach(([x, z], i) => P.box(`post ${i + 1}`, x, x + pt, 0, H, z, z + pt, L.frame));
  for (const [lvl, y] of [['lower', 0.3], ['upper', deckY]] as const) {
    P.box(`${lvl} base`, x0 + pt, x1 - pt, y - 0.04, y, -D / 2 + pt, D / 2 - pt, L.frame);
    P.box(`${lvl} rail`, x0, x1, y - 0.12, y, -D / 2, -D / 2 + 0.03, L.frame);
    P.box(`${lvl} mattress`, x0 + pt, x1 - pt, y, y + 0.16, -D / 2 + pt, D / 2 - pt, { material: 'mattress', color: '#f2efe8' });
  }
  P.box('guard rail', x0 + pt, x1 - pt, deckY + 0.16, H - 0.05, D / 2 - 0.03, D / 2, L.frame);
  P.box('guard rail top', x0, x1, H - 0.05, H, D / 2 - 0.04, D / 2, L.frame);
  // Ladder at the foot end, rungs between two rails up to the deck.
  const lz0 = -D / 2 + pt, lx = x1 - pt;
  P.box('ladder rail 1', lx, x1, 0, deckY + 0.16, D / 2 - pt - 0.46, D / 2 - pt - 0.42, L.frame);
  const rungs = Math.max(3, Math.round(deckY / 0.28));
  for (let i = 1; i <= rungs; i++) { const y = (deckY * i) / (rungs + 0.3); P.box(`rung ${i}`, lx, x1, y - 0.015, y + 0.015, D / 2 - pt - 0.42, D / 2 - pt, L.frame); }
  void lz0;
  if (slide) {
    // Sized so its rotated box spans exactly from the deck edge to the floor.
    const run = W - bw, th = 0.03, ang = Math.atan2(deckY, run), len = (run - th * Math.sin(ang)) / Math.cos(ang);
    const yext = len * Math.sin(ang) + th * Math.cos(ang);
    P.add('slide', 'panel', [len, th, 0.5], [x1 + run / 2, yext / 2, 0], { material: 'plastic', color: w.looks.main?.color ?? '#e94b3c' }, { rot: [0, 0, -ang] });
    P.box('slide rail', x1, x1 + 0.08, deckY - 0.06, deckY + 0.16, -0.27, 0.27, { material: 'plastic', color: '#f2c94c' });
  }
}

function column(P: Parts, w: Wish, L: L, W: number, D: number, H: number) {
  const plant = w.features.includes('plant');
  const topBudget = plant ? Math.min(0.45, H * 0.4) : 0;
  const top = H - topBudget;
  const baseH = 0.03;
  P.box('base', -W / 2, W / 2, 0, baseH, -D / 2, D / 2, w.archetype === 'column' && w.category === 'pet' ? L.platforms : L.body);
  const n = w.counts.platforms ?? 1;
  const pd = 0.1, post = w.category === 'pet' ? 0.11 : 0.06;
  P.add(w.features.includes('rope') ? 'rope post' : 'post', 'cylinder', [post, top - baseH, post], [0, baseH + (top - baseH) / 2, 0], L.post);
  const pw = Math.min(W, D) * (w.category === 'pet' ? 0.75 : 1);
  for (let i = 1; i <= n; i++) {
    const y = baseH + ((top - baseH) * i) / n;
    const off = w.category === 'pet' && n > 1 && i < n ? (i % 2 ? 1 : -1) * (W - pw) / 2 : 0;
    P.add(`platform ${i}`, w.round ? 'cylinder' : 'box', [pw, i === n ? 0.03 : pd * 0.3, pw], [off, y - 0.015, 0], L.platforms);
  }
  if (n === 0) for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2; P.add(`hook ${i + 1}`, 'cylinder', [0.02, 0.12, 0.02], [r4(Math.cos(a) * 0.06), top - 0.08, r4(Math.sin(a) * 0.06)], L.post, { rot: [r4(Math.sin(a) * 0.7), 0, r4(-Math.cos(a) * 0.7)] }); }
  if (plant) attachPlant(P, Math.min(W, D) * 0.8, top, topBudget);
}

function attachPlant(P: Parts, wpot: number, y: number, h: number) {
  const ph = h * 0.45;
  P.add('plant pot', 'cylinder', [wpot * 0.6, ph, wpot * 0.6], [0, y + ph / 2, 0], { material: 'ceramic', color: '#d8cfc4' });
  P.add('plant', 'sphere', [wpot, h - ph, wpot], [0, y + ph + (h - ph) / 2, 0], { material: 'plant' });
}

function attachLamp(P: Parts, wl: number, y: number, h: number, x = 0) {
  P.add('lamp base', 'cylinder', [wl * 0.5, 0.03, wl * 0.5], [x, y + 0.015, 0], { material: 'brass' });
  P.add('lamp stem', 'cylinder', [0.02, h * 0.55, 0.02], [x, y + 0.03 + h * 0.275, 0], { material: 'brass' });
  P.add('lamp shade', 'cone', [wl, h * 0.45 - 0.03, wl], [x, y + h - (h * 0.45 - 0.03) / 2, 0], { material: 'linen', color: '#f4ecd8' });
}

function lamp(P: Parts, w: Wish, L: L, W: number, D: number, H: number) {
  attachLamp(P, Math.min(W, D), 0, H);
  P.list.forEach((p) => { if (p.name === 'lamp base' && (w.looks.legs || w.looks.main?.material)) Object.assign(p, { material: (w.looks.legs ?? w.looks.main)!.material ?? p.material }); if (p.name === 'lamp shade' && w.looks.main?.color) p.color = w.looks.main.color; });
}

function frame(P: Parts, w: Wish, L: L, W: number, D: number, H: number) {
  const t = 0.03;
  const cart = w.category === 'cart';
  let y0 = 0;
  if (w.support === 'wheels' || cart) y0 = wheels(P, L, w.counts.wheels ?? 4, W, D, 0.015, 0.04);
  if (cart) {
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([sx, sz], i) => P.box(`post ${i + 1}`, sx < 0 ? -W / 2 : W / 2 - t, sx < 0 ? -W / 2 + t : W / 2, y0, H - (w.features.includes('handles') ? 0.12 : 0), sz < 0 ? -D / 2 : D / 2 - t, sz < 0 ? -D / 2 + t : D / 2, L.legs.material ? L.legs : L.frame));
    const n = Math.max(1, w.counts.shelves ?? 2), topY = H - (w.features.includes('handles') ? 0.12 : 0);
    for (let i = 0; i < n; i++) { const y = n === 1 ? topY - 0.02 : y0 + 0.1 + ((topY - 0.02 - y0 - 0.1) * i) / (n - 1); P.box(`shelf ${i + 1}`, -W / 2, W / 2, y - 0.01, y + 0.01, -D / 2, D / 2, L.shelves); }
    if (w.features.includes('handles')) { P.box('handle post 1', W / 2 - t, W / 2, topY, H, -D / 2, -D / 2 + t, L.frame); P.box('handle post 2', W / 2 - t, W / 2, topY, H, D / 2 - t, D / 2, L.frame); P.box('handle', W / 2 - t, W / 2, H - t, H, -D / 2, D / 2, L.handles, { shape: 'box' }); }
    return;
  }
  const ladder = /towel|ladder/.test(w.text.toLowerCase());
  [-1, 1].forEach((s, i) => {
    P.box(`upright ${i + 1}`, s < 0 ? -W / 2 : W / 2 - t, s < 0 ? -W / 2 + t : W / 2, y0 + (ladder ? 0 : t), H, -t / 2, t / 2, L.frame);
    if (!ladder) P.box(`foot ${i + 1}`, s < 0 ? -W / 2 : W / 2 - t, s < 0 ? -W / 2 + t : W / 2, y0, y0 + t, -D / 2, D / 2, L.frame);
  });
  if (ladder) {
    const n = w.counts.shelves ?? 4;
    for (let i = 1; i <= n; i++) { const y = (H * i) / (n + 1); P.box(`shelf ${i}`, -W / 2 + t, W / 2 - t, y - 0.01, y + 0.01, -D / 2, D / 2, L.shelves); }
    [-1, 1].forEach((s, i) => P.box(`leaning foot ${i + 1}`, s < 0 ? -W / 2 : W / 2 - t, s < 0 ? -W / 2 + t : W / 2, 0, 0.02, -D / 2, D / 2, L.frame));
  } else {
    P.add('rail', 'cylinder', [0.028, W - 2 * t, 0.028], [0, H - 0.03, 0], L.frame, { rot: [0, 0, Math.PI / 2] });
    for (let i = 1; i <= (w.counts.shelves ?? 0); i++) P.box(`shelf ${i}`, -W / 2 + t, W / 2 - t, y0 + t + 0.15 * i, y0 + t + 0.15 * i + 0.018, -D / 2 + 0.03, D / 2 - 0.03, L.shelves);
  }
}

function panel(P: Parts, w: Wish, L: L, W: number, D: number, H: number) {
  const divider = w.category === 'divider';
  if (divider) {
    const n = 3;
    for (let i = 0; i < n; i++) P.box(`panel ${i + 1}`, -W / 2 + (W * i) / n + 0.005, -W / 2 + (W * (i + 1)) / n - 0.005, 0, H, -D / 2, D / 2, L.body);
    return;
  }
  const footH = w.wallMounted ? 0 : Math.min(0.5, H * 0.3);
  if (!w.wallMounted) [-1, 1].forEach((s, i) => { P.box(`stand leg ${i + 1}`, s * W * 0.35 - 0.02, s * W * 0.35 + 0.02, 0.02, footH + 0.05, -0.02, 0.02, L.legs); P.box(`stand foot ${i + 1}`, s * W * 0.35 - 0.03, s * W * 0.35 + 0.03, 0, 0.02, -D / 2, D / 2, L.legs); });
  else P.box('wall cleat', -W * 0.3, W * 0.3, H - 0.08, H - 0.02, -D / 2, -D / 2 + 0.01, { material: 'pine' });
  P.box('frame', -W / 2, W / 2, footH, H, -0.015, 0.015, L.frame);
  P.box(w.features.includes('mirror') ? 'mirror' : 'board', -W / 2 + 0.03, W / 2 - 0.03, footH + 0.03, H - 0.03, 0.01, Math.min(D / 2, 0.02), w.features.includes('mirror') ? { material: 'glass', color: '#dfe8ee' } : { material: 'white-laminate', color: w.looks.main?.color });
}

function drumkit(P: Parts, w: Wish, L: L, W: number, D: number, H: number) {
  const shell: Look = w.looks.main?.color || w.looks.main?.material ? { material: w.looks.main.material ?? 'plastic', color: w.looks.main.color } : { material: 'plastic', color: '#8b1e2d' };
  const chrome: Look = { material: 'chrome' };
  const brass: Look = { material: 'brass', color: '#c9a227' };
  const nd = Math.max(1, w.counts.drums ?? 4), nc = w.counts.cymbals ?? 2;
  let k = 0;
  // Kick drum on its side at the front centre.
  const kd = Math.min(0.56, H * 0.5);
  P.add(`drum ${++k}`, 'cylinder', [kd, 0.4, kd], [0, kd / 2, D / 2 - 0.2], shell, { rot: [Math.PI / 2, 0, 0] });
  // Snare and floor toms on three-leg stands; rack toms ride on the kick.
  const spots: Array<[number, number, number, number]> = [[-W / 2 + 0.3, D / 2 - 0.45, 0.62, 0.36], [W / 2 - 0.3, D / 2 - 0.45, 0.5, 0.42], [-0.15, D / 2 - 0.2, kd + 0.18, 0.3], [0.15, D / 2 - 0.2, kd + 0.18, 0.32], [-W / 2 + 0.3, -D / 2 + 0.4, 0.55, 0.36], [W / 2 - 0.3, -D / 2 + 0.6, 0.5, 0.42]];
  for (let i = 0; i < nd - 1; i++) {
    const [x, z, y, dia] = spots[i % spots.length];
    const dh = 0.16;
    P.add(`drum ${++k}`, 'cylinder', [dia, dh, dia], [x, y + dh / 2, z], shell);
    if (y > kd) P.add(`tom mount ${i + 1}`, 'cylinder', [0.025, y - kd + 0.05, 0.025], [x, kd + (y - kd) / 2 - 0.02, z], chrome);
    else P.add(`drum stand ${i + 1}`, 'cylinder', [0.025, y, 0.025], [x, y / 2, z], chrome);
    if (y <= kd) P.add(`stand foot ${i + 1}`, 'cylinder', [dia * 0.8, 0.02, dia * 0.8], [x, 0.01, z], chrome);
  }
  for (let i = 0; i < nc; i++) {
    const x = (i % 2 ? 1 : -1) * (W / 2 - 0.2), z = -D / 2 + 0.2 + (Math.floor(i / 2) * 0.3), cy = H - 0.01 - (i % 2) * 0.1;
    P.add(`cymbal stand ${i + 1}`, 'cylinder', [0.022, cy, 0.022], [x, cy / 2, z], chrome);
    P.add(`stand foot c${i + 1}`, 'cylinder', [0.35, 0.02, 0.35], [x, 0.01, z], chrome);
    P.add(`cymbal ${i + 1}`, 'cylinder', [0.4, 0.012, 0.4], [x, cy + 0.006 - 0.012, z], brass);
  }
  P.add('throne', 'cylinder', [0.36, 0.08, 0.36], [0, 0.5, -D / 2 + 0.2], { material: 'leather', color: '#1b1b1b' });
  P.add('throne post', 'cylinder', [0.04, 0.46, 0.04], [0, 0.23, -D / 2 + 0.2], chrome);
}

const BUILDERS = { carcass, slab, seat, bed, bunk, frame, column, disc, panel, lamp, drumkit } as const;

// ---- entry -------------------------------------------------------------------------------

export interface WishReport { met: string[]; unmet: string[] }
/** A built object plus the wish it was built from and how it is mounted. */
export type ComposedSpec = ObjectSpec & { wish: Wish; mount?: { wall: true; elevationM: number } };

/** Size of the attachments that sit on top of the main body (lamp, plant), metres. */
function topBudget(w: Wish): number {
  if (w.archetype === 'lamp' || w.archetype === 'column' || w.archetype === 'panel' || w.archetype === 'drumkit') return 0;
  return w.features.includes('monitor-arm') ? 0.5 : w.features.includes('lamp') ? 0.45 : w.features.includes('plant') ? 0.4 : 0;
}

/** A clamp-on monitor arm at the back edge of a desk top, holding a screen over the desk. */
function attachMonitorArm(P: Parts, y: number, h: number, W: number, D: number) {
  const metal: Look = { material: 'black-metal' };
  const zb = -D / 2 + 0.06, sw = Math.min(0.6, W * 0.7), sh = Math.min(0.36, h * 0.72);
  P.box('monitor arm clamp', -0.04, 0.04, y, y + 0.04, -D / 2, -D / 2 + 0.1, metal);
  P.add('monitor arm pole', 'cylinder', [0.035, h - 0.04, 0.035], [0, y + 0.04 + (h - 0.04) / 2, zb], metal);
  P.box('monitor arm', -0.025, 0.025, y + h * 0.55, y + h * 0.55 + 0.04, zb, zb + Math.min(0.28, D * 0.4), metal);
  const zm = zb + Math.min(0.28, D * 0.4);
  P.box('monitor', -sw / 2, sw / 2, y + h - sh - 0.01, y + h - 0.01, zm, zm + 0.025, { material: 'black-laminate' });
}

/** Build the parts for a wish, inside its size exactly. */
export function composeParts(w: Wish): ObjectPart[] {
  const P = new Parts(w);
  const L = looks(w);
  const extra = topBudget(w);
  const { w: W, d: D } = w.size;
  // A stated height is the overall height; otherwise the attachment adds to it.
  const bodyH = w.stated.h ? Math.max(0.2, w.size.h - extra) : w.size.h;
  BUILDERS[w.archetype](P, w, L, W, D, bodyH);
  if (extra) {
    const wl = Math.min(0.32, W * 0.4, D * 0.8);
    if (w.features.includes('monitor-arm')) attachMonitorArm(P, bodyH, extra, W, D);
    else if (w.features.includes('lamp')) attachLamp(P, wl, bodyH, extra, W / 2 - wl / 2 - 0.02);
    else attachPlant(P, wl, bodyH, extra);
  }
  if (w.text_ && !P.list.some((p) => p.name === 'board')) {
    // A name plate on the front face of the body, inside the footprint.
    const fz = Math.max(...P.list.map((p) => p.pos[2] + (p.rot ? 0 : p.size[2] / 2)));
    const ys = P.list.filter((p) => !p.rot).map((p) => [p.pos[1] - p.size[1] / 2, p.pos[1] + p.size[1] / 2]);
    const front = P.list.find((p) => !p.rot && Math.abs(p.pos[2] + p.size[2] / 2 - fz) < 0.03 && p.size[0] > 0.2 && p.size[1] > 0.06) ?? P.list[0];
    void ys;
    const ph = Math.min(0.1, front.size[1] * 0.6), pw = Math.min(front.size[0] * 0.7, 0.08 * w.text_.length + 0.1);
    P.add('name plate', 'panel', [pw, ph, 0.006], [front.pos[0], front.pos[1], front.pos[2] + front.size[2] / 2 - 0.003], { material: 'brass' }, { text: { value: w.text_, color: '#1b1b1b', style: 'display' } });
  } else if (w.text_) {
    const b = P.list.find((p) => p.name === 'board')!;
    b.text = { value: w.text_, color: '#1b1b1b', background: b.color ?? '#ffffff', style: 'display' };
  }
  return P.list;
}

/** Overall size including attachments and the slide; stated dimensions never change. */
function overall(w: Wish): Wish['size'] {
  const s = { ...w.size };
  if (!w.stated.h) s.h += topBudget(w);
  if (w.archetype === 'bunk' && w.features.includes('slide') && !w.stated.w) s.w = Math.max(s.w, 1.0) + 1.5;
  return s;
}

/** A complete object for any description, offline. */
export function composeObject(input: string | Wish, opts: { t0?: number } = {}): ComposedSpec {
  const w = typeof input === 'string' ? parseWish(input) : input;
  const size = overall(w);
  const wb = { ...w, size: { ...size, h: w.stated.h ? size.h : size.h - topBudget(w) } };
  const parts = composeParts(wb).slice(0, 60);
  const label = (w.noun || w.category).replace(/^./, (c) => c.toUpperCase());
  const mat = w.looks.main?.material ? `${w.looks.main.material.replace('-', ' ')} ` : '';
  const name = (mat + (w.noun || w.category)).replace(/^./, (c) => c.toUpperCase());
  const raw: ObjectSpec = {
    id: uid('obj'), name, prompt: w.text, size, parts,
    semantics: { ...defaultSemantics(w.category, size, `${label}, ${Math.round(size.w * 100)} × ${Math.round(size.d * 100)} × ${Math.round(size.h * 100)} cm.`), wallBacked: w.wallMounted || defaultSemantics(w.category, size).wallBacked },
    model: 'rules', latencyMs: Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - (opts.t0 ?? 0)) || 0, createdAt: Date.now(),
  };
  const v = validateSpec(fitSpec(raw, size));
  const out: ComposedSpec = { ...v.fixed, wish: w };
  if (w.wallMounted) out.mount = { wall: true, elevationM: w.elevation ?? 1 };
  return out;
}
