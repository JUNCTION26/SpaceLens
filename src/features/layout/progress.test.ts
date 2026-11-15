import { describe, expect, it } from 'vitest';
import type { FurnitureItem, LayoutCandidate } from '../../core/types';
import { caseFor } from './caseFor';
import { checksRan, failReason, isFinalResult, isPartial, pickAuto, priceLabel, titleFor, wholeRoomAsk } from './progress';

const item = (id: string, x: number): FurnitureItem => ({
  id, catalogId: 'bed', name: id, category: 'bed', x, y: 1, rotation: 0, w: 1, d: 1, h: 1,
  clearance: { front: 0, back: 0, left: 0, right: 0 }, locked: false, owned: false, priceSek: 0, priceStatus: 'catalog', color: '#888', sourceKind: 'catalog',
});
const cand = (id: string, score: number, o: Partial<LayoutCandidate> & { partial?: boolean } = {}): LayoutCandidate & { partial?: boolean } => ({
  id, name: id, summary: '', parentVersion: 1, furniture: [item('a', score)], assumptions: [], generator: 'rules', checks: [],
  metrics: { openAreaM2: 5, costSek: 1000, minClearanceM: 0.9, routeLenM: null, score }, ...o,
});

describe('which layout furnishes the room', () => {
  it('takes the best final one by score', () => {
    expect(pickAuto([cand('a', 60), cand('b', 85), cand('c', 70)])?.id).toBe('b');
  });
  it('prefers the report final score and then fewer failed checks', () => {
    expect(pickAuto([cand('a', 60), cand('b', 85)], [{ candidateId: 'a', finalScore: 95 }])?.id).toBe('a');
    const bad = cand('x', 80, { checks: [{ result: 'fail' } as never] });
    expect(pickAuto([bad, cand('y', 80)])?.id).toBe('y');
  });
  it('never takes a draft or a partial layout', () => {
    expect(pickAuto([cand('draft', 99), cand('p', 90, { partial: true })])).toBeNull();
    expect(pickAuto([cand('draft', 99), cand('b', 10)])?.id).toBe('b');
  });
  it('skips the layout already in the room for another layout, unless it is the only one', () => {
    const cs = [cand('a', 90), cand('b', 70)];
    expect(pickAuto(cs, [], cs[0].furniture)?.id).toBe('b');
    expect(pickAuto([cs[0]], [], cs[0].furniture)?.id).toBe('a');
  });
  it('gives nothing for an empty or furniture-less result', () => {
    expect(pickAuto([])).toBeNull();
    expect(pickAuto([cand('e', 50, { furniture: [] })])).toBeNull();
  });
});

describe('when a result is final', () => {
  it('is final only with real layouts and no partial flag', () => {
    expect(isFinalResult({ candidates: [cand('a', 1)] })).toBe(true);
    expect(isFinalResult({ candidates: [] })).toBe(false);
    expect(isFinalResult({ candidates: [cand('draft', 0)] })).toBe(false);
    expect(isFinalResult({ candidates: [cand('a', 1)], partial: true })).toBe(false);
    expect(isFinalResult({ candidates: [cand('a', 1), cand('b', 1, { partial: true })] })).toBe(false);
    expect(isPartial(cand('z', 1, { generator: 'draft pass' }))).toBe(true);
  });
});

describe('titles, price, ring, reasons', () => {
  const model = { spaces: [{ id: 's', name: 'R', polygon: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }], walls: [] }], openings: [], furniture: [] } as never;
  it('uses the themed design name, never Classic plan', () => {
    const t = cand('c1', 70, { name: "Gerard's room", generator: 'theme' });
    expect(caseFor(t, undefined, model, []).title).toBe("Gerard's room");
    expect(titleFor(t, 'Classic plan')).toBe("Gerard's room");
    const t2 = cand('c2', 70, { name: "Gerard's room 2", generator: 'theme' });
    expect(caseFor(t2, undefined, model, [t]).title).toBe("Gerard's room 2");
  });
  it('a normal layout with a real name keeps it instead of a placeholder', () => {
    expect(caseFor(cand('n1', 70, { name: 'Open floor' }), undefined, model, []).title).toBe('Open floor');
    expect(caseFor(cand('n2', 70, { name: 'Layout' }), undefined, model, []).title).not.toBe('Layout');
  });
  it('hides unknown price and unchecked ring', () => {
    expect(priceLabel(0)).toBeNull();
    expect(priceLabel(undefined)).toBeNull();
    expect(priceLabel(2500)).toMatch(/kr$/);
    expect(checksRan(0)).toBe(false);
    expect(checksRan(5)).toBe(true);
  });
  it('names the failure in one or two words', () => {
    expect(failReason({ infeasible: true, offline: true })).toBe('No fit');
    expect(failReason({ offline: true })).toBe('Offline');
    expect(failReason({ error: new Error('x') })).toBe('Busy');
  });
  it('reads whole-room follow-ups', () => {
    expect(wholeRoomAsk('Start over')).toBe('reset');
    expect(wholeRoomAsk('please clear the room!')).toBe('reset');
    expect(wholeRoomAsk('another layout')).toBe('again');
    expect(wholeRoomAsk('try another')).toBe('again');
    expect(wholeRoomAsk('make it bigger')).toBeNull();
    expect(wholeRoomAsk('add a plant')).toBeNull();
  });
});
