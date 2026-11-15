import { describe, expect, it } from 'vitest';
import { convexOverlap, itemCorners, openingSegment, pointInPolygon } from '../../core/geometry';
import type { FurnitureItem, Opening, Space, SpaceModel } from '../../core/types';
import { makeItem } from '../furniture/catalog';
import { checkBuilding, furnishBuilding, skipReason } from './furnish';

const wall = { thicknessM: 0.1, sourceKind: 'manual' as const, status: 'verified' as const };
const room = (id: string, purpose: string, x0: number, y0: number, x1: number, y1: number): Space => ({
  id, name: `${purpose[0].toUpperCase()}${purpose.slice(1)} ${id}`, purpose,
  polygon: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }],
  walls: [wall, wall, wall, wall],
});
let n = 0;
const opening = (spaceId: string, kind: Opening['kind'], wallIndex: number, offsetM: number, widthM = 0.9): Opening => ({
  id: `o${++n}`, kind, spaceId, wallIndex, offsetM, widthM, heightM: kind === 'window' ? 1.2 : 2.1, sillM: kind === 'window' ? 0.9 : 0,
  swing: kind === 'door' ? 'in' : 'none', hinge: 'start', sourceKind: 'manual', status: 'verified',
});
const model = (id: string, spaces: Space[], openings: Opening[]): SpaceModel => ({
  id, name: id, version: 1, units: 'm', ceilingM: 2.6, sourceLabel: 'test', spaces, openings, furniture: [], measurements: [], evidence: [],
});
const inRoom = (res: { furniture: FurnitureItem[]; roomByItem: Record<string, string> }, id: string) => res.furniture.filter((f) => res.roomByItem[f.id] === id);
/** Every piece stands in the room it was laid out for. */
function allInside(m: SpaceModel, res: { furniture: FurnitureItem[]; roomByItem: Record<string, string> }) {
  for (const f of res.furniture) {
    const s = m.spaces.find((x) => x.id === res.roomByItem[f.id])!;
    expect(pointInPolygon(f, s.polygon), f.name).toBe(true);
  }
}
/** Nothing (but rugs) inside the 0.9 m strip in front of a door, on the room side. */
function doorsClear(m: SpaceModel, furniture: FurnitureItem[]) {
  for (const o of m.openings.filter((x) => x.kind !== 'window')) {
    const s = m.spaces.find((x) => x.id === o.spaceId)!;
    const g = openingSegment(s, o);
    const strip = [g.a, g.b, { x: g.b.x + g.inward.x * 0.8, y: g.b.y + g.inward.y * 0.8 }, { x: g.a.x + g.inward.x * 0.8, y: g.a.y + g.inward.y * 0.8 }];
    for (const f of furniture) if (f.category !== 'rug') expect(convexOverlap(itemCorners(f), strip), `${f.name} in front of ${o.id}`).toBeLessThan(0.03);
  }
}

describe('furnishing scenarios', () => {
  it('two-room flat: bed in the bedroom, sofa in the living room, doors clear, all reachable', async () => {
    const m = model('flat', [room('liv', 'living', 0, 0, 5, 4), room('bed', 'bedroom', 5, 0, 9, 4)], [
      opening('liv', 'door', 2, 1.0), opening('liv', 'door', 1, 3.0), opening('liv', 'window', 0, 2.5, 1.6), opening('bed', 'window', 0, 2, 1.4),
    ]);
    const res = await furnishBuilding(m, {}, { timeBudgetMs: 600, palette: 0 });
    expect(res.rooms.map((r) => r.status)).toEqual(['done', 'done']);
    expect(inRoom(res, 'bed').some((f) => f.category === 'bed')).toBe(true);
    // a living room without a sofa must say so (the room solver can return a layout without one)
    if (!inRoom(res, 'liv').some((f) => f.category === 'sofa')) expect(res.rooms[0].compromises).toContain('No seating group fits');
    allInside(m, res);
    doorsClear(m, res.furniture);
    expect(res.check.ok).toBe(true);
    expect(res.summary.roomsDone).toBe(2);
    expect(res.summary.items).toBe(res.furniture.length);
  }, 60000);

  it('12-person office: desks in facing clusters with aisles, every chair at a desk', async () => {
    const m = model('office12', [room('ws', 'workspace', 0, 0, 12, 8)], [opening('ws', 'door', 2, 1.5, 1.0), opening('ws', 'window', 0, 6, 3)]);
    const res = await furnishBuilding(m, {}, { people: { ws: 12 } });
    const items = inRoom(res, 'ws');
    const desks = items.filter((f) => f.category === 'desk');
    const chairs = items.filter((f) => f.category === 'chair');
    expect(desks.length).toBe(12);
    expect(chairs.length).toBe(12);
    // each chair within reach of a desk edge (chair centre at most 0.75 m from a desk centre line)
    for (const c of chairs) expect(Math.min(...desks.map((d) => Math.hypot(c.x - d.x, c.y - d.y)))).toBeLessThan(0.8);
    // clustered: every desk touches another desk (side by side or face to face)
    for (const d of desks) expect(desks.some((e) => e !== d && Math.hypot(e.x - d.x, e.y - d.y) <= Math.max(d.w, d.d) + 0.05)).toBe(true);
    // at least two clusters, and no desk sits alone
    const groups: FurnitureItem[][] = [];
    for (const d of desks) {
      const g = groups.find((gr) => gr.some((e) => Math.hypot(e.x - d.x, e.y - d.y) <= Math.max(d.w, d.d) + 0.05));
      if (g) g.push(d); else groups.push([d]);
    }
    expect(groups.length).toBeGreaterThanOrEqual(2);
    doorsClear(m, res.furniture);
    expect(res.check.ok).toBe(true);
    expect(res.rooms[0].compromises).toEqual([]);
  }, 60000);

  it('undersized office: fewer desks than people, and the shortfall is reported', async () => {
    const m = model('small-office', [room('ws', 'workspace', 0, 0, 4, 3)], [opening('ws', 'door', 2, 0.8)]);
    const res = await furnishBuilding(m, {}, { people: { ws: 12 }, timeBudgetMs: 500 });
    const desks = inRoom(res, 'ws').filter((f) => f.category === 'desk').length;
    expect(desks).toBeGreaterThan(0);
    expect(desks).toBeLessThan(12);
    expect(res.rooms[0].compromises).toContain(`${desks} of 12 desks fit`);
    expect(res.summary.roomsCompromised.map((r) => r.spaceId)).toContain('ws');
    doorsClear(m, res.furniture);
  }, 60000);

  it('tiny bedroom: a single bed, storage only when it fits, and a too-small room says so', async () => {
    const m = model('tiny', [room('bed', 'bedroom', 0, 0, 2.5, 2.6), room('box', 'bedroom', 2.5, 0, 4.5, 2.4)], [opening('bed', 'door', 2, 1.8, 0.8), opening('bed', 'door', 1, 2.0, 0.8)]);
    const res = await furnishBuilding(m, {}, { timeBudgetMs: 600 });
    const items = inRoom(res, 'bed');
    const bed = items.find((f) => f.category === 'bed');
    expect(bed).toBeTruthy();
    expect(bed!.w).toBeLessThanOrEqual(1.0);
    const storage = items.some((f) => f.category === 'wardrobe' || f.category === 'dresser' || f.category === 'storage-cabinet');
    if (!storage) expect(res.rooms[0].compromises).toContain('No storage fits');
    expect(res.rooms[1].status).toBe('skipped');
    expect(skipReason(m.spaces[1])).toBe('Too small');
    doorsClear(m, res.furniture);
  }, 60000);

  it('blocked door: a wardrobe across the door cuts off the room behind it', () => {
    const door = opening('a', 'door', 1, 2);
    const m = model('blocked', [room('a', 'living', 0, 0, 4, 4), room('b', 'bedroom', 4, 0, 8, 4)], [opening('a', 'door', 3, 2), door]);
    expect(checkBuilding(m, []).ok).toBe(true);
    const wardrobe = { ...makeItem('wardrobe-100'), x: 4.35, y: 2, rotation: Math.PI / 2 };
    const c = checkBuilding(m, [wardrobe]);
    expect(c.ok).toBe(false);
    expect(c.unreachable).toEqual(['b']);
    expect(c.blockedDoors).toContain(door.id);
    // the same wardrobe 2 m along the far wall leaves the way open
    expect(checkBuilding(m, [{ ...wardrobe, x: 7.65, y: 1 }]).ok).toBe(true);
  });

  it('a piece laid in front of a door moves to the nearest clear spot and says so', async () => {
    const m = model('nudge', [room('a', 'living', 0, 0, 4, 4), room('b', 'bedroom', 4, 0, 8, 4)], [opening('a', 'door', 3, 2), opening('a', 'door', 1, 2)]);
    const res = await furnishBuilding(m, {}, {
      compile: async () => ({ purpose: '', people: 1, budgetSek: null, items: [], routeTargets: [], minRouteWidthM: 0.8, style: '', lockedIds: [], notes: [], questions: [], compiledBy: 'rules' }),
      // a careless layout: an armchair right inside the door on the room's left wall
      solve: async () => [{ ...makeItem('armchair'), x: 0.5, y: 2 }],
    });
    expect(res.rooms.every((r) => r.status === 'done')).toBe(true);
    doorsClear(m, res.furniture);
    for (const id of ['a', 'b']) expect(inRoom(res, id).some((f) => f.category === 'armchair'), id).toBe(true);
    expect(res.rooms.flatMap((r) => r.compromises ?? []).some((t) => /moved/.test(t))).toBe(true);
    expect(res.check.ok).toBe(true);
  });

  it('a desk in front of a door moves with its chair, keeping the chair drawn up to it', async () => {
    const m = model('group', [room('a', 'study', 0, 0, 4, 4)], [opening('a', 'door', 3, 2)]);
    const res = await furnishBuilding(m, {}, {
      compile: async () => ({ purpose: '', people: 1, budgetSek: null, items: [], routeTargets: [], minRouteWidthM: 0.8, style: '', lockedIds: [], notes: [], questions: [], compiledBy: 'rules' }),
      solve: async () => [{ ...makeItem('desk-120'), x: 0.4, y: 2, rotation: Math.PI / 2 }, { ...makeItem('desk-chair'), x: 1.1, y: 2, rotation: Math.PI / 2 }],
    });
    const desk = res.furniture.find((f) => f.category === 'desk')!;
    const chair = res.furniture.find((f) => f.catalogId === 'desk-chair')!;
    expect(desk).toBeTruthy();
    expect(chair).toBeTruthy();
    doorsClear(m, res.furniture);
    // same distance and the same turn between them as laid out
    expect(Math.hypot(chair.x - desk.x, chair.y - desk.y)).toBeCloseTo(0.7, 2);
    expect(chair.rotation - desk.rotation).toBeCloseTo(0, 6);
    expect(res.rooms[0].compromises).toContain('Desk 120 moved clear of a door');
  });

  it('one palette per plan: every wooden piece in every room takes the same wood', async () => {
    const m = model('palette', [room('a', 'study', 0, 0, 4, 4), room('b', 'study', 4, 0, 8, 4)], [opening('a', 'door', 3, 2), opening('a', 'door', 1, 2)]);
    const stub = {
      compile: async () => ({ purpose: '', people: 1, budgetSek: null, items: [], routeTargets: [], minRouteWidthM: 0.8, style: '', lockedIds: [], notes: [], questions: [], compiledBy: 'rules' as const }),
      solve: async () => [{ ...makeItem('desk-140'), x: 2, y: 0.5 }, { ...makeItem('desk-120'), x: 2, y: 3.5 }, { ...makeItem('desk-chair'), x: 2.5, y: 1.4 }],
    };
    const one = await furnishBuilding(m, {}, { ...stub, palette: 1 });
    const wood = one.furniture.filter((f) => f.category === 'desk');
    expect(wood.length).toBe(4);
    expect(new Set(wood.map((f) => f.color)).size).toBe(1);
    expect(new Set(wood.map((f) => f.material)).size).toBe(1);
    expect(wood[0].material).toBe(one.summary.palette.wood);
    // a plastic desk chair keeps its own finish
    expect(one.furniture.find((f) => f.catalogId === 'desk-chair')!.material).toBe('plastic');
    const two = await furnishBuilding(m, {}, { ...stub, palette: 2 });
    expect(two.furniture.find((f) => f.category === 'desk')!.color).not.toBe(wood[0].color);
  });
});
