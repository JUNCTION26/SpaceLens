import { describe, expect, it } from 'vitest';
import { SAFETY_DEFAULTS } from '../safety/assess';
import { PACKS, applyPack, packFor } from './rulepacks';

describe('rule packs', () => {
  for (const pack of Object.values(PACKS)) {
    describe(pack.id, () => {
      it('is well formed with unique ids', () => {
        expect(pack.rules.length).toBeGreaterThan(0);
        expect(new Set(pack.rules.map((r) => r.id)).size).toBe(pack.rules.length);
        for (const r of pack.rules) {
          expect(r.title).toBeTruthy();
          expect(Number.isFinite(r.value) && r.value >= 0).toBe(true);
          expect(r.scope).toBeTruthy();
        }
      });
      it('gives every rule a source url and a read date', () => {
        for (const r of pack.rules) {
          expect(r.source.url).toMatch(/^https:\/\//);
          expect(r.source.readOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          expect(r.source.doc && r.source.section).toBeTruthy();
          if (pack.id !== 'generic') expect((r.source.quote ?? '').split(/\s+/).length).toBeLessThan(25);
        }
      });
      it('applyPack sets only known keys', () => {
        const patch = applyPack(pack);
        for (const k of Object.keys(patch)) expect(k in SAFETY_DEFAULTS).toBe(true);
      });
    });
  }
  it('generic pack reproduces today defaults', () => { expect(applyPack(PACKS.generic)).toEqual(SAFETY_DEFAULTS); });
  it('packFor maps codes', () => {
    expect(packFor('fi').id).toBe('FI'); expect(packFor('SE').id).toBe('SE');
    expect(packFor('DE').id).toBe('generic'); expect(packFor(undefined).id).toBe('generic');
  });
  it('Sweden reads the 2025 statutes, not the repealed BBR chapters', () => {
    for (const r of PACKS.SE.rules) expect(r.source.url).toMatch(/BFS2024-(7|12)\//);
    expect(applyPack(PACKS.SE)).toEqual({ wheelchairDoorM: 0.8, turningM: 1.5, routeWidthM: 0.9, doorWidthM: 0.8, inwardSwingMaxOccupants: 30 });
  });
  it('Finland has the room height from the housing decree', () => {
    const r = PACKS.FI.rules.find((x) => x.id === 'fi-room-height');
    expect(r?.value).toBe(2.5); expect(r?.source.doc).toContain('1008/2017');
  });
});
