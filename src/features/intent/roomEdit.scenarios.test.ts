// Follow-up sentences a real user types after the first layout, each checked against what an interior
// architect would expect: where the piece ends up, what it faces, and that the room stays usable.
import { describe, expect, it, vi } from 'vitest';
import { applyOp } from '../../core/ops';
import { convexOverlap, doorSwingPolygon, itemCorners, openingSegment, rotate } from '../../core/geometry';
import { sampleRoom } from '../../core/sample';
import type { FurnitureItem, Op, SpaceModel } from '../../core/types';
import { makeItem } from '../furniture/catalog';
import { refineRoomOffline, type RoomEdit } from './roomEdit';

vi.mock('../../core/gemini', () => ({ hasGemini: () => false, gemini: async () => ({}), usage: { calls: 0, inputTokens: 0, outputTokens: 0 } }));

// Sample room: 3.4 x 4.2 m, window centred on the top wall (x 1.0..2.4), door bottom-left (x 0.2..1.0) swinging in.
function room(items: Array<[string, number, number, number?]>): SpaceModel {
  const fs: FurnitureItem[] = items.map(([id, x, y, rot], i) => ({ ...makeItem(id, { x, y, rotation: rot ?? 0 }), id: `i${i}_${id}` }));
  return { ...sampleRoom(), furniture: fs };
}
const apply = (m: SpaceModel, ops: Op[]) => ops.reduce(applyOp, m);
const ok = (r: RoomEdit | null) => { expect(r).not.toBeNull(); expect(r!.ok).toBe(true); return r as Extract<RoomEdit, { ok: true }>; };
const byCat = (m: SpaceModel, cat: string) => m.furniture.filter((f) => f.category === cat);
const fwd = (f: FurnitureItem) => rotate({ x: 0, y: 1 }, f.rotation);
const window = () => { const m = sampleRoom(); return openingSegment(m.spaces[0], m.openings[1]).c; };
const gap = (a: FurnitureItem, b: FurnitureItem) => {
  // Axis-aligned enough for these scenarios: gap between bounding boxes.
  const bb = (f: FurnitureItem) => { const c = itemCorners(f); return { x0: Math.min(...c.map((p) => p.x)), x1: Math.max(...c.map((p) => p.x)), y0: Math.min(...c.map((p) => p.y)), y1: Math.max(...c.map((p) => p.y)) }; };
  const p = bb(a), q = bb(b);
  return Math.hypot(Math.max(0, p.x0 - q.x1, q.x0 - p.x1), Math.max(0, p.y0 - q.y1, q.y0 - p.y1));
};

/** Every piece inside the room, solids not overlapping, door swing clear. */
function sound(m: SpaceModel) {
  const swing = doorSwingPolygon(m.spaces[0], m.openings[0])!;
  const solid = m.furniture.filter((f) => f.category !== 'rug');
  for (const f of m.furniture) for (const c of itemCorners(f)) {
    expect(c.x).toBeGreaterThan(-0.01); expect(c.x).toBeLessThan(3.41);
    expect(c.y).toBeGreaterThan(-0.01); expect(c.y).toBeLessThan(4.21);
  }
  for (const f of solid) expect(convexOverlap(itemCorners(f), swing)).toBeLessThanOrEqual(0);
  for (let i = 0; i < solid.length; i++) for (let j = i + 1; j < solid.length; j++) expect(convexOverlap(itemCorners(solid[i]), itemCorners(solid[j]))).toBeLessThanOrEqual(0.031);
}

describe('real follow-ups', () => {
  it('move the desk to the window: desk ends under the window', () => {
    const m = room([['desk-120', 2.8, 2.6, Math.PI / 2], ['bed-single', 0.46, 1.6]]);
    const after = apply(m, ok(refineRoomOffline(m, 'move the desk to the window')).ops);
    const desk = byCat(after, 'desk')[0];
    expect(Math.hypot(desk.x - window().x, desk.y - window().y)).toBeLessThan(0.8);
    sound(after);
  });

  it('Swedish: flytta skrivbordet till fönstret', () => {
    const m = room([['desk-120', 2.8, 2.6, Math.PI / 2]]);
    const desk = byCat(apply(m, ok(refineRoomOffline(m, 'flytta skrivbordet till fönstret')).ops), 'desk')[0];
    expect(Math.hypot(desk.x - window().x, desk.y - window().y)).toBeLessThan(0.8);
  });

  it('a tall wardrobe moved to the window stands beside the glass, not in front of it', () => {
    const m = room([['wardrobe-100', 2.9, 3.0, Math.PI / 2]]);
    const after = apply(m, ok(refineRoomOffline(m, 'move the wardrobe to the window')).ops);
    const w = byCat(after, 'wardrobe')[0];
    const xs = itemCorners(w).map((p) => p.x);
    const coversGlass = Math.max(...xs) > 1.0 + 0.01 && Math.min(...xs) < 2.4 - 0.01 && Math.min(...itemCorners(w).map((p) => p.y)) < 0.4;
    expect(coversGlass).toBe(false);
    expect(Math.min(...itemCorners(w).map((p) => p.y))).toBeLessThan(0.1); // still on the window wall
    sound(after);
  });

  it('put the plant next to the sofa: at its side, not in the legroom', () => {
    const m = room([['sofa-2', 2.95, 2.1, Math.PI / 2], ['plant', 0.4, 0.4]]);
    const after = apply(m, ok(refineRoomOffline(m, 'put the plant next to the sofa')).ops);
    const [sofa, plant] = after.furniture;
    expect(gap(plant, sofa)).toBeLessThan(0.3);
    const f = fwd(sofa);
    expect((plant.x - sofa.x) * f.x + (plant.y - sofa.y) * f.y).toBeLessThan(sofa.d / 2 + 0.1);
    sound(after);
  });

  it('swap the bed and the wardrobe: each takes the other wall and facing', () => {
    const m = room([['bed-single', 0.46, 1.01, 0], ['wardrobe-100', 3.08, 2.0, Math.PI / 2]]);
    const r = ok(refineRoomOffline(m, 'swap the bed and the wardrobe'));
    const after = apply(m, r.ops);
    const bed = byCat(after, 'bed')[0], ward = byCat(after, 'wardrobe')[0];
    expect(bed.x).toBeGreaterThan(2.0);
    expect(Math.max(...itemCorners(bed).map((p) => p.x))).toBeGreaterThan(3.3); // head against the right wall
    expect(bed.rotation).toBeCloseTo(Math.PI / 2, 3);
    expect(ward.x).toBeLessThan(1.4);
    expect(Math.min(...itemCorners(ward).map((p) => p.y))).toBeLessThan(0.05); // back against the top wall
    sound(after);
  });

  it('swap the sofa with an armchair still means a new piece when one is named with "an"', () => {
    const m = room([['sofa-2', 2.95, 2.1, Math.PI / 2], ['armchair', 0.6, 1.0]]);
    const after = apply(m, ok(refineRoomOffline(m, 'swap the sofa with an armchair')).ops);
    expect(byCat(after, 'armchair')).toHaveLength(2);
  });

  it('turn the chair to face the desk', () => {
    const m = room([['desk-120', 1.7, 0.31, 0], ['chair', 2.8, 2.5, 0]]);
    const after = apply(m, ok(refineRoomOffline(m, 'turn the chair to face the desk')).ops);
    const [desk, chair] = after.furniture;
    const f = fwd(chair), to = { x: desk.x - chair.x, y: desk.y - chair.y }, L = Math.hypot(to.x, to.y);
    expect((f.x * to.x + f.y * to.y) / L).toBeGreaterThan(0.98);
    sound(after);
  });

  it('centre the rug', () => {
    const m = room([['rug-160', 0.9, 1.3]]);
    const rug = apply(m, ok(refineRoomOffline(m, 'centre the rug')).ops).furniture[0];
    expect(Math.abs(rug.x - 1.7)).toBeLessThan(0.05);
    expect(Math.abs(rug.y - 2.1)).toBeLessThan(0.05);
  });

  it('line up the shelves along the left wall: one run, backs on the wall, clear of the door', () => {
    const m = room([['bookshelf', 2.8, 1.0, Math.PI], ['bookshelf', 1.7, 2.5], ['bookshelf', 2.9, 3.2, Math.PI / 2]]);
    const r = ok(refineRoomOffline(m, 'line up the shelves along the left wall'));
    const after = apply(m, r.ops);
    const shelves = byCat(after, 'bookshelf').sort((a, b) => a.y - b.y);
    expect(shelves).toHaveLength(3);
    for (const s of shelves) {
      expect(Math.min(...itemCorners(s).map((p) => p.x))).toBeLessThan(0.05);
      expect(s.rotation).toBeCloseTo(shelves[0].rotation, 3);
    }
    for (let i = 1; i < shelves.length; i++) expect(gap(shelves[i - 1], shelves[i])).toBeLessThan(0.15);
    sound(after);
    expect(r.report!.moved.length).toBe(3);
  });

  it('move it a bit left: "it" is the piece from the last sentence', () => {
    const m = room([['armchair', 2.0, 2.0], ['plant', 0.4, 0.4]]);
    const first = ok(refineRoomOffline(m, 'move the armchair to the centre'));
    const mid = apply(m, first.ops);
    expect(first.memory!.last[0]).toBe('i0_armchair');
    const r = ok(refineRoomOffline(mid, 'move it a bit left', { memory: first.memory }));
    const a0 = mid.furniture[0], a1 = apply(mid, r.ops).furniture[0];
    expect(a1.x).toBeCloseTo(a0.x - 0.3, 2);
    expect(a1.y).toBeCloseTo(a0.y, 3);
  });

  it('"it" with nothing said before asks which piece', () => {
    const r = refineRoomOffline(room([['armchair', 2.0, 2.0]]), 'move it a bit left');
    expect(r && !r.ok && r.reason).toBe('Which piece?');
  });

  it('a nudge into the wall goes as far as there is room and says so', () => {
    const m = room([['armchair', 0.6, 2.0]]);
    const r = ok(refineRoomOffline(m, 'move the armchair 50 cm left'));
    const a = apply(m, r.ops).furniture[0];
    expect(a.x - a.w / 2).toBeGreaterThanOrEqual(-0.001);
    expect(a.x).toBeLessThan(0.45);
    expect(r.report!.compromises.length).toBeGreaterThan(0);
  });

  it('make the room 5 by 6 resizes the space', () => {
    const r = ok(refineRoomOffline(room([['armchair', 2.0, 2.0]]), 'make the room 5 by 6'));
    expect(r.ops).toEqual([expect.objectContaining({ type: 'RESIZE_SPACE', widthM: 5, depthM: 6 })]);
  });

  it('add a lamp by the armchair: at the arm, not in front', () => {
    const m = room([['armchair', 2.9, 1.5, Math.PI / 2]]);
    const r = ok(refineRoomOffline(m, 'add a lamp by the armchair'));
    const after = apply(m, r.ops);
    const [chair, lamp] = after.furniture;
    expect(lamp.category).toBe('lamp');
    expect(gap(lamp, chair)).toBeLessThan(0.3);
    const f = fwd(chair);
    expect((lamp.x - chair.x) * f.x + (lamp.y - chair.y) * f.y).toBeLessThan(chair.d / 2 + 0.1);
    expect(r.memory!.last[0]).toBe(lamp.id);
    sound(after);
  });

  it('remove the second chair removes exactly that one', () => {
    const m = room([['chair', 2.0, 2.0], ['chair', 2.8, 2.0], ['chair', 2.0, 3.0]]);
    const after = apply(m, ok(refineRoomOffline(m, 'remove the second chair')).ops);
    expect(after.furniture.map((f) => f.id)).toEqual(['i0_chair', 'i2_chair']);
  });

  it('make it cozier: rug before the sofa, lamp at its arm, plant in a corner', () => {
    const m = room([['sofa-2', 2.95, 2.1, Math.PI / 2]]);
    const r = ok(refineRoomOffline(m, 'make it cozier'));
    const after = apply(m, r.ops);
    const sofa = after.furniture[0], rug = byCat(after, 'rug')[0], lamp = byCat(after, 'lamp')[0], plant = byCat(after, 'plant')[0];
    expect(rug.x).toBeLessThan(sofa.x - 0.5);
    expect(Math.abs(rug.y - sofa.y)).toBeLessThan(0.3);
    expect(gap(lamp, sofa)).toBeLessThan(0.3);
    const corners = [[0, 0], [3.4, 0], [3.4, 4.2], [0, 4.2]];
    expect(Math.min(...corners.map(([x, y]) => Math.hypot(plant.x - x, plant.y - y)))).toBeLessThan(0.6);
    sound(after);
  });

  it('two clauses with "it" in the second: add a plant and move it to the corner', () => {
    const m = room([['sofa-2', 2.95, 2.1, Math.PI / 2]]);
    const after = apply(m, ok(refineRoomOffline(m, 'add a plant then move it to the corner')).ops);
    const plant = byCat(after, 'plant')[0];
    expect(Math.min(plant.x, 3.4 - plant.x)).toBeLessThan(0.5);
    expect(Math.min(plant.y, 4.2 - plant.y)).toBeLessThan(0.5);
  });
});
