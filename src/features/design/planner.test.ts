import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesignProgram, FurnitureItem, Requirements, SpaceModel } from '../../core/types';

const aiMock = vi.fn();
let ready = true;
vi.mock('../../core/ai', () => ({ ai: (c: unknown) => aiMock(c), aiReady: () => ready }));
vi.mock('./semantics', () => ({
  semanticsOf: (f: FurnitureItem) => ({ category: f.category, role: f.category === 'bed' ? 'sleeping' : 'surface', wallBacked: true, frontClearanceM: 0.6, sideClearanceM: 0.3, pairsWith: [], faces: 'room', tall: false, description: '' }),
}));
vi.mock('./program', () => ({
  defaultProgram: (_m: SpaceModel, items: FurnitureItem[]): DesignProgram => ({
    zones: [{ id: 'main', name: 'Main', purpose: 'everything', itemIds: items.map((f) => f.id) }],
    relations: items.map((f) => ({ kind: 'against-wall', subject: f.id, weight: 0.5, reason: 'default' })),
    focalItemId: items[0]?.id, notes: [], by: 'rules',
  }),
}));

const { cleanRelation, cleanProgram, mergeWithDefault, planConcepts, sceneDescription, wallInfo, sceneRefs } = await import('./planner');

const item = (id: string, category: string): FurnitureItem => ({
  id, catalogId: category, name: category, category, x: 1, y: 1, rotation: 0, w: 1, d: 0.6, h: 0.75,
  clearance: { front: 0.6, back: 0, left: 0, right: 0 }, locked: false, owned: false, priceSek: 100, priceStatus: 'catalog', color: '#888', sourceKind: 'catalog',
});
const model: SpaceModel = {
  id: 'm', name: 'Room', version: 1, units: 'm', ceilingM: 2.5, sourceLabel: '', furniture: [], measurements: [], evidence: [],
  spaces: [{ id: 's', name: 'Room', polygon: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }], walls: [] }],
  openings: [{ id: 'w1', kind: 'window', spaceId: 's', wallIndex: 0, offsetM: 2, widthM: 1.2, heightM: 1.2, sillM: 0.9, swing: 'none', hinge: 'start', sourceKind: 'manual', status: 'verified' }],
};
const req: Requirements = { purpose: 'office', people: 1, budgetSek: null, items: [], routeTargets: [], minRouteWidthM: 0.9, style: '', lockedIds: [], notes: [], questions: [], compiledBy: 'rules' };
const items = [item('desk_abc', 'desk'), item('bed_xyz', 'bed')];
const refs = sceneRefs(items);
const ctx = { ids: new Set(items.map((f) => f.id)), wallCount: 4, toLong: refs.toLong };

beforeEach(() => { aiMock.mockReset(); ready = true; });

describe('scene', () => {
  it('names walls by compass and marks openings', () => {
    const w = wallInfo(model);
    expect(w.map((x) => x.name)).toEqual(['north', 'east', 'south', 'west']);
    expect(w[0].window).toBe(true);
    const text = sceneDescription(model, items, req, refs);
    expect(text).toContain('wall:0 north');
    expect(text).toContain('i1 desk');
  });
});

describe('cleanRelation', () => {
  it('maps short ids, clamps weight and orders distances', () => {
    expect(cleanRelation({ kind: 'faces', subject: 'i1', target: 'i2', weight: 4, reason: ' Looks at bed ', distanceM: [2, 1] }, ctx))
      .toEqual({ kind: 'faces', subject: 'desk_abc', target: 'bed_xyz', weight: 1, reason: 'Looks at bed', distanceM: [1, 2] });
  });
  it('drops unknown kinds, ids, walls and missing targets', () => {
    expect(cleanRelation({ kind: 'levitate', subject: 'i1', weight: 1, reason: '' }, ctx)).toBeNull();
    expect(cleanRelation({ kind: 'against-wall', subject: 'i9', weight: 1, reason: '' }, ctx)).toBeNull();
    expect(cleanRelation({ kind: 'against-wall', subject: 'i1', target: 'wall:7', weight: 1, reason: '' }, ctx)).toBeNull();
    expect(cleanRelation({ kind: 'faces', subject: 'i1', weight: 1, reason: '' }, ctx)).toBeNull();
    expect(cleanRelation({ kind: 'beside', subject: 'i1', target: 'i1', weight: 1, reason: '' }, ctx)).toBeNull();
  });
});

describe('program', () => {
  it('merges with the default so every item has a zone and a relation', () => {
    const p = cleanProgram({ name: 'Window', zones: [{ id: 'z', name: 'Work', purpose: 'work', itemIds: ['i1', 'ghost'] }], relations: [{ kind: 'near-window', subject: 'i1', weight: 0.9, reason: 'Daylight on the desk.' }] }, ctx);
    const def = { zones: [{ id: 'main', name: 'Main', purpose: '', itemIds: ['desk_abc', 'bed_xyz'] }], relations: [{ kind: 'against-wall' as const, subject: 'bed_xyz', weight: 0.5, reason: 'd' }], notes: [], by: 'rules' as const };
    const m = mergeWithDefault(p, def);
    expect(m.zones.flatMap((z) => z.itemIds).sort()).toEqual(['bed_xyz', 'desk_abc']);
    expect(m.relations.map((r) => r.subject).sort()).toEqual(['bed_xyz', 'desk_abc']);
  });
});

describe('planConcepts', () => {
  it('returns validated concepts from one call', async () => {
    aiMock.mockResolvedValue({ model: 'flash', ms: 900, data: { concepts: [
      { name: 'Light', idea: 'Desk at the window', zones: [], relations: [{ kind: 'near-window', subject: 'i1', weight: 0.9, reason: 'Daylight.' }] },
      { name: 'Calm', idea: 'Bed away from door', zones: [], relations: [{ kind: 'away-from-door', subject: 'i2', weight: 0.8, reason: 'Quiet.' }, { kind: 'bogus', subject: 'i1' }] },
    ] } });
    const out = await planConcepts(model, items, req, 2);
    expect(aiMock).toHaveBeenCalledTimes(1);
    expect(aiMock.mock.calls[0][0].task).toBe('fast');
    expect(out.map((c) => c.name)).toEqual(['Light', 'Calm']);
    expect(out[0].by).toBe('gemini');
    expect(out[1].relations.every((r) => r.kind !== ('bogus' as never))).toBe(true);
    expect(out[0].relations.some((r) => r.subject === 'bed_xyz')).toBe(true);
  });
  it('falls back to the rule program on failure or without a key', async () => {
    aiMock.mockRejectedValue(new Error('503'));
    const [a] = await planConcepts(model, items, req, 3);
    expect(a.by).toBe('rules');
    expect(a.notes.join(' ')).toContain('503');
    ready = false;
    const [b] = await planConcepts(model, items, req, 3);
    expect(b.by).toBe('rules');
    expect(aiMock).toHaveBeenCalledTimes(1);
  });
});
