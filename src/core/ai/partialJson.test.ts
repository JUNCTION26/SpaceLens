import { describe, expect, it } from 'vitest';
import { partialJson } from './partialJson';

describe('partialJson', () => {
  it('parses complete documents exactly', () => {
    const doc = { a: 1, b: [true, false, null, 'x', { c: -2.5e3 }], d: 'he said "hi" \\ é' };
    expect(partialJson(JSON.stringify(doc))).toEqual(doc);
    expect(partialJson(JSON.stringify(doc, null, 2))).toEqual(doc);
    expect(partialJson('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('returns undefined before anything usable', () => {
    expect(partialJson('')).toBeUndefined();
    expect(partialJson('   ')).toBeUndefined();
    expect(partialJson('Sure, here')).toBeUndefined();
  });

  it('closes open containers', () => {
    expect(partialJson('{')).toEqual({});
    expect(partialJson('[')).toEqual([]);
    expect(partialJson('{"items": [')).toEqual({ items: [] });
    expect(partialJson('{"items": [{"name": "Bed", "w": 90}, {')).toEqual({ items: [{ name: 'Bed', w: 90 }, {}] });
    expect(partialJson('[[1,[2')).toEqual([[1, [2]]]);
  });

  it('closes an open string value and shows its text so far', () => {
    expect(partialJson('{"name": "Sing')).toEqual({ name: 'Sing' });
    expect(partialJson('["ab", "c')).toEqual(['ab', 'c']);
    expect(partialJson('{"a": "')).toEqual({ a: '' });
  });

  it('drops half-written escapes inside an open string', () => {
    expect(partialJson('{"a": "x\\')).toEqual({ a: 'x' });
    expect(partialJson('{"a": "x\\\\')).toEqual({ a: 'x\\' });
    expect(partialJson('{"a": "x\\u00')).toEqual({ a: 'x' });
    expect(partialJson('{"a": "x\\u00e9y')).toEqual({ a: 'xéy' });
    expect(partialJson('{"a": "say \\"hi')).toEqual({ a: 'say "hi' });
  });

  it('drops incomplete keys, colons and commas', () => {
    expect(partialJson('{"a": 1, "b')).toEqual({ a: 1 });
    expect(partialJson('{"a": 1, "bee"')).toEqual({ a: 1 });
    expect(partialJson('{"a": 1, "bee":')).toEqual({ a: 1 });
    expect(partialJson('{"a": 1, "bee": ')).toEqual({ a: 1 });
    expect(partialJson('{"a": 1,')).toEqual({ a: 1 });
    expect(partialJson('[1, 2,')).toEqual([1, 2]);
  });

  it('handles numbers and literals at the end', () => {
    expect(partialJson('{"w": 9')).toEqual({ w: 9 });
    expect(partialJson('{"w": -')).toEqual({});
    expect(partialJson('{"w": 1.')).toEqual({});
    expect(partialJson('{"w": 1.5e')).toEqual({});
    expect(partialJson('{"w": 1.5e2')).toEqual({ w: 150 });
    expect(partialJson('{"ok": tr')).toEqual({});
    expect(partialJson('{"ok": true')).toEqual({ ok: true });
    expect(partialJson('[nul')).toEqual([]);
    expect(partialJson('{"a": 1, "ok": fals')).toEqual({ a: 1 });
  });

  it('keeps nested partial objects inside arrays', () => {
    expect(partialJson('{"rooms": [{"name": "Kitchen", "walls": [{"len": 3.2}, {"len"')).toEqual({
      rooms: [{ name: 'Kitchen', walls: [{ len: 3.2 }, {}] }],
    });
  });

  it('skips fences, leading prose and trailing junk', () => {
    expect(partialJson('```json\n{"a": [1, 2')).toEqual({ a: [1, 2] });
    expect(partialJson('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(partialJson('Here you go: {"a": 1} hope it helps')).toEqual({ a: 1 });
  });

  it('treats brackets inside strings as text', () => {
    expect(partialJson('{"note": "use [x] and {y}", "n": [1')).toEqual({ note: 'use [x] and {y}', n: [1] });
    expect(partialJson('{"note": "open { [')).toEqual({ note: 'open { [' });
  });

  it('parses top-level scalars only when complete', () => {
    expect(partialJson('42')).toBe(42);
    expect(partialJson('"hi"')).toBe('hi');
  });

  it('never throws and grows monotonically on a real stream', () => {
    const full = JSON.stringify({ items: [{ name: 'Single bed', w: 90, tags: ['soft', 'wood'] }, { name: 'Desk é "q"', w: 120.5, ok: false, x: null }] }, null, 2);
    let lastItems = 0;
    for (let i = 0; i <= full.length; i++) {
      const v = partialJson<{ items?: unknown[] }>(full.slice(0, i));
      const n = v?.items?.length ?? 0;
      expect(n).toBeGreaterThanOrEqual(lastItems);
      lastItems = n;
    }
    expect(partialJson(full)).toEqual(JSON.parse(full));
  });

  it('rejects mismatched closers by falling back to the last good prefix', () => {
    expect(partialJson('{"a": [1, 2}')).toEqual({ a: [1, 2] });
  });
});
