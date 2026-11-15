/**
 * Strict IFC4 STEP checker used by the tests (it is not shipped to the browser unless imported).
 * It parses the file into entities and checks, for the entity kinds the writer emits: attribute
 * counts, required attributes are not `$`, every reference resolves to an entity of the right
 * kind, GlobalIds are well formed and unique, nothing is left unreferenced (except the project
 * and relationships), and the spatial and void/fill structure is complete.
 */
export type Val = null | '*' | number | string | { ref: number } | { en: string } | { typed: string; args: Val[] } | Val[];
export interface StepEnt { id: number; name: string; args: Val[] }

export function parseStep(text: string): { ents: Map<number, StepEnt>; errors: string[]; headerSchema: string } {
  const errors: string[] = [];
  const ents = new Map<number, StepEnt>();
  const di = text.indexOf('\nDATA;\n');
  if (!text.startsWith('ISO-10303-21;')) errors.push('missing ISO-10303-21 start');
  if (!text.trimEnd().endsWith('END-ISO-10303-21;')) errors.push('missing END-ISO-10303-21');
  const headerSchema = /FILE_SCHEMA\(\('([^']*)'\)\)/.exec(text)?.[1] ?? '';
  if (di < 0) { errors.push('no DATA section'); return { ents, errors, headerSchema }; }
  const data = text.slice(di + 7, text.indexOf('\nENDSEC;', di + 7));
  for (const line of data.split('\n')) {
    if (!line) continue;
    const m = /^#(\d+)=([A-Z0-9]+)\(([\s\S]*)\);$/.exec(line);
    if (!m) { errors.push(`bad line: ${line.slice(0, 80)}`); continue; }
    const id = Number(m[1]);
    if (ents.has(id)) errors.push(`duplicate id #${id}`);
    let p = 0;
    const s = m[3];
    const value = (): Val => {
      const c = s[p];
      if (c === '(') {
        p++;
        const out: Val[] = [];
        while (s[p] !== ')') { if (p >= s.length) throw new Error('unterminated list'); out.push(value()); if (s[p] === ',') p++; }
        p++;
        return out;
      }
      if (c === "'") {
        let r = ''; p++;
        for (;;) {
          if (p >= s.length) throw new Error('unterminated string');
          if (s[p] === "'") { if (s[p + 1] === "'") { r += "'"; p += 2; continue; } p++; break; }
          r += s[p++];
        }
        return r;
      }
      if (c === '#') { const mm = /^#(\d+)/.exec(s.slice(p))!; p += mm[0].length; return { ref: Number(mm[1]) }; }
      if (c === '.') { const e = s.indexOf('.', p + 1); const en = s.slice(p + 1, e); p = e + 1; return { en }; }
      if (c === '$') { p++; return null; }
      if (c === '*') { p++; return '*'; }
      const nm = /^-?\d+(\.\d*)?([eE][-+]?\d+)?/.exec(s.slice(p));
      if (nm) { p += nm[0].length; return parseFloat(nm[0]); }
      const tn = /^[A-Z0-9_]+/.exec(s.slice(p));
      if (tn && s[p + tn[0].length] === '(') {
        p += tn[0].length + 1;
        const args: Val[] = [];
        while (s[p] !== ')') { args.push(value()); if (s[p] === ',') p++; }
        p++;
        return { typed: tn[0], args };
      }
      throw new Error(`unexpected '${c}' at ${p}`);
    };
    try {
      const args: Val[] = [];
      while (p < s.length) { args.push(value()); if (s[p] === ',') p++; else if (p < s.length) throw new Error(`expected comma at ${p}`); }
      ents.set(id, { id, name: m[2], args });
    } catch (e) { errors.push(`#${id} ${m[2]}: ${(e as Error).message}`); }
  }
  return { ents, errors, headerSchema };
}

const isRef = (v: Val | undefined): v is { ref: number } => !!v && typeof v === 'object' && !Array.isArray(v) && 'ref' in v;
const isEnum = (v: Val | undefined): v is { en: string } => !!v && typeof v === 'object' && !Array.isArray(v) && 'en' in v;

/** Attribute spec: 'x' any, 'X' any required, 's' string required, 'n' number required, 'g' guid, 'e' enum required,
 * 'r:A|B' required ref to one of those kinds, 'o:A|B' optional ref, 'R:A|B' required non-empty list of refs. */
type Spec = string;
const OWNER = 'r:IFCOWNERHISTORY';
const PL = 'r:IFCLOCALPLACEMENT';
const PDS = 'r:IFCPRODUCTDEFINITIONSHAPE';
const SPECS: Record<string, Spec[]> = {
  IFCCARTESIANPOINT: ['X'], IFCDIRECTION: ['X'],
  IFCAXIS2PLACEMENT3D: ['r:IFCCARTESIANPOINT', 'o:IFCDIRECTION', 'o:IFCDIRECTION'],
  IFCAXIS2PLACEMENT2D: ['r:IFCCARTESIANPOINT', 'o:IFCDIRECTION'],
  IFCLOCALPLACEMENT: ['o:IFCLOCALPLACEMENT', 'r:IFCAXIS2PLACEMENT3D'],
  IFCGEOMETRICREPRESENTATIONCONTEXT: ['x', 's', 'n', 'n', 'r:IFCAXIS2PLACEMENT3D', 'o:IFCDIRECTION'],
  IFCGEOMETRICREPRESENTATIONSUBCONTEXT: ['s', 's', 'x', 'x', 'x', 'x', 'r:IFCGEOMETRICREPRESENTATIONCONTEXT', 'x', 'e', 'x'],
  IFCSIUNIT: ['x', 'e', 'x', 'e'], IFCMONETARYUNIT: ['s'],
  IFCUNITASSIGNMENT: ['R:IFCSIUNIT|IFCMONETARYUNIT'],
  IFCPERSON: ['x', 's', 'x', 'x', 'x', 'x', 'x', 'x'], IFCORGANIZATION: ['x', 's', 'x', 'x', 'x'],
  IFCPERSONANDORGANIZATION: ['r:IFCPERSON', 'r:IFCORGANIZATION', 'x'],
  IFCAPPLICATION: ['r:IFCORGANIZATION', 's', 's', 's'],
  IFCOWNERHISTORY: ['r:IFCPERSONANDORGANIZATION', 'r:IFCAPPLICATION', 'x', 'e', 'x', 'x', 'x', 'n'],
  IFCPROJECT: ['g', OWNER, 's', 'x', 'x', 'x', 'x', 'R:IFCGEOMETRICREPRESENTATIONCONTEXT', 'r:IFCUNITASSIGNMENT'],
  IFCSITE: ['g', OWNER, 's', 'x', 'x', PL, 'x', 'x', 'e', 'x', 'x', 'x', 'x', 'x'],
  IFCBUILDING: ['g', OWNER, 's', 'x', 'x', PL, 'x', 'x', 'e', 'x', 'x', 'x'],
  IFCBUILDINGSTOREY: ['g', OWNER, 's', 'x', 'x', PL, 'x', 'x', 'e', 'n'],
  IFCSPACE: ['g', OWNER, 's', 'x', 'x', PL, PDS, 's', 'e', 'e', 'n'],
  IFCWALL: ['g', OWNER, 's', 'x', 'x', PL, PDS, 'x', 'e'],
  IFCDOOR: ['g', OWNER, 's', 'x', 'x', PL, PDS, 'x', 'n', 'n', 'e', 'e', 'x'],
  IFCWINDOW: ['g', OWNER, 's', 'x', 'x', PL, PDS, 'x', 'n', 'n', 'e', 'e', 'x'],
  IFCFURNITURE: ['g', OWNER, 's', 'x', 'x', PL, PDS, 'x', 'e'],
  IFCOPENINGELEMENT: ['g', OWNER, 's', 'x', 'x', PL, PDS, 'x', 'e'],
  IFCPRODUCTDEFINITIONSHAPE: ['x', 'x', 'R:IFCSHAPEREPRESENTATION'],
  IFCSHAPEREPRESENTATION: ['r:IFCGEOMETRICREPRESENTATIONSUBCONTEXT', 's', 's', 'R:IFCEXTRUDEDAREASOLID|IFCPOLYLINE'],
  IFCEXTRUDEDAREASOLID: ['r:IFCRECTANGLEPROFILEDEF|IFCARBITRARYCLOSEDPROFILEDEF', 'r:IFCAXIS2PLACEMENT3D', 'r:IFCDIRECTION', 'n'],
  IFCRECTANGLEPROFILEDEF: ['e', 'x', 'r:IFCAXIS2PLACEMENT2D', 'n', 'n'],
  IFCARBITRARYCLOSEDPROFILEDEF: ['e', 'x', 'r:IFCPOLYLINE'],
  IFCPOLYLINE: ['R:IFCCARTESIANPOINT'],
  IFCELEMENTQUANTITY: ['g', OWNER, 's', 'x', 'x', 'R:IFCQUANTITYAREA|IFCQUANTITYLENGTH|IFCQUANTITYVOLUME'],
  IFCQUANTITYAREA: ['s', 'x', 'x', 'n', 'x'], IFCQUANTITYLENGTH: ['s', 'x', 'x', 'n', 'x'], IFCQUANTITYVOLUME: ['s', 'x', 'x', 'n', 'x'],
  IFCPROPERTYSET: ['g', OWNER, 's', 'x', 'R:IFCPROPERTYSINGLEVALUE'],
  IFCPROPERTYSINGLEVALUE: ['s', 'x', 'X', 'x'],
  IFCMATERIAL: ['s', 'x', 'x'], IFCMATERIALLAYER: ['r:IFCMATERIAL', 'n', 'x', 's', 'x', 'x', 'x'],
  IFCMATERIALLAYERSET: ['R:IFCMATERIALLAYER', 's', 'x'], IFCMATERIALLAYERSETUSAGE: ['r:IFCMATERIALLAYERSET', 'e', 'e', 'n', 'x'],
  IFCRELAGGREGATES: ['g', OWNER, 'x', 'x', 'r:IFCPROJECT|IFCSITE|IFCBUILDING|IFCBUILDINGSTOREY', 'R:IFCSITE|IFCBUILDING|IFCBUILDINGSTOREY|IFCSPACE'],
  IFCRELCONTAINEDINSPATIALSTRUCTURE: ['g', OWNER, 'x', 'x', 'R:IFCWALL|IFCDOOR|IFCWINDOW|IFCFURNITURE', 'r:IFCBUILDINGSTOREY'],
  IFCRELVOIDSELEMENT: ['g', OWNER, 'x', 'x', 'r:IFCWALL', 'r:IFCOPENINGELEMENT'],
  IFCRELFILLSELEMENT: ['g', OWNER, 'x', 'x', 'r:IFCOPENINGELEMENT', 'r:IFCDOOR|IFCWINDOW'],
  IFCRELDEFINESBYPROPERTIES: ['g', OWNER, 'x', 'x', 'R:IFCSPACE|IFCFURNITURE', 'r:IFCELEMENTQUANTITY|IFCPROPERTYSET'],
  IFCRELASSOCIATESMATERIAL: ['g', OWNER, 'x', 'x', 'R:IFCWALL', 'r:IFCMATERIALLAYERSETUSAGE'],
};

const GUID_RE = /^[0-3][0-9A-Za-z_$]{21}$/;

export function validateIfc(text: string): string[] {
  const { ents, errors, headerSchema } = parseStep(text);
  const out = [...errors];
  if (headerSchema !== 'IFC4') out.push(`schema is '${headerSchema}', expected IFC4`);
  const referenced = new Set<number>();
  const guids = new Map<string, number>();
  for (const e of ents.values()) {
    const spec = SPECS[e.name];
    if (!spec) { out.push(`#${e.id}: no rule for ${e.name} (unknown entity)`); continue; }
    if (e.args.length !== spec.length) { out.push(`#${e.id} ${e.name}: ${e.args.length} attributes, expected ${spec.length}`); continue; }
    const where = (i: number) => `#${e.id} ${e.name} attribute ${i + 1}`;
    const kindOk = (r: { ref: number }, kinds: string[], i: number) => {
      const t = ents.get(r.ref);
      if (!t) { out.push(`${where(i)}: #${r.ref} does not exist`); return; }
      if (!kinds.includes(t.name)) out.push(`${where(i)}: #${r.ref} is ${t.name}, expected ${kinds.join(' or ')}`);
    };
    spec.forEach((sp, i) => {
      const v = e.args[i];
      const kinds = sp.includes(':') ? sp.slice(2).split('|') : [];
      const walk = (x: Val) => { if (isRef(x)) referenced.add(x.ref); else if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === 'object' && 'typed' in x) x.args.forEach(walk); };
      walk(v);
      switch (sp[0]) {
        case 'x': return;
        case 'X': if (v === null) out.push(`${where(i)}: required value is $`); return;
        case 's': if (typeof v !== 'string' || !v) out.push(`${where(i)}: required string missing`); return;
        case 'n': if (typeof v !== 'number' || !Number.isFinite(v)) out.push(`${where(i)}: required number missing`); return;
        case 'e': if (!isEnum(v)) out.push(`${where(i)}: required enumeration missing`); return;
        case 'g':
          if (typeof v !== 'string' || !GUID_RE.test(v)) { out.push(`${where(i)}: bad GlobalId`); return; }
          if (guids.has(v)) out.push(`${where(i)}: GlobalId also used by #${guids.get(v)}`);
          guids.set(v, e.id);
          return;
        case 'r': if (!isRef(v)) out.push(`${where(i)}: required reference missing`); else kindOk(v, kinds, i); return;
        case 'o': if (v !== null) { if (!isRef(v)) out.push(`${where(i)}: not a reference`); else kindOk(v, kinds, i); } return;
        case 'R':
          if (!Array.isArray(v) || !v.length) { out.push(`${where(i)}: required list is empty`); return; }
          for (const r of v) { if (!isRef(r)) out.push(`${where(i)}: list item is not a reference`); else kindOk(r, kinds, i); }
          return;
      }
    });
  }
  // nothing unreferenced except the project and relationships
  for (const e of ents.values()) {
    if (e.name === 'IFCPROJECT' || e.name.startsWith('IFCREL')) continue;
    if (!referenced.has(e.id)) out.push(`#${e.id} ${e.name} is not referenced by anything`);
  }
  const all = [...ents.values()];
  const count = (n: string) => all.filter((e) => e.name === n);
  if (count('IFCPROJECT').length !== 1) out.push('need exactly one IfcProject');
  // spatial structure: project -> site -> building -> storey, each product placed in one container
  const agg = new Map<string, number>();
  for (const r of count('IFCRELAGGREGATES')) {
    const parent = ents.get((r.args[4] as { ref: number }).ref)?.name ?? '?';
    const kids = (r.args[5] as Array<{ ref: number }>).map((k) => ents.get(k.ref)?.name ?? '?');
    const want: Record<string, string> = { IFCPROJECT: 'IFCSITE', IFCSITE: 'IFCBUILDING', IFCBUILDING: 'IFCBUILDINGSTOREY', IFCBUILDINGSTOREY: 'IFCSPACE' };
    for (const k of kids) if (want[parent] !== k) out.push(`${parent} cannot aggregate ${k}`);
    agg.set(parent, (agg.get(parent) ?? 0) + 1);
  }
  for (const p of ['IFCPROJECT', 'IFCSITE', 'IFCBUILDING']) if (agg.get(p) !== 1) out.push(`${p} must aggregate exactly once`);
  const placed = new Map<number, number>();
  for (const r of count('IFCRELCONTAINEDINSPATIALSTRUCTURE')) for (const k of r.args[4] as Array<{ ref: number }>) placed.set(k.ref, (placed.get(k.ref) ?? 0) + 1);
  for (const e of all) {
    if (['IFCWALL', 'IFCDOOR', 'IFCWINDOW', 'IFCFURNITURE'].includes(e.name) && placed.get(e.id) !== 1) out.push(`#${e.id} ${e.name} is not contained in exactly one storey`);
  }
  const spaceAgg = new Set<number>();
  for (const r of count('IFCRELAGGREGATES')) if (ents.get((r.args[4] as { ref: number }).ref)?.name === 'IFCBUILDINGSTOREY') for (const k of r.args[5] as Array<{ ref: number }>) spaceAgg.add(k.ref);
  for (const e of count('IFCSPACE')) if (!spaceAgg.has(e.id)) out.push(`#${e.id} IFCSPACE is not aggregated to the storey`);
  // openings: every opening voids exactly one wall; every door and window fills an opening
  const voided = new Map<number, number>();
  for (const r of count('IFCRELVOIDSELEMENT')) { const o = (r.args[5] as { ref: number }).ref; voided.set(o, (voided.get(o) ?? 0) + 1); }
  for (const e of count('IFCOPENINGELEMENT')) if (voided.get(e.id) !== 1) out.push(`#${e.id} IFCOPENINGELEMENT does not void exactly one wall`);
  const filled = new Set<number>();
  for (const r of count('IFCRELFILLSELEMENT')) filled.add((r.args[5] as { ref: number }).ref);
  for (const e of all) if ((e.name === 'IFCDOOR' || e.name === 'IFCWINDOW') && !filled.has(e.id)) out.push(`#${e.id} ${e.name} does not fill an opening`);
  return out;
}
