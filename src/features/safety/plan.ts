// Printable evacuation plan (A4 landscape SVG): rooms, exits, escape arrows, equipment, legend, assumptions.
import { bounds, centroid, itemCorners } from '../../core/geometry';
import type { FurnitureItem, SpaceModel, Vec2 } from '../../core/types';
import { isRug } from '../sim/grid';
import { describeDoors } from './field';
import type { SafetyReport, Suggestion } from './assess';

export interface PlanOptions { youAreHere?: Vec2; title?: string; exitOverrides?: Record<string, boolean> }

const W = 1123, H = 794, M = 32;
const GREEN = '#137333', RED = '#c5221f', INK = '#1f1f1f', MUTED = '#6b6b6b';
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n1 = (v: number) => (Math.round(v * 10) / 10).toString();

function wrap(text: string, max: number): string[] {
  const out: string[] = []; let line = '';
  for (const w of text.split(/\s+/)) {
    if ((line + ' ' + w).trim().length > max && line) { out.push(line); line = w; } else line = (line + ' ' + w).trim();
  }
  if (line) out.push(line);
  return out;
}

function symbol(kind: Suggestion['kind'], x: number, y: number, dir?: Vec2): string {
  const t = `translate(${n1(x)} ${n1(y)})`;
  switch (kind) {
    case 'extinguisher': return `<g transform="${t}"><rect x="-8" y="-8" width="16" height="16" rx="2" fill="${RED}"/><path d="M-2 -4h4v9h-4z M0 -4v-2h3" stroke="#fff" stroke-width="1.5" fill="none"/></g>`;
    case 'smoke-alarm': return `<g transform="${t}"><circle r="7" fill="#fff" stroke="${INK}" stroke-width="1.5"/><circle r="2.5" fill="${INK}"/></g>`;
    case 'heat-alarm': return `<g transform="${t}"><circle r="7" fill="#fff" stroke="${INK}" stroke-width="1.5"/><text y="3.5" font-size="9" text-anchor="middle" fill="${INK}" font-weight="700">H</text></g>`;
    case 'first-aid': return `<g transform="${t}"><rect x="-8" y="-8" width="16" height="16" rx="2" fill="${GREEN}"/><path d="M0 -5v10M-5 0h10" stroke="#fff" stroke-width="3"/></g>`;
    case 'assembly': return `<g transform="${t}"><rect x="-10" y="-10" width="20" height="20" rx="2" fill="${GREEN}"/><path d="M-5 5l5-10 5 10M-3 1h6" stroke="#fff" stroke-width="1.8" fill="none"/></g>`;
    case 'exit-sign':
    case 'direction-sign': {
      const a = dir ? (Math.atan2(dir.y, dir.x) * 180) / Math.PI : 0;
      return `<g transform="${t}"><rect x="-9" y="-6" width="18" height="12" rx="1.5" fill="${GREEN}"/><path d="M-5 0h8M0 -3.5l3.5 3.5-3.5 3.5" stroke="#fff" stroke-width="1.6" fill="none" transform="rotate(${n1(a)})"/></g>`;
    }
  }
}

const LEGEND: Array<[Suggestion['kind'] | 'route' | 'exit' | 'here', string]> = [
  ['route', 'Escape route'], ['exit', 'Exit'], ['exit-sign', 'Exit sign / arrow'], ['extinguisher', 'Fire extinguisher'],
  ['smoke-alarm', 'Smoke alarm'], ['heat-alarm', 'Heat alarm'], ['first-aid', 'First-aid kit'], ['assembly', 'Assembly point'], ['here', 'You are here'],
];

export function evacuationPlanSvg(model: SpaceModel, furniture: FurnitureItem[], report: SafetyReport, opts: PlanOptions = {}): string {
  const doors = describeDoors(model, opts.exitOverrides ?? Object.fromEntries(report.doors.filter((d) => !d.auto).map((d) => [d.id, d.exit])));
  const extra = report.suggestions.filter((s) => s.kind === 'assembly').map((s) => s.at);
  const all = [...model.spaces.flatMap((s) => s.polygon), ...extra, ...(opts.youAreHere ? [opts.youAreHere] : [])];
  const b = bounds(all.length ? all : [{ x: 0, y: 0 }, { x: 1, y: 1 }]);
  const px0 = M, py0 = 96, pw = 760, ph = H - py0 - M - 30;
  const s = Math.min(pw / Math.max(1, b.w + 1), ph / Math.max(1, b.h + 1));
  const ox = px0 + (pw - b.w * s) / 2, oy = py0 + (ph - b.h * s) / 2;
  const T = (p: Vec2) => ({ x: ox + (p.x - b.minX) * s, y: oy + (p.y - b.minY) * s });
  const P = (pts: Vec2[]) => pts.map((p) => { const q = T(p); return `${n1(q.x)},${n1(q.y)}`; }).join(' ');
  const parts: string[] = [];

  parts.push(`<rect width="${W}" height="${H}" fill="#fff"/>`);
  parts.push(`<text x="${M}" y="48" font-size="26" font-weight="700" fill="${INK}">${esc(opts.title ?? 'Evacuation plan')}</text>`);
  parts.push(`<text x="${M}" y="72" font-size="13" fill="${MUTED}">${esc(model.name)} · In a fire: leave by the nearest exit, close doors behind you, do not use lifts, meet at the assembly point.</text>`);

  // rooms and furniture
  for (const sp of model.spaces) parts.push(`<polygon points="${P(sp.polygon)}" fill="#fafafa" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>`);
  for (const f of furniture) if (!isRug(f)) parts.push(`<polygon points="${P(itemCorners(f))}" fill="#eee" stroke="#bdbdbd" stroke-width="1"/>`);
  for (const sp of model.spaces) { const c = T(centroid(sp.polygon)); parts.push(`<text x="${n1(c.x)}" y="${n1(c.y)}" font-size="13" fill="${MUTED}" text-anchor="middle">${esc(sp.name)}</text>`); }

  // doors: gap in the wall; exits in green with a label outside
  for (const d of doors) {
    const a = T(d.a), c2 = T(d.b);
    parts.push(`<line x1="${n1(a.x)}" y1="${n1(a.y)}" x2="${n1(c2.x)}" y2="${n1(c2.y)}" stroke="${d.exit ? GREEN : '#fafafa'}" stroke-width="${d.exit ? 6 : 5}"/>`);
    if (d.exit) {
      const o = T({ x: d.c.x + d.outward.x * 0.6, y: d.c.y + d.outward.y * 0.6 });
      parts.push(`<text x="${n1(o.x)}" y="${n1(o.y + 4)}" font-size="13" font-weight="700" fill="${GREEN}" text-anchor="middle">EXIT</text>`);
    }
  }

  // escape routes with arrowheads
  parts.push(`<defs><marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${GREEN}"/></marker></defs>`);
  for (const e of report.egress) {
    if (e.pathPoints.length < 2) continue;
    parts.push(`<polyline points="${P(e.pathPoints)}" fill="none" stroke="${GREEN}" stroke-width="3" stroke-dasharray="10 5" stroke-linecap="round" marker-end="url(#arr)" marker-mid="url(#arr)"/>`);
  }

  for (const sg of report.suggestions) { const q = T(sg.at); parts.push(symbol(sg.kind, q.x, q.y, sg.dir)); }
  if (opts.youAreHere) {
    const q = T(opts.youAreHere);
    parts.push(`<g><circle cx="${n1(q.x)}" cy="${n1(q.y)}" r="8" fill="${RED}" stroke="#fff" stroke-width="2"/><text x="${n1(q.x + 12)}" y="${n1(q.y + 5)}" font-size="14" font-weight="700" fill="${RED}">You are here</text></g>`);
  }

  // scale bar
  const unit = b.w > 20 ? 5 : 1, sx = px0, sy = H - M;
  parts.push(`<g><line x1="${sx}" y1="${sy}" x2="${n1(sx + unit * s)}" y2="${sy}" stroke="${INK}" stroke-width="2"/><text x="${n1(sx + unit * s + 6)}" y="${sy + 4}" font-size="11" fill="${MUTED}">${unit} m</text></g>`);

  // legend
  const lx = 830, colW = W - M - lx;
  let ly = 104;
  parts.push(`<text x="${lx}" y="${ly}" font-size="14" font-weight="700" fill="${INK}">Legend</text>`); ly += 22;
  for (const [k, text] of LEGEND) {
    if (k === 'here' && !opts.youAreHere) continue;
    if (k === 'route') parts.push(`<line x1="${lx}" y1="${ly}" x2="${lx + 20}" y2="${ly}" stroke="${GREEN}" stroke-width="3" stroke-dasharray="6 3" marker-end="url(#arr)"/>`);
    else if (k === 'exit') parts.push(`<line x1="${lx}" y1="${ly}" x2="${lx + 20}" y2="${ly}" stroke="${GREEN}" stroke-width="6"/>`);
    else if (k === 'here') parts.push(`<circle cx="${lx + 10}" cy="${ly}" r="7" fill="${RED}"/>`);
    else parts.push(symbol(k, lx + 10, ly, { x: 1, y: 0 }));
    parts.push(`<text x="${lx + 30}" y="${ly + 4}" font-size="12" fill="${INK}">${esc(text)}</text>`);
    ly += 22;
  }

  // assumptions box
  ly += 10;
  const ev = report.evacuation, c = report.config;
  const lines: string[] = [
    `About ${report.occupancy.total} people (${report.occupancy.overridden ? 'your number' : 'estimated from seats and floor area'}).`,
    ev ? `Everyone out in about ${Math.round(ev.timeToClearS)} s at ${c.walkSpeedMS} m/s${report.evacuationSlowS != null ? `, ${Math.round(report.evacuationSlowS)} s at ${c.slowSpeedMS} m/s` : ''}.` : 'No evacuation estimate: no exit found.',
    `Routes kept ${Math.round(c.routeWidthM * 100)} cm wide (${Math.round(c.doorWidthM * 100)} cm at doors); longest walk guide ${c.maxTravelM} m.`,
    `Door flow ${c.doorFlowPerMS} people per second per metre of width.`,
    `Not assessed: ${report.notAssessed.join('; ').toLowerCase()}.`,
    'A planning aid from a measured floor plan, not a certified evacuation plan. Check with your local fire authority.',
  ];
  const wrapped = lines.flatMap((l) => wrap(l, 40).map((t, i) => ({ t, first: i === 0 })));
  const boxH = 30 + wrapped.length * 15 + lines.length * 3;
  parts.push(`<rect x="${lx - 10}" y="${ly}" width="${colW + 10}" height="${boxH}" fill="none" stroke="#bdbdbd"/>`);
  parts.push(`<text x="${lx}" y="${ly + 20}" font-size="13" font-weight="700" fill="${INK}">Assumptions</text>`);
  let ty = ly + 38;
  for (const w of wrapped) { if (w.first) ty += 3; parts.push(`<text x="${lx}" y="${ty}" font-size="11" fill="${INK}">${esc(w.t)}</text>`); ty += 15; }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="297mm" height="210mm" viewBox="0 0 ${W} ${H}" font-family="Helvetica, Arial, sans-serif">${parts.join('')}</svg>`;
}
