import { describe, expect, it } from 'vitest';
import { sampleRoom } from '../../core/sample';
import type { SpaceModel } from '../../core/types';
import { dxfToModel, parseDxf } from './dxfRead';
import { modelToDxf } from './dxfWrite';

const area = (p: Array<{ x: number; y: number }>) => Math.abs(p.reduce((s, a, i) => { const b = p[(i + 1) % p.length]; return s + (a.x * b.y - b.x * a.y); }, 0)) / 2;

function twoRooms(): SpaceModel {
  const m = sampleRoom();
  const a = m.spaces[0];
  const b = {
    ...a, id: 's2', name: 'Kitchen', purpose: 'kitchen',
    polygon: [{ x: 3.4, y: 0 }, { x: 7.4, y: 0 }, { x: 7.4, y: 4.2 }, { x: 3.4, y: 4.2 }],
  };
  return { ...m, spaces: [{ ...a, name: 'Bedroom' }, b], openings: [...m.openings, { ...m.openings[0], id: 'door2', spaceId: 's2', wallIndex: 3, hinge: 'end', swing: 'out' }] };
}

describe('dxf writer', () => {
  const model = twoRooms();
  const text = modelToDxf(model);

  it('writes the layers and entity kinds', () => {
    const d = parseDxf(text);
    expect(d.unitM).toBe(1);
    for (const l of ['WALLS', 'DOORS', 'WINDOWS', 'FURNITURE', 'DIMENSIONS', 'TEXT']) expect(d.layers).toContain(l);
    expect(text.trimEnd().endsWith('EOF')).toBe(true);
    expect(text).not.toContain('LWPOLYLINE');
    expect(d.lines.filter((l) => l.layer === 'DOORS' && l.kind === 'arc').length).toBe(2);
    expect(d.lines.filter((l) => l.layer === 'WALLS').length).toBe(16);
    expect(d.texts.map((t) => t.str)).toContain('3.40 m');
  });
  it('round-trips rooms, names and areas within 2 percent', () => {
    const { model: back, report } = dxfToModel(text, 'x.dxf', { now: 1 });
    expect(report.rooms).toBe(model.spaces.length);
    const want = model.spaces.map((s) => area(s.polygon)).sort((a, b) => a - b);
    const got = back.spaces.map((s) => area(s.polygon)).sort((a, b) => a - b);
    got.forEach((v, i) => expect(Math.abs(v - want[i]) / want[i]).toBeLessThan(0.02));
    expect(back.spaces.map((s) => s.name).sort()).toEqual(['Bedroom', 'Kitchen']);
    expect(report.doors).toBe(2);
    expect(report.windows).toBe(1);
  });
});
