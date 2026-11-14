// Plan drawing as an SVG string: used for option thumbnails and for checking plans by eye.
import type { BuildingPlan } from './partition';

const ZONE: Record<string, string> = {
  public: '#f3e3c3',
  private: '#d9e6f2',
  service: '#dfe9dc',
  hall: '#ececec',
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface SvgOpts { px?: number; labels?: boolean; pad?: number; title?: boolean }

export function planSvg(plan: BuildingPlan, o: SvgOpts = {}): string {
  const xs = plan.shell.map((p) => p.x), ys = plan.shell.map((p) => p.y);
  const minX = Math.min(...xs), minY = Math.min(...ys), W = Math.max(...xs) - minX, H = Math.max(...ys) - minY;
  const pad = o.pad ?? 0.8;
  const px = o.px ?? 40;
  const labels = o.labels ?? true;
  const title = o.title ?? false;
  const th = title ? 1.6 : 0;
  const vb = `${minX - pad} ${minY - pad - th} ${W + pad * 2} ${H + pad * 2 + th}`;
  const pts = (ps: Array<{ x: number; y: number }>) => ps.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`).join(' ');
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${((W + pad * 2) * px).toFixed(0)}" height="${((H + pad * 2 + th) * px).toFixed(0)}" font-family="system-ui, sans-serif">`);
  out.push(`<rect x="${minX - pad}" y="${minY - pad - th}" width="${W + pad * 2}" height="${H + pad * 2 + th}" fill="#fff"/>`);
  if (title) out.push(`<text x="${minX}" y="${minY - pad - th + 0.7}" font-size="0.55" font-weight="600" fill="#222">${esc(plan.name)} · ${plan.score}</text><text x="${minX}" y="${minY - pad - th + 1.35}" font-size="0.4" fill="#555">${esc(plan.summary)}</text>`);
  // outer wall: a stroke twice as thick as the wall, its inner half covered by the rooms
  out.push(`<polygon points="${pts(plan.shell)}" fill="#222" stroke="#222" stroke-width="${plan.exteriorWallM * 2}" stroke-linejoin="miter"/>`);
  for (const r of plan.rooms) {
    const fill = r.isHall ? ZONE.hall : ZONE[r.privacy] ?? '#eee';
    out.push(`<polygon points="${pts(r.polygon)}" fill="${fill}" stroke="#555" stroke-width="${plan.interiorWallM}" stroke-linejoin="miter"/>`);
  }
  for (const w of plan.windows) out.push(`<line x1="${w.a.x}" y1="${w.a.y}" x2="${w.b.x}" y2="${w.b.y}" stroke="#7fb4e6" stroke-width="${plan.exteriorWallM * 1.6}"/>`);
  for (const d of plan.doors) {
    const h = d.horizontal, half = d.widthM / 2;
    const a = h ? { x: d.at.x - half, y: d.at.y } : { x: d.at.x, y: d.at.y - half };
    const b = h ? { x: d.at.x + half, y: d.at.y } : { x: d.at.x, y: d.at.y + half };
    const sw = d.b === 'outside' ? plan.exteriorWallM * 2.2 : plan.interiorWallM * 2.2;
    out.push(`<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#fff" stroke-width="${sw}"/>`);
    if (d.kind === 'door') {
      // leaf into the room it serves
      const into = plan.rooms.find((r) => r.id === d.swingInto);
      let sx = 0, sy = 0;
      if (into) {
        const c = into.rects.find((q) => (h ? d.at.x >= q.x0 - 1e-3 && d.at.x <= q.x1 + 1e-3 && (Math.abs(q.y0 - d.at.y) < 1e-3 || Math.abs(q.y1 - d.at.y) < 1e-3) : d.at.y >= q.y0 - 1e-3 && d.at.y <= q.y1 + 1e-3 && (Math.abs(q.x0 - d.at.x) < 1e-3 || Math.abs(q.x1 - d.at.x) < 1e-3)));
        if (c) { if (h) sy = Math.abs(c.y0 - d.at.y) < 1e-3 ? 1 : -1; else sx = Math.abs(c.x0 - d.at.x) < 1e-3 ? 1 : -1; }
      }
      const tip = { x: a.x + sx * d.widthM, y: a.y + sy * d.widthM };
      out.push(`<line x1="${a.x}" y1="${a.y}" x2="${tip.x}" y2="${tip.y}" stroke="#333" stroke-width="0.04"/>`);
      out.push(`<path d="M ${tip.x} ${tip.y} A ${d.widthM} ${d.widthM} 0 0 ${(h ? sy > 0 : sx < 0) ? 0 : 1} ${b.x} ${b.y}" fill="none" stroke="#999" stroke-width="0.025"/>`);
    }
  }
  if (labels) {
    for (const r of plan.rooms) {
      const m = r.rects.reduce((p, q) => ((q.x1 - q.x0) * (q.y1 - q.y0) > (p.x1 - p.x0) * (p.y1 - p.y0) ? q : p), r.rects[0]);
      if (!m) continue;
      const cx = (m.x0 + m.x1) / 2, cy = (m.y0 + m.y1) / 2;
      const w = m.x1 - m.x0, hh = m.y1 - m.y0;
      const fs = Math.max(0.22, Math.min(0.42, Math.min(w, hh) / 5));
      const vertical = hh > w * 1.6 && w < 2.2;
      const tf = vertical ? ` transform="rotate(-90 ${cx} ${cy})"` : '';
      out.push(`<text x="${cx}" y="${cy}" font-size="${fs}" text-anchor="middle" fill="#222"${tf}>${esc(r.name)}<tspan x="${cx}" dy="${fs * 1.2}" fill="#666" font-size="${fs * 0.85}">${r.areaM2.toFixed(1)} m²${r.isHall ? '' : ` · ${r.widthM.toFixed(1)} m`}</tspan></text>`);
    }
    // overall dimensions
    out.push(`<text x="${minX + W / 2}" y="${minY - pad * 0.45}" font-size="0.32" text-anchor="middle" fill="#444">${W.toFixed(2)} m</text>`);
    out.push(`<text x="${minX - pad * 0.45}" y="${minY + H / 2}" font-size="0.32" text-anchor="middle" fill="#444" transform="rotate(-90 ${minX - pad * 0.45} ${minY + H / 2})">${H.toFixed(2)} m</text>`);
  }
  out.push('</svg>');
  return out.join('');
}
