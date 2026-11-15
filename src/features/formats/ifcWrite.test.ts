import { describe, expect, it } from 'vitest';
import { sampleRoom } from '../../core/sample';
import type { FurnitureItem, Opening, Space, SpaceModel } from '../../core/types';
import { doorOperation, furnitureType, ifcGuid, modelToIfc, netFloorArea } from './ifcWrite';
import { parseStep, validateIfc } from './ifcValidate';
import type { StepEnt, Val } from './ifcValidate';

const W = (t = 0.12) => ({ thicknessM: t, sourceKind: 'manual' as const, status: 'estimated' as const });
const room = (id: string, name: string, poly: Array<[number, number]>, purpose?: string): Space =>
  ({ id, name, purpose, polygon: poly.map(([x, y]) => ({ x, y })), walls: poly.map(() => W()) });
const door = (id: string, spaceId: string, wallIndex: number, offsetM: number, over: Partial<Opening> = {}): Opening =>
  ({ id, kind: 'door', spaceId, wallIndex, offsetM, widthM: 0.9, heightM: 2.05, sillM: 0, swing: 'in', hinge: 'start', sourceKind: 'manual', status: 'estimated', ...over });
const item = (id: string, category: string, x: number, y: number, over: Partial<FurnitureItem> = {}): FurnitureItem => ({
  id, catalogId: `cat-${id}`, name: `Real ${category} ${id}`, category, x, y, rotation: 0, w: 1, d: 0.5, h: 0.8,
  clearance: { front: 0, back: 0, left: 0, right: 0 }, locked: false, owned: false, priceSek: 1299, priceStatus: 'catalog', color: '#888', sourceKind: 'catalog', ...over,
});

/** Three rooms in an L: A and B share x=4, A and C share y=3. */
export function threeRooms(): SpaceModel {
  const base = sampleRoom();
  return {
    ...base, id: 'three', name: 'Three rooms', ceilingM: 2.6,
    spaces: [
      room('A', 'Living room', [[0, 0], [4, 0], [4, 3], [0, 3]], 'living'),
      room('B', 'Kitchen', [[4, 0], [7, 0], [7, 3], [4, 3]], 'kitchen'),
      room('C', 'Bedéroom', [[0, 3], [4, 3], [4, 6], [0, 6]], 'bedroom'),
    ],
    openings: [
      door('dAB', 'A', 1, 1.0),                                  // on the A/B wall, seen from A
      door('dCA', 'C', 0, 3.0, { hinge: 'end', swing: 'out' }),  // on the A/C wall, seen from C (reversed edge for A)
      { ...door('wA', 'A', 0, 2.0), kind: 'window', widthM: 1.4, heightM: 1.3, sillM: 0.85, swing: 'none' },
      { ...door('gap', 'B', 0, 1.5), kind: 'opening', widthM: 1.2 },
    ],
    furniture: [
      item('sofa1', 'sofa', 1, 1), item('desk1', 'desk', 5, 1, { priceSek: 0, priceStatus: 'owned', owned: true, sourceKind: 'user-measured' }),
      item('wardrobe1', 'wardrobe', 1, 5, { rotation: Math.PI / 2 }),
      item('shelf1', 'wall-shelf', 6.5, 1, { elevationM: 1.4, mount: 'wall' }),
    ],
    measurements: [],
  };
}

type Tf = { o: [number, number, number]; x: [number, number]; y: [number, number] };
function world(ents: Map<number, StepEnt>, id: number): Tf {
  const e = ents.get(id)!;
  const a = e.args as Val[];
  const ax = ents.get((a[1] as { ref: number }).ref)!;
  const pt = (ents.get((ax.args[0] as { ref: number }).ref)!.args[0] as number[]);
  const xd = ax.args[2] ? (ents.get((ax.args[2] as { ref: number }).ref)!.args[0] as number[]) : [1, 0, 0];
  const own: Tf = { o: [pt[0], pt[1], pt[2]], x: [xd[0], xd[1]], y: [-xd[1], xd[0]] };
  if (!a[0]) return own;
  const r = world(ents, (a[0] as { ref: number }).ref);
  return {
    o: [r.o[0] + r.x[0] * own.o[0] + r.y[0] * own.o[1], r.o[1] + r.x[1] * own.o[0] + r.y[1] * own.o[1], r.o[2] + own.o[2]],
    x: [r.x[0] * own.x[0] + r.y[0] * own.x[1], r.x[1] * own.x[0] + r.y[1] * own.x[1]],
    y: [r.x[0] * own.y[0] + r.y[0] * own.y[1], r.x[1] * own.y[0] + r.y[1] * own.y[1]],
  };
}

describe('ifc writer: structure and validity', () => {
  const model = threeRooms();
  const text = modelToIfc(model);
  const { ents } = parseStep(text);
  const all = [...ents.values()];
  const named = (n: string) => all.filter((e) => e.name === n);

  it('passes the strict validator', () => {
    expect(validateIfc(text)).toEqual([]);
  });
  it('validator also passes the single sample room and an empty model', () => {
    expect(validateIfc(modelToIfc(sampleRoom()))).toEqual([]);
    expect(validateIfc(modelToIfc({ ...sampleRoom(), spaces: [], openings: [], furniture: [] }))).toEqual([]);
  });
  it('validator catches broken files', () => {
    const wallRef = named('IFCRELVOIDSELEMENT')[0];
    const bad = text.replace(new RegExp(`#${wallRef.id}=IFCRELVOIDSELEMENT\\(([^,]*),([^,]*),\\$,\\$,#\\d+,`), (m, a, b) => `#${wallRef.id}=IFCRELVOIDSELEMENT(${a},${b},$,$,#${named('IFCSPACE')[0].id},`);
    expect(validateIfc(bad).join('\n')).toMatch(/is IFCSPACE, expected IFCWALL/);
    expect(validateIfc(text.replace(/#\d+=IFCRELCONTAINEDINSPATIALSTRUCTURE/, '#99999=IFCRELFOO'))).not.toEqual([]);
    expect(validateIfc(text.replace("IFCPROJECT(", 'IFCPROJECT($,')).length).toBeGreaterThan(0);
    // a duplicate GlobalId
    const g = /IFCSPACE\('([^']+)'/.exec(text)![1];
    expect(validateIfc(text.replace(/IFCWALL\('[^']+'/, `IFCWALL('${g}'`).split('\n').join('\n')).join('\n')).toMatch(/GlobalId also used/);
  });
  it('has the owner history, a Body and an Axis context, and the full unit set', () => {
    expect(named('IFCOWNERHISTORY')).toHaveLength(1);
    const ids = named('IFCGEOMETRICREPRESENTATIONSUBCONTEXT').map((e) => e.args[0]);
    expect(ids).toEqual(expect.arrayContaining(['Body', 'Axis']));
    for (const u of ['LENGTHUNIT', 'AREAUNIT', 'VOLUMEUNIT', 'PLANEANGLEUNIT', 'MASSUNIT', 'TIMEUNIT']) expect(text).toContain(`.${u}.`);
    expect(text).toContain("IFCMONETARYUNIT('SEK')");
  });
  it('writes one wall per distinct edge: shared edges are not doubled', () => {
    expect(named('IFCWALL')).toHaveLength(12 - 2);
    expect(named('IFCWALLSTANDARDCASE')).toHaveLength(0);
    expect(named('IFCRELASSOCIATESMATERIAL')).toHaveLength(10);
    // each wall has an axis and a body
    for (const w of named('IFCWALL')) {
      const pds = ents.get((w.args[6] as { ref: number }).ref)!;
      const reps = (pds.args[2] as Array<{ ref: number }>).map((r) => ents.get(r.ref)!.args[1]);
      expect(reps).toEqual(['Axis', 'Body']);
    }
  });
  it('aggregates spaces to the storey and contains walls, doors, windows, furniture', () => {
    expect(named('IFCSPACE')).toHaveLength(3);
    const contained = named('IFCRELCONTAINEDINSPATIALSTRUCTURE')[0];
    const kinds = (contained.args[4] as Array<{ ref: number }>).map((r) => ents.get(r.ref)!.name);
    expect(kinds.filter((k) => k === 'IFCWALL')).toHaveLength(10);
    expect(kinds.filter((k) => k === 'IFCDOOR')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'IFCWINDOW')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'IFCFURNITURE')).toHaveLength(4);
    expect(kinds).not.toContain('IFCSPACE');
  });
  it('voids a shared wall once per opening and fills doors and windows, not the plain gap', () => {
    expect(named('IFCOPENINGELEMENT')).toHaveLength(4);
    expect(named('IFCRELVOIDSELEMENT')).toHaveLength(4);
    expect(named('IFCRELFILLSELEMENT')).toHaveLength(3);
  });
  it('places each opening inside its host wall, seen from either room', () => {
    const byGuid = (key: string) => all.find((e) => e.args[0] === ifcGuid(key))!;
    const hostOf = (holeId: number) => ents.get((named('IFCRELVOIDSELEMENT').find((r) => (r.args[5] as { ref: number }).ref === holeId)!.args[4] as { ref: number }).ref)!;
    const expectAt = (key: string, x: number, y: number, z: number, w: number) => {
      const hole = byGuid('void:' + key);
      const h = world(ents, (hole.args[5] as { ref: number }).ref);
      expect(h.o[0]).toBeCloseTo(x, 4); expect(-h.o[1]).toBeCloseTo(y, 4); expect(h.o[2]).toBeCloseTo(z, 4);
      // in the host wall's frame: along the wall inside its length, across it within half the thickness
      const host = hostOf(hole.id);
      const wp = world(ents, (host.args[5] as { ref: number }).ref);
      const dx = h.o[0] - wp.o[0], dy = h.o[1] - wp.o[1];
      const along = dx * wp.x[0] + dy * wp.x[1], across = dx * wp.y[0] + dy * wp.y[1];
      expect(Math.abs(across)).toBeLessThan(1e-6);
      expect(along - w / 2).toBeGreaterThan(-1e-6);
      expect(along + w / 2).toBeLessThan(wallLength(host) + 1e-6);
      return { h, wp };
    };
    const wallLength = (wall: StepEnt) => {
      const pds = ents.get((wall.args[6] as { ref: number }).ref)!;
      const axisRep = (pds.args[2] as Array<{ ref: number }>).map((r) => ents.get(r.ref)!).find((r) => r.args[1] === 'Axis')!;
      const pl = ents.get((axisRep.args[3] as Array<{ ref: number }>)[0].ref)!;
      const last = ents.get((pl.args[0] as Array<{ ref: number }>)[1].ref)!.args[0] as number[];
      return last[0];
    };
    expectAt('dAB', 4, 1, 0, 0.9);
    expectAt('dCA', 3, 3, 0, 0.9);       // given from C along its edge (0,3)->(4,3)
    expectAt('wA', 2, 0, 0.85, 1.4);
    expectAt('gap', 5.5, 0, 0, 1.2);
    // the door sits where its hole is, and the sill is respected
    const doorEnt = byGuid('opening:dAB');
    expect(world(ents, (doorEnt.args[5] as { ref: number }).ref).o).toEqual(world(ents, (byGuid('void:dAB').args[5] as { ref: number }).ref).o);
  });
  it('maps swing and hinge to the door operation, seen from the swing side', () => {
    const op = (id: string) => (byGuidArgs('opening:' + id)[11] as { en: string }).en;
    const byGuidArgs = (key: string) => all.find((e) => e.args[0] === ifcGuid(key))!.args;
    // A/B wall runs north to south (plan y down); leaf swings into A (west). From inside A, north is on the left.
    expect(op('dAB')).toBe('SINGLE_SWING_LEFT');
    expect(doorOperation({ x: 0, y: 1 }, { x: -1, y: 0 }, 'start')).toBe('SINGLE_SWING_LEFT');
    expect(doorOperation({ x: 0, y: 1 }, { x: -1, y: 0 }, 'end')).toBe('SINGLE_SWING_RIGHT');
    // the same wall seen from the other side flips handedness
    expect(doorOperation({ x: 0, y: 1 }, { x: 1, y: 0 }, 'start')).toBe('SINGLE_SWING_RIGHT');
    expect(op('dCA')).toMatch(/SINGLE_SWING_(LEFT|RIGHT)/);
    expect(byGuidArgs('opening:dAB')[8]).toBeCloseTo(2.05);
    expect(byGuidArgs('opening:dAB')[9]).toBeCloseTo(0.9);
    expect(doorOperation({ x: 1, y: 0 }, { x: 0, y: 1 }, 'start')).not.toBe(doorOperation({ x: 1, y: 0 }, { x: 0, y: -1 }, 'start'));
  });
  it('writes spaces with long name, purpose and base quantities', () => {
    const sp = named('IFCSPACE').map((s) => ({ name: s.args[2], desc: s.args[3], long: s.args[7] }));
    expect(sp.map((s) => s.long)).toEqual(['Living room', 'Kitchen', 'Bed\\X2\\00E9\\X0\\room']);
    expect(sp.map((s) => s.desc)).toEqual(['living', 'kitchen', 'bedroom']);
    const qto = named('IFCELEMENTQUANTITY').find((q) => q.args[0] === ifcGuid('qto:A'))!;
    expect(qto.args[2]).toBe('Qto_SpaceBaseQuantities');
    const qs = (qto.args[5] as Array<{ ref: number }>).map((r) => ents.get(r.ref)!);
    const val = (n: string) => qs.find((q) => q.args[0] === n)!.args[3] as number;
    expect(val('NetFloorArea')).toBeCloseTo((4 - 0.12) * (3 - 0.12), 5);
    expect(val('GrossFloorArea')).toBeCloseTo(12, 5);
    expect(val('Height')).toBeCloseTo(2.6, 5);
  });
  it('net floor area handles an L shape', () => {
    const L = room('L', 'L', [[0, 0], [4, 0], [4, 2], [2, 2], [2, 3], [0, 3]]);
    // outline moved in 6 cm all round: an L has 5 convex corners and 1 reflex corner
    const a = 10 - 0.06 * (4 + 2 + 2 + 1 + 2 + 3) + 0.0036 * 4;
    expect(netFloorArea(L)).toBeCloseTo(a, 6);
  });
  it('writes furniture with predefined type, real name and a price and source property set', () => {
    const f = named('IFCFURNITURE');
    const byName = (n: string) => f.find((e) => e.args[2] === n)!;
    expect((byName('Real sofa sofa1').args[8] as { en: string }).en).toBe('SOFA');
    expect((byName('Real desk desk1').args[8] as { en: string }).en).toBe('DESK');
    const w = byName('Real wardrobe wardrobe1');
    expect((w.args[8] as { en: string }).en).toBe('USERDEFINED');
    expect(w.args[4]).toBe('WARDROBE');
    expect((byName('Real wall-shelf shelf1').args[8] as { en: string }).en).toBe('SHELF');
    expect(world(ents, (byName('Real wall-shelf shelf1').args[5] as { ref: number }).ref).o[2]).toBeCloseTo(1.4);
    const rel = named('IFCRELDEFINESBYPROPERTIES').find((r) => (r.args[4] as Array<{ ref: number }>)[0].ref === byName('Real desk desk1').id)!;
    const pset = ents.get((rel.args[5] as { ref: number }).ref)!;
    const props = Object.fromEntries((pset.args[4] as Array<{ ref: number }>).map((r) => { const p = ents.get(r.ref)!; return [p.args[0], (p.args[2] as { args: Val[] }).args[0]]; }));
    expect(props.Price).toBe(0);
    expect(props.Source).toBe('user-measured');
    expect(props.PriceStatus).toBe('owned');
    expect(props.Owned).toEqual({ en: 'T' });
    expect(furnitureType('').type).toBe('NOTDEFINED');
  });
  it('is deterministic and every GlobalId is unique', () => {
    expect(modelToIfc(model)).toBe(text);
    const g = all.map((e) => e.args[0]).filter((v) => typeof v === 'string' && /^[0-3][0-9A-Za-z_$]{21}$/.test(v));
    expect(new Set(g).size).toBe(g.length);
    expect(ifcGuid('a')).toHaveLength(22);
    expect(ifcGuid('a')).not.toBe(ifcGuid('b'));
  });
  it('has a valid header', () => {
    expect(text.startsWith('ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(')).toBe(true);
    expect(text).toContain("FILE_SCHEMA(('IFC4'));");
    expect(text.trimEnd().endsWith('END-ISO-10303-21;')).toBe(true);
  });
});
