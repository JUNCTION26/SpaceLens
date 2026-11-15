/**
 * IFC (STEP) reader: IfcSpace footprints, names and heights into a SpaceModel, all marked
 * estimated. Reads IfcExtrudedAreaSolid bodies whose profile is an IfcArbitraryClosedProfileDef
 * (IfcPolyline) or an IfcRectangleProfileDef, and applies the IfcLocalPlacement chain.
 * The file is untrusted data: nothing is evaluated, every lookup is bounds-checked.
 */
import type { Evidence, FurnitureItem, Opening, Space, SpaceModel, Vec2 } from '../../core/types';
import { doorOperation } from './ifcWrite';

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
  'IFCMEASUREWITHUNIT', 'IFCBUILDINGSTOREY', 'IFCGEOMETRICCURVESET',
  'IFCWALL', 'IFCWALLSTANDARDCASE', 'IFCDOOR', 'IFCWINDOW', 'IFCOPENINGELEMENT', 'IFCRELFILLSELEMENT',
  'IFCRELVOIDSELEMENT', 'IFCFURNITURE', 'IFCPROPERTYSET', 'IFCPROPERTYSINGLEVALUE', 'IFCRELDEFINESBYPROPERTIES',
  'IFCRELCONTAINEDINSPATIALSTRUCTURE',
]);
/** Building elements this reader does not turn into plan content; they are counted in the skip report. */
const UNSUPPORTED = new Set([
  'IFCSLAB', 'IFCCOLUMN', 'IFCBEAM', 'IFCSTAIR', 'IFCSTAIRFLIGHT', 'IFCRAMP', 'IFCRAMPFLIGHT', 'IFCROOF', 'IFCCURTAINWALL',
  'IFCRAILING', 'IFCPLATE', 'IFCMEMBER', 'IFCCOVERING', 'IFCFOOTING', 'IFCPILE', 'IFCCHIMNEY', 'IFCBUILDINGELEMENTPROXY',
  'IFCFLOWTERMINAL', 'IFCFLOWSEGMENT', 'IFCFLOWFITTING', 'IFCDISTRIBUTIONELEMENT', 'IFCFURNISHINGELEMENT', 'IFCSYSTEMFURNITUREELEMENT',
  'IFCTRANSPORTELEMENT', 'IFCELECTRICAPPLIANCE', 'IFCLIGHTFIXTURE', 'IFCSANITARYTERMINAL', 'IFCMECHANICALFASTENER', 'IFCREINFORCINGBAR',
  'IFCWALLELEMENTEDCASE', 'IFCSLABSTANDARDCASE', 'IFCOPENINGSTANDARDCASE', 'IFCGEOGRAPHICELEMENT', 'IFCANNOTATION', 'IFCGRID',
]);
const MAX_ARGS_LEN = 200000;

/** Splits the DATA section into entities, keeping only the kinds this reader needs. */
function entities(text: string): { ents: Map<number, Ent>; header: string; skipped: Map<string, number> } {
  const ents = new Map<number, Ent>();
  const skipped = new Map<string, number>();
  const di = text.indexOf('DATA;');
  const header = di >= 0 ? text.slice(0, di) : '';
  let i = di >= 0 ? di + 5 : 0;
  const n = text.length;
  while (i < n) {
    while (i < n && text.charCodeAt(i) !== 35 /* # */) {
      if (text.startsWith('ENDSEC', i)) return { ents, header, skipped };
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
    else if (UNSUPPORTED.has(name)) skipped.set(name, (skipped.get(name) ?? 0) + 1);
  }
  return { ents, header, skipped };
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
  /** IFC walls found, and those placed on a room edge (their thickness is applied there). */
  walls: number;
  wallList: IfcWallRead[];
  doors: number;
  windows: number;
  /** Doors and windows that could not be placed on a room wall. */
  openingsSkipped: number;
  furniture: number;
  storeys: Array<{ name: string; elevationM: number }>;
  /** Unsupported building elements by IFC type, with the count of each. */
  skipped: Record<string, number>;
}
export interface IfcWallRead { name: string; a: Vec2; b: Vec2; thicknessM: number; heightM: number }
export interface IfcResult { model: SpaceModel; report: IfcReport }

const area2 = (p: Vec2[]) => p.reduce((s, a, i) => { const b = p[(i + 1) % p.length]; return s + (a.x * b.y - b.x * a.y); }, 0) / 2;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Builds a SpaceModel from IFC text. Never throws on odd input; problems become warnings. */
export function ifcToModel(text: string, name = 'model.ifc', opts: { now?: number } = {}): IfcResult {
  const now = opts.now ?? Date.now();
  const warnings: string[] = [];
  const base = name.replace(/\.ifc$/i, '');
  const { ents, header, skipped } = entities(text);
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
        if (se && se.name === 'IFCGEOMETRICCURVESET') {
          // a footprint drawn as a closed polyline (no extrusion): height unknown
          const curves = args(se.raw)[0];
          for (const c of Array.isArray(curves) ? curves : []) {
            const ce = isRef(c) ? ents.get(c.ref) : undefined;
            if (!ce || ce.name !== 'IFCPOLYLINE') continue;
            const pts: Vec2[] = [];
            for (const r of (args(ce.raw)[0] as Arg[] | undefined) ?? []) if (isRef(r)) { const v = point(r.ref); if (v.length >= 2) pts.push({ x: v[0], y: v[1] }); }
            if (pts.length >= 3) return { pts, tf: ID, depth: NaN };
          }
          continue;
        }
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

  // IFC is y-up when viewed from above; the plan is y-down, so flip. Files written by SpaceLens
  // keep their absolute position; other files are moved to the plan origin.
  const flip = -1;
  const pts0 = pick.flatMap((f) => f.poly);
  const minX = pts0.length && !ours ? Math.min(...pts0.map((p) => p.x)) : 0;
  const minY = pts0.length && !ours ? Math.min(...pts0.map((p) => p.y * flip)) : 0;
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

  // ---- walls, doors, windows, furniture ---------------------------------------------------
  const pickZ = pick.length ? pick[0].z : undefined;
  const toPlan = (w: V3): Vec2 => ({ x: w[0] * lenUnit - minX, y: -w[1] * lenUnit - minY });
  const sOf = (v: Arg | undefined) => (typeof v === 'string' ? v : '');
  const enOf = (v: Arg | undefined) => (v && typeof v === 'object' && !Array.isArray(v) && 'en' in v ? v.en : '');
  const storeys: Array<{ name: string; elevationM: number }> = [];
  const storeyZ = new Map<number, number>();
  for (const [id, e] of ents) {
    if (e.name !== 'IFCBUILDINGSTOREY') continue;
    const a = args(e.raw);
    const z = isRef(a[5]) ? placement(a[5].ref).o[2] * lenUnit : 0;
    storeyZ.set(id, z);
    storeys.push({ name: sOf(a[2]) || sOf(a[7]) || `Level ${storeys.length}`, elevationM: r3(z) });
  }
  const contained = new Map<number, number>(); // element -> storey elevation
  const fillOf = new Map<number, number>(); // filler (door/window) -> opening element
  const voidOf = new Map<number, number>(); // opening element -> host wall
  const psetsOf = new Map<number, number[]>();
  for (const e of ents.values()) {
    const a = args(e.raw);
    if (e.name === 'IFCRELCONTAINEDINSPATIALSTRUCTURE' && isRef(a[5]) && storeyZ.has(a[5].ref) && Array.isArray(a[4])) {
      for (const r of a[4]) if (isRef(r)) contained.set(r.ref, storeyZ.get(a[5].ref)!);
    } else if (e.name === 'IFCRELFILLSELEMENT' && isRef(a[4]) && isRef(a[5])) fillOf.set(a[5].ref, a[4].ref);
    else if (e.name === 'IFCRELVOIDSELEMENT' && isRef(a[4]) && isRef(a[5])) voidOf.set(a[5].ref, a[4].ref);
    else if (e.name === 'IFCRELDEFINESBYPROPERTIES' && isRef(a[5]) && Array.isArray(a[4])) {
      for (const r of a[4]) if (isRef(r)) psetsOf.set(r.ref, [...(psetsOf.get(r.ref) ?? []), a[5].ref]);
    }
  }
  const filledOpenings = new Set(fillOf.values());
  const propsOf = (id: number): Record<string, Arg> => {
    const out: Record<string, Arg> = {};
    for (const ps of psetsOf.get(id) ?? []) {
      const pe = ents.get(ps);
      if (!pe || pe.name !== 'IFCPROPERTYSET') continue;
      const list = args(pe.raw)[4];
      for (const r of Array.isArray(list) ? list : []) {
        const sv = isRef(r) ? ents.get(r.ref) : undefined;
        if (!sv || sv.name !== 'IFCPROPERTYSINGLEVALUE') continue;
        const b = args(sv.raw);
        const v = Array.isArray(b[2]) ? b[2][0] : b[2];
        if (typeof b[0] === 'string') out[b[0]] = v ?? null;
      }
    }
    return out;
  };
  /** World footprint (plan coordinates), base height, depth and frame of a product's extruded body. */
  const bodyOf = (a: Arg[]) => {
    const sd = solidOf(a);
    if (!sd || !Number.isFinite(sd.depth)) return null;
    const world = isRef(a[5]) ? compose(placement(a[5].ref), sd.tf) : sd.tf;
    const w3 = sd.pts.map((p) => apply(world, [p.x, p.y, 0]));
    return { pts: w3.map(toPlan), z: w3[0][2] * lenUnit, depth: Math.abs(sd.depth) * lenUnit, tf: world };
  };
  const axisOf = (a: Arg[]): [Vec2, Vec2] | null => {
    const pd = isRef(a[6]) ? ents.get(a[6].ref) : undefined;
    if (!pd || pd.name !== 'IFCPRODUCTDEFINITIONSHAPE' || !isRef(a[5])) return null;
    const reps = args(pd.raw)[2];
    for (const r of Array.isArray(reps) ? reps : []) {
      const re = isRef(r) ? ents.get(r.ref) : undefined;
      if (!re || re.name !== 'IFCSHAPEREPRESENTATION') continue;
      const ra = args(re.raw);
      if (ra[1] !== 'Axis') continue;
      for (const it of Array.isArray(ra[3]) ? ra[3] : []) {
        const ce = isRef(it) ? ents.get(it.ref) : undefined;
        if (!ce || ce.name !== 'IFCPOLYLINE') continue;
        const pts: V3[] = [];
        const refs = args(ce.raw)[0];
        for (const q of Array.isArray(refs) ? refs : []) if (isRef(q)) { const v = point(q.ref); if (v.length >= 2) pts.push(apply(placement(a[5].ref), [v[0], v[1], v[2] ?? 0])); }
        if (pts.length >= 2) return [toPlan(pts[0]), toPlan(pts[pts.length - 1])];
      }
    }
    return null;
  };
  const longestEdgeDir = (pts: Vec2[]): Vec2 => {
    let best = { x: 1, y: 0 }, bl = -1;
    pts.forEach((p, i) => { const q = pts[(i + 1) % pts.length]; const l = Math.hypot(q.x - p.x, q.y - p.y); if (l > bl) { bl = l; best = { x: (q.x - p.x) / (l || 1), y: (q.y - p.y) / (l || 1) }; } });
    return best;
  };
  const extent = (pts: Vec2[], d: Vec2): [number, number] => {
    const v = pts.map((p) => p.x * d.x + p.y * d.y);
    return [Math.min(...v), Math.max(...v)];
  };
  const centreOf = (pts: Vec2[]): Vec2 => ({ x: pts.reduce((t, p) => t + p.x, 0) / pts.length, y: pts.reduce((t, p) => t + p.y, 0) / pts.length });
  const onLevel = (z: number) => pickZ === undefined || Math.abs(z - pickZ) < 0.2;

  interface WallRec extends IfcWallRead { id: number; z: number; ux: number; uy: number; L: number }
  const wallRecs: WallRec[] = [];
  const skipCount = new Map(skipped);
  const skip = (k: string) => skipCount.set(k, (skipCount.get(k) ?? 0) + 1);
  for (const [id, e] of ents) {
    if (e.name !== 'IFCWALL' && e.name !== 'IFCWALLSTANDARDCASE') continue;
    const a = args(e.raw);
    const b = bodyOf(a);
    if (!b) { skip(e.name + ' (no extruded body)'); continue; }
    if (!onLevel(contained.get(id) ?? b.z)) continue;
    const d = longestEdgeDir(b.pts);
    const [l0, l1] = extent(b.pts, d), [t0, t1] = extent(b.pts, { x: -d.y, y: d.x });
    const ax = axisOf(a);
    const mid = (t0 + t1) / 2;
    const A = ax ? ax[0] : { x: d.x * l0 - d.y * mid, y: d.y * l0 + d.x * mid };
    const B = ax ? ax[1] : { x: d.x * l1 - d.y * mid, y: d.y * l1 + d.x * mid };
    const L = Math.hypot(B.x - A.x, B.y - A.y);
    if (L < 0.05) { skip(e.name + ' (zero length)'); continue; }
    wallRecs.push({
      id, name: sOf(a[2]) || `Wall ${wallRecs.length + 1}`, a: { x: r3(A.x), y: r3(A.y) }, b: { x: r3(B.x), y: r3(B.y) },
      thicknessM: r3(t1 - t0), heightM: r3(b.depth), z: b.z, ux: (B.x - A.x) / L, uy: (B.y - A.y) / L, L,
    });
  }
  const offLine = (w: WallRec, p: Vec2) => Math.abs((p.x - w.a.x) * -w.uy + (p.y - w.a.y) * w.ux);
  const alongOf = (w: WallRec, p: Vec2) => (p.x - w.a.x) * w.ux + (p.y - w.a.y) * w.uy;
  const edgeOn = (w: WallRec, p: Vec2, q: Vec2) => { const tol = w.thicknessM / 2 + 0.05; return offLine(w, p) <= tol && offLine(w, q) <= tol; };
  // thickness of each room edge from the wall that lies on it (largest overlap wins)
  const placedWalls = new Set<number>();
  for (const sp of spaces) {
    sp.polygon.forEach((p, i) => {
      const q = sp.polygon[(i + 1) % sp.polygon.length];
      const el = Math.hypot(q.x - p.x, q.y - p.y);
      let best: { w: WallRec; ov: number } | null = null;
      for (const w of wallRecs) {
        if (!edgeOn(w, p, q)) continue;
        const a0 = alongOf(w, p), a1 = alongOf(w, q);
        const ov = Math.min(Math.max(a0, a1), w.L) - Math.max(Math.min(a0, a1), 0);
        if (ov >= Math.min(0.3, el * 0.5) && (!best || ov > best.ov)) best = { w, ov };
      }
      if (best) { sp.walls[i] = { ...sp.walls[i], thicknessM: best.w.thicknessM }; placedWalls.add(best.w.id); }
    });
  }
  if (wallRecs.length && placedWalls.size < wallRecs.length) warnings.push(`${wallRecs.length - placedWalls.size} wall(s) do not lie on a room edge; kept in the wall list only.`);

  const openings: Opening[] = [];
  let doors = 0, windows = 0, openingsSkipped = 0, swingGuessed = 0;
  const wallById = new Map(wallRecs.map((w) => [w.id, w]));
  const handle = (id: number, e: Ent) => {
    const a = args(e.raw);
    const isOpen = e.name === 'IFCOPENINGELEMENT';
    if (isOpen && (filledOpenings.has(id) || !voidOf.has(id))) return; // filled: its door or window is read
    const holeId = isOpen ? id : fillOf.get(id);
    const hostId = holeId === undefined ? undefined : voidOf.get(holeId);
    const host = hostId === undefined ? undefined : wallById.get(hostId);
    const holeEnt = holeId !== undefined ? ents.get(holeId) : undefined;
    const b = bodyOf(a) ?? (holeEnt ? bodyOf(args(holeEnt.raw)) : null);
    if (!b) { openingsSkipped++; return; }
    if (!onLevel(host ? contained.get(host.id) ?? host.z : contained.get(id) ?? b.z)) return;
    const c = centreOf(b.pts);
    const dir = host ? { x: host.ux, y: host.uy } : longestEdgeDir(b.pts);
    const [e0, e1] = extent(b.pts, dir);
    const kind: Opening['kind'] = isOpen ? 'opening' : e.name === 'IFCDOOR' ? 'door' : 'window';
    const widthM = !isOpen && typeof a[9] === 'number' && a[9] > 0 ? a[9] * lenUnit : e1 - e0;
    const heightM = !isOpen && typeof a[8] === 'number' && a[8] > 0 ? a[8] * lenUnit : b.depth;
    let best: { sp: Space; i: number; d: number; t: number } | null = null;
    for (const sp of spaces) sp.polygon.forEach((p, i) => {
      const q = sp.polygon[(i + 1) % sp.polygon.length];
      const L = Math.hypot(q.x - p.x, q.y - p.y);
      if (L < 0.2) return;
      if (host && !edgeOn(host, p, q)) return;
      const t = Math.max(0, Math.min(L, ((c.x - p.x) * (q.x - p.x) + (c.y - p.y) * (q.y - p.y)) / L));
      const d = Math.hypot(p.x + ((q.x - p.x) * t) / L - c.x, p.y + ((q.y - p.y) * t) / L - c.y);
      if (!best || d < best.d) best = { sp, i, d, t };
    });
    const found = best as { sp: Space; i: number; d: number; t: number } | null;
    if (!found || found.d > (host ? host.thicknessM / 2 + 0.1 : 0.3)) { openingsSkipped++; return; }
    const sp = found.sp;
    const p = sp.polygon[found.i], q = sp.polygon[(found.i + 1) % sp.polygon.length];
    const L = Math.hypot(q.x - p.x, q.y - p.y);
    const u = { x: (q.x - p.x) / L, y: (q.y - p.y) / L };
    let swing: Opening['swing'] = 'none', hinge: Opening['hinge'] = 'start';
    if (kind === 'door') {
      const op = enOf(a[11]);
      if (op === 'SINGLE_SWING_LEFT' || op === 'SINGLE_SWING_RIGHT') {
        swing = 'in'; swingGuessed++;
        const sg = area2(sp.polygon) >= 0 ? 1 : -1;
        hinge = doorOperation(u, { x: -u.y * sg, y: u.x * sg }, 'start') === op ? 'start' : 'end';
      } else if (op.startsWith('DOUBLE_')) swing = 'in';
      doors++;
    } else if (kind === 'window') windows++;
    const baseZ = host ? host.z : contained.get(id) ?? pickZ ?? 0;
    openings.push({
      id: `${kind}-${openings.length + 1}`, kind, spaceId: sp.id, wallIndex: found.i, offsetM: r3(found.t),
      widthM: r3(widthM), heightM: r3(heightM), sillM: r3(Math.max(0, b.z - baseZ)), swing, hinge,
      sourceKind: 'pdf-annotation', status: 'estimated',
    });
  };
  for (const [id, e] of ents) if (e.name === 'IFCDOOR' || e.name === 'IFCWINDOW' || e.name === 'IFCOPENINGELEMENT') handle(id, e);
  if (swingGuessed) warnings.push('IFC does not store which side a door swings to; swing doors are read as opening into the room, the hinge follows the door operation.');
  if (openingsSkipped) warnings.push(`${openingsSkipped} door, window or opening element(s) could not be placed on a room wall.`);

  const furniture: FurnitureItem[] = [];
  for (const [id, e] of ents) {
    if (e.name !== 'IFCFURNITURE') continue;
    const a = args(e.raw);
    const b = bodyOf(a);
    if (!b) { skip('IFCFURNITURE (no extruded body)'); continue; }
    const storeyEl = contained.get(id);
    if (!onLevel(storeyEl ?? b.z)) continue;
    const c = centreOf(b.pts);
    const rotation = Math.atan2(-b.tf.x[1], b.tf.x[0]);
    const ex = extent(b.pts, { x: Math.cos(rotation), y: Math.sin(rotation) });
    const ey = extent(b.pts, { x: -Math.sin(rotation), y: Math.cos(rotation) });
    const pr = propsOf(id);
    const pt = enOf(a[8]);
    const cat = typeof pr.Category === 'string' && pr.Category ? pr.Category
      : sOf(a[4]) ? sOf(a[4]).toLowerCase().replace(/_/g, '-')
      : pt && pt !== 'NOTDEFINED' && pt !== 'USERDEFINED' ? pt.toLowerCase() : 'furniture';
    const ps = String(pr.PriceStatus ?? '');
    const elev = Math.max(0, b.z - (storeyEl ?? 0));
    furniture.push({
      id: `furn-${furniture.length + 1}`, catalogId: typeof pr.CatalogId === 'string' ? pr.CatalogId : 'ifc-furniture',
      name: sOf(a[2]) || cat, category: cat, x: r3(c.x), y: r3(c.y), rotation: r3(rotation),
      w: r3(ex[1] - ex[0]), d: r3(ey[1] - ey[0]), h: r3(b.depth), clearance: { front: 0, back: 0, left: 0, right: 0 },
      locked: false, owned: enOf(pr.Owned) === 'T', priceSek: typeof pr.Price === 'number' ? pr.Price : 0,
      priceStatus: ps === 'catalog' || ps === 'user' || ps === 'owned' ? ps : 'estimated', color: '#9aa0a6',
      material: typeof pr.Material === 'string' ? pr.Material : undefined, sourceKind: 'pdf-annotation',
      elevationM: elev > 0.001 ? r3(elev) : undefined,
    });
  }
  if (skipCount.size) warnings.push(`Not read: ${[...skipCount].map(([k, n]) => `${n} x ${k}`).join(', ')}.`);

  const evidence: Evidence[] = [{
    id: 'ev-ifc', kind: 'manual', label: `IFC file ${name}`,
    note: `Read from ${schema || 'an IFC file'}; rooms, walls, doors, windows and furniture; all estimated.`, createdAt: now,
  }];
  const model: SpaceModel = {
    id: `ifc-${now}`, name: base, version: 1, units: 'm', ceilingM,
    sourceLabel: `IFC: ${name}, ${spaces.length} room(s), ${openings.length} opening(s), ${furniture.length} item(s); all estimated`,
    spaces, openings, furniture, measurements: [], evidence,
  };
  return { model, report: {
    spaces: total, converted: spaces.length, levels, unitM, schema, warnings,
    walls: wallRecs.length, wallList: wallRecs.map(({ name: n, a, b, thicknessM, heightM }) => ({ name: n, a, b, thicknessM, heightM })),
    doors, windows, openingsSkipped, furniture: furniture.length, storeys, skipped: Object.fromEntries(skipCount),
  } };
}

/** Reads an IFC file picked by the user. */
export async function openIfcFile(file: File): Promise<IfcResult> {
  return ifcToModel(await file.text(), file.name);
}
