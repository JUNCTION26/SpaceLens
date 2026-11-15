import { describe, expect, it } from 'vitest';
import { sampleRoom } from '../../core/sample';
import { exportItemUsdz, exportRoomUsdz } from './usdz';

const head = async (b: Blob) => new Uint8Array(await b.slice(0, 4).arrayBuffer());

describe('USDZ export', () => {
  it('exports the sample room as a non-empty zip', async () => {
    const m = sampleRoom();
    const blob = await exportRoomUsdz(m);
    expect(blob.size).toBeGreaterThan(1000);
    expect(blob.type).toBe('model/vnd.usdz+zip');
    expect([...(await head(blob))]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it('exports one item at its true size', async () => {
    const blob = await exportItemUsdz(sampleRoom().furniture[0]);
    expect(blob.size).toBeGreaterThan(500);
    // The model file inside is stored uncompressed, so its text holds the scale (metres) and the extent.
    const text = new TextDecoder('latin1').decode(new Uint8Array(await blob.arrayBuffer()));
    expect(text).toContain('metersPerUnit = 1');
  });
});

const latin = async (b: Blob) => new TextDecoder('latin1').decode(new Uint8Array(await b.arrayBuffer()));

describe('USDZ contents', () => {
  it('has a root layer, metres, y-up and real geometry for a generated object', async () => {
    const { EXAMPLES } = await import('../forge/examples');
    const spec = EXAMPLES.find((e) => e.parts.length > 8)!;
    const bb = { w: 1.6, d: 0.9, h: 0.75 };
    const item = { ...sampleRoom().furniture[0], ...bb, custom: spec };
    const t = await latin(await exportItemUsdz(item));
    expect(t).toMatch(/\.usd[ac]/);
    expect(t).toContain('metersPerUnit = 1');
    expect(t).toContain('upAxis = "Y"');
    // one mesh per part, not a single box
    expect((t.match(/def Mesh /g) ?? []).length).toBeGreaterThanOrEqual(spec.parts.length);
    const box = await latin(await exportItemUsdz({ ...item, custom: undefined }));
    expect((box.match(/def Mesh /g) ?? []).length).toBe(1);
  });

  it('keeps generated furniture as parts inside the room file', async () => {
    const { EXAMPLES } = await import('../forge/examples');
    const m = sampleRoom();
    const spec = EXAMPLES[0];
    const t = await latin(await exportRoomUsdz(m, [{ ...m.furniture[0], custom: spec }]));
    expect((t.match(/def Mesh /g) ?? []).length).toBeGreaterThan(spec.parts.length);
  });
});
