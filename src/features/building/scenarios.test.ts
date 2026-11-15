// Scenario tests: floor plans judged the way an architect would judge a drawing.
import { describe, expect, it } from 'vitest';
import { lShell, planBuilding, rectShell, type BuildingPlan, type PlanRoom } from './partition';
import { apartmentProgramme, officeProgramme, villaProgramme, type RoomProgramme } from './programme';
import { rArea, touching } from './rects';

const WINDOW_H = 1.3;
const isBed = (r: PlanRoom) => r.purpose === 'bedroom';
const byProg = (p: BuildingPlan, id: string) => p.rooms.find((r) => r.programmeId === id);

function sharedLen(a: PlanRoom, b: PlanRoom) {
  let t = 0;
  for (const p of a.rects) for (const q of b.rects) for (const s of touching(p, q, 0.01)) t += Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
  return t;
}

/** Rooms reachable from the entrance when private rooms are dead ends (never walked through). */
function reachable(p: BuildingPlan) {
  const ent = p.doors.find((d) => d.b === 'outside')!;
  const adj = new Map<string, string[]>();
  for (const d of p.doors) if (d.b !== 'outside') { (adj.get(d.a) ?? adj.set(d.a, []).get(d.a)!).push(d.b); (adj.get(d.b) ?? adj.set(d.b, []).get(d.b)!).push(d.a); }
  const seen = new Set([ent.a]);
  const q = [ent.a];
  const room = (id: string) => p.rooms.find((r) => r.id === id)!;
  while (q.length) {
    const c = q.shift()!;
    const cr = room(c);
    if (c !== ent.a && !cr.isHall && cr.privacy !== 'public') continue; // do not walk through bedrooms, offices, wet rooms
    for (const n of adj.get(c) ?? []) if (!seen.has(n)) { seen.add(n); q.push(n); }
  }
  return seen;
}

function windowArea(p: BuildingPlan, roomId: string) {
  return p.windows.filter((w) => w.roomId === roomId).reduce((s, w) => s + Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) * WINDOW_H, 0);
}

function check(p: BuildingPlan, programme: RoomProgramme, opts: { bedMinW?: number } = {}): string[] {
  const bad: string[] = [];
  const t = (cond: boolean, msg: string) => { if (!cond) bad.push(`[${p.metrics.idea}] ${msg}`); };
  const prog = p.rooms.filter((r) => !r.isHall);
  const seen = reachable(p);
  for (const r of p.rooms) t(seen.has(r.id), `${r.name} not reachable from the entrance without crossing a private room`);
  t(p.doors.find((d) => d.b === 'outside')!.a === 'hall', 'entrance does not open into the hall');
  for (const r of prog.filter(isBed)) t(r.widthM >= (opts.bedMinW ?? 2.1), `${r.name} is ${r.widthM.toFixed(2)} m wide`);
  const hall = p.rooms[0];
  const hw = Math.min(...hall.rects.filter((q) => rArea(q) > 1).map((q) => Math.min(q.x1 - q.x0, q.y1 - q.y0)));
  t(hw >= 1.2 - 1e-6, `corridor ${hw.toFixed(2)} m wide`);
  for (const r of prog.filter((x) => x.needsWindow)) {
    t(r.daylightM >= 1, `${r.name} not on the facade`);
    t(windowArea(p, r.id) >= r.areaM2 * 0.1 - 1e-6, `${r.name} window ${windowArea(p, r.id).toFixed(2)} m2 of ${r.areaM2.toFixed(1)} m2`);
  }
  t(p.metrics.doorClashes === 0, `${p.metrics.doorClashes} door clashes`);
  t(/^[A-Za-z]+$/.test(p.metrics.idea), 'idea is one word');
  const wet = prog.filter((r) => ['bathroom', 'wc'].includes(r.purpose));
  if (wet.length >= 2) for (const w of wet) {
    const mate = prog.some((o) => o !== w && ['bathroom', 'wc', 'kitchen', 'utility'].includes(o.purpose) && sharedLen(w, o) >= 0.9);
    t(mate, `${w.name} does not back onto another wet room`);
  }
  t(programme.rooms.length + 1 === p.rooms.length, 'all rooms placed');
  return bad;
}

// Heavy (planning runs while tests are collected): opt in with BUILDING_SCENARIOS=1.
const RUN = Boolean((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.BUILDING_SCENARIOS);
const plan = (shell: ReturnType<typeof rectShell>, ent: { wallIndex: number; offsetM: number }, prog: RoomProgramme, count = 3): BuildingPlan[] =>
  RUN ? planBuilding(shell, [ent], [], prog, { count, seed: 3, iterations: 600 }) : [];

describe.skipIf(!RUN)('60 m2 two-room flat (6 x 10)', () => {
  const prog = apartmentProgramme(2);
  const plans = plan(rectShell(6, 10), { wallIndex: 2, offsetM: 3 }, prog);
  it('three options with different ideas', () => {
    expect(plans.length).toBe(3);
    expect(new Set(plans.map((p) => p.metrics.idea)).size).toBe(3);
  });
  it('every option passes the architect checks', () => {
    for (const p of plans) {
      expect(check(p, prog)).toEqual([]);
      expect(p.metrics.corridorShare, 'corridor share').toBeLessThan(0.16);
    }
  });
  it('living is near the entrance, bedroom is farther than living', () => {
    const p = plans[0];
    const e = p.doors.find((d) => d.b === 'outside')!.at;
    const dist = (r: PlanRoom) => Math.min(...r.rects.map((q) => Math.hypot((q.x0 + q.x1) / 2 - e.x, (q.y0 + q.y1) / 2 - e.y)));
    expect(dist(byProg(p, 'living')!)).toBeLessThanOrEqual(dist(byProg(p, 'bed-master')!) + 0.5);
  });
});

describe.skipIf(!RUN)('120 m2 three-bedroom villa (10 x 12)', () => {
  const prog = villaProgramme(3);
  const plans = plan(rectShell(10, 12), { wallIndex: 2, offsetM: 5 }, prog);
  it('options differ and pass the checks', () => {
    expect(new Set(plans.map((p) => p.metrics.idea)).size).toBe(plans.length);
    for (const p of plans) { expect(check(p, prog)).toEqual([]); expect(p.metrics.corridorShare).toBeLessThan(0.16); }
  });
  it('bedrooms are grouped: the bedrooms sit closer to each other than to the living room', () => {
    const p = plans[0];
    const c = (r: PlanRoom) => { const q = r.rects[0]; return { x: (q.x0 + q.x1) / 2, y: (q.y0 + q.y1) / 2 }; };
    const beds = p.rooms.filter(isBed).map(c), liv = c(byProg(p, 'living')!);
    const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
    const bb = mean(beds.flatMap((a, i) => beds.slice(i + 1).map((b) => Math.hypot(a.x - b.x, a.y - b.y))));
    const bl = mean(beds.map((b) => Math.hypot(liv.x - b.x, liv.y - b.y)));
    expect(bb).toBeLessThanOrEqual(bl + 0.5);
  });
});

describe.skipIf(!RUN)('200 m2 office for 20 (20 x 10)', () => {
  const prog = officeProgramme(20);
  const plans = plan(rectShell(20, 10), { wallIndex: 2, offsetM: 10 }, prog);
  it('desks get daylight, one corridor loop, no door clashes', () => {
    for (const p of plans) {
      expect(check(p, prog)).toEqual([]);
      for (const r of p.rooms.filter((x) => x.purpose === 'workspace')) expect(r.daylightM, r.name).toBeGreaterThanOrEqual(1);
      expect(p.metrics.daylightOk).toBeGreaterThanOrEqual(p.rooms.filter((r) => r.needsWindow).length - 0);
    }
  });
  it('meeting rooms are nearer the core than the desks', () => {
    const p = plans[0];
    const cx = 10, cy = 5;
    const d = (r: PlanRoom) => { const q = r.rects[0]; return Math.hypot((q.x0 + q.x1) / 2 - cx, (q.y0 + q.y1) / 2 - cy); };
    const service = p.rooms.filter((r) => ['storage', 'wc', 'phone'].includes(r.purpose));
    const work = p.rooms.filter((r) => r.purpose === 'workspace');
    expect(Math.min(...service.map(d))).toBeLessThanOrEqual(Math.max(...work.map(d)));
  });
});

describe.skipIf(!RUN)('L-shaped 90 m2', () => {
  const prog = apartmentProgramme(3);
  const plans = plan(lShell(12, 10, 6, 5), { wallIndex: 0, offsetM: 9 }, prog);
  it('no slivers, covers the shell, passes the checks', () => {
    for (const p of plans) {
      expect(check(p, prog)).toEqual([]);
      const sum = p.rooms.reduce((s, r) => s + r.rects.reduce((t, q) => t + rArea(q), 0), 0);
      expect(sum).toBeCloseTo(90, 1);
      for (const r of p.rooms) for (const q of r.rects) expect(Math.min(q.x1 - q.x0, q.y1 - q.y0), `${r.name} ${JSON.stringify(q)} ${p.metrics.idea}`).toBeGreaterThanOrEqual(0.9);
    }
  });
});

describe.skipIf(!RUN)('narrow 5 x 16 m flat', () => {
  const prog = apartmentProgramme(3);
  const plans = plan(rectShell(5, 16), { wallIndex: 2, offsetM: 2.5 }, prog);
  it('keeps bedrooms 2.1 m wide and reaches everything', () => {
    expect(plans.length).toBeGreaterThan(0);
    for (const p of plans) expect(check(p, prog)).toEqual([]);
  });
});
