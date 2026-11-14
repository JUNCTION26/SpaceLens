import { describe, expect, it } from 'vitest';
import type { P, PagePaths, VPath } from './pdfPaths';
import type { TextItem } from './textCore';
import { classify } from './textCore';
import { buildFromPaths } from './toBuilding';
import { answerFromGeometry, walkDistance } from './geoAnswer';
import { purposeOf } from './purpose';
import { buildFromProposals, cleanProposals, scaleFromAreas } from './rasterRooms';

// A synthetic 1:100 sheet: two 4 x 4 m rooms side by side, one door between them, one window.
const M = (100 * 0.0254) / 72; // metres per point at 1:100
const W = 842, H = 595, OX = 100, OY = 100;
const pt = (x: number, y: number): P => ({ x: OX + x / M, y: OY + y / M });
const rect = (x0: number, y0: number, x1: number, y1: number) => [pt(x0, y0), pt(x1, y0), pt(x1, y1), pt(x0, y1)];
const wall = (r: P[]): VPath => ({ paint: 'fillStroke', lw: 1, stroke: [0, 0, 0], fill: [176, 176, 176], dashed: false, subs: [r], closed: [true], curves: 0, arcs: [] });

function sheet(): { pp: PagePaths; items: TextItem[] } {
  const walls = [
    rect(-0.3, -0.3, 1, 0), rect(2.5, -0.3, 8.4, 0), // top wall with a window gap in room A
    rect(-0.3, 4, 8.4, 4.3), // bottom
    rect(-0.3, 0, 0, 4), rect(8.1, 0, 8.4, 4), // sides
    rect(4, 0, 4.1, 1.0), rect(4, 1.9, 4.1, 4), // interior wall with a door gap
  ].map(wall);
  const win: VPath = { paint: 'fillStroke', lw: 0.5, stroke: [0, 0, 0], fill: [255, 255, 255], dashed: false, subs: [rect(1, -0.3, 2.5, 0)], closed: [true], curves: 0, arcs: [] };
  // door: hinge at (4.0, 1.0), swings into room A, open tip at (3.1, 1.0), closes onto (4.0, 1.9)
  // arc points from the open tip (3.1, 1.0) round to the jamb (4.0, 1.9)
  const arcPts = Array.from({ length: 17 }, (_, k) => { const t = (k / 16) * (Math.PI / 2); return pt(4 - 0.9 * Math.cos(t), 1 + 0.9 * Math.sin(t)); });
  const door: VPath = { paint: 'stroke', lw: 0.37, stroke: [0, 0, 0], fill: [255, 255, 255], dashed: false, subs: [arcPts], closed: [false], curves: 2, arcs: [arcPts] };
  const leaf: VPath = { paint: 'stroke', lw: 0.85, stroke: [0, 0, 0], fill: [255, 255, 255], dashed: false, subs: [[pt(4, 1), pt(3.1, 1)]], closed: [false], curves: 0, arcs: [] };
  let id = 0;
  const text = (s: string, x: number, y: number): TextItem => {
    const p = pt(x, y), h = 9, w = s.length * 5;
    return { id: id++, page: 0, str: s, x: (p.x - w / 2) / W, y: (p.y - h / 2) / H, w: w / W, h: h / H, ...classify(s) };
  };
  const items = [
    text('Zimmer', 2, 1.7), text('1.01', 2, 2.0), text('16.00 m²', 2, 2.3),
    text('Küche', 6.05, 1.7), text('1.02', 6.05, 2.0), text('16.00 m²', 6.05, 2.3),
    { id: id++, page: 0, str: 'Massstab 1:100', x: 0.8, y: 0.9, w: 0.1, h: 0.015, ...classify('Massstab 1:100') },
  ];
  return { pp: { w: W, h: H, paths: [...walls, win, door, leaf] }, items };
}

describe('plan to building', () => {
  const { pp, items } = sheet();
  const { model, report } = buildFromPaths(pp, items, 0, { name: 'test.pdf', now: 1 });

  it('reads the printed scale and finds both rooms with their printed areas', () => {
    expect(report.ok).toBe(true);
    expect(report.scale.n).toBe(100);
    expect(report.rooms.map((r) => r.no).sort()).toEqual(['1.01', '1.02']);
    for (const r of report.rooms) {
      expect(Math.abs(r.errorPct!)).toBeLessThan(2);
      expect(r.status).toBe('verified');
    }
    expect(report.medianAreaErrorPct!).toBeLessThan(2);
  });

  it('names rooms and purposes from multilingual labels', () => {
    expect(model.spaces.map((s) => s.purpose).sort()).toEqual(['bedroom', 'kitchen']);
    expect(purposeOf('Cucina')?.purpose).toBe('kitchen');
    expect(purposeOf('Séjour')?.purpose).toBe('living');
    expect(purposeOf('Bagno')?.purpose).toBe('bathroom');
    expect(purposeOf('Treppenhaus')?.purpose).toBe('stair');
  });

  it('puts the door on both rooms and the window on the outer wall', () => {
    const doors = model.openings.filter((o) => o.kind === 'door');
    expect(doors.length).toBe(2);
    expect(new Set(doors.map((d) => d.spaceId)).size).toBe(2);
    for (const d of doors) expect(d.widthM).toBeCloseTo(0.9, 1);
    expect(doors.filter((d) => d.swing === 'in').length).toBe(1);
    const wins = model.openings.filter((o) => o.kind === 'window');
    expect(wins.length).toBe(1);
    expect(wins[0].widthM).toBeCloseTo(1.5, 1);
  });

  it('gives interior walls half their thickness on each side and outer walls all of it', () => {
    const a = model.spaces.find((s) => s.purpose === 'bedroom')!;
    const ts = a.walls.map((w) => w.thicknessM).sort((x, y) => x - y);
    expect(ts[0]).toBeCloseTo(0.05, 1);
    expect(ts[ts.length - 1]).toBeCloseTo(0.3, 1);
  });

  it('links every wall to evidence on the sheet', () => {
    for (const s of model.spaces) s.walls.forEach((w, i) => {
      const m = model.measurements.find((x) => x.id === w.measurementId)!;
      expect(m.targetId).toBe(`${s.id}:${i}`);
      const ev = model.evidence.find((e) => e.id === m.evidenceIds[0])!;
      expect(ev.kind).toBe('pdf');
      expect(ev.bbox!.every((v) => v >= 0 && v <= 1)).toBe(true);
    });
  });

  it('answers geometry questions without a model call', () => {
    const big = answerFromGeometry(report, model, 'Which room is largest?')!;
    expect(big.unit).toBe('m²');
    expect(big.regions.length).toBe(1);
    const win = answerFromGeometry(report, model, 'How many rooms have a window?')!;
    expect(win.value).toBe(1);
    const a = model.spaces[0].id, b = model.spaces[1].id;
    const w = walkDistance(model, a, b)!;
    expect(w.metres).toBeGreaterThan(4);
    expect(w.metres).toBeLessThan(5);
    const d = answerFromGeometry(report, model, 'Distance from Zimmer to the kitchen?')!;
    expect(d.unit).toBe('m');
  });
});

describe('picture plans', () => {
  it('sizes proposed rooms from printed areas and marks them photo-inferred', () => {
    const rooms = cleanProposals({ rooms: [
      { name: 'Kitchen', areaM2: 12, polygon: [{ x: 0.1, y: 0.1 }, { x: 0.4, y: 0.1 }, { x: 0.4, y: 0.5 }, { x: 0.1, y: 0.5 }] },
      { name: 'Bedroom', areaM2: 12, polygon: [{ x: 0.4, y: 0.1 }, { x: 0.7, y: 0.1 }, { x: 0.7, y: 0.5 }, { x: 0.4, y: 0.5 }] },
      { name: 'Bad', polygon: [{ x: 0, y: 0 }, { x: 0, y: 0 }] },
    ] });
    expect(rooms.length).toBe(2);
    const k = scaleFromAreas(rooms, 1000, 1000)!;
    const { model } = buildFromProposals(rooms, { pxW: 1000, pxH: 1000, mPerPx: k, name: 'scan.png', page: 0, now: 1 });
    expect(model.spaces.length).toBe(2);
    expect(model.spaces[0].walls[0].sourceKind).toBe('photo-inferred');
  });
});
