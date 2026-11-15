import type { SpaceModel } from '../../core/types';

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
    return `\\X2\\${cp.toString(16).toUpperCase().padStart(4, '0')}\\X0\\`;
  }).join('') + "'";

export function modelToIfc(model: SpaceModel): string {
  const lines: string[] = [];
  let n = 0;
  const add = (body: string) => { lines.push(`#${++n}=${body};`); return `#${n}`; };
  const pt3 = (x: number, y: number, z: number) => add(`IFCCARTESIANPOINT((${num(x)},${num(y)},${num(z)}))`);
  const dir3 = (x: number, y: number, z: number) => add(`IFCDIRECTION((${num(x)},${num(y)},${num(z)}))`);
  const zDir = dir3(0, 0, 1);
  const place3 = (x: number, y: number, z: number, rx = 1, ry = 0) =>
    add(`IFCAXIS2PLACEMENT3D(${pt3(x, y, z)},${zDir},${dir3(rx, ry, 0)})`);
  const local = (rel: string | null, x: number, y: number, z: number, rx = 1, ry = 0) =>
    add(`IFCLOCALPLACEMENT(${rel ?? '$'},${place3(x, y, z, rx, ry)})`);
  const g = (k: string) => str(ifcGuid(k));

  // Context and units
  const worldPlace = place3(0, 0, 0);
  const ctx = add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,${worldPlace},$)`);
  const body = add(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,${ctx},$,.MODEL_VIEW.,$)`);
  const units = [
    add('IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)'),
    add('IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)'),
    add('IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)'),
    add('IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)'),
  ];
  const unitAssign = add(`IFCUNITASSIGNMENT((${units.join(',')}))`);
  const project = add(`IFCPROJECT(${g('project:' + model.id)},$,${str(model.name)},$,$,$,$,(${ctx}),${unitAssign})`);

  const sitePl = local(null, 0, 0, 0);
  const site = add(`IFCSITE(${g('site:' + model.id)},$,'Site',$,$,${sitePl},$,$,.ELEMENT.,$,$,$,$,$)`);
  const bldPl = local(sitePl, 0, 0, 0);
  const building = add(`IFCBUILDING(${g('building:' + model.id)},$,${str(model.name)},$,$,${bldPl},$,$,.ELEMENT.,$,$,$)`);
  const stPl = local(bldPl, 0, 0, 0);
  const storey = add(`IFCBUILDINGSTOREY(${g('storey:' + model.id)},$,'Level 0',$,$,${stPl},$,$,.ELEMENT.,0.0)`);

  const shape = (profile: string, depth: number) => {
    const solid = add(`IFCEXTRUDEDAREASOLID(${profile},${place3(0, 0, 0)},${zDir},${num(depth)})`);
    const rep = add(`IFCSHAPEREPRESENTATION(${body},'Body','SweptSolid',(${solid}))`);
    return add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${rep}))`);
  };
  const rect = (cx: number, cy: number, w: number, d: number) => {
    const c = add(`IFCCARTESIANPOINT((${num(cx)},${num(cy)}))`);
    const p2 = add(`IFCAXIS2PLACEMENT2D(${c},$)`);
    return add(`IFCRECTANGLEPROFILEDEF(.AREA.,$,${p2},${num(w)},${num(d)})`);
  };

  const contained: string[] = [];
  const spaces: string[] = [];
  const wallIds = new Map<string, string>();

  for (const sp of model.spaces) {
    const pts = sp.polygon.map((p) => add(`IFCCARTESIANPOINT((${num(p.x)},${num(p.y)}))`));
    const poly = add(`IFCPOLYLINE((${[...pts, pts[0]].join(',')}))`);
    const prof = add(`IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,${poly})`);
    const spPl = local(stPl, 0, 0, 0);
    const spShape = shape(prof, model.ceilingM);
    spaces.push(add(`IFCSPACE(${g('space:' + sp.id)},$,${str(sp.name)},${sp.purpose ? str(sp.purpose) : '$'},$,${spPl},${spShape},$,.ELEMENT.,.INTERNAL.,0.0)`));

    sp.polygon.forEach((p, i) => {
      const q = sp.polygon[(i + 1) % sp.polygon.length];
      const L = Math.hypot(q.x - p.x, q.y - p.y);
      if (L < 1e-6) return;
      const t = sp.walls[i]?.thicknessM ?? 0.12;
      const pl = local(stPl, p.x, p.y, 0, (q.x - p.x) / L, (q.y - p.y) / L);
      const sh = shape(rect(L / 2, 0, L, t), model.ceilingM);
      wallIds.set(`${sp.id}:${i}`, add(`IFCWALLSTANDARDCASE(${g(`wall:${sp.id}:${i}`)},$,${str(`${sp.name} wall ${i + 1}`)},$,$,${pl},${sh},$,.STANDARD.)`));
      contained.push(wallIds.get(`${sp.id}:${i}`)!);
    });
  }

  for (const o of model.openings) {
    const sp = model.spaces.find((s) => s.id === o.spaceId);
    if (!sp) continue;
    const p = sp.polygon[o.wallIndex];
    const q = sp.polygon[(o.wallIndex + 1) % sp.polygon.length];
    if (!p || !q) continue;
    const L = Math.hypot(q.x - p.x, q.y - p.y) || 1;
    const ux = (q.x - p.x) / L, uy = (q.y - p.y) / L;
    const t = (sp.walls[o.wallIndex]?.thicknessM ?? 0.12) + 0.02;
    const pl = local(stPl, p.x + ux * o.offsetM, p.y + uy * o.offsetM, o.sillM, ux, uy);
    const sh = shape(rect(0, 0, o.widthM, t), o.heightM);
    const label = o.kind[0].toUpperCase() + o.kind.slice(1) + ' ' + o.id;
    // The hole: an opening element voiding the wall, slightly deeper than the wall itself.
    const hole = add(`IFCOPENINGELEMENT(${g('void:' + o.id)},$,${str('Opening for ' + label)},$,$,${pl},${sh},$,.OPENING.)`);
    const wall = wallIds.get(`${o.spaceId}:${o.wallIndex}`);
    if (wall) add(`IFCRELVOIDSELEMENT(${g('rel:void:' + o.id)},$,$,$,${wall},${hole})`);
    if (o.kind === 'opening') continue;
    const fpl = local(stPl, p.x + ux * o.offsetM, p.y + uy * o.offsetM, o.sillM, ux, uy);
    const fsh = shape(rect(0, 0, o.widthM, t), o.heightM);
    const common = `${g('opening:' + o.id)},$,${str(label)},$,$,${fpl},${fsh},$`;
    const fill = o.kind === 'door'
      ? add(`IFCDOOR(${common},${num(o.heightM)},${num(o.widthM)},.DOOR.,.NOTDEFINED.,$)`)
      : add(`IFCWINDOW(${common},${num(o.heightM)},${num(o.widthM)},.WINDOW.,.NOTDEFINED.,$)`);
    contained.push(fill);
    if (wall) add(`IFCRELFILLSELEMENT(${g('rel:fill:' + o.id)},$,$,$,${hole},${fill})`);
  }

  for (const f of model.furniture) {
    const pl = local(stPl, f.x, f.y, f.elevationM ?? 0, Math.cos(f.rotation), Math.sin(f.rotation));
    const sh = shape(rect(0, 0, f.w, f.d), f.h);
    contained.push(add(`IFCFURNISHINGELEMENT(${g('furniture:' + f.id)},$,${str(f.name)},${str(f.category)},$,${pl},${sh},$)`));
  }

  add(`IFCRELAGGREGATES(${g('rel:site')},$,$,$,${project},(${site}))`);
  add(`IFCRELAGGREGATES(${g('rel:building')},$,$,$,${site},(${building}))`);
  add(`IFCRELAGGREGATES(${g('rel:storey')},$,$,$,${building},(${storey}))`);
  if (spaces.length) add(`IFCRELAGGREGATES(${g('rel:spaces')},$,$,$,${storey},(${spaces.join(',')}))`);
  if (contained.length) add(`IFCRELCONTAINEDINSPATIALSTRUCTURE(${g('rel:contained')},$,$,$,(${contained.join(',')}),${storey})`);

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
