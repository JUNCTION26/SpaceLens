import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { Op } from './types';

let mod: typeof import('./store');
beforeAll(async () => {
  const mem: Record<string, string> = {};
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => mem[k] ?? null,
    setItem: (k: string, val: string) => { mem[k] = val; },
    removeItem: (k: string) => { delete mem[k]; },
  });
  mod = await import('./store');
});

const s = () => mod.useStore.getState();

describe('store', () => {
  it('dispatch/undo/redo sequence', () => {
    const v0 = s().model.version;
    s().dispatch({ type: 'RENAME', name: 'A' } as Op);
    s().dispatch({ type: 'RENAME', name: 'B' } as Op);
    expect(s().model.name).toBe('B');
    expect(s().past).toHaveLength(2);
    expect(s().changes).toHaveLength(2);
    s().undo(); expect(s().model.name).toBe('A'); expect(s().model.version).toBe(v0 + 3);
    s().undo(); expect(s().model.name).toBe('Sample room');
    s().undo(); expect(s().model.name).toBe('Sample room');
    s().redo(); expect(s().model.name).toBe('A');
    s().dispatch({ type: 'RENAME', name: 'C' } as Op);
    expect(s().future).toHaveLength(0);
    s().redo(); expect(s().model.name).toBe('C');
    const vs = [s().model.version];
    s().undo(); vs.push(s().model.version);
    s().redo(); vs.push(s().model.version);
    expect(vs[1]).toBeGreaterThan(vs[0]);
    expect(vs[2]).toBeGreaterThan(vs[1]);
  });

  it('applyCandidate', () => {
    const furniture = [{ ...s().model.furniture[0], id: 'x1' }];
    s().setCandidates([{ id: 'c1', name: 'Cand', furniture } as never]);
    expect(s().activeCandidateId).toBe('c1');
    s().applyCandidate('nope');
    expect(s().activeCandidateId).toBe('c1');
    s().applyCandidate('c1');
    expect(s().model.furniture.map((f) => f.id)).toEqual(['x1']);
    expect(s().activeCandidateId).toBeNull();
    expect(s().changes.at(-1)!.label).toBe('Applied "Cand"');
  });
});
