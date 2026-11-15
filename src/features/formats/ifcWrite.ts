/**
 * IFC4 writer. The plan has y pointing down; IFC is right-handed with y and z up. Every plan
 * coordinate is written as (x, -y), directions as (dx, -dy) and rotations as -angle, so the
 * building looks the same from above in any IFC viewer.
 *
 * Walls sit on the room edges (the wall centre line). An edge shared by two rooms becomes ONE
 * wall. Doors and windows are placed relative to their host wall: an IfcOpeningElement voids the
 * wall and the door or window fills that opening.
 */
import type { FurnitureItem, Space, SpaceModel } from '../../core/types';

const TOL = 1e-3;
type Pt = { x: number; y: number };

const B64 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';

function hash32(s: string, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d) >>> 0; h ^= h >>> 12;
  return h >>> 0;
}

/** Deterministic 22-character IFC GlobalId (128 bits in the IFC base-64 alphabet). */
export function ifcGuid(key: string): string {
  const w = [1, 2, 3, 4].map((i) => hash32(key, i * 7919));
  let bits = '';
  for (const n of w) bits += n.toString(2).padStart(32, '0');
  let out = B64[parseInt(bits.slice(0, 2), 2)];
  for (let i = 2; i < 128; i += 6) out += B64[parseInt(bits.slice(i, i + 6), 2)];
  return out;
}

const num = (n: number) => {
  const s = (Math.abs(n) < 1e-9 ? 0 : n).toFixed(6).replace(/0+$/, '');
  return s.endsWith('.') ? s + '0' : s;
};

const str = (s: string) =>
  "'" + Array.from(s).map((c) => {
    const cp = c.codePointAt(0)!;
    if (c === "'") return "''";
    if (c === '\\') return '\\\\';
    if (cp >= 32 && cp < 127) return c;
    if (cp > 0xffff) return `\\X4\\${cp.toString(16).toUpperCase().padStart(8, '0')}\\X0\\`;
    return `\\X2\\${cp.toString(16).toUpperCase().padStart(4, '0')}\\X0\\`;
  }).join('') + "'";

const FURNITURE_TYPE: Record<string, string> = {
  desk: 'DESK', table: 'TABLE', 'side-table': 'TABLE', counter: 'TABLE', bed: 'BED', 'bunk-bed': 'BED',
  chair: 'CHAIR', 'office-chair': 'CHAIR', stool: 'CHAIR', bench: 'CHAIR', armchair: 'CHAIR', seat: 'CHAIR', seating: 'CHAIR',
  sofa: 'SOFA', bookshelf: 'SHELF', shelf: 'SHELF', 'wall-shelf': 'SHELF',
};

/** IFC predefined type and, for user defined types, the object type text. */
export function furnitureType(category: string): { type: string; objectType: string | null } {
  const c = category.trim().toLowerCase();
  if (!c) return { type: 'NOTDEFINED', objectType: null };
  const t = FURNITURE_TYPE[c];
  return t ? { type: t, objectType: null } : { type: 'USERDEFINED', objectType: c.toUpperCase().replace(/[^A-Z0-9]+/g, '_') };
}

/**
 * Door operation from swing and hinge. Convention: stand on the side the leaf swings towards,
 * looking at the door; the hinge on your left gives SINGLE_SWING_LEFT. `u` is the wall direction
 * and `swingDir` the direction the leaf swings to, both in plan axes (y down).
 */
export function doorOperation(u: Pt, swingDir: Pt, hinge: 'start' | 'end'): 'SINGLE_SWING_LEFT' | 'SINGLE_SWING_RIGHT' {
  const uu = { x: u.x, y: -u.y }, s = { x: swingDir.x, y: -swingDir.y }; // IFC axes (y up)
  const look = { x: -s.x, y: -s.y };
  const right = { x: look.y, y: -look.x };
  const h = hinge === 'start' ? { x: -uu.x, y: -uu.y } : uu;
  return h.x * right.x + h.y * right.y < 0 ? 'SINGLE_SWING_LEFT' : 'SINGLE_SWING_RIGHT';
}

const signedArea = (p: Pt[]) => p.reduce((s, a, i) => { const b = p[(i + 1) % p.length]; return s + (a.x * b.y - b.x * a.y); }, 0) / 2;

/** Floor area inside the wall faces: the room outline moved in by half of each wall's thickness. */
export function netFloorArea(sp: Space): number {
  const A = Math.abs(signedArea(sp.polygon));
  const n = sp.polygon.length;
  const sgn = signedArea(sp.polygon) >= 0 ? 1 : -1;
  let tw = 0, corners = 0;
  const d = sp.walls.length ? sp.walls.reduce((s, w) => s + w.thicknessM, 0) / sp.walls.length / 2 : 0.06;
  for (let i = 0; i < n; i++) {
    const a = sp.polygon[i], b = sp.polygon[(i + 1) % n], c = sp.polygon[(i + 2) % n];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    tw += L * ((sp.walls[i]?.thicknessM ?? 0.12) / 2);
    const turn = Math.atan2((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x), (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)) * sgn;
    corners += Math.tan(turn / 2);
  }
  return Math.max(0, A - tw + d * d * corners);
}

interface WallRec { p: Pt; q: Pt; L: number; ux: number; uy: number; t: number; keys: string[]; id?: string; pl?: string }

export function modelToIfc(model: SpaceModel, opts: { now?: number } = {}): string {
  const lines: string[] = [];
  let n = 0;
  const add = (body: string) => { lines.push(`#${++n}=${body};`); return `#${n}`; };
  const pt3 = (x: number, y: number, z: number) => add(`IFCCARTESIANPOINT((${num(x)},${num(y)},${num(z)}))`);
  const pt2 = (x: number, y: number) => add(`IFCCARTESIANPOINT((${num(x)},${num(y)}))`);
  const dir3 = (x: number, y: number, z: number) => add(`IFCDIRECTION((${num(x)},${num(y)},${num(z)}))`);
  const zDir = dir3(0, 0, 1);
  const xDir = dir3(1, 0, 0);
  const place3 = (x: number, y: number, z: number, rx = 1, ry = 0) =>
    add(`IFCAXIS2PLACEMENT3D(${pt3(x, y, z)},${zDir},${rx === 1 && ry === 0 ? xDir : dir3(rx, ry, 0)})`);
  const local = (rel: string | null, x: number, y: number, z: number, rx = 1, ry = 0) =>
    add(`IFCLOCALPLACEMENT(${rel ?? '$'},${place3(x, y, z, rx, ry)})`);
  const g = (k: string) => str(ifcGuid(k));
  const list = (a: string[]) => `(${a.join(',')})`;

  // Owner history
  const person = add("IFCPERSON($,'SpaceLens',$,$,$,$,$,$)");
  const org = add("IFCORGANIZATION($,'SpaceLens',$,$,$)");
  const pao = add(`IFCPERSONANDORGANIZATION(${person},${org},$)`);
  const app = add(`IFCAPPLICATION(${org},'1.0','SpaceLens','SpaceLens')`);
  const stamp = Math.max(0, Math.floor(opts.now ?? 0));
  const oh = add(`IFCOWNERHISTORY(${pao},${app},$,.NOCHANGE.,$,$,$,${stamp})`);

  // Contexts and units
  const worldPlace = place3(0, 0, 0);
  const trueNorth = add('IFCDIRECTION((0.,1.))');
  const ctx = add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,${worldPlace},${trueNorth})`);
  let bodyRef = '';
  const bodyCtx = () => bodyRef || (bodyRef = add(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,${ctx},$,.MODEL_VIEW.,$)`));
  let axisCtxRef = '';
  const axisCtx = () => axisCtxRef || (axisCtxRef = add(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Axis','Model',*,*,*,*,${ctx},$,.GRAPH_VIEW.,$)`));
  const units = [
    add('IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)'),
    add('IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)'),
    add('IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)'),
    add('IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)'),
    add('IFCSIUNIT(*,.MASSUNIT.,.KILO.,.GRAM.)'),
    add('IFCSIUNIT(*,.TIMEUNIT.,$,.SECOND.)'),
    add("IFCMONETARYUNIT('SEK')"),
  ];
  const unitAssign = add(`IFCUNITASSIGNMENT(${list(units)})`);
  const project = add(`IFCPROJECT(${g('project:' + model.id)},${oh},${str(model.name)},$,$,$,$,(${ctx}),${unitAssign})`);

  const sitePl = local(null, 0, 0, 0);
  const site = add(`IFCSITE(${g('site:' + model.id)},${oh},'Site',$,$,${sitePl},$,$,.ELEMENT.,$,$,$,$,$)`);
  const bldPl = local(sitePl, 0, 0, 0);
  const building = add(`IFCBUILDING(${g('building:' + model.id)},${oh},${str(model.name)},$,$,${bldPl},$,$,.ELEMENT.,$,$,$)`);
  const stPl = local(bldPl, 0, 0, 0);
  const storey = add(`IFCBUILDINGSTOREY(${g('storey:' + model.id)},${oh},'Level 0',$,$,${stPl},$,$,.ELEMENT.,0.0)`);

  const shape = (profile: string, depth: number) => {
    const solid = add(`IFCEXTRUDEDAREASOLID(${profile},${place3(0, 0, 0)},${zDir},${num(depth)})`);
    const rep = add(`IFCSHAPEREPRESENTATION(${bodyCtx()},'Body','SweptSolid',(${solid}))`);
    return add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${rep}))`);
  };
  const rect = (cx: number, cy: number, w: number, d: number) => {
    const p2 = add(`IFCAXIS2PLACEMENT2D(${pt2(cx, cy)},$)`);
    return add(`IFCRECTANGLEPROFILEDEF(.AREA.,$,${p2},${num(w)},${num(d)})`);
  };
  const quantity = (kind: 'AREA' | 'LENGTH' | 'VOLUME', name: string, v: number) =>
    add(`IFCQUANTITY${kind}(${str(name)},$,$,${num(v)},$)`);

  const contained: string[] = [];
  const spaces: string[] = [];

  // Walls: one per distinct room edge. An edge shared by two rooms (same ends, either direction) is one wall.
  const walls: WallRec[] = [];
  const wallOf = new Map<string, { w: WallRec; flip: boolean }>();
  for (const sp of model.spaces) {
    sp.polygon.forEach((p, i) => {
      const q = sp.polygon[(i + 1) % sp.polygon.length];
      const L = Math.hypot(q.x - p.x, q.y - p.y);
      if (L < 1e-6) return;
      const t = sp.walls[i]?.thicknessM ?? 0.12;
      const key = `${sp.id}:${i}`;
      let hit: { w: WallRec; flip: boolean } | null = null;
      for (const w of walls) {
        if (Math.hypot(w.p.x - p.x, w.p.y - p.y) < TOL && Math.hypot(w.q.x - q.x, w.q.y - q.y) < TOL) { hit = { w, flip: false }; break; }
        if (Math.hypot(w.p.x - q.x, w.p.y - q.y) < TOL && Math.hypot(w.q.x - p.x, w.q.y - p.y) < TOL) { hit = { w, flip: true }; break; }
      }
      if (hit) { hit.w.t = Math.max(hit.w.t, t); hit.w.keys.push(key); wallOf.set(key, hit); return; }
      const w: WallRec = { p, q, L, ux: (q.x - p.x) / L, uy: (q.y - p.y) / L, t, keys: [key] };
      walls.push(w); wallOf.set(key, { w, flip: false });
    });
  }

  const layerSets = new Map<string, string>();
  let plasterRef = '';
  const plaster = () => plasterRef || (plasterRef = add("IFCMATERIAL('Plastered masonry',$,'Masonry')"));
  const layerSet = (t: number) => {
    const k = num(t);
    if (!layerSets.has(k)) {
      const layer = add(`IFCMATERIALLAYER(${plaster()},${num(t)},$,'Wall',$,$,$)`);
      layerSets.set(k, add(`IFCMATERIALLAYERSET((${layer}),'Wall ${k} m',$)`));
    }
    return layerSets.get(k)!;
  };

  for (const sp of model.spaces) {
    const ring = sp.polygon.map((p) => ({ x: p.x, y: -p.y }));
    if (signedArea(ring) < 0) ring.reverse(); // profiles are counter-clockwise
    const pts = ring.map((p) => pt2(p.x, p.y));
    const poly = add(`IFCPOLYLINE(${list([...pts, pts[0]])})`);
    const prof = add(`IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,${poly})`);
    const spPl = local(stPl, 0, 0, 0);
    const spShape = shape(prof, model.ceilingM);
    const space = add(`IFCSPACE(${g('space:' + sp.id)},${oh},${str(String(spaces.length + 1))},${sp.purpose ? str(sp.purpose) : '$'},$,${spPl},${spShape},${str(sp.name)},.ELEMENT.,.INTERNAL.,0.0)`);
    spaces.push(space);
    const A = Math.abs(signedArea(sp.polygon));
    const net = netFloorArea(sp);
    const qs = [
      quantity('AREA', 'NetFloorArea', net), quantity('AREA', 'GrossFloorArea', A),
      quantity('LENGTH', 'Height', model.ceilingM), quantity('VOLUME', 'NetVolume', net * model.ceilingM),
    ];
    const qto = add(`IFCELEMENTQUANTITY(${g('qto:' + sp.id)},${oh},'Qto_SpaceBaseQuantities',$,$,${list(qs)})`);
    add(`IFCRELDEFINESBYPROPERTIES(${g('rel:qto:' + sp.id)},${oh},$,$,(${space}),${qto})`);
  }

  walls.forEach((w, i) => {
    w.pl = local(stPl, w.p.x, -w.p.y, 0, w.ux, -w.uy);
    const solid = add(`IFCEXTRUDEDAREASOLID(${rect(w.L / 2, 0, w.L, w.t)},${place3(0, 0, 0)},${zDir},${num(model.ceilingM)})`);
    const rep = add(`IFCSHAPEREPRESENTATION(${bodyCtx()},'Body','SweptSolid',(${solid}))`);
    const axis = add(`IFCPOLYLINE((${pt2(0, 0)},${pt2(w.L, 0)}))`);
    const arep = add(`IFCSHAPEREPRESENTATION(${axisCtx()},'Axis','Curve2D',(${axis}))`);
    const pds = add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${arep},${rep}))`);
    w.id = add(`IFCWALL(${g('wall:' + w.keys[0])},${oh},${str(`Wall ${i + 1}`)},$,$,${w.pl},${pds},$,.STANDARD.)`);
    contained.push(w.id);
    const usage = add(`IFCMATERIALLAYERSETUSAGE(${layerSet(w.t)},.AXIS2.,.POSITIVE.,${num(-w.t / 2)},$)`);
    add(`IFCRELASSOCIATESMATERIAL(${g('rel:mat:' + w.keys[0])},${oh},$,$,(${w.id}),${usage})`);
  });

  for (const o of model.openings) {
    const sp = model.spaces.find((s) => s.id === o.spaceId);
    const hit = wallOf.get(`${o.spaceId}:${o.wallIndex}`);
    if (!sp || !hit) continue;
    const { w, flip } = hit;
    const along = flip ? w.L - o.offsetM : o.offsetM;
    const label = o.kind[0].toUpperCase() + o.kind.slice(1) + ' ' + o.id;
    // Placements are relative to the host wall: x along the wall, y across it, z up from the storey.
    const hpl = local(w.pl!, along, 0, o.sillM);
    const hole = add(`IFCOPENINGELEMENT(${g('void:' + o.id)},${oh},${str('Opening for ' + label)},$,$,${hpl},${shape(rect(0, 0, o.widthM, w.t + 0.02), o.heightM)},$,.OPENING.)`);
    add(`IFCRELVOIDSELEMENT(${g('rel:void:' + o.id)},${oh},$,$,${w.id},${hole})`);
    if (o.kind === 'opening') continue;
    const fpl = local(hpl, 0, 0, 0);
    const fsh = shape(rect(0, 0, o.widthM, w.t), o.heightM);
    const common = `${g('opening:' + o.id)},${oh},${str(label)},$,$,${fpl},${fsh},$`;
    let fill: string;
    if (o.kind === 'door') {
      const p = sp.polygon[o.wallIndex], q = sp.polygon[(o.wallIndex + 1) % sp.polygon.length];
      const L = Math.hypot(q.x - p.x, q.y - p.y) || 1;
      const u = { x: (q.x - p.x) / L, y: (q.y - p.y) / L };
      const a = signedArea(sp.polygon) >= 0 ? 1 : -1;
      const inward = { x: -u.y * a, y: u.x * a };
      const swing = o.swing === 'out' ? { x: -inward.x, y: -inward.y } : inward;
      const op = o.swing === 'none' ? 'NOTDEFINED' : doorOperation(u, swing, o.hinge);
      fill = add(`IFCDOOR(${common},${num(o.heightM)},${num(o.widthM)},.DOOR.,.${op}.,$)`);
    } else {
      fill = add(`IFCWINDOW(${common},${num(o.heightM)},${num(o.widthM)},.WINDOW.,.SINGLE_PANEL.,$)`);
    }
    contained.push(fill);
    add(`IFCRELFILLSELEMENT(${g('rel:fill:' + o.id)},${oh},$,$,${hole},${fill})`);
  }

  const furnitureProps = (f: FurnitureItem) => {
    const sv = (name: string, v: string) => add(`IFCPROPERTYSINGLEVALUE(${str(name)},$,${v},$)`);
    const props = [
      sv('Category', `IFCLABEL(${str(f.category)})`),
      sv('CatalogId', `IFCIDENTIFIER(${str(f.catalogId)})`),
      sv('Price', `IFCMONETARYMEASURE(${num(f.priceSek)})`),
      sv('PriceStatus', `IFCLABEL(${str(f.priceStatus)})`),
      sv('Source', `IFCLABEL(${str(f.sourceKind)})`),
      sv('Owned', `IFCBOOLEAN(${f.owned ? '.T.' : '.F.'})`),
    ];
    if (f.material) props.push(sv('Material', `IFCLABEL(${str(f.material)})`));
    if (f.listing) {
      props.push(sv('Store', `IFCLABEL(${str(f.listing.store)})`), sv('ListingTitle', `IFCTEXT(${str(f.listing.title)})`), sv('ListingUrl', `IFCTEXT(${str(f.listing.url)})`));
    }
    return add(`IFCPROPERTYSET(${g('pset:' + f.id)},${oh},'Pset_SpaceLensFurniture',$,${list(props)})`);
  };
  for (const f of model.furniture) {
    const pl = local(stPl, f.x, -f.y, f.elevationM ?? 0, Math.cos(f.rotation), -Math.sin(f.rotation));
    const sh = shape(rect(0, 0, f.w, f.d), f.h);
    const ft = furnitureType(f.category);
    const el = add(`IFCFURNITURE(${g('furniture:' + f.id)},${oh},${str(f.name || f.category || 'Furniture')},$,${ft.objectType ? str(ft.objectType) : '$'},${pl},${sh},$,.${ft.type}.)`);
    contained.push(el);
    add(`IFCRELDEFINESBYPROPERTIES(${g('rel:pset:' + f.id)},${oh},$,$,(${el}),${furnitureProps(f)})`);
  }

  add(`IFCRELAGGREGATES(${g('rel:site')},${oh},$,$,${project},(${site}))`);
  add(`IFCRELAGGREGATES(${g('rel:building')},${oh},$,$,${site},(${building}))`);
  add(`IFCRELAGGREGATES(${g('rel:storey')},${oh},$,$,${building},(${storey}))`);
  if (spaces.length) add(`IFCRELAGGREGATES(${g('rel:spaces')},${oh},$,$,${storey},${list(spaces)})`);
  if (contained.length) add(`IFCRELCONTAINEDINSPATIALSTRUCTURE(${g('rel:contained')},${oh},$,$,${list(contained)},${storey})`);

  const safeName = model.name.replace(/[^\w .-]/g, '_');
  const header = [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('ViewDefinition [ReferenceView_V1.2]'),'2;1');",
    `FILE_NAME(${str(safeName + '.ifc')},'1970-01-01T00:00:00',(''),(''),'SpaceLens','SpaceLens','');`,
    "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;',
    'DATA;',
  ];
  return [...header, ...lines, 'ENDSEC;', 'END-ISO-10303-21;', ''].join('\n');
}
