import { describe, expect, it, vi } from 'vitest';
import type { DesignProgram, FurnitureItem, LayoutCandidate, Requirements, RuleVerdict, SpaceModel } from '../../core/types';

let ready = false;
const aiMock = vi.fn();
vi.mock('../../core/ai', () => ({ ai: (c: unknown) => aiMock(c), aiReady: () => ready }));
vi.mock('./render', () => ({ renderPlanPng: () => '' }));
vi.mock('./semantics', () => ({
  semanticsOf: (f: FurnitureItem) => ({ category: f.category, role: 'surface', wallBacked: true, frontClearanceM: 0.6, sideClearanceM: 0.3, pairsWith: [], faces: 'room', tall: false, description: '' }),
}));
vi.mock('./program', () => ({
  defaultProgram: (_m: SpaceModel, items: FurnitureItem[]): DesignProgram => ({
    zones: [{ id: 'main', name: 'Main', purpose: '', itemIds: items.map((f) => f.id) }],
    relations: items.map((f) => ({ kind: 'against-wall', subject: f.id, weight: 0.7, reason: `${f.name} against a wall.` })), notes: [], by: 'rules',
  }),
}));
let solveCalls = 0;
vi.mock('./solve', () => ({
  solveProgram: async (_m: SpaceModel, items: FurnitureItem[], program: DesignProgram, opts: { variants?: number }) => {
    solveCalls++;
    const n = opts?.variants ?? 1;
    const candidates: LayoutCandidate[] = Array.from({ length: n }, (_, k) => ({
      id: `c${solveCalls}_${k}`, name: `Layout ${k + 1}`, summary: '', parentVersion: 1,
      furniture: items.map((f, i) => ({ ...f, x: 0.5 + i + k * 0.1 })),
      metrics: { openAreaM2: 5, costSek: 100, minClearanceM: null, routeLenM: null, score: 0 }, checks: [], assumptions: [], generator: 'program',
    }));
    return { candidates, reports: candidates.map((c) => ({ candidateId: c.id, program, verdicts: [] })), infeasibility: null };
  },
}));
vi.mock('./rules', () => ({
  evaluateRules: (_m: SpaceModel, furniture: FurnitureItem[]): RuleVerdict[] => [
    { ruleId: 'walk', name: 'Walkway width', itemIds: [], score: 1, pass: true, severity: 'hard', message: 'ok' },
    { ruleId: 'wall', name: 'Back to wall', itemIds: [furniture[0].id], score: furniture[0].x > 0.55 ? 0.4 : 0.9, pass: furniture[0].x <= 0.55, severity: 'preference', message: 'm' },
  ],
}));
vi.mock('./score', () => ({ designScore: (v: RuleVerdict[]) => 100 * v.reduce((s, x) => s + x.score, 0) / v.length }));

const { designRoom, buildDesignItems } = await import('./pipeline');

const model: SpaceModel = {
  id: 'm', name: 'Room', version: 1, units: 'm', ceilingM: 2.5, sourceLabel: '', furniture: [], measurements: [], evidence: [], openings: [],
  spaces: [{ id: 's', name: 'Room', polygon: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }], walls: [] }],
};
const req: Requirements = { purpose: 'office', people: 1, budgetSek: null, items: [{ catalogId: 'desk', qty: 1 }, { catalogId: 'chair', qty: 1 }], routeTargets: [], minRouteWidthM: 0.9, style: '', lockedIds: [], notes: [], questions: [], compiledBy: 'rules' };

describe('designRoom', () => {
  it('works offline with rules only and reports every stage', async () => {
    ready = false;
    const stages: string[][] = [];
    const res = await designRoom(model, req, { variants: 3, onStage: (s) => stages.push(s.map((x) => `${x.id}:${x.status}`)) });
    expect(aiMock).not.toHaveBeenCalled();
    expect(res.candidates.length).toBe(3);
    expect(res.reports.map((r) => r.candidateId)).toEqual(res.candidates.map((c) => c.id));
    expect(res.candidates[0].metrics.score).toBeGreaterThanOrEqual(res.candidates[2].metrics.score);
    expect(stages.at(-1)).toEqual(['room:done', 'plan:done', 'solve:done', 'rules:done', 'critic:skipped']);
    expect(res.stages.find((s) => s.id === 'rules')?.label).toBe('Checked 2 rules');
  });

  it('plans concepts, critiques and re-solves once when the critic asks for a change', async () => {
    ready = true; solveCalls = 0;
    aiMock.mockImplementation(async (call: { schema: { properties: Record<string, unknown> } }) => {
      if ('concepts' in call.schema.properties) {
        return { model: 'flash', ms: 500, data: { concepts: [
          { name: 'Window', idea: 'Desk by the light', zones: [], relations: [{ kind: 'near-window', subject: 'i1', weight: 0.9, reason: 'Daylight.' }] },
          { name: 'Open', idea: 'Clear floor', zones: [], relations: [{ kind: 'in-corner', subject: 'i1', weight: 0.8, reason: 'Corner.' }] },
        ] } };
      }
      return { model: 'flash', ms: 300, data: { summary: 'Fine', score: 8, decisions: [{ itemId: 'i1', verdict: 'change', reason: 'Closer to wall.' }],
        fixes: [{ op: 'add', relation: { kind: 'against-wall', subject: 'i1', target: 'wall:0', weight: 1, reason: 'Back to wall.' }, why: 'Stability.' }] } };
    });
    const res = await designRoom(model, req, { variants: 2 });
    expect(res.candidates.map((c) => c.name).sort()).toEqual(['Open', 'Window']);
    expect(solveCalls).toBe(4);
    expect(res.reports.every((r) => r.critique?.score === 8)).toBe(true);
    expect(res.stages.map((s) => s.id)).toEqual(['room', 'plan', 'solve', 'rules', 'critic']);
    expect(res.stages.find((s) => s.id === 'plan')?.model).toBe('flash');
  });

  it('keeps locked room furniture as an item', () => {
    const own = { ...buildDesignItems(model, { ...req, items: [{ catalogId: 'desk', qty: 1 }] })[0], id: 'mine', locked: true };
    const items = buildDesignItems({ ...model, furniture: [own] }, { ...req, items: [] });
    expect(items.map((f) => f.id)).toEqual(['mine']);
  });
});
