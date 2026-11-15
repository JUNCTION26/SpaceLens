// @ts-nocheck -- reads the shipped sample PDFs from disk; the app tsconfig has no Node types.
// Space > Drawings: an example plan becomes rooms, the same way "Build" in the panel does it.
import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { area } from '../../core/geometry';
import { dxfToModel } from '../../features/formats/dxfRead';
import { modelToDxf } from '../../features/formats/dxfWrite';
import { sampleRoom } from '../../core/sample';
import { resetStore, st } from './lite';

// No key and no server: the app's offline path.
vi.stubEnv('VITE_API_BASE', '');
vi.stubGlobal('fetch', () => Promise.reject(new TypeError('offline')));

async function buildSample(file: string) {
  const { readPagePaths } = await import('../../features/drawings/pdfPaths');
  const { textItemsFrom, finishItems } = await import('../../features/drawings/pdfText');
  const { buildFromPaths } = await import('../../features/drawings/toBuilding');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(`public/samples/stoa/${file}`)), verbosity: 0 }).promise;
  const page = await pdf.getPage(1);
  const vp = page.getViewport({ scale: 1 });
  const pp = await readPagePaths(page, pdfjs.OPS);
  const items = finishItems(textItemsFrom((await page.getTextContent()).items, vp, 1, 0));
  return buildFromPaths(pp, items, 0, { name: file, now: 0 });
}

describe('Drawings', () => {
  const index = JSON.parse(fs.readFileSync('public/samples/stoa/index.json', 'utf8'));

  it('lists the shipped example plans', () => {
    expect(index.length).toBeGreaterThanOrEqual(3);
    for (const e of index) expect(fs.existsSync(`public/samples/stoa/${e.file}`)).toBe(true);
  });

  for (const e of index.slice(0, 2)) {
    it(`example "${e.file}" > Build loads rooms into the model`, async () => {
      resetStore(sampleRoom());
      const out = await buildSample(e.file);
      expect(out.report.ok).toBe(true);
      st().dispatch({ type: 'REPLACE_MODEL', model: out.model });
      const m = st().model;
      expect(m.spaces.length).toBeGreaterThanOrEqual(3);
      for (const s of m.spaces) expect(area(s.polygon)).toBeGreaterThan(0.5);
      expect(m.openings.some((o) => o.kind === 'door')).toBe(true);
    }, 120000);
  }

  it('opening a .dxf file replaces the model with its rooms', () => {
    resetStore(sampleRoom());
    const dxf = modelToDxf(sampleRoom());
    const out = dxfToModel(dxf, 'room.dxf');
    st().dispatch({ type: 'REPLACE_MODEL', model: out.model });
    expect(st().model.spaces.length).toBeGreaterThanOrEqual(1);
    expect(area(st().model.spaces[0].polygon)).toBeGreaterThan(5);
  });
});
