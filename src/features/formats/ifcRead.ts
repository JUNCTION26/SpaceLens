/**
 * IFC (STEP) reader: IfcSpace footprints, names and heights into a SpaceModel, all marked
 * estimated. Reads IfcExtrudedAreaSolid bodies whose profile is an IfcArbitraryClosedProfileDef
 * (IfcPolyline) or an IfcRectangleProfileDef, and applies the IfcLocalPlacement chain.
 * The file is untrusted data: nothing is evaluated, every lookup is bounds-checked.
 */
import type { Evidence, Space, SpaceModel, Vec2 } from '../../core/types';

type Arg = Arg[] | { ref: number } | number | string | null | { en: string };
interface Ent { name: string; raw: string }
type V3 = [number, number, number];
/** Column-major affine transform: x, y, z axes and origin. */
interface Tf { x: V3; y: V3; z: V3; o: V3 }

const ID: Tf = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1], o: [0, 0, 0] };
const KEEP = new Set([
  'IFCSPACE', 'IFCLOCALPLACEMENT', 'IFCAXIS2PLACEMENT3D', 'IFCAXIS2PLACEMENT2D', 'IFCCARTESIANPOINT', 'IFCDIRECTION',
  'IFCPRODUCTDEFINITIONSHAPE', 'IFCSHAPEREPRESENTATION', 'IFCEXTRUDEDAREASOLID', 'IFCARBITRARYCLOSEDPROFILEDEF',
  'IFCARBITRARYPROFILEDEFWITHVOIDS', 'IFCPOLYLINE', 'IFCRECTANGLEPROFILEDEF', 'IFCSIUNIT', 'IFCCONVERSIONBASEDUNIT',
  'IFCMEASUREWITHUNIT', 'IFCBUILDINGSTOREY',
]);
const MAX_ARGS_LEN = 200000;

/** Splits the DATA section into entities, keeping only the kinds this reader needs. */
function entities(text: string): { ents: Map<number, Ent>; header: string } {
  const ents = new Map<number, Ent>();
  const di = text.indexOf('DATA;');
  const header = di >= 0 ? text.slice(0, di) : '';
  let i = di >= 0 ? di + 5 : 0;
  const n = text.length;
  while (i < n) {
    while (i < n && text.charCodeAt(i) !== 35 /* # */) {
      if (text.startsWith('ENDSEC', i)) return { ents, header };
      i++;
    }
    if (i >= n) break;
    // find the end of the statement, skipping quoted strings
    let j = i, q = false;
    for (; j < n; j++) {
      const c = text.charCodeAt(j);
      if (c === 39) q = !q;
      else if (c === 59 && !q) break;
    }
    const stmt = text.slice(i, j);
    i = j + 1;
    const m = /^#(\d+)\s*=\s*([A-Za-z0-9_]+)\s*\(([\s\S]*)\)\s*$/.exec(stmt);
    if (!m) continue;
    const name = m[2].toUpperCase();
    if (KEEP.has(name) && m[3].length < MAX_ARGS_LEN) ents.set(Number(m[1]), { name, raw: m[3] });
  }
  return { ents, header };
}

/** Parses an argument list into nested arrays. Returns [] on malformed input. */
function args(raw: string): Arg[] {
  let p = 0;
  const n = raw.length;
  const val = (): Arg => {
    while (p < n && /\s/.test(raw[p])) p++;
    const c = raw[p];
    if (c === '(') {
      p++;
      const out: Arg[] = [];
      for (;;) {
        while (p < n && /\s/.test(raw[p])) p++;
        if (p >= n) return out;
        if (raw[p] === ')') { p++; return out; }
        if (raw[p] === ',') { p++; continue; }
        out.push(val());
      }
    }
    if (c === "'") {
      let s = '';
      p++;
      while (p < n) {
        if (raw[p] === "'") { if (raw[p + 1] === "'") { s += "'"; p += 2; continue; } p++; break; }
        s += raw[p++];
      }
      return s;
    }
    if (c === '#') { const m = /^#(\d+)/.exec(raw.slice(p, p + 14)); if (m) { p += m[0].length; return { ref: Number(m[1]) }; } }
    if (c === '.') { const e = raw.indexOf('.', p + 1); if (e > 0) { const en = raw.slice(p + 1, e); p = e + 1; return { en }; } }
    if (c === '$' || c === '*') { p++; return null; }
    const m = /^[-+0-9.eE]+/.exec(raw.slice(p, p + 40));
    if (m) { p += m[0].length; return parseFloat(m[0]); }
    // typed value such as IFCLABEL('x') or an unknown token: skip it
    const m2 = /^[A-Za-z0-9_]+/.exec(raw.slice(p, p + 80));
    p += m2 ? m2[0].length : 1;
    if (raw[p] === '(') return val();
    return null;
  };
  const out: Arg[] = [];
  while (p < n) {
    while (p < n && (raw[p] === ',' || /\s/.test(raw[p]))) p++;
    if (p >= n) break;
    out.push(val());
  }
  return out;
}

const isRef = (a: Arg | undefined): a is { ref: number } => !!a && typeof a === 'object' && !Array.isArray(a) && 'ref' in a;
const nums = (a: Arg | undefined): number[] => (Array.isArray(a) ? a.filter((x): x is number => typeof x === 'number') : []);

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 | null => { const l = Math.hypot(...a); return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : null; };
const apply = (t: Tf, p: V3): V3 => [
  t.o[0] + t.x[0] * p[0] + t.y[0] * p[1] + t.z[0] * p[2],
  t.o[1] + t.x[1] * p[0] + t.y[1] * p[1] + t.z[1] * p[2],
  t.o[2] + t.x[2] * p[0] + t.y[2] * p[1] + t.z[2] * p[2],
];
/** outer after inner: first inner, then outer. */
const compose = (outer: Tf, inner: Tf): Tf => ({
  x: apply({ ...outer, o: [0, 0, 0] }, inner.x), y: apply({ ...outer, o: [0, 0, 0] }, inner.y),
  z: apply({ ...outer, o: [0, 0, 0] }, inner.z), o: apply(outer, inner.o),
});

export interface IfcReport {
  spaces: number;
  converted: number;
  levels: number;
  unitM: number;
  schema: string;
  warnings: string[];
}
export interface IfcResult { model: SpaceModel; report: IfcReport }

const area2 = (p: Vec2[]) => p.reduce((s, a, i) => { const b = p[(i + 1) % p.length]; return s + (a.x * b.y - b.x * a.y); }, 0) / 2;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Builds a SpaceModel from IFC text. Never throws on odd input; problems become warnings. */
export function ifcToModel(text: string, name = 'model.ifc', opts: { now?: number } = {}): IfcResult {
  const now = opts.now ?? Date.now();
  const warnings: string[] = [];
  const base = name.replace(/\.ifc$/i, '');
  const { ents, header } = entities(text);
  const schema = /FILE_SCHEMA\s*\(\s*\(\s*'([^']*)'/i.exec(header)?.[1] ?? '';
  const ours = /'SpaceLens'/.test(header);

  // Length unit: metres unless the project says millimetres, centimetres, feet or inches.
  let unitM = 1;
  for (const e of ents.values()) {
    if (e.name === 'IFCSIUNIT') {
      const a = args(e.raw);
      if (a[1] && (a[1] as { en?: string }).en === 'LENGTHUNIT') {
        const pre = (a[2] as { en?: string } | null)?.en;
        unitM = pre === 'MILLI' ? 0.001 : pre === 'CENTI' ? 0.01 : pre === 'KILO' ? 1000 : 1;
      }
    } else if (e.name === 'IFCCONVERSIONBASEDUNIT') {
      const a = args(e.raw);
      if (a[1] && (a[1] as { en?: string }).en === 'LENGTHUNIT') {
        const nm = String(a[2] ?? '').toUpperCase();
        unitM = nm.includes('FOOT') || nm.includes('FEET') ? 0.3048 : nm.includes('INCH') ? 0.0254 : 1;
      }
    }
  }
  const lenUnit = unitM;

  const cache = new Map<number, Tf>();
  const point = (id: number): number[] => {
    const e = ents.get(id);
    return e && e.name === 'IFCCARTESIANPOINT' ? nums(args(e.raw)[0]) : [];
  };
  const dir = (a: Arg | undefined): V3 | null => {
    if (!isRef(a)) return null;
    const e = ents.get(a.ref);
    if (!e || e.name !== 'IFCDIRECTION') return null;
    const v = nums(args(e.raw)[0]);
    return unit([v[0] ?? 0, v[1] ?? 0, v[2] ?? 0]);
  };
  const axis3 = (id: number): Tf => {
    const e = ents.get(id);
    if (!e) return ID;
    if (e.name === 'IFCAXIS2PLACEMENT2D') {
      const a = args(e.raw);
      const o = isRef(a[0]) ? point(a[0].ref) : [];
      const rd = dir(a[1]);
      const x: V3 = rd ? [rd[0], rd[1], 0] : [1, 0, 0];
      return { x, y: [-x[1], x[0], 0], z: [0, 0, 1], o: [o[0] ?? 0, o[1] ?? 0, 0] };
    }
    if (e.name !== 'IFCAXIS2PLACEMENT3D') return ID;
    const a = args(e.raw);
    const o = isRef(a[0]) ? point(a[0].ref) : [];
    const z = dir(a[1]) ?? [0, 0, 1];
    let x = dir(a[2]) ?? (Math.abs(z[0]) < 0.9 ? [1, 0, 0] as V3 : [0, 1, 0] as V3);
    const k = dot(x, z);
    x = unit(sub(x, [z[0] * k, z[1] * k, z[2] * k])) ?? [1, 0, 0];
    return { x, y: cross(z, x), z, o: [o[0] ?? 0, o[1] ?? 0, o[2] ?? 0] };
  };
  const placement = (id: number, depth = 0): Tf => {
    const hit = cache.get(id);
    if (hit) return hit;
    const e = ents.get(id);
    if (!e || e.name !== 'IFCLOCALPLACEMENT' || depth > 64) return ID;
    const a = args(e.raw);
    const rel = isRef(a[0]) ? placement(a[0].ref, depth + 1) : ID;
    const own = isRef(a[1]) ? axis3(a[1].ref) : ID;
    const t = compose(rel, own);
    cache.set(id, t);
    return t;
  };

  /** Footprint of one extruded solid, in the solid's own frame (units not yet applied). */
  const profile = (id: number): Vec2[] | null => {
    const e = ents.get(id);
    if (!e) return null;
    const a = args(e.raw);
    if (e.name === 'IFCRECTANGLEPROFILEDEF') {
      const t = isRef(a[2]) ? axis3(a[2].ref) : ID;
      const w = Number(a[3]) / 2, d = Number(a[4]) / 2;
      if (!(w > 0) || !(d > 0)) return null;
      return [[-w, -d], [w, -d], [w, d], [-w, d]].map(([x, y]) => { const p = apply(t, [x, y, 0]); return { x: p[0], y: p[1] }; });
    }
    if (e.name === 'IFCARBITRARYCLOSEDPROFILEDEF' || e.name === 'IFCARBITRARYPROFILEDEFWITHVOIDS') {
      const c = isRef(a[2]) ? ents.get(a[2].ref) : undefined;
      if (!c || c.name !== 'IFCPOLYLINE') return null;
      const refs = (args(c.raw)[0] as Arg[] | undefined) ?? [];
      const pts: Vec2[] = [];
      for (const r of refs) if (isRef(r)) { const v = point(r.ref); if (v.length >= 2) pts.push({ x: v[0], y: v[1] }); }
      return pts;
    }
    return null;
  };

  const solidOf = (spaceArgs: Arg[]): { pts: Vec2[]; tf: Tf; depth: number } | null => {
    const pd = isRef(spaceArgs[6]) ? ents.get(spaceArgs[6].ref) : undefined;
    if (!pd || pd.name !== 'IFCPRODUCTDEFINITIONSHAPE') return null;
    const reps = args(pd.raw)[2];
    if (!Array.isArray(reps)) return null;
    for (const r of reps) {
      const re = isRef(r) ? ents.get(r.ref) : undefined;
      if (!re || re.name !== 'IFCSHAPEREPRESENTATION') continue;
      const items = args(re.raw)[3];
      if (!Array.isArray(items)) continue;
      for (const it of items) {
        const se = isRef(it) ? ents.get(it.ref) : undefined;
        if (!se || se.name !== 'IFCEXTRUDEDAREASOLID') continue;
        const a = args(se.raw);
        const pts = isRef(a[0]) ? profile(a[0].ref) : null;
        if (!pts || pts.length < 3) continue;
        const own = isRef(a[1]) ? axis3(a[1].ref) : ID;
        return { pts, tf: own, depth: Number(a[3]) };
      }
    }
    return null;
  };

  interface Found { name: string; longName: string; poly: Vec2[]; z: number; h: number }
  const found: Found[] = [];
  let total = 0;
  let noShape = 0;
  for (const e of ents.values()) {
    if (e.name !== 'IFCSPACE') continue;
    total++;
    const a = args(e.raw);
    const s = solidOf(a);
    if (!s) { noShape++; continue; }
    const world = isRef(a[5]) ? compose(placement(a[5].ref), s.tf) : s.tf;
    let z = 0;
    const poly = s.pts.map((p) => { const w = apply(world, [p.x, p.y, 0]); z = w[2]; return { x: w[0] * lenUnit, y: w[1] * lenUnit }; });
    const str = (v: Arg | undefined) => (typeof v === 'string' ? v : '');
    found.push({ name: str(a[2]), longName: str(a[7]), poly, z: z * lenUnit, h: Math.abs(s.depth) * lenUnit });
  }
  if (noShape) warnings.push(`${noShape} space(s) have no extruded footprint (other body types are not read).`);

  // One plan holds one level: keep the level with the most spaces.
  const byLevel = new Map<number, Found[]>();
  for (const f of found) { const k = Math.round(f.z * 10) / 10; byLevel.set(k, [...(byLevel.get(k) ?? []), f]); }
  const levels = byLevel.size;
  let pick: Found[] = [];
  for (const g of byLevel.values()) if (g.length > pick.length) pick = g;
  if (levels > 1) warnings.push(`The file has ${levels} levels; read the one with the most spaces (${pick.length}).`);

  // Foreign files are y-up when viewed from above; the plan is y-down, so flip. Files written by
  // SpaceLens already use plan axes.
  const flip = ours ? 1 : -1;
  const pts0 = pick.flatMap((f) => f.poly);
  const minX = pts0.length ? Math.min(...pts0.map((p) => p.x)) : 0;
  const minY = pts0.length ? Math.min(...pts0.map((p) => p.y * flip)) : 0;
  const spaces: Space[] = [];
  for (const f of pick) {
    let poly = f.poly.map((p) => ({ x: r3(p.x - minX), y: r3(p.y * flip - minY) }));
    poly = poly.filter((p, i) => { const q = poly[(i + poly.length - 1) % poly.length]; return Math.hypot(p.x - q.x, p.y - q.y) > 1e-4; });
    if (poly.length > 3 && Math.hypot(poly[0].x - poly[poly.length - 1].x, poly[0].y - poly[poly.length - 1].y) < 1e-4) poly.pop();
    if (poly.length < 3 || Math.abs(area2(poly)) < 0.2) continue;
    if (area2(poly) < 0) poly.reverse();
    const nm = f.longName || f.name || `Room ${spaces.length + 1}`;
    spaces.push({
      id: `room-${spaces.length + 1}`, name: nm, polygon: poly,
      walls: poly.map(() => ({ thicknessM: 0.15, sourceKind: 'pdf-annotation' as const, status: 'estimated' as const })),
    });
  }
  const hs = pick.map((f) => f.h).filter((h) => h >= 2 && h <= 6).sort((a, b) => a - b);
  const ceilingM = hs.length ? r3(hs[Math.floor(hs.length / 2)]) : 2.6;
  if (!spaces.length) warnings.push('No readable room footprints found.');

  const evidence: Evidence[] = [{
    id: 'ev-ifc', kind: 'manual', label: `IFC file ${name}`,
    note: `Read from ${schema || 'an IFC file'}; room footprints only, all estimated.`, createdAt: now,
  }];
  const model: SpaceModel = {
    id: `ifc-${now}`, name: base, version: 1, units: 'm', ceilingM,
    sourceLabel: `IFC: ${name}, ${spaces.length} room footprint(s); all estimated`,
    spaces, openings: [], furniture: [], measurements: [], evidence,
  };
  return { model, report: { spaces: total, converted: spaces.length, levels, unitM, schema, warnings } };
}
