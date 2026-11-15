import { describe, expect, it } from 'vitest';
import { sampleRoom } from '../../core/sample';
import { ifcToModel } from './ifcRead';
import { modelToIfc } from './ifcWrite';

const area = (p: Array<{ x: number; y: number }>) => Math.abs(p.reduce((s, a, i) => { const b = p[(i + 1) % p.length]; return s + (a.x * b.y - b.x * a.y); }, 0)) / 2;

describe('ifc reader', () => {
  it('round-trips the writer: rooms, names, areas, height, marked estimated', () => {
    const m = sampleRoom();
    const b = { ...m.spaces[0], id: 's2', name: 'Hall', polygon: [{ x: 4, y: 0 }, { x: 7, y: 0 }, { x: 7, y: 2 }, { x: 5, y: 2 }, { x: 5, y: 3 }, { x: 4, y: 3 }], walls: m.spaces[0].walls.concat(m.spaces[0].walls).slice(0, 6) };
    const model = { ...m, ceilingM: 2.7, spaces: [{ ...m.spaces[0], name: 'Bedroom' }, b] };
    const { model: back, report } = ifcToModel(modelToIfc(model), 'x.ifc', { now: 1 });
    expect(report.spaces).toBe(2);
    expect(report.converted).toBe(2);
    expect(back.spaces.map((s) => s.name)).toEqual(['Bedroom', 'Hall']);
    back.spaces.forEach((s, i) => expect(area(s.polygon)).toBeCloseTo(area(model.spaces[i].polygon), 2));
    expect(back.ceilingM).toBeCloseTo(2.7, 2);
    expect(back.spaces.every((s) => s.walls.every((w) => w.status === 'estimated'))).toBe(true);
    expect(back.sourceLabel).toContain('estimated');
  });
  it('round-trips an asymmetric L room within 1 mm and writes y negated', () => {
    const m = sampleRoom();
    const L = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 2 }, { x: 2, y: 2 }, { x: 2, y: 3 }, { x: 0, y: 3 }];
    const sp = { ...m.spaces[0], name: 'L room', polygon: L, walls: L.map(() => m.spaces[0].walls[0]) };
    const item = { ...m.furniture[0], x: 1, y: 2, rotation: Math.PI / 2 };
    const model = { ...m, spaces: [sp], openings: [], furniture: [item] };
    const ifc = modelToIfc(model);
    // corner (4,2) of the plan is (4,-2) in IFC; a mirrored writer would put y = +2
    expect(ifc).toContain('IFCCARTESIANPOINT((4.,-2.))'.replace('4.,', '4.0,').replace('-2.', '-2.0'));
    expect(ifc).not.toContain('IFCCARTESIANPOINT((4.0,2.0))');
    // item at (1,2) turned a quarter turn on the plan: placed at (1,-2), x axis pointing (0,-1)
    expect(ifc).toContain('IFCCARTESIANPOINT((1.0,-2.0,0.0))');
    expect(ifc).toContain('IFCDIRECTION((0.0,-1.0,0.0))');
    const { model: back } = ifcToModel(ifc, 'l.ifc', { now: 1 });
    expect(back.spaces[0].name).toBe('L room');
    // the profile is written counter-clockwise, so the start vertex may differ: match as a set
    expect(back.spaces[0].polygon).toHaveLength(L.length);
    for (const c of L) {
      expect(back.spaces[0].polygon.some((p) => Math.abs(p.x - c.x) < 0.001 && Math.abs(p.y - c.y) < 0.001)).toBe(true);
    }
    expect(area(back.spaces[0].polygon)).toBeCloseTo(10, 3);
  });
  it('survives garbage', () => {
    expect(ifcToModel('not ifc').report.converted).toBe(0);
    expect(ifcToModel('DATA;\n#1=IFCSPACE(').report.converted).toBe(0);
  });
  it('applies placements, millimetre units and rectangle profiles', () => {
    const t = [
      "FILE_SCHEMA(('IFC2X3'));", 'DATA;',
      '#1=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);',
      '#2=IFCCARTESIANPOINT((1000.,2000.,0.));', '#3=IFCAXIS2PLACEMENT3D(#2,$,$);', '#4=IFCLOCALPLACEMENT($,#3);',
      '#5=IFCCARTESIANPOINT((0.,0.,0.));', '#6=IFCDIRECTION((0.,1.,0.));', '#7=IFCAXIS2PLACEMENT3D(#5,$,#6);', '#8=IFCLOCALPLACEMENT(#4,#7);',
      '#9=IFCCARTESIANPOINT((0.,0.));', '#10=IFCAXIS2PLACEMENT2D(#9,$);', '#11=IFCRECTANGLEPROFILEDEF(.AREA.,$,#10,4000.,3000.);',
      '#12=IFCEXTRUDEDAREASOLID(#11,#3,#13,2700.);', '#13=IFCDIRECTION((0.,0.,1.));',
      "#14=IFCSHAPEREPRESENTATION(#99,'Body','SweptSolid',(#12));", '#15=IFCPRODUCTDEFINITIONSHAPE($,$,(#14));',
      "#16=IFCSPACE('g',$,'A1','',$,#8,#15,'Lounge',.ELEMENT.,.INTERNAL.,$);",
      'ENDSEC;',
    ].join('\n');
    const { model, report } = ifcToModel(t, 'a.ifc');
    expect(report.unitM).toBe(0.001);
    expect(model.spaces[0].name).toBe('Lounge');
    expect(area(model.spaces[0].polygon)).toBeCloseTo(12, 2);
    // placement rotates the 4 x 3 rectangle a quarter turn
    const xs = model.spaces[0].polygon.map((p) => p.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(3, 2);
    expect(model.ceilingM).toBeCloseTo(2.7, 2);
  });

  // Opt-in: SPACELENS_IFC_DIR=<folder with *.ifc>. These files are untrusted and never committed.
  const env = (globalThis as unknown as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
  const dir = env.SPACELENS_IFC_DIR;
  const run = dir ? it : it.skip;
  run('reads the dataset files', async () => {
    // loaded by computed name so the browser build and its types never see node modules
    const m = 'node:';
    const fs = (await import(/* @vite-ignore */ m + 'fs')) as any;
    const path = (await import(/* @vite-ignore */ m + 'path')) as any;
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e: any) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.ifc$/i.test(e.name) ? [path.join(d, e.name)] : []));
    const files = walk(dir!);
    let ok = 0;
    const lines: string[] = [];
    for (const f of files) {
      const r = ifcToModel(fs.readFileSync(f, 'utf8'), f);
      if (r.report.converted > 0) ok++;
      lines.push(`${f.split(/[\\/]/).pop()}: ${r.report.converted}/${r.report.spaces} spaces, ${r.report.levels} levels, unit ${r.report.unitM}, ${r.report.schema}`);
    }
    console.log(`IFC dataset: ${ok} of ${files.length} files give rooms`);
    console.log(lines.join(String.fromCharCode(10)));
    expect(files.length).toBeGreaterThan(0);
  }, 600000);
});
