// Ranking and repair with the professional relations: a layout that breaks a hard relation (a chair
// left 2 m from its desk, a headboard off the wall, a wardrobe in the door swing) never outranks a
// clean one, and the repair step carries out the critic's own repair, then re-checks.
import { describe, expect, it } from 'vitest';
import type { FurnitureItem } from '../../core/types';
import { makeItem } from '../furniture/catalog';
import { opening, rect, reqs, room } from '../referee/fixtures';
import { evaluateKnowledge } from './knowledge';
import { seatArrangements } from './relations';
import { repairKnowledge, repairLayout } from './repair';
import { analyseItem, buildRoom, evaluateRules, polyDist } from './rules';
import { rankDetail, rankScore } from './score';

const put = (id: string, x: number, y: number, rotation = 0, key = id): FurnitureItem => ({ ...makeItem(id, { x, y, rotation }), id: key });
const req = reqs({});
const rank = (m: ReturnType<typeof room>, f: FurnitureItem[], use?: Parameters<typeof rankScore>[3]) => rankScore(evaluateRules(m, f, req), m, f, use);

// 3.6 x 3.4 m study: window top centre, door bottom left swinging in. Desk on the left wall facing +x.
const study = room(rect(3.6, 3.4), [opening('door', 'door', 2, 2.9, 0.8, 'in'), opening('win', 'window', 0, 1.8, 1.2)]);
const desk = () => put('desk-120', 0.3, 0.9, -Math.PI / 2, 'desk');
const good = () => [desk(), put('office-chair', 1.0, 0.9, Math.PI / 2, 'chair'), put('bookshelf', 3.6 - 0.18, 1.6, Math.PI / 2, 'shelf')];
const bad = () => [desk(), put('office-chair', 2.9, 2.6, Math.PI / 2, 'chair'), put('bookshelf', 3.6 - 0.18, 1.6, Math.PI / 2, 'shelf')];
const gapTo = (f: FurnitureItem[], a: string, b: string) => {
  const r = buildRoom(study);
  return polyDist(analyseItem(r, f.find((x) => x.id === a)!).poly, analyseItem(r, f.find((x) => x.id === b)!).poly);
};

describe('a chair belongs at its desk', () => {
  it('a chair 2 m from its desk breaks a hard relation with a repair that names the desk', () => {
    expect(gapTo(bad(), 'chair', 'desk')).toBeGreaterThan(1.9);
    const r = evaluateKnowledge(study, bad(), 'home-office');
    const v = r.hardBroken.find((x) => x.id === 'seat-at-host')!;
    expect(v).toBeDefined();
    expect(v.chip).toBe('Chair adrift');
    expect(v.repair).toMatchObject({ itemId: 'chair', action: 'pull-in', to: 'desk', chip: 'Chair to desk' });
    expect(v.repair!.relation).toMatchObject({ kind: 'paired-seat', subject: 'chair', target: 'desk' });
    expect(r.score).toBeLessThanOrEqual(30);
    expect(r.bad).toContain('Chair adrift');
  });

  it('a chair drawn up to the desk holds every hard relation', () => {
    const r = evaluateKnowledge(study, good(), 'home-office');
    expect(r.hardBroken.map((x) => x.id)).toEqual([]);
    expect(r.good).toContain('Chairs drawn up');
  });

  it('a chair turned away from the desk is broken even when close', () => {
    const f = [desk(), put('office-chair', 1.0, 0.9, 0, 'chair')];
    const v = evaluateKnowledge(study, f, 'home-office').hardBroken.find((x) => x.id === 'seat-at-host');
    expect(v?.chip).toBe('Chair turned away');
  });

  it('the bad layout ranks below the good one and is capped at 30', () => {
    const g = rank(study, good(), 'home-office'), b = rank(study, bad(), 'home-office');
    expect(b).toBeLessThanOrEqual(30);
    expect(g).toBeGreaterThan(30);
    expect(b).toBeLessThan(g);
    const d = rankDetail(evaluateRules(study, bad(), req), study, bad(), 'home-office');
    expect(d.hardBroken).toContain('knowledge:seat-at-host');
    expect(d.bad).toContain('Chair adrift');
  });

  it('repair draws the chair back to the desk, moves nothing else, and the result re-checks clean', () => {
    const before = bad();
    const res = repairKnowledge(study, before, req, { use: 'home-office' });
    expect(res.hardBefore).toContain('seat-at-host');
    expect(res.hardAfter).not.toContain('seat-at-host');
    expect(new Set(res.moves.map((m) => m.itemId))).toEqual(new Set(['chair']));
    const d = res.furniture.find((f) => f.id === 'desk')!;
    expect([d.x, d.y, d.rotation]).toEqual([before[0].x, before[0].y, before[0].rotation]);
    expect(gapTo(res.furniture, 'chair', 'desk')).toBeLessThanOrEqual(0.3);
    expect(res.left.some((c) => c.relation === 'seat-at-host')).toBe(false);
    expect(rank(study, res.furniture, 'home-office')).toBeGreaterThan(rank(study, before, 'home-office'));
  });

  it('repairLayout runs the relation pass after the referee pass and reports it', () => {
    const res = repairLayout(study, bad(), req, { use: 'home-office' });
    expect(res.knowledge?.hardBefore).toContain('seat-at-host');
    expect(res.knowledge?.hardAfter).not.toContain('seat-at-host');
    expect(gapTo(res.furniture, 'chair', 'desk')).toBeLessThanOrEqual(0.3);
  });

  it('a desk chair sits 35-45 cm from the desk front, centre to edge', () => {
    for (const id of ['desk-chair', 'office-chair', 'office-chair-exec']) {
      const host = put('desk-120', 1, 1, 0, 'd'), seat = put(id, 0, 0, 0, 's');
      const p = seatArrangements(host, [seat])[0][0];
      const off = p.y - (host.y + host.d / 2);
      expect(off, id).toBeGreaterThanOrEqual(0.35 - 1e-9);
      expect(off, id).toBeLessThanOrEqual(0.45 + 1e-9);
    }
  });
});

describe('other hard breaks never rank first', () => {
  // 3.4 x 4 m bedroom, door bottom left swinging in, window top centre.
  const m = room(rect(3.4, 4), [opening('door', 'door', 2, 2.9, 0.8, 'in'), opening('win', 'window', 0, 1.7, 1.2)]);
  const rot = Math.PI / 2;
  const ns = () => [put('nightstand', 3.4 - 0.2, 2.0 - 0.7 - 0.245, rot, 'n1'), put('nightstand', 3.4 - 0.2, 2.0 + 0.7 + 0.245, rot, 'n2')];
  const onWall = () => [put('bed-double', 3.4 - 1.0, 2.0, rot, 'bed'), ...ns()];

  it('a headboard 40 cm off the wall ranks below the same bed on the wall', () => {
    const off = [put('bed-double', 3.4 - 1.4, 2.0, rot, 'bed')];
    expect(evaluateKnowledge(m, off, 'bedroom-double').hardBroken.map((v) => v.id)).toContain('bed-headboard');
    expect(rank(m, off, 'bedroom-double')).toBeLessThanOrEqual(30);
    expect(rank(m, off, 'bedroom-double')).toBeLessThan(rank(m, [put('bed-double', 3.4 - 1.0, 2.0, rot, 'bed')], 'bedroom-double'));
  });

  it('a wardrobe in the door swing ranks below the same room with it clear', () => {
    const blocked = [...onWall(), put('wardrobe-100', 0.6, 3.4, 0, 'w')];
    const clear = [...onWall(), put('wardrobe-100', 0.3, 1.2, -Math.PI / 2, 'w')];
    expect(evaluateKnowledge(m, blocked, 'bedroom-double').hardBroken.map((v) => v.id)).toEqual(expect.arrayContaining(['door-swing']));
    expect(rank(m, blocked, 'bedroom-double')).toBeLessThan(rank(m, clear, 'bedroom-double'));
    expect(rank(m, blocked, 'bedroom-double')).toBeLessThanOrEqual(30);
  });

  it('without a layout the ranking score is the rule score', () => {
    const v = evaluateRules(m, onWall(), req);
    expect(rankScore(v)).toBe(rankDetail(v).rules);
  });
});
