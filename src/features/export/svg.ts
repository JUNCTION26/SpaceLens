import type { FurnitureItem, SpaceModel, Vec2 } from '../../core/types';
import { area, bounds, centroid, itemCorners, openingSegment, wallInwardNormal, wallLength, wallSegment } from '../../core/geometry';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** Walls whose status is not verified, as "Room wall N (status)". */
export function uncertainWalls(model: SpaceModel): string[] {
  const out: string[] = [];
  for (const s of model.spaces) s.walls.forEach((w, i) => { if (w.status !== 'verified') out.push(`${s.name} wall ${i + 1} (${w.status})`); });
  return out;
}

export interface PlanOptions { furniture?: boolean; dimensions?: boolean; titleBlock?: boolean }

export function planToSvg(model: SpaceModel, furniture: FurnitureItem[], date = new Date(), opts: PlanOptions = {}): string {
  const showF = opts.furniture !== false, showD = opts.dimensions !== false, showT = opts.titleBlock !== false;
  if (!showF) furniture = [];
  const S = 100; // px per metre
  const pts = model.spaces.flatMap((s) => s.polygon);
  const b = pts.length ? bounds(pts) : { minX: 0, minY: 0, maxX: 4, maxY: 4 };
  const pad = 0.9;
  const ox = b.minX - pad, oy = b.minY - pad;
  const W = Math.max(700, (b.maxX - b.minX + pad * 2) * S);
  const planH = (b.maxY - b.minY + pad * 2) * S;
  const blockH = showT ? 120 : 0;
  const H = planH + blockH;
  const X = (p: Vec2) => ((p.x - ox) * S).toFixed(1);
  const Y = (p: Vec2) => ((p.y - oy) * S).toFixed(1);
  const P = (p: Vec2) => `${X(p)},${Y(p)}`;
  const o: string[] = [];
  o.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W.toFixed(0)} ${H.toFixed(0)}" width="${W.toFixed(0)}" height="${H.toFixed(0)}" font-family="Helvetica, Arial, sans-serif">`);
  o.push(`<rect width="100%" height="100%" fill="#fff"/>`);
  for (const s of model.spaces) {
    o.push(`<polygon points="${s.polygon.map(P).join(' ')}" fill="#f7f5f0"/>`);
    s.walls.forEach((w, i) => {
      const [a, c] = wallSegment(s, i);
      const n = wallInwardNormal(s, i);
      const th = Math.max(w.thicknessM, 0.05);
      const sh = (p: Vec2, k: number) => ({ x: p.x - n.x * k, y: p.y - n.y * k });
      const ok = w.status === 'verified';
      o.push(`<line x1="${X(sh(a, th / 2))}" y1="${Y(sh(a, th / 2))}" x2="${X(sh(c, th / 2))}" y2="${Y(sh(c, th / 2))}" stroke="${ok ? '#1a1a1a' : '#8a8a8a'}" stroke-width="${(th * S).toFixed(1)}" stroke-linecap="square"${ok ? '' : ' stroke-dasharray="10 4"'}/>`);
      if (!showD) return;
      const off = th + 0.35;
      const da = sh(a, off), dc = sh(c, off);
      const m = sh({ x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 }, off + 0.12);
      let ang = (Math.atan2(c.y - a.y, c.x - a.x) * 180) / Math.PI;
      if (ang > 90) ang -= 180;
      if (ang < -90) ang += 180;
      const label = `${Math.round(wallLength(s, i) * 100)}${ok ? '' : '?'}`;
      o.push(`<g stroke="#666" stroke-width="0.6"><line x1="${X(da)}" y1="${Y(da)}" x2="${X(dc)}" y2="${Y(dc)}"/><line x1="${X(sh(a, th))}" y1="${Y(sh(a, th))}" x2="${X(da)}" y2="${Y(da)}" stroke-dasharray="2 3"/><line x1="${X(sh(c, th))}" y1="${Y(sh(c, th))}" x2="${X(dc)}" y2="${Y(dc)}" stroke-dasharray="2 3"/></g>`);
      o.push(`<text x="${X(m)}" y="${Y(m)}" font-size="12" text-anchor="middle" dominant-baseline="middle" fill="${ok ? '#222' : '#b4581f'}" paint-order="stroke" stroke="#fff" stroke-width="3" transform="rotate(${ang.toFixed(1)} ${X(m)} ${Y(m)})">${label}</text>`);
    });
  }
  for (const op of model.openings) {
    const s = model.spaces.find((x) => x.id === op.spaceId);
    if (!s) continue;
    const { a, b: e, inward, dir } = openingSegment(s, op);
    const t = (s.walls[op.wallIndex]?.thicknessM ?? 0.1) + 0.01;
    const out = (p: Vec2, k: number) => ({ x: p.x - inward.x * t * k, y: p.y - inward.y * t * k });
    o.push(`<polygon points="${[out(a, -0.05), out(e, -0.05), out(e, 1.05), out(a, 1.05)].map(P).join(' ')}" fill="#fff"/>`);
    if (op.kind === 'window') {
      for (const k of [0, 0.5, 1]) o.push(`<line x1="${X(out(a, k))}" y1="${Y(out(a, k))}" x2="${X(out(e, k))}" y2="${Y(out(e, k))}" stroke="#2a7ab8" stroke-width="2"/>`);
    } else if (op.kind === 'door' && op.swing !== 'none') {
      const n = op.swing === 'in' ? inward : { x: -inward.x, y: -inward.y };
      const hinge = op.hinge === 'start' ? a : e;
      const free = op.hinge === 'start' ? e : a;
      const tip = { x: hinge.x + n.x * op.widthM, y: hinge.y + n.y * op.widthM };
      // Arc from free end to tip around hinge; sweep direction from the sign of the turn.
      const v1 = { x: free.x - hinge.x, y: free.y - hinge.y };
      const sweep = v1.x * n.y - v1.y * n.x > 0 ? 1 : 0;
      void dir;
      const r = (op.widthM * S).toFixed(1);
      o.push(`<line x1="${X(hinge)}" y1="${Y(hinge)}" x2="${X(tip)}" y2="${Y(tip)}" stroke="#222" stroke-width="2"/>`);
      o.push(`<path d="M ${P(free)} A ${r} ${r} 0 0 ${sweep} ${P(tip)}" fill="none" stroke="#222" stroke-width="1" stroke-dasharray="4 3"/>`);
    }
  }
  for (const f of furniture) {
    o.push(`<polygon points="${itemCorners(f).map(P).join(' ')}" fill="${esc(f.color || '#ccc')}" fill-opacity="0.35" stroke="#333" stroke-width="0.8"/>`);
    const fs = Math.max(9, Math.min(13, (Math.min(f.w, f.d) * S) / 4));
    o.push(`<text x="${X(f)}" y="${Y(f)}" font-size="${fs.toFixed(0)}" text-anchor="middle" dominant-baseline="middle" fill="#111">${esc(f.name)}</text>`);
  }
  for (const s of model.spaces) {
    const ctr = centroid(s.polygon);
    o.push(`<text x="${X(ctr)}" y="${Y(ctr)}" font-size="15" font-weight="600" letter-spacing="0.5" text-anchor="middle" fill="#777">${esc(s.name)}</text>`);
    o.push(`<text x="${X(ctr)}" y="${(+Y(ctr) + 18).toFixed(1)}" font-size="13" text-anchor="middle" fill="#888">${area(s.polygon).toFixed(1)} m²</text>`);
  }
  // Title block: scale bar, project info, legend for estimated walls.
  if (showT) {
    const ty = planH;
    const bw = W - 20;
    o.push(`<rect x="10" y="${ty + 4}" width="${bw.toFixed(0)}" height="${blockH - 14}" fill="none" stroke="#1a1a1a" stroke-width="1.5"/>`);
    o.push(`<line x1="${24 + S + 16}" y1="${ty + 4}" x2="${24 + S + 16}" y2="${ty + blockH - 10}" stroke="#1a1a1a" stroke-width="0.6"/>`);
    o.push(`<g><rect x="24" y="${ty + 24}" width="${S / 2}" height="6" fill="#222"/><rect x="${24 + S / 2}" y="${ty + 24}" width="${S / 2}" height="6" fill="#fff" stroke="#222"/><text x="24" y="${ty + 46}" font-size="10">0</text><text x="${24 + S}" y="${ty + 46}" font-size="10" text-anchor="middle">1 m</text></g>`);
    const tx = 24 + S + 30;
    const uw = uncertainWalls(model);
    o.push(`<text x="${tx}" y="${ty + 30}" font-size="16" font-weight="700">${esc(model.name)}</text>`);
    o.push(`<text x="${tx}" y="${ty + 48}" font-size="10.5" fill="#333">${date.toISOString().slice(0, 10)} · Version ${model.version} · Dimensions in cm · Source: ${esc(model.sourceLabel || 'unknown')}</text>`);
    o.push(`<text x="${tx}" y="${ty + 66}" font-size="10.5" fill="#333">${uw.length ? `Not verified: ${esc(uw.join(', '))}` : 'All walls verified'}</text>`);
    const ly = ty + 88;
    o.push(`<g font-size="10" fill="#444"><line x1="${tx}" y1="${ly}" x2="${tx + 26}" y2="${ly}" stroke="#1a1a1a" stroke-width="6"/><text x="${tx + 32}" y="${ly + 3.5}">Verified wall</text><line x1="${tx + 120}" y1="${ly}" x2="${tx + 146}" y2="${ly}" stroke="#8a8a8a" stroke-width="6" stroke-dasharray="10 4"/><text x="${tx + 152}" y="${ly + 3.5}">Estimated wall, value marked ?</text></g>`);
    o.push(`<text x="${tx}" y="${ty + 104}" font-size="9.5" fill="#777">Check values marked ? before building.</text>`);
  }
  o.push('</svg>');
  return o.join('\n');
}
