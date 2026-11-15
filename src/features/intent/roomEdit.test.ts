import { describe, expect, it, vi } from 'vitest';
import { applyOp } from '../../core/ops';
import { itemCorners, convexOverlap } from '../../core/geometry';
import { sampleRoom } from '../../core/sample';
import type { FurnitureItem, Op, SpaceModel } from '../../core/types';
import { makeItem } from '../furniture/catalog';
import { diffToOps, findItems, patchToOps, refineRoomOffline, turningCircle, validateRoomOps, type RoomEdit } from './roomEdit';

vi.mock('../../core/gemini', () => ({ hasGemini: () => false, gemini: async () => ({}), usage: { calls: 0, inputTokens: 0, outputTokens: 0 } }));

function room(items: Array<[string, number, number, number?]> = []): SpaceModel {
  const m = sampleRoom();
  const fs: FurnitureItem[] = items.map(([id, x, y, rot], i) => ({ ...makeItem(id, { x, y, rotation: rot ?? 0 }), id: `i${i}_${id}` }));
  return { ...m, furniture: fs };
}
const apply = (m: SpaceModel, ops: Op[]) => ops.reduce(applyOp, m);
const ok = (r: RoomEdit | null) => { expect(r).not.toBeNull(); expect(r!.ok).toBe(true); return r as Extract<RoomEdit, { ok: true }>; };
const noOverlap = (m: SpaceModel) => {
  const s = m.furniture.filter((f) => f.category !== 'rug');
  for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) expect(convexOverlap(itemCorners(s[i]), itemCorners(s[j]))).toBeLessThanOrEqual(0.031);
};
const base = () => room([['sofa-2', 2.4, 2.8, Math.PI], ['plant', 0.4, 0.4], ['floor-lamp', 3.0, 0.4], ['coffee-table', 1.7, 2.0], ['armchair', 0.7, 3.2]]);

describe('finding items', () => {
  it('finds by English, Swedish and Finnish nouns', () => {
    const m = base();
    expect(findItems(m.furniture, 'the sofa')).toHaveLength(1);
    expect(findItems(m.furniture, 'soffan')).toHaveLength(1);
    expect(findItems(m.furniture, 'sohva')).toHaveLength(1);
    expect(findItems(m.furniture, 'växt')).toHaveLength(1);
    expect(findItems(m.furniture, 'lamppu')).toHaveLength(1);
  });
  it('returns nothing for unknown things', () => {
    expect(findItems(base().furniture, 'spaceship')).toHaveLength(0);
  });
});

describe('move', () => {
  it('moves an item near the window', () => {
    const m = base();
    const r = ok(refineRoomOffline(m, 'move the sofa to the window'));
    const after = apply(m, r.ops);
    const sofa = after.furniture.find((f) => f.category === 'sofa')!;
    expect(sofa.y).toBeLessThan(1.5);
    noOverlap(after);
  });
  it('moves an item away from the door', () => {
    const m = room([['armchair', 0.7, 3.4]]);
    const r = ok(refineRoomOffline(m, 'move the armchair away from the door'));
    const a = apply(m, r.ops).furniture[0];
    expect(Math.hypot(a.x - 0.6, a.y - 4.2)).toBeGreaterThan(Math.hypot(0.7 - 0.6, 3.4 - 4.2));
  });
  it('moves to the left wall', () => {
    const m = room([['sofa-2', 2.0, 2.0]]);
    const a = apply(m, ok(refineRoomOffline(m, 'put the sofa against the left wall')).ops).furniture[0];
    expect(a.x).toBeLessThan(1.0);
  });
  it('moves to a corner', () => {
    const m = room([['plant', 1.7, 2.0]]);
    const a = apply(m, ok(refineRoomOffline(m, 'move the plant to the corner')).ops).furniture[0];
    const nearCorner = Math.min(a.x, 3.4 - a.x) < 0.7 && Math.min(a.y, 4.2 - a.y) < 0.7;
    expect(nearCorner).toBe(true);
  });
  it('moves to the centre', () => {
    const m = room([['armchair', 0.5, 0.6]]);
    const a = apply(m, ok(refineRoomOffline(m, 'move the armchair to the centre')).ops).furniture[0];
    expect(Math.abs(a.x - 1.7)).toBeLessThan(0.4);
  });
  it('moves next to another item', () => {
    const m = room([['sofa-2', 0.9, 1.5], ['floor-lamp', 3.0, 3.5]]);
    const r = ok(refineRoomOffline(m, 'move the lamp next to the sofa'));
    const after = apply(m, r.ops);
    const [sofa, lamp] = after.furniture;
    expect(Math.hypot(sofa.x - lamp.x, sofa.y - lamp.y)).toBeLessThan(2);
  });
  it('understands Swedish and Finnish move verbs', () => {
    const m = base();
    ok(refineRoomOffline(m, 'flytta soffan till fönstret'));
    ok(refineRoomOffline(m, 'siirrä sohva ikkunan viereen'));
  });
  it('answers with a typed cannot for a missing item', () => {
    const r = refineRoomOffline(base(), 'move the piano to the window');
    expect(r && !r.ok && r.cannot).toBe(true);
  });
  it('refuses to move a locked item', () => {
    const m = base();
    m.furniture[0] = { ...m.furniture[0], locked: true };
    const r = refineRoomOffline(m, 'move the sofa to the window');
    expect(r && !r.ok).toBe(true);
  });
});

describe('swap, remove, add, rotate', () => {
  it('swaps for a smaller one', () => {
    const m = room([['sofa-3', 1.7, 2.5]]);
    const a = apply(m, ok(refineRoomOffline(m, 'swap the sofa for a smaller one')).ops).furniture[0];
    expect(a.w).toBeLessThan(2.1);
    expect(a.catalogId).toBe('sofa-2');
  });
  it('swaps for a bigger one', () => {
    const m = room([['desk-120', 1.0, 3.0]]);
    const a = apply(m, ok(refineRoomOffline(m, 'make the desk bigger')).ops).furniture[0];
    expect(a.w).toBeGreaterThan(1.2);
  });
  it('swaps for a cheaper one', () => {
    const m = room([['sofa-3', 1.7, 2.5]]);
    const a = apply(m, ok(refineRoomOffline(m, 'replace the sofa with a cheaper one')).ops).furniture[0];
    expect(a.priceSek).toBeLessThan(7990);
  });
  it('says so when nothing smaller exists', () => {
    const r = refineRoomOffline(room([['plant', 1.7, 2.0]]), 'swap the plant for a smaller one');
    expect(r && !r.ok).toBe(true);
  });
  it('swaps one named piece for another', () => {
    const m = room([['sofa-2', 1.7, 2.5]]);
    const a = apply(m, ok(refineRoomOffline(m, 'replace the sofa with an armchair')).ops).furniture[0];
    expect(a.category).toBe('armchair');
  });
  it('removes an item', () => {
    const m = base();
    const after = apply(m, ok(refineRoomOffline(m, 'remove the plant')).ops);
    expect(after.furniture.some((f) => f.category === 'plant')).toBe(false);
  });
  it('removes all of a kind', () => {
    const m = room([['chair', 1.0, 3.0], ['chair', 2.0, 3.0], ['plant', 0.4, 0.4]]);
    const after = apply(m, ok(refineRoomOffline(m, 'remove all chairs')).ops);
    expect(after.furniture.map((f) => f.category)).toEqual(['plant']);
  });
  it('removes in Swedish and Finnish', () => {
    const m = base();
    expect(apply(m, ok(refineRoomOffline(m, 'ta bort växten')).ops).furniture.some((f) => f.category === 'plant')).toBe(false);
    expect(apply(m, ok(refineRoomOffline(m, 'poista kasvi')).ops).furniture.some((f) => f.category === 'plant')).toBe(false);
  });
  it('adds a counted number of items', () => {
    const m = room([]);
    const after = apply(m, ok(refineRoomOffline(m, 'add 2 chairs')).ops);
    expect(after.furniture.filter((f) => f.category === 'chair')).toHaveLength(2);
    noOverlap(after);
  });
  it('adds in Swedish', () => {
    const after = apply(room([]), ok(refineRoomOffline(room([]), 'lägg till en växt')).ops);
    expect(after.furniture[0].category).toBe('plant');
  });
  it('rotates by 90 degrees by default', () => {
    const m = room([['armchair', 1.7, 2.0]]);
    const a = apply(m, ok(refineRoomOffline(m, 'rotate the armchair')).ops).furniture[0];
    expect(a.rotation).toBeCloseTo(Math.PI / 2, 3);
  });
  it('rotates to a given angle and turns around', () => {
    const m = room([['armchair', 1.7, 2.0]]);
    expect(apply(m, ok(refineRoomOffline(m, 'turn the armchair 180')).ops).furniture[0].rotation).toBeCloseTo(Math.PI, 3);
    expect(apply(m, ok(refineRoomOffline(m, 'turn the armchair around')).ops).furniture[0].rotation).toBeCloseTo(Math.PI, 3);
  });
});

describe('whole-room intents', () => {
  it('makes more space by dropping decor', () => {
    const m = base();
    const after = apply(m, ok(refineRoomOffline(m, 'make more space')).ops);
    expect(after.furniture.length).toBeLessThan(m.furniture.length);
    expect(after.furniture.some((f) => f.category === 'plant')).toBe(false);
  });
  it('opens it up in Swedish', () => {
    ok(refineRoomOffline(base(), 'öppna upp rummet'));
  });
  it('makes it cozier with a rug, lamp and plant', () => {
    const m = room([['sofa-2', 1.7, 3.7, Math.PI]]);
    const after = apply(m, ok(refineRoomOffline(m, 'make it cozier')).ops);
    const cats = after.furniture.map((f) => f.category);
    expect(cats).toEqual(expect.arrayContaining(['rug', 'lamp', 'plant']));
    expect(after.furniture[0].color).not.toBe(m.furniture[0].color);
    noOverlap(after);
  });
  it('makes it minimal', () => {
    const m = base();
    const after = apply(m, ok(refineRoomOffline(m, 'make it minimal')).ops);
    expect(after.furniture.map((f) => f.category)).toEqual(['sofa', 'armchair']);
  });
  it('adds storage', () => {
    const m = room([['sofa-2', 1.7, 3.7, Math.PI]]);
    const after = apply(m, ok(refineRoomOffline(m, 'I need more storage')).ops);
    expect(after.furniture.length).toBeGreaterThan(1);
    noOverlap(after);
  });
  it('gives room for two: wider bed and nightstand', () => {
    const m = room([['bed-single', 1.7, 1.4]]);
    const after = apply(m, ok(refineRoomOffline(m, 'room for two people')).ops);
    expect(after.furniture[0].w).toBeGreaterThan(0.9);
    expect(after.furniture.some((f) => f.category === 'nightstand')).toBe(true);
  });
  it('gives a second desk and chair', () => {
    const m = room([['desk-120', 1.0, 3.0], ['desk-chair', 1.0, 2.4]]);
    const after = apply(m, ok(refineRoomOffline(m, 'room for two')).ops);
    expect(after.furniture.filter((f) => f.category === 'desk')).toHaveLength(2);
  });
  it('makes it kid-safe', () => {
    const m = base();
    const after = apply(m, ok(refineRoomOffline(m, 'make it kid safe')).ops);
    expect(after.furniture.some((f) => f.category === 'coffee-table')).toBe(false);
    expect(after.furniture.some((f) => f.category === 'rug')).toBe(true);
  });
  it('keeps a 1.5 m turning circle for a wheelchair', () => {
    const m = room([['sofa-2', 1.7, 2.1], ['armchair', 1.0, 1.0], ['plant', 2.6, 1.6], ['floor-lamp', 1.2, 2.2]]);
    const r = ok(refineRoomOffline(m, 'make it wheelchair friendly'));
    const after = apply(m, r.ops);
    expect(turningCircle(after, after.furniture)).not.toBeNull();
  });
  it('sets up a home office near the window', () => {
    const m = room([]);
    const after = apply(m, ok(refineRoomOffline(m, 'I work from home')).ops);
    expect(after.furniture.some((f) => f.category === 'desk')).toBe(true);
    expect(after.furniture.some((f) => /chair/.test(f.category))).toBe(true);
  });
  it('gets ready for guests', () => {
    const m = room([]);
    const after = apply(m, ok(refineRoomOffline(m, 'make it guest ready')).ops);
    expect(after.furniture.some((f) => f.category === 'sofa-bed' || f.category === 'bed')).toBe(true);
  });
});

describe('colour, undo and clauses', () => {
  it('recolours wood to walnut', () => {
    const m = room([['desk-140', 1.7, 2.0], ['sofa-2', 1.7, 3.5]]);
    const after = apply(m, ok(refineRoomOffline(m, 'walnut')).ops);
    expect(after.furniture[0].material).toBe('walnut');
  });
  it('paints one item a colour', () => {
    const m = base();
    const after = apply(m, ok(refineRoomOffline(m, 'make the sofa blue')).ops);
    expect(after.furniture.find((f) => f.category === 'sofa')!.color).toBe('#4f6f95');
    expect(after.furniture.find((f) => f.category === 'plant')!.color).toBe(m.furniture.find((f) => f.category === 'plant')!.color);
  });
  it('paints everything white', () => {
    const m = base();
    const after = apply(m, ok(refineRoomOffline(m, 'all white')).ops);
    expect(after.furniture.filter((f) => f.category !== 'rug').every((f) => f.color === '#f2f0ea')).toBe(true);
  });
  it('cannot recolour the floor but names the nearest thing', () => {
    const r = refineRoomOffline(base(), 'darker floor');
    expect(r && !r.ok && r.nearest.length).toBeTruthy();
  });
  it('undoes with previous furniture', () => {
    const m = base();
    const r = ok(refineRoomOffline(m, 'undo that', { previous: [] }));
    expect(apply(m, r.ops).furniture).toHaveLength(0);
    expect(r.undo).toBe(true);
  });
  it('applies several clauses in order', () => {
    const m = base();
    const r = ok(refineRoomOffline(m, 'remove the plant and add a rug'));
    const after = apply(m, r.ops);
    expect(after.furniture.some((f) => f.category === 'plant')).toBe(false);
    expect(after.furniture.some((f) => f.category === 'rug')).toBe(true);
    expect(r.label).toBe('2 changes');
  });
  it('returns null for sentences no rule reads', () => {
    expect(refineRoomOffline(base(), 'it feels like a library in autumn')).toBeNull();
  });
});

describe('validator', () => {
  it('drops ops for unknown ids', () => {
    const v = validateRoomOps(base(), [{ type: 'REMOVE_OBJECT', id: 'nope' }, { type: 'UPDATE_OBJECT', id: 'nope', patch: { x: 1 } }]);
    expect(v.ops).toHaveLength(0);
    expect(v.dropped).toHaveLength(2);
  });
  it('repairs a position outside the room', () => {
    const m = room([['armchair', 1.7, 2.0]]);
    const v = validateRoomOps(m, [{ type: 'UPDATE_OBJECT', id: m.furniture[0].id, patch: { x: 9, y: 9 } }]);
    expect(v.ops).toHaveLength(1);
    const a = apply(m, v.ops).furniture[0];
    expect(a.x).toBeLessThan(3.4);
    expect(a.y).toBeLessThan(4.2);
  });
  it('repairs an overlap', () => {
    const m = room([['sofa-2', 1.7, 2.0], ['armchair', 0.7, 0.6]]);
    const v = validateRoomOps(m, [{ type: 'UPDATE_OBJECT', id: m.furniture[1].id, patch: { x: 1.7, y: 2.0 } }]);
    noOverlap(apply(m, v.ops));
  });
  it('rejects non-finite numbers', () => {
    const m = room([['armchair', 1.7, 2.0]]);
    expect(validateRoomOps(m, [{ type: 'UPDATE_OBJECT', id: m.furniture[0].id, patch: { x: NaN } }]).ops).toHaveLength(0);
  });
  it('does not move locked items', () => {
    const m = room([['armchair', 1.7, 2.0]]);
    m.furniture[0].locked = true;
    expect(validateRoomOps(m, [{ type: 'UPDATE_OBJECT', id: m.furniture[0].id, patch: { x: 1.2 } }]).ops).toHaveLength(0);
  });
  it('keeps new items out of the door swing', () => {
    const m = room([]);
    const it = makeItem('armchair', { x: 0.6, y: 3.7 });
    const v = validateRoomOps(m, [{ type: 'PLACE_OBJECT', item: it }]);
    if (v.ops.length) {
      const placed = (v.ops[0] as Extract<Op, { type: 'PLACE_OBJECT' }>).item;
      expect(Math.hypot(placed.x - 0.6, placed.y - 3.7)).toBeGreaterThan(0.05);
    }
  });
  it('drops non-furniture ops', () => {
    expect(validateRoomOps(base(), [{ type: 'SET_CEILING', heightM: 9 }]).ops).toHaveLength(0);
  });
});

describe('ai patch conversion', () => {
  it('converts model patches and drops unknown ids and catalogue ids', () => {
    const m = base();
    const id = m.furniture[0].id;
    const { ops, dropped } = patchToOps(m, { ops: [
      { op: 'move', id, x: 1, y: 1 }, { op: 'remove', id: 'ghost' }, { op: 'add', catalogId: 'unicorn' }, { op: 'add', catalogId: 'plant' },
      { op: 'recolor', id, color: 'blue' }, { op: 'rotate', id, rotationDeg: 90 },
    ] });
    expect(ops.map((o) => o.type)).toEqual(['UPDATE_OBJECT', 'PLACE_OBJECT', 'UPDATE_OBJECT']);
    expect(dropped.length).toBe(3);
  });
  it('tolerates a malformed patch', () => {
    expect(patchToOps(base(), { ops: undefined as never }).ops).toHaveLength(0);
  });
  it('diffToOps round-trips', () => {
    const m = base();
    const next = m.furniture.slice(1).map((f) => ({ ...f, x: f.x + 0.1 }));
    expect(apply(m, diffToOps(m.furniture, next)).furniture.map((f) => f.x)).toEqual(next.map((f) => f.x));
  });
});
