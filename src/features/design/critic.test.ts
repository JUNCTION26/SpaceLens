import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesignProgram, DesignReport, FurnitureItem, LayoutCandidate, SpaceModel } from '../../core/types';

const aiMock = vi.fn();
vi.mock('../../core/ai', () => ({ ai: (c: unknown) => aiMock(c), aiReady: () => true }));
vi.mock('./render', () => ({ renderPlanPng: () => 'data:image/png;base64,AAAA' }));
vi.mock('./semantics', () => ({
  semanticsOf: (f: FurnitureItem) => ({ category: f.category, role: f.category === 'plant' ? 'decor' : 'surface', wallBacked: false, frontClearanceM: 0.6, sideClearanceM: 0.3, pairsWith: [], faces: 'room', tall: false, description: '' }),
}));
vi.mock('./program', () => ({ defaultProgram: () => ({ zones: [], relations: [], notes: [], by: 'rules' }) }));

const { critique, applyFixes, cleanFixes } = await import('./critic');

const item = (id: string, category: string, x = 1): FurnitureItem => ({
  id, catalogId: category, name: category, category, x, y: 1, rotation: 0, w: 1, d: 0.6, h: 0.75,
  clearance: { front: 0.6, back: 0, left: 0, right: 0 }, locked: false, owned: false, priceSek: 100, priceStatus: 'catalog', color: '#888', sourceKind: 'catalog',
});
const model: SpaceModel = {
  id: 'm', name: 'Room', version: 1, units: 'm', ceilingM: 2.5, sourceLabel: '', furniture: [], measurements: [], evidence: [], openings: [],
  spaces: [{ id: 's', name: 'Room', polygon: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }], walls: [] }],
};
const furniture = [item('desk_1', 'desk'), item('sofa_1', 'sofa', 3), item('plant_1', 'plant', 2)];
const cand: LayoutCandidate = { id: 'c1', name: 'A', summary: '', parentVersion: 1, furniture, metrics: { openAreaM2: 5, costSek: 300, minClearanceM: null, routeLenM: null, score: 0 }, checks: [], assumptions: [], generator: 'program' };
const program: DesignProgram = { zones: [], relations: [{ kind: 'against-wall', subject: 'desk_1', weight: 0.6, reason: 'Stable.' }, { kind: 'faces', subject: 'sofa_1', target: 'desk_1', weight: 0.4, reason: 'x' }], notes: [], by: 'rules' };
const report: DesignReport = { candidateId: 'c1', program, verdicts: [{ ruleId: 'walk', name: 'Walkway width', itemIds: ['sofa_1'], score: 0.3, pass: false, severity: 'hard', message: 'Walkway is 62 cm, needs 90 cm.' }] };
const ctx = { ids: new Set(furniture.map((f) => f.id)), wallCount: 4 };

beforeEach(() => aiMock.mockReset());

describe('critique', () => {
  it('sends the scene, verdicts and plan image; returns cleaned decisions and relation-only fixes', async () => {
    aiMock.mockResolvedValue({ model: 'flash', ms: 700, data: {
      summary: 'Sofa blocks the walkway.', score: 14,
      decisions: [{ itemId: 'i1', verdict: 'keep', reason: 'Good wall.' }, { itemId: 'i2', verdict: 'change', reason: 'Blocks route.' }, { itemId: 'nope', verdict: 'keep', reason: '' }],
      fixes: [{ op: 'add', relation: { kind: 'against-wall', subject: 'i2', target: 'wall:2', weight: 0.9, reason: 'Clears the route.' }, why: 'Free the walkway.', x: 3, y: 2 }],
    } });
    const c = await critique(model, cand, report);
    const call = aiMock.mock.calls[0][0];
    expect(call.task).toBe('vision');
    expect(call.parts[0].text).toContain('Walkway is 62 cm');
    expect(call.parts[1].inlineData.mimeType).toBe('image/png');
    expect(c.score).toBe(10);
    expect(c.decisions).toEqual([{ itemId: 'desk_1', verdict: 'keep', reason: 'Good wall.' }, { itemId: 'sofa_1', verdict: 'change', reason: 'Blocks route.' }]);
    expect(c.ops).toEqual([{ op: 'add', relation: { kind: 'against-wall', subject: 'sofa_1', target: 'wall:2', weight: 0.9, reason: 'Clears the route.' }, why: 'Free the walkway.' }]);
    expect(JSON.stringify(c.ops)).not.toMatch(/"x"|"y"/);
  });
});

describe('fixes', () => {
  it('caps at three and drops invalid ones', () => {
    const rel = (s: string) => ({ op: 'add', relation: { kind: 'in-corner', subject: s, weight: 0.5, reason: 'r' }, why: 'w' });
    expect(cleanFixes([rel('desk_1'), rel('ghost'), rel('sofa_1'), rel('plant_1'), rel('desk_1')], ctx)).toHaveLength(3);
  });
  it('applies add, remove and reweight without touching geometry', () => {
    const p = applyFixes(program, [
      { op: 'remove', subject: 'sofa_1', kind: 'faces', why: 'not needed' },
      { op: 'reweight', subject: 'desk_1', kind: 'against-wall', weight: 1, why: 'matters' },
      { op: 'add', relation: { kind: 'in-corner', subject: 'plant_1', weight: 0.3, reason: 'Fills the corner.' }, why: 'corner' },
    ]);
    expect(p.relations.map((r) => `${r.kind}:${r.subject}:${r.weight}`)).toEqual(['against-wall:desk_1:1', 'in-corner:plant_1:0.3']);
    expect(p.notes).toHaveLength(3);
    expect(program.relations).toHaveLength(2);
  });
});
