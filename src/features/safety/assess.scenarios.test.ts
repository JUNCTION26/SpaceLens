import { describe, expect, it } from 'vitest';
import { applyOp } from '../../core/ops';
import { assessSafety, quickFindings } from './assess';
import { bigOffice, deadEndCorridor, door, longRoom, model, officeFloor, rect, sofaGapRoom, space } from './fixtures';

const kinds = (r: { findings: Array<{ kind: string }> }) => r.findings.map((f) => f.kind);

describe('assess scenarios', () => {
  it('10 m room with one door: farthest point is about 9-10 m away, no travel finding, single exit direction', () => {
    const m = longRoom();
    const r = assessSafety(m, m.furniture, { skipFixes: true });
    const e = r.egress[0];
    expect(e.exitId).toBe('exit');
    expect(e.lengthM!).toBeGreaterThan(8.5);
    expect(e.lengthM!).toBeLessThan(10.6);
    expect(kinds(r)).not.toContain('travel');
    expect(e.alternative).toBe('single');
    expect(e.travelTimeSlowS!).toBeGreaterThan(e.travelTimeS!);
  });

  it('dead-end corridor is reported with its length and the required limit', () => {
    const m = deadEndCorridor();
    const r = assessSafety(m, m.furniture, { skipFixes: true });
    expect(r.depth.deadEnds.length).toBeGreaterThan(0);
    const d = r.depth.deadEnds[0];
    expect(d.lengthM).toBeGreaterThan(7);
    expect(d.requiredM).toBe(r.config.deadEndM);
    expect(kinds(r)).toContain('dead-end');
  });

  it('sofa leaving 1.0 m is fine', () => {
    const m = sofaGapRoom(1.0);
    const r = assessSafety(m, m.furniture, { skipFixes: true });
    expect(r.findings.filter((x) => x.itemIds.includes('sofa') && x.severity !== 'advice')).toEqual([]);
  });

  it('room with no door: no-exit is critical and nobody is routed', () => {
    const m = model([space('r', 'Box', rect(0, 0, 4, 4))], []);
    const r = assessSafety(m, m.furniture, { skipFixes: true });
    expect(kinds(r)).toContain('no-exit');
    expect(r.findings.find((f) => f.kind === 'no-exit')!.severity).toBe('critical');
    expect(r.egress[0].exitId).toBeNull();
    expect(r.score).toBeLessThan(80);
  });

  it('inner room is reported with the room it opens through', () => {
    const m = model([space('a', 'Hall', rect(0, 0, 4, 4)), space('b', 'Store', rect(4, 0, 3, 4))],
      [door('exit', 'a', 3, 2, 0.9, 'out'), door('in', 'a', 1, 2, 0.9, 'in')]);
    const r = assessSafety(m, m.furniture, { skipFixes: true });
    const inner = r.depth.innerRooms.find((x) => x.spaceId === 'b')!;
    expect(inner).toBeDefined();
    expect(inner.accessSpaceId).toBe('a');
    expect(inner.hops).toBe(1);
  });

  it('skipFixes returns no fix and the report is stable between runs', () => {
    const m = sofaGapRoom(0.6);
    const a = assessSafety(m, m.furniture, { skipFixes: true });
    const b = assessSafety(m, m.furniture, { skipFixes: true });
    expect(a.findings.every((f) => !f.fix)).toBe(true);
    expect(a.findings.map((f) => f.id)).toEqual(b.findings.map((f) => f.id));
    expect(a.score).toBe(b.score);
    expect(Array.isArray(a.depth.compromised)).toBe(true);
  });
});
