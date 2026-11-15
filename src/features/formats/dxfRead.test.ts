import { describe, expect, it } from 'vitest';
import { dxfToModel, parseDxf } from './dxfRead';

const g = (...a: Array<string | number>) => a.join('\n') + '\n';
const rect = (layer: string, x0: number, y0: number, x1: number, y1: number) =>
  g(0, 'LWPOLYLINE', 8, layer, 90, 4, 70, 1, 10, x0, 20, y0, 10, x1, 20, y0, 10, x1, 20, y1, 10, x0, 20, y1);

const SNIP = g(0, 'SECTION', 2, 'HEADER', 9, '$INSUNITS', 70, 4, 0, 'ENDSEC')
  + g(0, 'SECTION', 2, 'BLOCKS', 0, 'BLOCK', 2, 'DR', 10, 0, 20, 0, 0, 'LINE', 8, '0', 10, 0, 20, 0, 11, 900, 21, 0, 0, 'ARC', 8, '0', 10, 0, 20, 0, 40, 900, 50, 0, 51, 90, 0, 'ENDBLK', 0, 'ENDSEC')
  + g(0, 'SECTION', 2, 'ENTITIES')
  + rect('A-ROOM', 0, 0, 4000, 3000) + rect('A-ROOM', 4000, 0, 7000, 3000)
  + g(0, 'TEXT', 8, 'A-ROOM-TEXT', 10, 1500, 20, 1500, 40, 200, 1, 'Kitchen')
  + g(0, 'MTEXT', 8, 'A-ROOM-TEXT', 10, 5000, 20, 1500, 40, 200, 1, '\\fArial;Bedroom')
  + g(0, 'INSERT', 8, 'A-DOOR', 2, 'DR', 10, 4000, 20, 500, 41, 1, 42, 1, 50, 90)
  + g(0, 'ENDSEC', 0, 'EOF');

describe('dxf reader', () => {
  it('reads units, blocks with transforms and text', () => {
    const d = parseDxf(SNIP);
    expect(d.unitM).toBe(0.001);
    const door = d.lines.filter((l) => l.layer === 'A-DOOR');
    expect(door.length).toBe(2);
    // the line of 900 was rotated 90 degrees about the insert point
    const l = door.find((x) => x.kind === 'line')!;
    expect(l.pts[0].x).toBeCloseTo(4000); expect(l.pts[1].y).toBeCloseTo(1400);
    expect(d.texts.map((t) => t.str)).toEqual(['Kitchen', 'Bedroom']);
  });
  it('builds rooms with names, a door, and marks all estimated', () => {
    const { model, report } = dxfToModel(SNIP, 'x.dxf', { now: 1 });
    expect(report.method).toBe('room-outlines');
    expect(model.spaces.map((s) => s.name)).toEqual(['Kitchen', 'Bedroom']);
    expect(model.spaces[0].polygon.length).toBe(4);
    expect(report.doors).toBe(1);
    expect(model.openings[0].status).toBe('estimated');
    expect(model.openings[0].widthM).toBeCloseTo(0.9, 1);
  });
  it('survives garbage', () => {
    expect(dxfToModel('not a dxf').report.rooms).toBe(0);
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DIR: string | undefined = (globalThis as any).process?.env?.SPACELENS_DXF_DIR;

describe.skipIf(!DIR)('dxf dataset (opt-in)', () => {
  it('converts the files', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fs: any = await import(/* @vite-ignore */ 'node:' + 'fs');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const path: any = await import(/* @vite-ignore */ 'node:' + 'path');
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e: { isDirectory(): boolean; name: string }) => e.isDirectory() ? walk(path.join(d, e.name)) : /\.dxf$/i.test(e.name) ? [path.join(d, e.name)] : []);
    const files = walk(DIR!);
    let ok = 0; const rows: string[] = [];
    for (const f of files) {
      const t0 = Date.now();
      try {
        const r = dxfToModel(fs.readFileSync(f, 'latin1'), path.basename(f));
        if (r.report.rooms > 0) ok++;
        rows.push(`${path.basename(f)} ${r.report.method} rooms=${r.report.rooms} doors=${r.report.doors} win=${r.report.windows} ${Date.now() - t0}ms ${r.report.warnings[0] ?? ''}`);
      } catch (e) { rows.push(`${path.basename(f)} ERROR ${(e as Error).message}`); }
    }
    console.log(rows.join('\n') + `\nCONVERTED ${ok}/${files.length}`);
    expect(files.length).toBeGreaterThan(0);
  }, 600000);
});
