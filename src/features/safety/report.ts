// One-page fire and accessibility report: typed structure plus a self-contained printable HTML page.
import type { SpaceModel, Vec2 } from '../../core/types';
import type { SafetyFinding, SafetyKey, SafetyReport as Assessment } from './assess';
import { SAFETY_DEFAULTS } from './assess';
import { GENERIC_PACK, type RulePack, type RuleSource } from '../jurisdiction/rulepacks';

export interface ReportCheck {
  id: string;
  title: string;
  area: 'fire' | 'access';
  measured: number | null;
  required: number;
  unit: string;
  /** 'min' means measured must be at least required; 'max' at most. */
  sense: 'min' | 'max';
  pass: boolean;
  source: RuleSource;
  confidence: string;
}

export interface ReportFinding {
  number: number;
  id: string;
  severity: SafetyFinding['severity'];
  area: 'fire' | 'access';
  title: string;
  message: string;
  fix: string | null;
  at: Vec2;
  route: Vec2[] | null;
}

export interface BuiltReport {
  title: string;
  date: string;
  ruleSet: string;
  checks: ReportCheck[];
  findings: ReportFinding[];
  routes: Array<{ room: string; points: Vec2[]; lengthM: number | null }>;
  exits: Array<{ label: string; at: Vec2 }>;
  occupancy: number;
  headline: string;
  model: SpaceModel;
  disclaimer: string;
}

export const DISCLAIMER = 'Planning guidance only. This is not a compliance certificate and does not replace an inspection by the authority or a qualified fire or accessibility specialist.';

const FALLBACK: RuleSource = { doc: 'SpaceLens planning defaults', section: 'planning rule of thumb', url: '', readOn: '' };

function ruleFor(pack: RulePack, key: SafetyKey) {
  return pack.rules.find((r) => r.key === key) ?? GENERIC_PACK.rules.find((r) => r.key === key);
}

const round = (v: number) => Math.round(v * 100) / 100;

export function buildSafetyReport(model: SpaceModel, a: Assessment, pack: RulePack, now: Date = new Date()): BuiltReport {
  const checks: ReportCheck[] = [];
  const add = (id: string, title: string, area: 'fire' | 'access', key: SafetyKey, measured: number | null, sense: 'min' | 'max', failed: boolean) => {
    const rule = ruleFor(pack, key);
    const required = rule?.value ?? a.config[key] ?? SAFETY_DEFAULTS[key];
    const ok = measured === null ? true : sense === 'min' ? measured >= required - 1e-9 : measured <= required + 1e-9;
    checks.push({
      id, title, area, measured, required, unit: rule?.unit ?? 'm', sense, pass: ok && !failed,
      source: rule?.source ?? FALLBACK, confidence: rule?.confidence ?? 'rule-of-thumb',
    });
  };
  const has = (...kinds: string[]) => a.findings.some((f) => kinds.includes(f.kind));
  const lens = a.egress.map((e) => e.lengthM).filter((v): v is number => v !== null);
  const widths = a.egress.map((e) => e.narrowestM).filter((v): v is number => v !== null);

  add('travel', 'Longest walk to an exit', 'fire', 'maxTravelM', lens.length ? round(Math.max(...lens)) : null, 'max', has('travel', 'no-exit', 'trapped'));
  add('route-width', 'Narrowest escape route', 'fire', 'routeWidthM', widths.length ? round(Math.min(...widths)) : null, 'min', has('route-width'));
  add('exit-door', 'Narrowest exit door', 'fire', 'doorWidthM', a.exits.length ? round(Math.min(...a.exits.map((e) => e.widthM))) : null, 'min', has('no-exit'));
  add('exits', 'Second exit when occupancy is high', 'fire', 'twoExitsOccupancy', a.occupancy.total, 'max', has('two-exits'));
  add('swing', 'Inward-opening exit doors, occupancy limit', 'fire', 'inwardSwingMaxOccupants', a.occupancy.total, 'max', has('exit-swing'));
  add('dead-end', 'Dead-end aisle', 'fire', 'deadEndM', null, 'max', has('dead-end'));
  add('wc-door', 'Narrowest door on accessible route', 'access', 'wheelchairDoorM', a.doors.length ? round(Math.min(...a.doors.map((d) => d.widthM))) : null, 'min', has('wc-door'));
  add('wc-route', 'Narrowest accessible route', 'access', 'wheelchairRouteM', null, 'min', has('wc-route'));
  add('wc-turn', 'Wheelchair turning circle', 'access', 'turningM', null, 'min', has('wc-turn'));
  for (const c of checks) {
    if (c.id !== 'wc-route' && c.id !== 'wc-turn') continue;
    const f = a.findings.find((x) => x.kind === c.id && x.measureM !== undefined);
    if (f) c.measured = round(f.measureM!);
  }
  const extra: Array<[string, string, 'fire' | 'access', SafetyKey]> = [
    ['single-direction', 'Walk with only one way out', 'fire', 'singleDirectionM'],
    ['exit-clearance', 'Clear zone at exit doors', 'fire', 'exitClearM'],
    ['pinch', 'Crowd pinch point', 'fire', 'pinchWidthM'],
    ['door-blocked', 'Door can be opened fully', 'fire', 'doorWidthM'],
    ['door-swing', 'Door swing is clear', 'fire', 'doorWidthM'],
    ['wc-reach', 'Space beside furniture', 'access', 'besideM'],
    ['wc-dead-end', 'Reversing distance', 'access', 'wheelchairDeadEndM'],
  ];
  for (const [kind, title, area, key] of extra) {
    if (has(kind)) add(kind, title, area, key, null, 'min', true);
  }

  const findings: ReportFinding[] = a.findings.map((f, i) => ({
    number: i + 1, id: f.id, severity: f.severity, area: f.area, title: f.title, message: f.message,
    fix: f.fix ? f.fix.label : null, at: f.at, route: f.route ?? null,
  }));
  return {
    title: model.name || 'Untitled space',
    date: now.toISOString().slice(0, 10),
    ruleSet: pack.name,
    checks,
    findings,
    routes: a.egress.filter((e) => e.pathPoints.length >= 2).map((e) => ({ room: e.name, points: e.pathPoints, lengthM: e.lengthM })),
    exits: a.exits.map((e) => ({ label: e.label, at: e.at })),
    occupancy: a.occupancy.total,
    headline: a.headline,
    model,
    disclaimer: DISCLAIMER,
  };
}

const ENT: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ENT[c]);
}

const f2 = (n: number) => String(Math.round(n * 100) / 100);

export function planSvg(r: BuiltReport): string {
  const pts: Vec2[] = r.model.spaces.flatMap((s) => s.polygon);
  if (!pts.length) return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" role="img" aria-label="Empty plan"></svg>';
  const pad = 0.6;
  const x0 = Math.min(...pts.map((p) => p.x)) - pad;
  const y0 = Math.min(...pts.map((p) => p.y)) - pad;
  const w = Math.max(...pts.map((p) => p.x)) - x0 + pad;
  const h = Math.max(...pts.map((p) => p.y)) - y0 + pad;
  const P = (p: Vec2) => `${f2(p.x)},${f2(p.y)}`;
  const rad = Math.max(w, h) / 40;
  const out: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f2(x0)} ${f2(y0)} ${f2(w)} ${f2(h)}" role="img" aria-label="Plan with escape routes and numbered findings">`];
  for (const s of r.model.spaces) out.push(`<polygon points="${s.polygon.map(P).join(' ')}" fill="#f4f4f4" stroke="#333" stroke-width="${f2(rad / 3)}"><title>${esc(s.name)}</title></polygon>`);
  for (const rt of r.routes) out.push(`<path class="route" d="M${rt.points.map(P).join(' L')}" fill="none" stroke="#1a7f37" stroke-width="${f2(rad / 2)}" stroke-linejoin="round"><title>${esc(rt.room)}</title></path>`);
  for (const e of r.exits) out.push(`<rect x="${f2(e.at.x - rad)}" y="${f2(e.at.y - rad)}" width="${f2(rad * 2)}" height="${f2(rad * 2)}" fill="#1a7f37"><title>${esc(e.label)}</title></rect>`);
  for (const f of r.findings) {
    if (f.route && f.route.length >= 2) out.push(`<polyline class="frt" points="${f.route.map(P).join(' ')}" fill="none" stroke="#c0392b" stroke-width="${f2(rad / 3)}" stroke-dasharray="${f2(rad / 2)}"/>`);
  }
  for (const f of r.findings) {
    out.push(`<circle cx="${f2(f.at.x)}" cy="${f2(f.at.y)}" r="${f2(rad * 1.3)}" fill="#c0392b"/><text x="${f2(f.at.x)}" y="${f2(f.at.y + rad * 0.5)}" font-size="${f2(rad * 1.5)}" text-anchor="middle" fill="#fff" font-family="Arial,sans-serif" font-weight="700">${f.number}</text>`);
  }
  out.push('</svg>');
  return out.join('');
}

const CSS = '@page{size:A4;margin:12mm}*{box-sizing:border-box}body{font:11px/1.35 Arial,Helvetica,sans-serif;color:#111;margin:0;padding:12mm;max-width:210mm}'
  + 'h1{font-size:20px;margin:0 0 2px}h2{font-size:13px;margin:12px 0 4px;border-bottom:1px solid #999}.meta{color:#444;margin-bottom:8px}'
  + '.plan svg{width:100%;max-height:80mm}table{width:100%;border-collapse:collapse}th,td{border:1px solid #bbb;padding:3px 5px;text-align:left;vertical-align:top}'
  + 'th{background:#eee}.pass{color:#1a7f37;font-weight:700}.fail{color:#c0392b;font-weight:700}.src{color:#444;font-size:10px}ol{margin:4px 0;padding-left:18px}li{margin-bottom:3px}'
  + 'footer{margin-top:12px;padding-top:6px;border-top:2px solid #111;font-weight:700}tr,li{break-inside:avoid}';

export function reportHtml(r: BuiltReport): string {
  const rows = r.checks.map((c) => {
    const unit = c.unit === 'people' ? ' people' : ` ${esc(c.unit)}`;
    const meas = c.measured === null ? (c.pass ? 'no issue found' : 'see findings') : `${f2(c.measured)}${unit}`;
    const src = `${esc(c.source.doc)}, ${esc(c.source.section)}${c.source.url ? ` <span class="src">(${esc(c.source.url)})</span>` : ''}`;
    return `<tr><td>${esc(c.title)}</td><td>${meas}</td><td>${c.sense === 'min' ? 'at least' : 'at most'} ${f2(c.required)}${unit}</td><td class="${c.pass ? 'pass' : 'fail'}">${c.pass ? 'PASS' : 'FAIL'}</td><td>${src}<br><span class="src">${esc(c.confidence)}</span></td></tr>`;
  }).join('');
  const finds = r.findings.length
    ? `<ol>${r.findings.map((f) => `<li value="${f.number}"><b>${esc(f.title)}</b> (${esc(f.severity)}, ${esc(f.area)}). ${esc(f.message)}<br>Suggested fix: ${f.fix ? esc(f.fix) : 'none suggested'}</li>`).join('')}</ol>`
    : '<p>No findings.</p>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(r.title)} safety report</title><style>${CSS}</style></head><body>
<h1>Fire and accessibility report: ${esc(r.title)}</h1>
<div class="meta">Date ${esc(r.date)} &middot; Rule set: ${esc(r.ruleSet)} &middot; Estimated occupancy ${esc(r.occupancy)} &middot; ${esc(r.headline)}</div>
<div class="plan">${planSvg(r)}</div>
<h2>Checks</h2><table><thead><tr><th>Check</th><th>Measured</th><th>Required</th><th>Result</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table>
<h2>Findings and suggested fixes</h2>${finds}
<footer>${esc(r.disclaimer)}</footer></body></html>`;
}
