import { describe, expect, it } from 'vitest';
import { densityFactor, fireRadius, headwayFor, personAt, runDrill } from './drill';
import { buildSafetyGrid, cellAt } from './field';
import { door, item, model, rect, space, twoRoomFlat } from './fixtures';

const FAR = { x: -50, y: -50 };
// free walking, no reaction delay, no fire: isolates the thing a test is about
const plain = { reactionS: 0, fire: FAR, fireGrowthMS: 0, switching: false, freeFlow: true, mix: 'adult' as const };
const oneDoor = (w = 0.9) => model([space('r', 'Room', rect(0, 0, 5, 4))], [door('d', 'r', 3, 2, w, 'out')]);

describe('drill basics', () => {
  it('one door, four people: empties in the expected time', () => {
    const m = oneDoor();
    const starts = [{ x: 4.5, y: 1 }, { x: 4.5, y: 3 }, { x: 3.5, y: 2 }, { x: 4, y: 2 }];
    const r = runDrill(m, [], { starts, ...plain });
    expect(r.allOut).toBe(true);
    expect(r.totalS).toBeGreaterThan(2.5);
    expect(r.totalS).toBeLessThan(9);
    expect(r.pass).toBe(true);
    expect(runDrill(m, [], { starts, ...plain }).totalS).toBe(r.totalS);
  });

  it('a blocked door sends everyone to the other one', () => {
    const m = model([space('r', 'Room', rect(0, 0, 6, 4))], [door('l', 'r', 3, 2, 0.9, 'out'), door('rt', 'r', 1, 2, 0.9, 'out')]);
    const starts = [{ x: 1, y: 1 }, { x: 1.2, y: 2.6 }, { x: 2, y: 2 }];
    const o = { starts, fire: { x: 0.9, y: 3.7 }, reactionS: 0, fireGrowthMS: 0, switching: false };
    const open = runDrill(m, [], o);
    const shut = runDrill(m, [], { ...o, blockExit: true });
    expect(shut.blockedId).toBe('l');
    expect(shut.people.every((p) => p.escaped && p.exitId === 'rt')).toBe(true);
    expect(shut.totalS).toBeGreaterThan(open.totalS);
  });

  it('a chair in a 0.6 m gap is the bottleneck', () => {
    const wall = [item('w1', 'wardrobe', 3, 0.85, 0.5, 1.7, { locked: true }), item('w2', 'wardrobe', 3, 3.15, 0.5, 1.7, { locked: true })];
    const m = model([space('r', 'Room', rect(0, 0, 7, 4))], [door('d', 'r', 3, 2, 0.9, 'out')], wall);
    const starts = [4.5, 5, 5.5, 6, 6.5].flatMap((x) => [{ x, y: 1.2 }, { x, y: 2.8 }]);
    const r = runDrill(m, wall, { starts, ...plain });
    expect(r.allOut).toBe(true);
    expect(r.bottleneck).not.toBeNull();
    expect(r.bottleneck!.kind).toBe('gap');
    expect(r.bottleneck!.widthM).toBeGreaterThan(0.5);
    expect(r.bottleneck!.widthM).toBeLessThan(0.65);
    expect(r.bottleneck!.queue).toBeGreaterThan(2);
    expect(r.bottleneck!.lostS).toBeGreaterThan(1);
    expect(r.fix?.label).toMatch(/^Move /);
    expect(r.fix?.itemId).toMatch(/^w[12]$/);
  });

  it('nobody walks through walls or furniture', () => {
    const m = twoRoomFlat();
    const r = runDrill(m, m.furniture, { occupants: 6, seed: 3 });
    const g = buildSafetyGrid(m, m.furniture);
    expect(r.occupants).toBe(6);
    expect(r.allOut).toBe(true);
    for (const p of r.people) for (const q of p.track) {
      const c = cellAt(g, q);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(g.free[c]).toBe(1);
    }
    const p0 = r.people[0];
    expect(personAt(p0, 0, r.dt)).toEqual(p0.start);
    expect(personAt(p0, (p0.exitS ?? 0) + 1, r.dt)).toBeNull();
  });
});

describe('formulas a fire engineer can check by hand', () => {
  it('door flow: 1.3 persons per second per metre of width minus 0.15 m each side', () => {
    expect(headwayFor(0.9)).toBeCloseTo(1 / (1.3 * 0.6), 6); // 1.282 s
    expect(headwayFor(0.8)).toBeCloseTo(1 / (1.3 * 0.5), 6); // 1.538 s
    expect(headwayFor(1.8)).toBeLessThan(headwayFor(0.9) / 2); // wider passes more than proportionally
  });
  it('walking speed falls with density and is free below about 0.5 persons per m2', () => {
    expect(densityFactor(0.3)).toBeGreaterThan(0.95);
    expect(densityFactor(2)).toBeCloseTo(1 - Math.exp(-1.913 * (0.5 - 1 / 5.4)), 6);
    expect(densityFactor(4)).toBeLessThan(densityFactor(2));
    expect(densityFactor(6)).toBeLessThanOrEqual(0.06);
  });
  it('fire radius starts at 0.5 m, grows 1.5 cm/s, caps at 3 m', () => {
    expect(fireRadius(0)).toBe(0.5);
    expect(fireRadius(60)).toBeCloseTo(1.4, 6);
    expect(fireRadius(1e4)).toBe(3);
  });

  it('ten people at a 0.9 m door leave one every 1.28 s', () => {
    const m = oneDoor(0.9);
    const starts = Array.from({ length: 10 }, () => ({ x: 2, y: 2 }));
    const r = runDrill(m, [], { starts, ...plain });
    const t = r.people.map((p) => p.exitS!).sort((a, b) => a - b);
    for (let i = 1; i < t.length; i++) expect(t[i] - t[i - 1]).toBeCloseTo(headwayFor(r.bottleneck!.widthM), 2);
    expect(t[9] - t[0]).toBeCloseTo(9 * headwayFor(r.bottleneck!.widthM), 1);
    expect(r.bottleneck!.kind).toBe('door');
    expect(r.bottleneck!.queue).toBe(10);
    expect(r.timeTo.p100).toBe(r.totalS);
  });

  it('30 people at a 0.8 m door: the queue, its length and the last person out', () => {
    const m = oneDoor(0.8);
    const starts: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < 6; i++) for (let j = 0; j < 5; j++) starts.push({ x: 1.2 + i * 0.5, y: 0.8 + j * 0.6 });
    const r = runDrill(m, [], { starts, ...plain });
    const h = headwayFor(r.bottleneck!.widthM);
    const t = r.people.map((p) => p.exitS!).sort((a, b) => a - b);
    expect(r.allOut).toBe(true);
    expect(r.bottleneck!.kind).toBe('door');
    expect(r.bottleneck!.doorId).toBe('d');
    expect(h).toBeGreaterThan(1.4); // about 1.5 s per person through 0.8 m
    expect(t[29] - t[0]).toBeGreaterThanOrEqual(29 * h - 0.01);
    expect(r.bottleneck!.queue).toBeGreaterThan(12);
    expect(r.bottleneck!.lengthM).toBeCloseTo(r.bottleneck!.queue * 0.45, 2);
    expect(r.bottleneck!.lostS).toBeGreaterThan(20);
    expect(r.timeTo.p50!).toBeLessThan(r.timeTo.p90!);
    expect(r.timeTo.p90!).toBeLessThan(r.timeTo.p100!);
    expect(r.targetMet).toBe(true);
  });

  it('a corridor bottleneck: time to clear equals the walk plus the door-flow formula', () => {
    // 1.2 m wide, 10 m long corridor ending in a 0.9 m door; 8 people start together at the far end
    const m = model([space('c', 'Corridor', rect(0, 0, 10, 1.2))], [door('d', 'c', 3, 0.6, 0.9, 'out')]);
    const starts = Array.from({ length: 8 }, () => ({ x: 9.3, y: 0.6 }));
    const r = runDrill(m, [], { starts, ...plain });
    const t = r.people.map((p) => p.exitS!).sort((a, b) => a - b);
    const h = headwayFor(r.bottleneck!.widthM);
    expect(t[0]).toBeGreaterThan(9.3 / 1.2 - 0.6);
    expect(t[0]).toBeLessThan(9.3 / 1.2 + 1.2);
    expect(t[7] - t[0]).toBeCloseTo(7 * h, 1);
  });
});

describe('who walks, and when', () => {
  const alone = (mix: 'adult' | 'child' | 'mobility') => runDrill(oneDoor(1.2), [], { starts: [{ x: 4.5, y: 2 }], ...plain, mix }).people[0];
  it('speeds by type: adult 1.2, child 0.9, reduced mobility 0.7 m/s', () => {
    const a = alone('adult'), c = alone('child'), mob = alone('mobility');
    expect([a.speedMS, c.speedMS, mob.speedMS]).toEqual([1.2, 0.9, 0.7]);
    expect(c.exitS! / a.exitS!).toBeCloseTo(1.2 / 0.9, 1);
    expect(mob.exitS! / a.exitS!).toBeCloseTo(1.2 / 0.7, 1);
  });

  it('mix by use: a home has children and slow walkers, an office mostly adults; every person has a type', () => {
    const home = runDrill(oneDoor(1.2), [], { occupants: 20, seed: 4, fire: FAR });
    const homeTypes = new Set(home.people.map((p) => p.type));
    expect(homeTypes.has('child') && homeTypes.has('mobility')).toBe(true);
    const o = model([space('o', 'Open office', rect(0, 0, 10, 10))], [door('d', 'o', 3, 5, 1.2, 'out')]);
    const off = runDrill(o, [], { occupants: 40, seed: 4, fire: FAR });
    expect(off.people.filter((p) => p.type === 'child').length).toBe(0);
    expect(off.people.filter((p) => p.type === 'adult').length).toBeGreaterThanOrEqual(36);
    expect(off.assumptions.some((a) => a.id === 'drill-share-office')).toBe(true);
  });

  it('reaction delay follows the use and shows as the first phase of the timeline', () => {
    const o = model([space('o', 'Open office', rect(0, 0, 6, 4)), space('h', 'Flat', rect(6, 0, 6, 4))], [door('d', 'o', 3, 2, 1.2, 'out'), door('e', 'h', 1, 2, 1.2, 'out')]);
    const r = runDrill(o, [], { starts: [{ x: 2, y: 2 }, { x: 10, y: 2 }], fire: FAR, fireGrowthMS: 0, switching: false, freeFlow: true });
    const [off, home] = r.people;
    expect(off.reactionS).toBeGreaterThanOrEqual(22.5);
    expect(off.reactionS).toBeLessThanOrEqual(37.5);
    expect(home.reactionS).toBeGreaterThanOrEqual(45);
    expect(home.reactionS).toBeLessThanOrEqual(75);
    for (const p of r.people) {
      expect(p.phases[0].state).toBe('waiting');
      expect(p.phases[0].t0).toBe(0);
      expect(p.phases[0].t1).toBeCloseTo(p.reactionS, 6);
      expect(p.phases[p.phases.length - 1].t1).toBeCloseTo(p.exitS!, 3);
      expect(personAt(p, p.reactionS / 2, r.dt)).toEqual(p.start);
      for (let i = 1; i < p.phases.length; i++) expect(p.phases[i].t0).toBeCloseTo(p.phases[i - 1].t1, 3);
    }
  });

  it('a crowd walks slower than a lone person, and the slowest factor is reported', () => {
    const m = model([space('r', 'Room', rect(0, 0, 8, 3))], [door('d', 'r', 3, 1.5, 1.2, 'out')]);
    const cluster = Array.from({ length: 24 }, (_, i) => ({ x: 4 + (i % 6) * 0.2, y: 1 + Math.floor(i / 6) * 0.3 }));
    const base = { reactionS: 0, fire: FAR, fireGrowthMS: 0, switching: false, mix: 'adult' as const };
    const crowd = runDrill(m, [], { ...base, starts: cluster });
    const free = runDrill(m, [], { ...base, starts: cluster, freeFlow: true });
    const lone = runDrill(m, [], { ...base, starts: [{ x: 4, y: 1 }] });
    expect(lone.people[0].slowestFactor).toBe(1);
    expect(Math.min(...crowd.people.map((p) => p.slowestFactor))).toBeLessThan(0.7);
    expect(crowd.people.reduce((a, p) => a + p.exitS!, 0)).toBeGreaterThan(free.people.reduce((a, p) => a + p.exitS!, 0));
  });
});

describe('fire and exit choice', () => {
  const hall = () => model([space('r', 'Room', rect(0, 0, 8, 4))], [door('l', 'r', 3, 2, 1.2, 'out'), door('rt', 'r', 1, 2, 1.2, 'out')]);

  it('a fire that grows at the near exit sends people who leave late to the far one', () => {
    const fire = { x: 1.5, y: 2 };
    const early = runDrill(hall(), [], { starts: [{ x: 3, y: 1 }], fire, reactionS: 0, fireGrowthMS: 0.05, mix: 'adult' });
    const late = runDrill(hall(), [], { starts: [{ x: 3, y: 1 }], fire, reactionS: 45, fireGrowthMS: 0.05, mix: 'adult' });
    expect(early.people[0].exitId).toBe('l');
    expect(late.people[0].exitId).toBe('rt');
    expect(late.people[0].escaped).toBe(true);
    const e = late.exits.find((x) => x.id === 'l')!;
    expect(e.closedByFireS).not.toBeNull();
    expect(e.closedByFireS!).toBeLessThan(45);
    expect(late.notes.join(' ')).toMatch(/fire reaches/i);
  });

  it('exit choice counts the queue: a crowd at one door uses the other door as well', () => {
    const starts = Array.from({ length: 30 }, (_, i) => ({ x: 1.5 + (i % 5) * 0.3, y: 1 + Math.floor(i / 5) * 0.4 }));
    const r = runDrill(hall(), [], { starts, ...plain });
    const used = Object.fromEntries(r.exits.map((e) => [e.id, e.used]));
    expect(used.l + used.rt).toBe(30);
    expect(used.rt).toBeGreaterThan(3);
    // a single 1.2 m door would need 30 x headway to clear
    expect(r.totalS).toBeLessThan(30 * headwayFor(1.2));
  });

  it('the only exit blocked: nobody out, target not met, and it says why', () => {
    const r = runDrill(oneDoor(), [], { starts: [{ x: 2, y: 2 }], fire: { x: 2.5, y: 2 }, blockExit: true, reactionS: 0 });
    expect(r.allOut).toBe(false);
    expect(r.targetMet).toBe(false);
    expect(r.timeTo.p100).toBeNull();
    expect(r.stuck).toBe(1);
    expect(r.notes.join(' ')).toMatch(/blocked/i);
    expect(r.fix?.label).toBe('Add exit');
  });
});

describe('size and repeatability', () => {
  it('60-person office: under 2 s, identical for the same seed', () => {
    const desks = [];
    for (let i = 0; i < 6; i++) for (let j = 0; j < 4; j++) desks.push(item(`d${i}${j}`, 'desk', 2 + i * 2.2, 2 + j * 2.2, 1.4, 0.7, { name: `Desk ${i}${j}` }));
    const m = model([space('o', 'Office', rect(0, 0, 16, 12))], [door('a', 'o', 3, 6, 1.2, 'out'), door('b', 'o', 1, 6, 1.2, 'out')], desks);
    const t0 = Date.now();
    const r = runDrill(m, desks, { occupants: 60, seed: 7 });
    const ms = Date.now() - t0;
    const r2 = runDrill(m, desks, { occupants: 60, seed: 7 });
    expect(ms).toBeLessThan(2000);
    expect(r.occupants).toBe(60);
    expect(r.totalS).toBe(r2.totalS);
    expect(r.people.map((p) => p.exitS)).toEqual(r2.people.map((p) => p.exitS));
    expect(r.people.map((p) => p.type)).toEqual(r2.people.map((p) => p.type));
    expect(r.allOut).toBe(true);
    expect(r.timeTo.p50!).toBeLessThanOrEqual(r.timeTo.p90!);
    expect(r.timeTo.p90!).toBeLessThanOrEqual(r.timeTo.p100!);
  });
});
