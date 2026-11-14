// Kit recipes for the common asks, used when there is no model (and as the instant silhouette).
// Each recipe writes a few kit items at the requested size; the kits supply the detail, so a desk
// has a real drawer pedestal, a bed is made up, a wall bed folds and a piano has keys.

import type { MaterialId } from '../../core/types';
import { KIT_EXAMPLES } from './kitExamples';
import type { ParsedRequest } from './parseRequest';

type Item = Record<string, unknown>;
type Size = { w: number; d: number; h: number };
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const I = (name: string, size: number[], pos: number[], material: MaterialId, extra: Item = {}): Item => ({ name, ...extra, size: size.map(r3), pos: pos.map(r3), material });

const WOODS: MaterialId[] = ['oak', 'walnut', 'pine', 'birch'];
const SOFT: MaterialId[] = ['fabric', 'linen', 'velvet', 'leather', 'wool'];

interface Look { wood: MaterialId; metal: MaterialId; soft: MaterialId; main?: string; accent?: string; glossy: boolean; theme?: string }

function lookOf(p: ParsedRequest): Look {
  const th = p.theme;
  const wood = (p.materials.find((m) => WOODS.includes(m) || m === 'white-laminate' || m === 'black-laminate' || m === 'marble') ?? th?.materials?.find((m) => WOODS.includes(m)) ?? 'oak') as MaterialId;
  const metal = (p.materials.find((m) => ['black-metal', 'steel', 'brass', 'chrome'].includes(m)) ?? th?.materials?.find((m) => ['black-metal', 'steel', 'brass', 'chrome'].includes(m)) ?? 'black-metal') as MaterialId;
  const soft = (p.materials.find((m) => SOFT.includes(m)) ?? th?.materials?.find((m) => SOFT.includes(m)) ?? 'fabric') as MaterialId;
  const main = p.colors[0]?.hex ?? th?.palette[0];
  const accent = p.colors[1]?.hex ?? (p.colors.length ? undefined : th?.palette[1]);
  return { wood, metal, soft, main, accent, glossy: th?.materials?.[0] === 'plastic', theme: th?.id };
}

/** Body material for painted or coloured furniture. */
const bodyMat = (L: Look): MaterialId => (L.main && !WOODS.includes(L.wood) ? L.wood : L.main ? (L.glossy ? 'plastic' : 'white-laminate') : L.wood);
const col = (L: Look) => (L.main ? { color: L.main } : {});

const has = (p: ParsedRequest, re: RegExp) => re.test(p.text.toLowerCase());

function desk(s: Size, p: ParsedRequest, L: Look, standing = false): Item[] {
  const t = 0.03, top = s.h - t, side = p.side === 'left' ? -1 : 1;
  const drawers = p.features.includes('drawers') || p.counts.drawers !== undefined || has(p, /pedestal/);
  const out: Item[] = [I('Desktop', [s.w, t, s.d], [0, s.h - t / 2, 0], bodyMat(L), { shape: 'rounded', radius: 0.006, ...col(L) })];
  if (standing) {
    out.push(I('Frame', [s.w - 0.12, top, s.d - 0.1], [0, top / 2, 0], L.metal, { kit: 'legs', style: 'trestle', radius: 0.035 }));
    out.push(I('Control', [0.1, 0.025, 0.05], [s.w / 2 - 0.2, top - 0.0125, s.d / 2 - 0.05], 'plastic', { shape: 'rounded', color: '#222222' }));
    return out;
  }
  if (drawers) {
    const pw = Math.min(0.44, s.w * 0.3), px = side * (s.w / 2 - pw / 2);
    out.push(I('Leg', [0.05, top, 0.05], [-side * (s.w / 2 - 0.025), top / 2, s.d / 2 - 0.05], L.metal, { shape: 'box', mirror: 'z' }));
    out.push(I('Foot rail', [0.05, 0.03, s.d - 0.05], [-side * (s.w / 2 - 0.025), 0.015, 0], L.metal, { shape: 'box' }));
    out.push(I('Pedestal', [pw, top, s.d - 0.04], [px, top / 2, 0], bodyMat(L), { kit: 'carcass', style: 'plinth', ...col(L) }));
    out.push(I('Drawer', [pw - 0.036, top - 0.1, s.d - 0.06], [px, 0.08 + (top - 0.1) / 2, 0.01], bodyMat(L), { kit: 'drawers', count: p.counts.drawers ?? 3, ...col(L) }));
    out.push(I('Modesty panel', [s.w - pw - 0.06, Math.min(0.3, top * 0.4), 0.018], [-side * (pw / 2), top - Math.min(0.3, top * 0.4) / 2, -s.d / 2 + 0.05], bodyMat(L), { shape: 'panel', ...col(L) }));
  } else {
    out.push(I('Legs', [s.w, top, s.d], [0, top / 2, 0], L.metal, { kit: 'legs', style: has(p, /hairpin/) ? 'hairpin' : 'square' }));
    out.push(I('Apron', [s.w - 0.1, 0.08, s.d - 0.1], [0, top - 0.04, 0], bodyMat(L), { kit: 'frame', style: 'apron', ...col(L) }));
  }
  return out;
}

function bed(s: Size, p: ParsedRequest, L: Look): Item[] {
  const themed = L.theme === 'barbie' || L.theme === 'princess' || has(p, /canopy|four.?poster|princess|dream/);
  const frameH = 0.3, legH = 0.08;
  const hbStyle = has(p, /heart/) ? 'heart' : has(p, /arch/) ? 'arch' : has(p, /scallop/) ? 'scallop' : has(p, /tufted|button/) ? 'tufted' : themed ? 'scallop' : 'channel';
  const frameMat: MaterialId = L.main ? (L.glossy ? 'plastic' : 'velvet') : L.wood;
  const hbH = Math.min(1.2, Math.max(0.9, s.h * 0.55));
  const out: Item[] = [
    I('Feet', [s.w - 0.04, legH, s.d - 0.1], [0, legH / 2, 0], themed ? 'brass' : L.wood, { kit: 'legs', style: themed ? 'bun' : 'square' }),
    I('Bed frame', [s.w, frameH - legH, s.d - 0.08], [0, legH + (frameH - legH) / 2, 0.04], frameMat, { shape: 'rounded', radius: 0.03, ...col(L) }),
    I('Bedding', [s.w - 0.08, 0.3, s.d - 0.16], [0, frameH + 0.15, 0.06], 'linen', { kit: 'bedding', style: hbStyle === 'heart' || themed ? 'heart' : '', color: L.accent && themed ? L.accent : L.main ? '#f4f2ee' : '#ece7dd', accent: L.main }),
    I('Headboard', [s.w, hbH, 0.07], [0, 0.18 + hbH / 2, -s.d / 2 + 0.035], SOFT.includes(L.soft) && !L.glossy ? L.soft : frameMat, { kit: 'headboard', style: hbStyle, color: L.main, accent: L.accent }),
  ];
  if (themed) {
    out.push(I('Canopy', [s.w + 0.06, Math.max(s.h, 1.9), s.d], [0, Math.max(s.h, 1.9) / 2, 0], 'white-laminate', { kit: 'canopy', style: 'princess', color: '#ffffff', accent: L.accent ?? '#ffd1e3' }));
    out.push(I('Footboard', [s.w, 0.5, 0.05], [0, 0.33, s.d / 2 - 0.025], frameMat, { shape: 'extrude', style: 'arch', color: L.accent ?? '#ffffff' }));
  }
  return out;
}

function bunk(s: Size, p: ParsedRequest, L: Look): Item[] {
  const w = s.w, d = s.d, h = s.h, mat = L.main ? 'white-laminate' : L.wood;
  const out: Item[] = [
    I('Corner post', [0.07, h, 0.07], [-w / 2 + 0.035, h / 2, -d / 2 + 0.035], mat, { shape: 'box', mirror: 'xz' }),
    I('Lower frame', [w, 0.1, d], [0, 0.3, 0], mat, { kit: 'frame', radius: 0.035 }),
    I('Lower bedding', [w - 0.1, 0.26, d - 0.1], [0, 0.48, 0], 'linen', { kit: 'bedding', count: 1, color: L.main ?? '#4a6a8f', style: 'plain' }),
    I('Upper frame', [w, 0.1, d], [0, h * 0.62, 0], mat, { kit: 'frame', radius: 0.035 }),
    I('Upper bedding', [w - 0.1, 0.26, d - 0.1], [0, h * 0.62 + 0.18, 0], 'linen', { kit: 'bedding', count: 1, color: L.accent ?? '#f2c230', style: 'plain' }),
    I('Guard rail', [0.04, 0.06, d - 0.14], [-w / 2 + 0.035, h - 0.08, 0], mat, { shape: 'box', mirror: 'x' }),
    I('Ladder', [0.42, h * 0.95, 0.04], [w / 2 - 0.3, h * 0.475, d / 2 + 0.02], mat, { kit: 'ladder', count: 5 }),
  ];
  if (has(p, /slide/)) out.push(I('Slide', [1.4, h * 0.66, 0.46], [w / 2 + 0.7, h * 0.33, d / 2 - 0.4], 'plastic', { kit: 'slide', style: 'right', color: L.main && L.main !== '#f4f2ee' ? L.main : '#e8742a' }));
  return out;
}

function crib(s: Size, _p: ParsedRequest, L: Look): Item[] {
  const mat = L.main ? 'white-laminate' : L.wood;
  return [
    I('Post', [0.05, s.h, 0.05], [-s.w / 2 + 0.025, s.h / 2, -s.d / 2 + 0.025], mat, { shape: 'box', mirror: 'xz', ...col(L) }),
    I('Side bars', [s.d - 0.1, s.h - 0.25, 0.03], [-s.w / 2 + 0.025, 0.25 + (s.h - 0.25) / 2, 0], mat, { kit: 'slats', count: 14, rot: [0, Math.PI / 2, 0], mirror: 'x', ...col(L) }),
    I('End bars', [s.w - 0.1, s.h - 0.25, 0.03], [0, 0.25 + (s.h - 0.25) / 2, -s.d / 2 + 0.025], mat, { kit: 'slats', count: 8, mirror: 'z', ...col(L) }),
    I('Base', [s.w - 0.1, 0.03, s.d - 0.1], [0, 0.26, 0], mat, { shape: 'panel' }),
    I('Mattress', [s.w - 0.12, 0.12, s.d - 0.12], [0, 0.335, 0], 'linen', { kit: 'bedding', style: 'bare' }),
  ];
}

function hospital(s: Size, _p: ParsedRequest, L: Look): Item[] {
  const g = '#c9cbcd';
  return [
    I('Wheel', [0.1, 0.1, 0.04], [-s.w / 2 + 0.1, 0.05, -s.d / 2 + 0.12], 'plastic', { shape: 'cylinder', rot: [0, 0, Math.PI / 2], color: '#2a2a2a', mirror: 'xz' }),
    I('Base frame', [s.w - 0.1, 0.12, s.d - 0.2], [0, 0.16, 0], 'steel', { kit: 'frame', style: 'base', radius: 0.025 }),
    I('Lift column', [0.12, 0.3, 0.12], [0, 0.37, 0], 'plastic', { shape: 'box', color: g }),
    I('Deck', [s.w - 0.12, 0.08, s.d - 0.2], [0, 0.56, 0], 'white-laminate', { shape: 'rounded', radius: 0.02, color: L.main ?? '#f4f2ee' }),
    I('Mattress', [s.w - 0.16, 0.14, s.d * 0.62], [0, 0.67, s.d * 0.17], 'mattress', { shape: 'rounded', radius: 0.04 }),
    I('Raised back', [s.w - 0.16, 0.14, s.d * 0.32], [0, 0.82, -s.d * 0.26], 'mattress', { shape: 'rounded', radius: 0.04, rot: [0.5, 0, 0] }),
    I('Head end', [s.w, 0.62, 0.05], [0, 0.6, -s.d / 2 + 0.025], 'plastic', { shape: 'rounded', radius: 0.03, color: g }),
    I('Foot end', [s.w, 0.45, 0.05], [0, 0.5, s.d / 2 - 0.025], 'plastic', { shape: 'rounded', radius: 0.03, color: g }),
    I('Side rail', [0.03, 0.3, s.d * 0.45], [-s.w / 2 + 0.03, 0.85, -s.d * 0.12], 'steel', { kit: 'slats', style: 'horizontal', count: 3, mirror: 'x' }),
    I('Pillow', [0.55, 0.12, 0.35], [0, 0.98, -s.d * 0.33], 'linen', { shape: 'cushion', color: '#f6f3ee', rot: [0.5, 0, 0] }),
  ];
}

function sofa(s: Size, p: ParsedRequest, L: Look, armchair = false): Item[] {
  const c = L.main ?? (L.soft === 'leather' ? '#9a5b34' : '#6f7f73');
  const soft = L.soft;
  if (has(p, /curved|curve|round|crescent|semi.?circ/)) {
    const depth = Math.min(s.w * 0.22, 0.6);
    return [
      I('Plinth', [s.w, 0.1, depth], [0, 0.05, 0], L.wood, { kit: 'arc', radius: 0.7, inset: 0.06 }),
      I('Seat base', [s.w, 0.3, depth], [0, 0.25, 0], soft, { kit: 'arc', radius: 0.9, color: c }),
      I('Back', [s.w, 0.42, depth], [0, 0.61, 0], soft, { kit: 'arc', radius: 0.22, color: c }),
      I('Seat cushion', [s.w, 0.14, depth], [0, 0.47, 0], soft, { kit: 'arc', radius: 0.64, inset: 0.22, count: Math.max(2, Math.round(s.w / 0.8)), color: c }),
    ];
  }
  const arm = Math.min(0.2, s.w * 0.1), seatW = s.w - 2 * arm, n = armchair ? 1 : Math.max(2, Math.round(seatW / 0.65));
  return [
    I('Legs', [s.w - 0.08, 0.12, s.d - 0.1], [0, 0.06, 0], L.wood, { kit: 'legs', count: armchair || s.w < 1.6 ? 4 : 6, style: 'tapered' }),
    I('Base', [s.w, 0.26, s.d], [0, 0.25, 0], soft, { shape: 'rounded', radius: 0.04, color: c }),
    I('Back', [s.w, s.h - 0.38, 0.2], [0, 0.38 + (s.h - 0.38) / 2, -s.d / 2 + 0.1], soft, { shape: 'rounded', radius: 0.05, color: c }),
    I('Arm', [arm, 0.26, s.d - 0.2], [-s.w / 2 + arm / 2, 0.51, 0.1], soft, { shape: 'rounded', radius: 0.06, color: c, mirror: 'x' }),
    I('Seat cushion', [seatW, 0.16, s.d - 0.3], [0, 0.46, 0.15], soft, { kit: 'cushions', count: n, color: c, style: has(p, /tufted|chesterfield/) ? 'tufted' : 'seat' }),
    I('Back cushion', [seatW, Math.max(0.3, s.h - 0.46), 0.2], [0, 0.46 + Math.max(0.3, s.h - 0.46) / 2, -s.d / 2 + 0.3], soft, { kit: 'cushions', count: n, style: 'back', color: c }),
    I('Throw pillow', [seatW * 0.8, 0.36, 0.14], [0, 0.72, -s.d / 2 + 0.45], 'linen', { kit: 'cushions', count: 2, style: 'pillows', color: L.accent ?? '#c9a227', accent: '#e8e1d3' }),
  ];
}

function officeChair(s: Size, p: ParsedRequest, L: Look, gaming: boolean): Item[] {
  const main = L.main ?? (gaming ? '#1e1e1e' : '#5a5f66'), acc = L.accent ?? (gaming ? '#d0021b' : '#222222');
  const seatY = 0.48, mat: MaterialId = gaming ? 'leather' : 'fabric';
  const out: Item[] = [
    I('Base', [s.w, seatY, s.d], [0, seatY / 2, 0], 'black-metal', { kit: 'casters' }),
    I('Seat shell', [0.5, 0.04, 0.48], [0, seatY + 0.02, 0.02], 'plastic', { shape: 'rounded', color: '#222222' }),
    I('Seat', [0.52, 0.1, 0.5], [0, seatY + 0.09, 0.03], mat, { shape: 'cushion', color: main }),
    I('Backrest', [0.52, s.h - seatY - 0.18, 0.12], [0, seatY + 0.14 + (s.h - seatY - 0.18) / 2, -0.24], mat, { shape: 'rounded', radius: 0.05, color: main, rot: [-0.12, 0, 0] }),
    I('Arm post', [0.04, 0.2, 0.05], [-0.29, seatY + 0.12, 0], 'plastic', { shape: 'box', color: '#222222', mirror: 'x' }),
    I('Arm pad', [0.08, 0.035, 0.24], [-0.29, seatY + 0.235, 0.02], 'plastic', { shape: 'rounded', radius: 0.015, color: '#222222', mirror: 'x' }),
  ];
  if (gaming) {
    out.push(I('Seat bolster', [0.08, 0.13, 0.48], [-0.24, seatY + 0.13, 0.03], mat, { shape: 'cushion', color: acc, mirror: 'x' }));
    out.push(I('Back bolster', [0.09, s.h - seatY - 0.3, 0.15], [-0.25, seatY + 0.2 + (s.h - seatY - 0.3) / 2, -0.22], mat, { shape: 'cushion', color: acc, rot: [-0.12, 0, 0], mirror: 'x' }));
    out.push(I('Head pillow', [0.3, 0.15, 0.09], [0, s.h - 0.17, -0.18], mat, { shape: 'cushion', color: acc, rot: [-0.12, 0, 0] }));
    out.push(I('Lumbar pillow', [0.34, 0.16, 0.09], [0, seatY + 0.3, -0.16], mat, { shape: 'cushion', color: acc, rot: [-0.12, 0, 0] }));
  }
  void p;
  return out;
}

function table(s: Size, p: ParsedRequest, L: Look): Item[] {
  const t = 0.035, mat = p.materials.includes('marble') ? 'marble' : p.materials.includes('glass') ? 'glass' : bodyMat(L);
  if (p.round || p.features.includes('pedestal')) {
    const base = p.materials.find((m) => ['brass', 'steel', 'chrome', 'black-metal'].includes(m)) ?? (mat === 'marble' ? 'brass' : L.wood);
    return [
      I('Tabletop', [s.w, t, s.d], [0, s.h - t / 2, 0], mat, { shape: p.round ? 'cylinder' : 'rounded', ...col(L) }),
      I('Pedestal', [Math.min(s.w, s.d) * 0.48, s.h - t, Math.min(s.w, s.d) * 0.48], [0, (s.h - t) / 2, 0], base, { kit: 'pedestal', style: base === 'brass' || base === 'steel' ? 'tulip' : 'cross turned' }),
    ];
  }
  return [
    I('Tabletop', [s.w, t, s.d], [0, s.h - t / 2, 0], mat, { shape: 'rounded', radius: 0.008, ...col(L) }),
    I('Legs', [s.w - 0.1, s.h - t, s.d - 0.1], [0, (s.h - t) / 2, 0], p.materials.find((m) => ['black-metal', 'steel', 'brass'].includes(m)) ?? L.wood, { kit: 'legs', style: has(p, /hairpin/) ? 'hairpin' : 'tapered' }),
    I('Apron', [s.w - 0.12, 0.08, s.d - 0.12], [0, s.h - t - 0.04, 0], L.wood, { kit: 'frame', style: 'apron' }),
  ];
}

function bookshelf(s: Size, p: ParsedRequest, L: Look, wall: boolean): Item[] {
  const mat = bodyMat(L);
  const ladder = wall || has(p, /ladder/);
  // A leaning ladder needs room in front of the shelves: it takes the front of the depth.
  const bookD = ladder ? Math.min(0.4, s.d * 0.62) : s.d;
  const out: Item[] = [I('Bookcase', [s.w, s.h, bookD], [0, s.h / 2, -s.d / 2 + bookD / 2], mat, { kit: 'bookcase', count: p.counts.shelves ?? Math.max(3, Math.round(s.h / 0.38) - 1), style: 'books decor', ...col(L) })];
  if (ladder) {
    const H = s.h - 0.12, room = s.d - bookD - 0.06, lean = Math.asin(Math.min(0.35, Math.max(0.02, room - 0.05) / H));
    out.push(I('Ladder rail', [s.w - 0.1, 0.025, 0.025], [0, s.h - 0.12, -s.d / 2 + bookD + 0.03], 'brass', { shape: 'tube' }));
    out.push(I('Library ladder', [0.45, H, 0.05], [s.w * 0.2, H / 2, -s.d / 2 + bookD + 0.03 + room / 2], L.wood === 'white-laminate' ? 'oak' : L.wood, { kit: 'ladder', rot: [-lean, 0, 0] }));
  }
  return out;
}

function storage(s: Size, p: ParsedRequest, L: Look, kind: string): Item[] {
  const mat = bodyMat(L), legH = kind === 'tv-unit' || kind === 'nightstand' || kind === 'sideboard' ? Math.min(0.14, s.h * 0.2) : 0;
  const bodyH = s.h - legH, t = 0.018;
  const out: Item[] = [];
  if (legH) out.push(I('Legs', [s.w - 0.06, legH, s.d - 0.06], [0, legH / 2, 0], L.wood === 'white-laminate' ? 'oak' : L.wood, { kit: 'legs', style: 'splayed' }));
  out.push(I('Body', [s.w, bodyH, s.d], [0, legH + bodyH / 2, 0], mat, { kit: 'carcass', style: legH ? 'legs' : 'plinth', ...col(L) }));
  const fy0 = legH + (legH ? t : Math.min(0.08, bodyH * 0.1) + t), fh = s.h - t - fy0;
  const front = { size: [s.w - 2 * t, fh, s.d - 0.02], pos: [0, fy0 + fh / 2, 0.01] };
  if (kind === 'dresser' || kind === 'nightstand' || p.features.includes('drawers')) {
    out.push(I('Drawer', front.size, front.pos, mat, { kit: 'drawers', count: p.counts.drawers ?? (kind === 'nightstand' ? 2 : 6), style: kind === 'dresser' ? '2col knob' : 'bar', ...col(L) }));
  } else {
    const sliding = has(p, /slid/), n = p.counts.doors ?? (s.w > 1.4 ? 3 : 2);
    out.push(I('Door', [front.size[0], fh, 0.02], [0, fy0 + fh / 2, s.d / 2 - 0.01], mat, { kit: 'doors', count: n, style: `${sliding ? 'sliding ' : ''}${has(p, /glass/) ? 'glass' : has(p, /cane|rattan/) ? 'cane' : kind === 'tv-unit' ? 'fluted' : 'shaker'}`, ...col(L) }));
  }
  return out;
}

function island(s: Size, p: ParsedRequest, L: Look): Item[] {
  const topT = 0.04, over = 0.25, body = { w: s.w - 0.05, d: s.d - over };
  const mat = bodyMat(L), top: MaterialId = p.materials.includes('marble') || !p.materials.length ? 'marble' : p.materials.includes('oak') ? 'oak' : 'marble';
  const out: Item[] = [
    I('Cabinet', [body.w, s.h - topT, body.d], [0, (s.h - topT) / 2, -over / 2], mat, { kit: 'carcass', style: 'plinth', count: 2, ...col(L) }),
    I('Drawer', [body.w / 2 - 0.03, s.h - topT - 0.12, body.d - 0.04], [-body.w / 4, 0.1 + (s.h - topT - 0.12) / 2, -over / 2 + 0.01], mat, { kit: 'drawers', count: 3, style: 'bar', ...col(L) }),
    I('Door', [body.w / 2 - 0.03, s.h - topT - 0.12, 0.02], [body.w / 4, 0.1 + (s.h - topT - 0.12) / 2, -over / 2 + body.d / 2 - 0.01], mat, { kit: 'doors', count: 2, style: 'shaker', ...col(L) }),
    I('Worktop', [s.w, topT, s.d], [0, s.h - topT / 2, 0], top, { shape: 'rounded', radius: 0.006 }),
  ];
  if (has(p, /stool/)) {
    const n = p.counts.stools ?? 2;
    out.push(I('Stool seat', [0.38, 0.05, 0.38], [-(n - 1) * 0.3, 0.65, s.d / 2 + 0.05], 'leather', { shape: 'cylinder', color: L.accent ?? '#2f2f2f', count: n, step: [0.6, 0, 0] }));
    out.push(I('Stool column', [0.05, 0.62, 0.05], [-(n - 1) * 0.3, 0.32, s.d / 2 + 0.05], 'chrome', { shape: 'cylinder', count: n, step: [0.6, 0, 0] }));
    out.push(I('Stool base', [0.4, 0.02, 0.4], [-(n - 1) * 0.3, 0.01, s.d / 2 + 0.05], 'chrome', { shape: 'cylinder', count: n, step: [0.6, 0, 0] }));
  }
  return out;
}

function barCounter(s: Size, _p: ParsedRequest, L: Look): Item[] {
  const mat = bodyMat(L);
  return [
    I('Front', [s.w, s.h - 0.05, 0.1], [0, (s.h - 0.05) / 2, s.d / 2 - 0.05], mat, { shape: 'extrude', style: 'rect', ...col(L) }),
    I('Front panels', [s.w - 0.04, s.h - 0.25, 0.02], [0, 0.15 + (s.h - 0.25) / 2, s.d / 2 + 0.01], mat, { kit: 'doors', count: Math.max(2, Math.round(s.w / 0.5)), style: 'fluted push', ...col(L) }),
    I('Back counter', [s.w, 0.9, s.d - 0.25], [0, 0.45, -0.125], mat, { kit: 'carcass', style: 'plinth', ...col(L) }),
    I('Bar top', [s.w + 0.04, 0.05, 0.4], [0, s.h - 0.025, s.d / 2 - 0.15], 'walnut', { shape: 'rounded', radius: 0.02 }),
    I('Foot rail', [s.w - 0.1, 0.035, 0.035], [0, 0.22, s.d / 2 + 0.15], 'brass', { shape: 'tube' }),
    I('Rail bracket', [0.03, 0.03, 0.14], [-s.w / 2 + 0.2, 0.22, s.d / 2 + 0.09], 'brass', { shape: 'box', mirror: 'x' }),
    I('Bottle', [0.08, 0.3, 0.08], [-s.w / 2 + 0.3, 1.05, -0.2], 'glass', { shape: 'lathe', count: 5, step: [0.2, 0, 0], profile: [[0.04, 0], [0.04, 0.2], [0.015, 0.26], [0.015, 0.3]] }),
  ];
}

function reception(s: Size, p: ParsedRequest, L: Look): Item[] {
  const front = L.main ?? '#f4f2ee', frontMat: MaterialId = 'white-laminate';
  const top = p.materials.find((m) => WOODS.includes(m)) ?? 'oak';
  const curved = has(p, /curv|round|arc/);
  if (curved) {
    const depth = Math.min(0.45, s.w * 0.15);
    return [
      I('Front', [s.w, s.h - 0.04, depth], [0, (s.h - 0.04) / 2, 0], frontMat, { kit: 'arc', style: 'convex', radius: 0.12, color: front }),
      I('Plinth', [s.w, 0.08, depth], [0, 0.04, 0], 'black-laminate', { kit: 'arc', style: 'convex', radius: 0.08, inset: 0.04 }),
      I('Ledge', [s.w, 0.04, depth], [0, s.h - 0.02, 0], top, { kit: 'arc', style: 'convex', radius: 0.3 }),
      I('Work surface', [s.w, 0.03, depth], [0, 0.735, 0], top, { kit: 'arc', style: 'convex', radius: 0.7, inset: 0.12 }),
      I('Light strip', [s.w, 0.02, depth], [0, 0.12, 0], 'plastic', { kit: 'arc', style: 'convex', radius: 0.01, color: '#fff3c4' }),
    ];
  }
  return [
    I('Front', [s.w, s.h - 0.04, 0.12], [0, (s.h - 0.04) / 2, s.d / 2 - 0.06], frontMat, { shape: 'rounded', radius: 0.01, color: front }),
    I('Ledge', [s.w, 0.04, 0.35], [0, s.h - 0.02, s.d / 2 - 0.175], top, { shape: 'rounded', radius: 0.01 }),
    I('Work surface', [s.w - 0.1, 0.03, s.d - 0.12], [0, 0.735, -0.06], top, { shape: 'panel' }),
    I('Side', [0.04, 0.72, s.d - 0.12], [-s.w / 2 + 0.02, 0.36, -0.06], frontMat, { shape: 'panel', color: front, mirror: 'x' }),
  ];
}

function grandPiano(s: Size, L: Look): Item[] {
  const black = L.main ?? '#111111', bh = 0.32, legH = s.h * 0.6;
  return [
    I('Front leg', [0.1, legH, 0.1], [-s.w / 2 + 0.1, legH / 2, s.d / 2 - 0.25], 'plastic', { shape: 'leg', color: black, mirror: 'x' }),
    I('Tail leg', [0.1, legH, 0.1], [-s.w * 0.15, legH / 2, -s.d / 2 + 0.2], 'plastic', { shape: 'leg', color: black }),
    I('Case', [s.w, bh, s.d - 0.18], [0, legH + bh / 2, -0.09], 'plastic', { kit: 'plan', style: 'piano', color: black }),
    I('Key bed', [s.w * 0.92, 0.1, 0.24], [0, legH + 0.08, s.d / 2 - 0.12], 'plastic', { shape: 'box', color: black }),
    I('Keys', [s.w * 0.8, 0.035, 0.15], [0, legH + 0.1475, s.d / 2 - 0.08], 'plastic', { kit: 'keyboard', color: black }),
    I('Cheek', [0.08, 0.14, 0.24], [-s.w * 0.43, legH + 0.1, s.d / 2 - 0.12], 'plastic', { shape: 'rounded', radius: 0.02, color: black, mirror: 'x' }),
    I('Music desk', [0.7, 0.28, 0.02], [0, legH + bh + 0.14, s.d / 2 - 0.42], 'plastic', { shape: 'panel', color: black, rot: [-0.25, 0, 0] }),
    I('Lid', [s.w * 0.98, 0.02, s.d - 0.3], [-s.w * 0.08, legH + bh + 0.38, -0.15], 'plastic', { kit: 'plan', style: 'piano', color: black, rot: [0, 0, 0.5] }),
    I('Lid prop', [0.02, 0.62, 0.02], [s.w * 0.28, legH + bh + 0.31, -0.2], 'brass', { shape: 'tube' }),
    I('Lyre', [0.18, legH - 0.06, 0.06], [0, legH / 2 + 0.03, s.d / 2 - 0.45], 'plastic', { shape: 'extrude', style: 'shield', color: black }),
    I('Pedal', [0.04, 0.02, 0.1], [-0.07, 0.06, s.d / 2 - 0.4], 'brass', { shape: 'box', count: 3, step: [0.07, 0, 0] }),
  ];
}

function arcade(s: Size, L: Look): Item[] {
  const a = L.main && L.main !== '#1e1e1e' ? L.main : '#7d4fb3', b = L.accent ?? '#2bb3b1';
  const sideProfile = [[-0.2, 0], [0.5, 0], [0.5, 1], [-0.3, 1], [-0.3, 0.86], [-0.08, 0.8], [-0.14, 0.6], [-0.5, 0.54], [-0.5, 0.49], [-0.2, 0.44]];
  return [
    I('Side panel', [s.d, s.h, 0.03], [-s.w / 2 + 0.015, s.h / 2, 0], 'black-laminate', { shape: 'extrude', profile: sideProfile, rot: [0, Math.PI / 2, 0], mirror: 'x' }),
    I('Side art', [s.d * 0.5, s.h * 0.4, 0.004], [-s.w / 2 - 0.002, s.h * 0.55, -s.d * 0.12], 'plastic', { shape: 'extrude', style: 'star', rot: [0, Math.PI / 2, 0], color: a, mirror: 'x' }),
    I('Body', [s.w - 0.06, s.h * 0.45, s.d * 0.7], [0, s.h * 0.225, -s.d * 0.15], 'black-laminate', { shape: 'box' }),
    I('Coin door', [0.22, 0.24, 0.02], [0, s.h * 0.2, s.d * 0.2 + 0.01], 'steel', { shape: 'panel' }),
    I('Control panel', [s.w - 0.06, 0.05, s.d * 0.32], [0, s.h * 0.505, s.d * 0.33], 'plastic', { shape: 'rounded', radius: 0.01, color: a, rot: [0.2, 0, 0] }),
    I('Joystick', [0.016, 0.08, 0.016], [-0.15, s.h * 0.55, s.d * 0.33], 'black-metal', { shape: 'tube' }),
    I('Joystick ball', [0.045, 0.045, 0.045], [-0.15, s.h * 0.55 + 0.05, s.d * 0.33], 'plastic', { shape: 'sphere', color: '#d0021b' }),
    I('Button', [0.032, 0.02, 0.032], [0.02, s.h * 0.53, s.d * 0.33], 'plastic', { shape: 'cylinder', color: b, count: 3, step: [0.06, 0, 0] }),
    I('Screen', [s.w - 0.12, s.h * 0.24, 0.05], [0, s.h * 0.69, s.d * 0.04], 'black-laminate', { kit: 'screen', style: 'arcade', rot: [-0.25, 0, 0], accent: '#3a6bff' }),
    I('Marquee', [s.w - 0.06, s.h * 0.1, 0.04], [0, s.h * 0.9, s.d * 0.22], 'plastic', { shape: 'box', color: a }),
  ];
}

function booth(s: Size, _p: ParsedRequest, L: Look): Item[] {
  const felt = L.main ?? '#5a6b7a', fr = '#2a2a2a';
  return [
    I('Base', [s.w, 0.06, s.d], [0, 0.03, 0], 'plastic', { shape: 'box', color: fr }),
    I('Back wall', [s.w, s.h - 0.12, 0.05], [0, s.h / 2, -s.d / 2 + 0.025], 'wool', { shape: 'panel', color: felt }),
    I('Side wall', [0.05, s.h - 0.12, s.d - 0.05], [-s.w / 2 + 0.025, s.h / 2, 0.025], 'wool', { shape: 'panel', color: felt, mirror: 'x' }),
    I('Roof', [s.w, 0.06, s.d], [0, s.h - 0.03, 0], 'plastic', { shape: 'box', color: fr }),
    I('Glass door', [s.w - 0.1, s.h - 0.12, 0.02], [0, s.h / 2, s.d / 2 - 0.01], 'glass', { kit: 'doors', count: 1, style: 'glass', color: fr }),
    I('Desk shelf', [s.w - 0.1, 0.03, 0.35], [0, 1.05, -s.d / 2 + 0.225], 'oak', { shape: 'panel' }),
    I('Stool', [0.36, 0.6, 0.36], [0, 0.36, 0], 'wool', { shape: 'cylinder', color: L.accent ?? '#c4633f' }),
    I('Ceiling light', [0.3, 0.03, 0.3], [0, s.h - 0.075, 0], 'plastic', { shape: 'cylinder', color: '#fff3c4' }),
  ];
}

/** Kit items for the request at `size`, or null when the generic templates should handle it. */
export function kitRecipe(p: ParsedRequest, size: Size): Item[] | null {
  const k = p.kind;
  if (!k) return null;
  const L = lookOf(p);
  switch (k.id) {
    case 'desk': return desk(size, p, L);
    case 'standing-desk': return desk(size, p, L, true);
    case 'bed': return bed(size, p, L);
    case 'wall-bed': return [I('Wall bed', [size.w, size.h, size.d], [0, size.h / 2, 0], L.main ? 'white-laminate' : L.wood, { kit: 'wallbed', ...col(L), accent: L.accent ?? (L.main ? undefined : '#f4f2ee') })];
    case 'bunk-bed': return bunk(size, p, L);
    case 'crib': return crib(size, p, L);
    case 'hospital-bed': return hospital(size, p, L);
    case 'sofa': return sofa(size, p, L);
    case 'armchair': return sofa(size, p, L, true);
    case 'desk-chair': return officeChair(size, p, L, false);
    case 'gaming-chair': return officeChair(size, p, L, true);
    case 'dining-table': case 'table': case 'coffee-table': return table(size, p, L);
    case 'bookshelf': return bookshelf(size, p, L, false);
    case 'library-wall': return bookshelf(size, p, L, true);
    case 'tv-unit': case 'sideboard': case 'wardrobe': case 'dresser': case 'nightstand': case 'cabinet': return storage(size, p, L, k.id);
    case 'kitchen-island': return island(size, p, L);
    case 'bar-counter': return barCounter(size, p, L);
    case 'reception-desk': return reception(size, p, L);
    case 'grand-piano': return grandPiano(size, L);
    case 'piano': return (KIT_EXAMPLES.find((e) => /upright piano/.test(e.prompt))!.json.parts as Item[]).map((it) => ({ ...it }));
    case 'arcade': return arcade(size, L);
    case 'phone-booth': return booth(size, p, L);
  }
  return null;
}
