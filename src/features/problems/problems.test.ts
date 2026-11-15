import { describe, expect, it } from 'vitest';
import { item, opening, rect, room } from '../referee/fixtures';
import { collectProblems } from './collect';
import { applyOps, findFixes, fixContext, moveLabel } from './fixes';
import { validateLayout } from '../referee/validate';

const base = () => room(rect(4, 4), [opening('d1', 'door', 2, 3.2, 0.8, 'in'), opening('w1', 'window', 0, 2, 1.2)]);

describe('problems', () => {
  it('turns an overlap into one plain problem with a verified move', () => {
    const m = base();
    const f = [item('a', 1, 1.5, 1, 0.6, { name: 'Desk' }), item('b', 1.6, 1.5, 0.6, 0.6, { name: 'Cabinet' })];
    const { problems, raw } = collectProblems(m, f, null);
    const p = problems.find((x) => x.rule === 'No overlap')!;
    expect(p.title).toBe('Desk and Cabinet overlap by 20 cm.');
    expect(p.severity).toBe('error');
    const ctx = fixContext(m, f, null, raw);
    const fixes = findFixes(ctx, p);
    expect(fixes.length).toBeGreaterThan(1);
    const first = fixes[0];
    expect(first.safe).toBe(true);
    expect(first.label).toMatch(/^Move \d+ cm (left|right|up|down)/);
    expect(first.preview.length).toBe(1);
    const after = applyOps({ ...m, furniture: f }, first.ops);
    expect(validateLayout(after, after.furniture, null).some((r) => r.result === 'fail' && r.rule === 'No overlap')).toBe(false);
    expect(fixes[fixes.length - 1].kind).toBe('remove');
  });

  it('offers a fix for an item blocking the door swing', () => {
    const m = base();
    // The door sits 3.2 m along the bottom wall, measured from the right-hand corner: centre x = 0.8.
    const f = [item('c', 0.8, 3.6, 0.6, 0.5, { name: 'Chair' })];
    const { problems, raw } = collectProblems(m, f, null);
    const p = problems.find((x) => x.rule === 'Door swing')!;
    expect(p.title).toContain('Chair blocks the door');
    const fixes = findFixes(fixContext(m, f, null, raw), p);
    expect(fixes.some((x) => x.safe)).toBe(true);
  });

  it('labels moves in plain words', () => {
    expect(moveLabel(-0.2, 0)).toBe('Move 20 cm left');
    expect(moveLabel(0, 0.15)).toBe('Move 15 cm down');
    expect(moveLabel(0.3, -0.1)).toBe('Move 30 cm right and 10 cm up');
  });

  it('slides a door back onto its wall', () => {
    const m = room(rect(4, 4), [opening('d1', 'door', 2, 3.9, 0.8, 'none')]);
    const { problems, raw } = collectProblems(m, [], null);
    const p = problems.find((x) => x.rule === 'Opening on wall')!;
    const fixes = findFixes(fixContext(m, [], null, raw), p);
    expect(fixes[0].kind).toBe('opening');
    expect(fixes[0].safe).toBe(true);
  });

  it('includes design and safety findings when asked, and stays fast', () => {
    const m = base();
    const f = [
      item('bed', 2, 1.0, 1.4, 2.0, { name: 'Bed', category: 'bed', clearance: { front: 0.6, back: 0, left: 0.6, right: 0.6 } }),
      item('desk', 0.4, 2.6, 1.2, 0.6, { name: 'Desk', category: 'desk', rotation: Math.PI / 2, clearance: { front: 0.75, back: 0, left: 0, right: 0 } }),
      item('w', 3.6, 2.6, 1.0, 0.6, { name: 'Wardrobe', category: 'wardrobe', h: 2, clearance: { front: 0.6, back: 0, left: 0, right: 0 } }),
    ];
    const { problems, raw } = collectProblems(m, f, null, { design: true, safety: true });
    expect(problems.some((p) => p.source === 'design')).toBe(true);
    expect(problems.every((p) => p.title.length > 0 && /[.]$/.test(p.title))).toBe(true);
    expect(new Set(problems.map((p) => p.id)).size).toBe(problems.length);
    const ctx = fixContext(m, f, null, raw);
    for (const p of problems.filter((x) => x.source !== 'check').slice(0, 3)) {
      for (const fix of findFixes(ctx, p, 12)) expect(fix.label.length).toBeGreaterThan(0);
    }
  }, 60000);
});

describe('two rooms', () => {
  const two = () => {
    const m = room(rect(4, 4), [opening('d1', 'door', 2, 3.2, 0.8, 'in'), opening('w1', 'window', 0, 2, 1.2)]);
    const poly = rect(4, 4).map((p) => ({ x: p.x + 5, y: p.y }));
    m.spaces.push({ id: 's2', name: 'Bedroom', polygon: poly, walls: poly.map(() => ({ thicknessM: 0.1, sourceKind: 'manual' as const, status: 'verified' as const })) });
    return m;
  };
  it('does not judge an item in room B against room A', () => {
    const m = two();
    const f = [item('b', 7, 2, 1, 0.6, { name: 'Table', category: 'table' })];
    const { problems } = collectProblems(m, f, null, { design: true });
    expect(problems.filter((p) => p.itemIds.includes('b') && p.source === 'design' && /outside|out of/i.test(p.title))).toEqual([]);
    expect(problems.filter((p) => p.itemIds.includes('b') && p.rule === 'Inside room')).toEqual([]);
  });
  it('reports nothing for a valid furnished two-room model', () => {
    const m = two();
    const f = [item('a', 3.2, 2, 0.8, 0.5, { name: 'Table', category: 'table' }), item('b', 7, 2, 1, 0.6, { name: 'Table', category: 'table' })];
    const { problems } = collectProblems(m, f, null, { design: true });
    expect(problems.filter((p) => p.severity !== 'tip').map((p) => p.title)).toEqual([]);
  });
});
