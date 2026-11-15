import { describe, expect, it } from 'vitest';
import type { ObjectPart, ObjectSpec } from '../../core/types';
import { partsBounds, MAX_PARTS } from './spec';
import { checkSpec, validateSpec } from './validate';

const box = (name: string, pos: [number, number, number], size: [number, number, number]): ObjectPart => ({ name, shape: 'box', size, pos, material: 'oak' });
const spec = (parts: ObjectPart[], size = { w: 1, d: 0.6, h: 0.8 }): ObjectSpec => ({ id: 't', name: 't', prompt: 't', size, parts } as unknown as ObjectSpec);
const table = () => [
  box('top', [0, 0.77, 0], [1, 0.06, 0.6]),
  box('leg a', [-0.45, 0.37, -0.25], [0.06, 0.74, 0.06]),
  box('leg b', [0.45, 0.37, 0.25], [0.06, 0.74, 0.06]),
];

describe('validateSpec repairs', () => {
  it('a clean table needs no repair', () => {
    const v = validateSpec(spec(table()));
    expect(v.ok).toBe(true);
  });
  it('snaps a floating part onto what is below it', () => {
    const parts = [...table(), box('shelf', [0, 0.45, 0], [0.5, 0.03, 0.3])];
    parts[3].pos[1] = 0.55; // not touching a leg or the top
    const v = validateSpec(spec(parts));
    expect(checkSpec(v.fixed).filter((s) => /floating/.test(s))).toEqual([]);
    expect(v.issues.some((s) => /floating/.test(s))).toBe(true);
  });
  it('snaps the lowest point to the floor', () => {
    const lifted = table().map((p) => ({ ...p, pos: [p.pos[0], p.pos[1] + 0.2, p.pos[2]] as [number, number, number] }));
    const v = validateSpec(spec(lifted));
    expect(partsBounds(v.fixed.parts).min[1]).toBeCloseTo(0, 3);
    expect(v.ok).toBe(true);
  });
  it('pulls parts back inside the stated bounding size', () => {
    const wide = [...table(), box('arm', [1.2, 0.5, 0], [0.4, 0.05, 0.05])];
    const v = validateSpec(spec(wide));
    const b = partsBounds(v.fixed.parts);
    expect(b.max[0] - b.min[0]).toBeLessThanOrEqual(1.003);
    expect(v.ok).toBe(true);
  });
  it('drops parts with zero or negative dimensions', () => {
    const v = validateSpec(spec([...table(), box('flat', [0, 0.4, 0], [0.2, 0, 0.2]), box('neg', [0, 0.4, 0], [0.2, -0.1, 0.2])]));
    expect(v.fixed.parts.map((p) => p.name)).not.toContain('flat');
    expect(v.fixed.parts.map((p) => p.name)).not.toContain('neg');
    expect(v.fixed.parts.every((p) => p.size.every((n) => n > 0))).toBe(true);
  });
  it('caps the part count at 60', () => {
    expect(MAX_PARTS).toBe(60);
    const many = [...table()];
    for (let i = 0; i < 90; i++) many.push(box(`peg ${i}`, [-0.4 + (i % 10) * 0.08, 0.7 - Math.floor(i / 10) * 0.02, 0], [0.03, 0.03, 0.03 + (i % 7) * 0.01]));
    const v = validateSpec(spec(many));
    expect(v.fixed.parts.length).toBeLessThanOrEqual(60);
    expect(checkSpec(spec(many)).some((s) => /at most 60/.test(s))).toBe(true);
  });
});
