import { describe, expect, it } from 'vitest';
import { assessSafety } from './assess';
import { shelfRoom, deadEndOffice } from './fixtures';
import { buildSafetyReport, reportHtml } from './report';
import { FI_PACK, SE_PACK, GENERIC_PACK } from '../jurisdiction/rulepacks';

describe('safety report', () => {
  it('every failed check appears with its rule source and a finding list', () => {
    const m = deadEndOffice();
    const a = assessSafety(m, m.furniture, { skipFixes: true });
    for (const pack of [FI_PACK, SE_PACK, GENERIC_PACK]) {
      const r = buildSafetyReport(m, a, pack);
      const html = reportHtml(r);
      expect(r.checks.length).toBeGreaterThan(0);
      for (const c of r.checks) {
        expect(c.source.doc.length).toBeGreaterThan(0);
        expect(c.source.section.length).toBeGreaterThan(0);
        expect(html).toContain(c.source.doc);
      }
      expect(html.match(/>FAIL</g)?.length ?? 0).toBe(r.checks.filter((c) => !c.pass).length);
      expect(r.findings.length).toBe(a.findings.length);
      expect(html).toContain('not a compliance certificate');
    }
    const r = buildSafetyReport(m, a, GENERIC_PACK);
    expect(r.checks.some((c) => c.id === 'dead-end' && !c.pass)).toBe(true);
  });

  it('escapes names', () => {
    const m = shelfRoom();
    m.name = '<script>alert(1)</script>&"x"';
    const a = assessSafety(m, m.furniture);
    const html = reportHtml(buildSafetyReport(m, a, FI_PACK));
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });

  it('plan has one path per route', () => {
    const m = deadEndOffice();
    const a = assessSafety(m, m.furniture, { skipFixes: true });
    const r = buildSafetyReport(m, a, GENERIC_PACK);
    const html = reportHtml(r);
    expect(html.match(/<path class="route"/g)?.length ?? 0).toBe(r.routes.length);
    expect(r.routes.length).toBe(a.egress.filter((e) => e.pathPoints.length >= 2).length);
    expect(r.routes.length).toBeGreaterThan(0);
  });
});
