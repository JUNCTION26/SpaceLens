import { describe, expect, it } from 'vitest';
import { applyOp } from '../../core/ops';
import { assessSafety, quickFindings } from './assess';
import { cafe, deadEndOffice, shelfRoom, twoRoomFlat } from './fixtures';
import { evacuationPlanSvg } from './plan';
import { evacHeat } from './evac';

describe('escape routes', () => {
  it('shelf narrowing the way out: finding with a verified minimal fix', () => {
    const m = shelfRoom();
    const r = assessSafety(m, m.furniture);
    const f = r.findings.find((x) => x.kind === 'route-width')!;
    expect(f).toBeDefined();
    expect(f.itemIds).toContain('shelf');
    expect(f.title).toMatch(/7\d cm/);
    expect(f.fix).toBeDefined();
    expect(f.fix!.movedM).toBeLessThanOrEqual(0.35);
    expect(r.headline).toMatch(/to fix/);
    // apply the op through the real store reducer and confirm the problem is gone
    let next = m;
    for (const op of f.fix!.ops) next = applyOp(next, op);
    const after = quickFindings(next, next.furniture);
    expect(after.some((x) => x.kind === 'route-width')).toBe(false);
  });

  it('dead-end office aisle is flagged', () => {
    const m = deadEndOffice();
    const r = assessSafety(m, m.furniture, { skipFixes: true });
    const d = r.findings.filter((x) => x.kind === 'dead-end');
    expect(d.length).toBeGreaterThan(0);
    expect(d[0].message).toMatch(/\d+\.\d m/);
    expect(r.egress[0].exitId).toBe('exit');
  });

  it('two-room flat: bedroom escapes through the living room', () => {
    const m = twoRoomFlat();
    const r = assessSafety(m, m.furniture);
    const bed = r.egress.find((e) => e.spaceId === 'bed')!;
    expect(r.exits.map((e) => e.id)).toEqual(['front']);
    expect(bed.exitId).toBe('front');
    expect(bed.pathPoints.some((p) => p.x < 4.9)).toBe(true);
    expect(bed.lengthM!).toBeGreaterThan(5);
    expect(bed.lengthM!).toBeLessThan(12);
    expect(r.findings.some((f) => f.kind === 'trapped' || f.kind === 'no-exit')).toBe(false);
    expect(r.suggestions.some((s) => s.kind === 'smoke-alarm' && /Bedroom/.test(s.label))).toBe(true);
    // marking the inner door as an exit makes the bedroom leave through it
    const r2 = assessSafety(m, m.furniture, { exitOverrides: { inner: true }, skipFixes: true });
    expect(r2.exits.length).toBe(2);
  });

  it('cafe with 30 seats and one door: two-exits advice and an evacuation time', () => {
    const m = cafe();
    const r = assessSafety(m, m.furniture, { skipFixes: true });
    expect(r.occupancy.total).toBe(30);
    expect(r.egress[0].narrowestM!).toBeLessThanOrEqual(0.9 + 1e-9);
    expect(r.findings.some((f) => f.kind === 'dead-end')).toBe(false);
    expect(r.findings.some((f) => f.kind === 'two-exits')).toBe(true);
    const ev = r.evacuation!;
    expect(ev.occupants).toBe(30);
    expect(ev.unreachable).toBe(0);
    expect(ev.bottleneck?.doorId).toBe('exit');
    // 30 people through one ~0.86 m door at 1.3 p/s/m take at least ~25 s
    expect(ev.timeToClearS).toBeGreaterThan(25);
    expect(ev.timeToClearS).toBeLessThan(60);
    expect(evacHeat(ev, 5).values.some((v) => v > 0)).toBe(true);
    const svg = evacuationPlanSvg(m, m.furniture, r, { youAreHere: { x: 5, y: 3 } });
    expect(svg).toMatch(/^<svg/);
    expect(svg).toContain('You are here');
    expect(svg).toContain('Assumptions');
  });

  it('no exit at all is critical', () => {
    const m = shelfRoom();
    const r = assessSafety(m, m.furniture, { exitOverrides: { exit: false }, skipFixes: true });
    expect(r.findings[0].kind).toBe('no-exit');
  });
});
