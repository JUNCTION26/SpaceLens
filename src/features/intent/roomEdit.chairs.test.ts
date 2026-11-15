// A chair belongs to a desk or table: it stays with it when the desk moves, and a new chair sits at its
// front or side facing it. Without a desk or table a chair stands with its back to a wall.
import { describe, expect, it, vi } from 'vitest';
import { applyOp } from '../../core/ops';
import { rotate } from '../../core/geometry';
import { sampleRoom } from '../../core/sample';
import type { FurnitureItem, Op, SpaceModel } from '../../core/types';
import { makeItem } from '../furniture/catalog';
import { refineRoomOffline, type RoomEdit } from './roomEdit';

vi.mock('../../core/gemini', () => ({ hasGemini: () => false, gemini: async () => ({}), usage: { calls: 0, inputTokens: 0, outputTokens: 0 } }));

function room(items: Array<[string, number, number, number?]>): SpaceModel {
  const fs: FurnitureItem[] = items.map(([id, x, y, rot], i) => ({ ...makeItem(id, { x, y, rotation: rot ?? 0 }), id: `i${i}_${id}` }));
  return { ...sampleRoom(), furniture: fs };
}
const run = (m: SpaceModel, text: string) => {
  const r = refineRoomOffline(m, text) as RoomEdit | null;
  expect(r && r.ok, JSON.stringify(r)).toBe(true);
  return (r as Extract<RoomEdit, { ok: true }>).ops.reduce((a: SpaceModel, o: Op) => applyOp(a, o), m);
};
const W = 3.4, H = 4.2;
const isSeat = (f: FurnitureItem) => f.category === 'chair' || f.category === 'office-chair';
const isAnchor = (f: FurnitureItem) => ['desk', 'table', 'cafe-table'].includes(f.category);
/** Gap between a chair centre and the desk footprint (axis-aligned or rotated: via local coordinates). */
function edgeGap(c: FurnitureItem, a: FurnitureItem) {
  const l = rotate({ x: c.x - a.x, y: c.y - a.y }, -a.rotation);
  return Math.hypot(Math.max(0, Math.abs(l.x) - a.w / 2), Math.max(0, Math.abs(l.y) - a.d / 2));
}
function angleTo(c: FurnitureItem, a: FurnitureItem) {
  const f = rotate({ x: 0, y: 1 }, c.rotation);
  const dx = a.x - c.x, dy = a.y - c.y, n = Math.hypot(dx, dy) || 1;
  return Math.acos(Math.max(-1, Math.min(1, (f.x * dx + f.y * dy) / n))) * 180 / Math.PI;
}
function backToWall(c: FurnitureItem) {
  const f = rotate({ x: 0, y: 1 }, c.rotation);
  const bx = c.x - f.x * (c.d / 2 + 0.04), by = c.y - f.y * (c.d / 2 + 0.04);
  return Math.min(bx, W - bx, by, H - by) < 0.08;
}
function everyChairBelongs(m: SpaceModel) {
  const anchors = m.furniture.filter(isAnchor);
  for (const c of m.furniture.filter(isSeat)) {
    const near = anchors.filter((a) => edgeGap(c, a) <= 0.7);
    const faces = near.some((a) => angleTo(c, a) <= 20);
    expect(faces || backToWall(c), `${c.id} at ${c.x.toFixed(2)},${c.y.toFixed(2)} rot ${c.rotation.toFixed(2)}`).toBe(true);
  }
}
const deskSet = () => room([['desk-120', 2.8, 2.6, Math.PI / 2], ['desk-chair', 2.1, 2.6, -Math.PI / 2], ['bed-single', 0.46, 1.6]]);

describe('chairs stay with their desk', () => {
  it('move the desk to the window: the chair travels with it', () => {
    const m = deskSet();
    const after = run(m, 'move the desk to the window');
    const d = after.furniture.find((f) => f.category === 'desk')!;
    expect(d.y).toBeLessThan(1.2);
    expect(after.furniture.filter(isSeat)).toHaveLength(1);
    everyChairBelongs(after);
    expect(edgeGap(after.furniture.find(isSeat)!, d)).toBeLessThan(0.5);
  });
  it('push everything to the walls: desk and chair stay together', () => {
    const m = room([['desk-120', 1.7, 2.2], ['desk-chair', 1.7, 2.75, Math.PI], ['bed-single', 0.46, 1.6]]);
    const after = run(m, 'push everything to the walls');
    everyChairBelongs(after);
  });
  it('rotating the desk turns the chair with it', () => {
    const after = run(room([['desk-120', 1.7, 2.2], ['desk-chair', 1.7, 2.75, Math.PI]]), 'rotate the desk');
    everyChairBelongs(after);
  });
  it('add a chair: goes to the desk, facing it', () => {
    const after = run(room([['desk-120', 1.7, 1.0, 0], ['desk-chair', 1.7, 1.55, Math.PI]]), 'add a chair');
    expect(after.furniture.filter(isSeat)).toHaveLength(2);
    everyChairBelongs(after);
    for (const c of after.furniture.filter(isSeat)) expect(angleTo(c, after.furniture.find(isAnchor)!)).toBeLessThanOrEqual(20);
  });
  it('add a chair with no desk: back to a wall', () => {
    const after = run(room([['bed-single', 0.46, 1.6]]), 'add a chair');
    const c = after.furniture.find(isSeat)!;
    expect(backToWall(c)).toBe(true);
  });
  it('make it a workspace for two: each desk has its chair', () => {
    const after = run(room([['desk-120', 1.7, 1.0, 0], ['desk-chair', 1.7, 1.55, Math.PI]]), 'make it a workspace for two');
    everyChairBelongs(after);
  });
  it('I work from home: the new desk gets a chair that faces it', () => {
    const after = run(room([['bed-single', 0.46, 1.6]]), 'I work from home');
    const chairs = after.furniture.filter(isSeat);
    expect(chairs.length).toBeGreaterThan(0);
    everyChairBelongs(after);
    for (const c of chairs) expect(angleTo(c, after.furniture.find(isAnchor)!)).toBeLessThanOrEqual(20);
  });
  it('a table keeps all its chairs when moved', () => {
    const m = room([['dining-4', 1.7, 2.4], ['chair', 1.7, 1.7, 0], ['chair', 1.7, 3.1, Math.PI]]);
    const after = run(m, 'move the table to the window');
    expect(after.furniture.filter(isSeat)).toHaveLength(2);
    everyChairBelongs(after);
  });
});
