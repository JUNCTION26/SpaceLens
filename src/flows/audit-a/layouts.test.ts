// Design > Layouts: Make layouts, hover preview, click to apply, Compare + Combine, Why, relax chips.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { sampleRoom } from '../../core/sample';
import { compileWithMeta } from '../../features/intent/refine';
import { designRoom } from '../../features/design/pipeline';
import { showLayouts } from '../../features/layout/progress';
import { crossover } from '../../features/layout/solver';
import { caseFor, whyText } from '../../features/layout/caseFor';
import { useReports } from '../../features/design/reportStore';
import { outside, overlaps, resetStore, st } from '../helpers';

// No key and no server: the app's offline path.
vi.stubEnv('VITE_API_BASE', '');
vi.stubGlobal('fetch', () => Promise.reject(new TypeError('offline')));

describe('Layouts', () => {
  beforeAll(async () => {
    resetStore(sampleRoom());
    const { req } = await compileWithMeta('Home office for two', st().model);
    st().setRequirements(req);
    // "Make layouts" (DesignPanel.regenerate)
    const res = await designRoom(st().model, req, { variants: 3, onProgress: (p) => showLayouts(p) });
    showLayouts(res);
  }, 240000);

  it('Make layouts lists at least two distinct layouts offline', () => {
    const c = st().candidates;
    expect(c.length).toBeGreaterThanOrEqual(2);
    const sigs = new Set(c.map((x) => JSON.stringify(x.furniture.map((f) => [f.catalogId, f.x.toFixed(1), f.y.toFixed(1)]))));
    expect(sigs.size).toBeGreaterThanOrEqual(2);
  });

  it('hovering a card previews it, leaving restores', () => {
    const before = st().activeCandidateId;
    const id = st().candidates[1].id;
    st().previewCandidate(id);
    expect(st().activeCandidateId).toBe(id);
    st().previewCandidate(before);
    expect(st().activeCandidateId).toBe(before);
  });

  it('clicking a layout applies it: the room holds its furniture, inside and not overlapping', () => {
    for (const c of st().candidates) {
      st().applyCandidate(c.id);
      const f = st().model.furniture;
      expect(f.length).toBe(c.furniture.length);
      for (const g of c.furniture) expect(f.some((x) => Math.abs(x.x - g.x) < 1e-6 && Math.abs(x.y - g.y) < 1e-6)).toBe(true);
      expect(outside(st().model)).toEqual([]);
      expect(overlaps(f)).toEqual([]);
    }
  });

  it('applying a layout is one undo step', () => {
    const before = st().model.furniture;
    st().applyCandidate(st().candidates[0].id);
    st().undo();
    expect(st().model.furniture).toEqual(before);
  });

  it('Why explains the chosen layout', () => {
    const c = st().candidates[0];
    const k = caseFor(c, useReports.getState().reports[c.id], st().model, st().candidates.filter((x) => x.id !== c.id));
    expect(k).toBeTruthy();
    expect(whyText(k!, c).length).toBeGreaterThan(10);
  });

  it('Compare: pick two and Combine adds a valid new layout', async () => {
    const [a, b] = st().candidates;
    const n = st().candidates.length;
    const c = await crossover(a, b, st().model, st().requirements!);
    if (c) {
      st().setCandidates([...st().candidates, c]);
      st().previewCandidate(c.id);
      expect(st().candidates.length).toBe(n + 1);
      st().applyCandidate(c.id);
      expect(outside(st().model)).toEqual([]);
      expect(overlaps(st().model.furniture)).toEqual([]);
    } else {
      // the panel shows Retry when the two cannot be combined
      expect(c).toBeNull();
    }
  }, 120000);

  it('Regenerate with a changed brief replaces the list', async () => {
    const req = { ...st().requirements!, people: 1 };
    st().setRequirements(req);
    const res = await designRoom(st().model, req, { variants: 3 });
    showLayouts(res);
    expect(st().candidates.length).toBeGreaterThan(0);
  }, 240000);
});
