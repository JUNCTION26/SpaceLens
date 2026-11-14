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
