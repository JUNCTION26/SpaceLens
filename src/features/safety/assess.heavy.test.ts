import { describe, expect, it } from 'vitest';
import { applyOp } from '../../core/ops';
import { assessSafety, quickFindings } from './assess';
import { bigOffice, deadEndCorridor, door, longRoom, model, officeFloor, rect, sofaGapRoom, space } from './fixtures';

const kinds = (r: { findings: Array<{ kind: string }> }) => r.findings.map((f) => f.kind);

describe('assess scenarios, large plans', () => {
  it('40 m room: travel limit exceeded, finding carries measured value above the required one', () => {
    const m = longRoom(40);
    const r = assessSafety(m, m.furniture, { skipFixes: true });
    const f = r.findings.find((x) => x.kind === 'travel')!;
    expect(f).toBeDefined();
    expect(f.measured!.value).toBeGreaterThan(f.required!.value!);
    expect(f.required!.value).toBe(r.config.maxTravelM);
    expect(f.severity).not.toBe('advice');
  });

  it('a second exit at the far end halves the walk and gives two directions', () => {
    const base = longRoom(40);
    const m = { ...base, openings: [...base.openings, door('far', 'r', 1, 2, 0.9, 'out')] };
    const r = assessSafety(m, m.furniture, { skipFixes: true });
    expect(r.exits.length).toBe(2);
    expect(r.egress[0].lengthM!).toBeLessThan(21);
    expect(r.egress[0].alternative).toBe('two-directions');
    expect(kinds(r)).not.toContain('travel');
    expect(kinds(r)).not.toContain('single-direction');
  });

  it('sofa leaving 0.6 m: pinch is flagged at about 0.6 m and a verified fix clears it', () => {
    const m = sofaGapRoom(0.6);
    const r = assessSafety(m, m.furniture);
    const f = r.findings.find((x) => x.itemIds.includes('sofa'))!;
    expect(f).toBeDefined();
    expect(f.measureM ?? f.measured?.value).toBeGreaterThan(0.45);
    expect(f.measureM ?? f.measured?.value).toBeLessThan(0.75);
    expect(f.fix).toBeDefined();
    let next = m;
    for (const op of f.fix!.ops) next = applyOp(next, op);
    expect(quickFindings(next, next.furniture).some((x) => x.itemIds.includes('sofa') && x.severity === 'critical')).toBe(false);
  });

  it('200-person office with a single inward door: swing, two-exit and capacity problems, and lost-exit capacity is null', () => {
    const m = bigOffice(20, 10, 'in');
    const r = assessSafety(m, m.furniture, { skipFixes: true, occupancy: 200 });
    expect(r.occupancy.total).toBe(200);
    expect(r.occupancy.overridden).toBe(true);
    const k = kinds(r);
    expect(k).toContain('two-exits');
    expect(k).toContain('exit-swing');
    expect(r.depth.capacity.doors.find((d) => d.exit)!.ok).toBe(false);
    expect(r.depth.capacity.capacityWithoutLargestExit).toBeNull();
  });

  it('the same office with an outward door has no swing finding', () => {
    const m = bigOffice(20, 10, 'out');
    expect(kinds(assessSafety(m, m.furniture, { skipFixes: true, occupancy: 200 }))).not.toContain('exit-swing');
  });

  it('office floor: two exits, every office reaches one, blocking one exit traps nobody but halves capacity', () => {
    const m = officeFloor();
    const r = assessSafety(m, m.furniture, { skipFixes: true });
    expect(r.exits.length).toBe(2);
    expect(r.egress.every((e) => e.exitId !== null)).toBe(true);
    expect(r.egress.length).toBe(15);
    expect(r.depth.capacity.capacityWithoutLargestExit).not.toBeNull();
    const exitTests = r.depth.blockedDoors.filter((b) => b.exit);
    expect(exitTests.length).toBe(2);
    for (const b of exitTests) expect(b.trappedPeople).toBe(0);
    expect(kinds(r)).not.toContain('no-exit');
  });

});
