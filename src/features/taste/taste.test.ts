import { describe, expect, it } from 'vitest';
import type { AppState } from '../../core/store';
import type { FurnitureItem, LayoutCandidate } from '../../core/types';
import { makeItem } from '../furniture/catalog';
import { opening, rect, room } from '../referee/fixtures';
import { rankByTaste, tasteHints, tasteWeights } from './apply';
import { buildProfile } from './profile';
import { observe } from './signals';
import type { Signal } from './signals';

const base = () => room(rect(4, 4), [opening('w', 'window', 0, 2, 1.4)]);
const at = (id: string, x: number, y: number, patch: Partial<FurnitureItem> = {}): FurnitureItem => ({ ...makeItem(id, { x, y }), ...patch });
const st = (model: ReturnType<typeof base>, extra: Partial<AppState> = {}, n = 0, candidates: LayoutCandidate[] = []) =>
  ({ model, changes: Array.from({ length: n }, () => ({ op: 'UPDATE_OBJECT', label: '', at: 0, version: 0 })), candidates, requirements: null, ...extra }) as unknown as AppState;

function history(now: number): Signal[] {
  const log: Signal[] = [];
  const push = (x: Signal) => log.push(x);
  for (let i = 0; i < 6; i++) {
    const desk = at('desk-120', 2, 3.2, { id: 'd' }), rug = at('rug-160', 2, 2, { id: 'r' });
    const m0 = { ...base(), furniture: [desk, rug] };
    const m1 = { ...base(), furniture: [{ ...desk, x: 2, y: 0.5, material: 'walnut', color: '#5b4636' }] };
    observe(st(m1, {}, i * 3 + 3), st(m0, {}, i * 3 + 1), push, now - i * 3600_000);
    // second pass: the rug removal, as its own change
    observe(st({ ...base(), furniture: [] }, {}, i * 3 + 4), st(m1, {}, i * 3 + 3), push, now - i * 3600_000);
  }
  return log;
}

const cand = (id: string, items: FurnitureItem[]): LayoutCandidate => ({
  id, name: id, summary: '', parentVersion: 1, furniture: items, checks: [], assumptions: [], generator: 't',
  metrics: { openAreaM2: 8, costSek: 0, minClearanceM: 1, routeLenM: 1, score: 1 },
});

describe('taste', () => {
  const now = Date.now();
  const log = history(now);
  const p = buildProfile(log, now);

  it('logs moves, removals and materials from store changes', () => {
    expect(log.some((s) => s.k === 'move' && s.cat === 'desk' && s.win! < s.winBefore!)).toBe(true);
    expect(log.some((s) => s.k === 'remove' && s.cat === 'rug')).toBe(true);
    expect(log.some((s) => s.k === 'material' && s.v === 'walnut')).toBe(true);
  });
  it('learns window-side desk, no rugs, walnut, open floor', () => {
    expect(p.window.desk.v).toBeGreaterThan(0.8);
    expect(p.window.desk.c).toBeGreaterThan(0.6);
    expect(p.avoid[0].cat).toBe('rug');
    expect(p.materials[0].name).toBe('walnut');
    expect(p.traits.open.v).toBeGreaterThan(0.6);
    expect(p.window.bed.c).toBeLessThan(0.1);
  });
  it('decays old signals', () => {
    const old = buildProfile(log, now + 120 * 86_400_000);
    expect(old.window.desk.c).toBeLessThan(p.window.desk.c / 2);
  });
  it('re-ranks candidates and emits weights and hints', () => {
    const near = cand('near', [at('desk-120', 2, 0.5, { material: 'walnut', color: '#5b4636' })]);
    const far = cand('far', [at('desk-120', 2, 3.4, { material: 'oak' }), at('rug-160', 2, 2)]);
    const m = base();
    expect(rankByTaste([far, near], p, m).map((c) => c.id)).toEqual(['near', 'far']);
    expect(rankByTaste([far, near], buildProfile([], now), m).map((c) => c.id)).toEqual(['far', 'near']);
    expect(tasteWeights(p).solver.window).toBeGreaterThan(1);
    expect(tasteWeights(p).rules['rug-anchor']).toBeLessThan(1);
    expect(tasteHints(p).join(' ')).toMatch(/desk near the window/);
    expect(tasteHints(buildProfile([], now))).toEqual([]);
  });
  it('records apply and skip from a candidate choice', () => {
    const a = cand('Open floor', [at('desk-120', 2, 0.5)]), b = cand('Full', [at('desk-120', 2, 3.4)]);
    const out: Signal[] = [];
    const prev = st(base(), {}, 0, [a, b]);
    const next = { ...st({ ...base(), furniture: a.furniture }, {}, 1, [a, b]), changes: [{ op: 'SET_FURNITURE', label: 'Applied "Open floor"', at: 0, version: 2 }] } as unknown as AppState;
    observe(next, prev, (x) => out.push(x));
    expect(out.map((s) => s.k)).toEqual(['apply', 'skip']);
  });
});
