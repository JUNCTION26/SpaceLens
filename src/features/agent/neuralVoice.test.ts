import { describe, expect, it } from 'vitest';
import { audioParts, pcm16ToFloat, pcmRate, stripWavHeader } from './neuralVoice';

describe('neural voice helpers', () => {
  it('reads the sample rate from the mime type', () => {
    expect(pcmRate('audio/l16; rate=24000; channels=1')).toBe(24000);
    expect(pcmRate('audio/L16;codec=pcm;rate=16000')).toBe(16000);
    expect(pcmRate('audio/wav')).toBe(24000);
  });
  it('decodes little-endian 16-bit samples and carries an odd byte to the next chunk', () => {
    const a = pcm16ToFloat(new Uint8Array([0x00, 0x40, 0x00])); // 0.5, then one stray byte
    expect(a.samples[0]).toBeCloseTo(0.5);
    expect(a.carry).toBe(0x00);
    const b = pcm16ToFloat(new Uint8Array([0x80]), a.carry); // 0x8000 = -1
    expect(b.samples[0]).toBeCloseTo(-1);
    expect(b.carry).toBeNull();
  });
  it('strips a WAV header only when present', () => {
    const wav = new Uint8Array(48); wav.set([0x52, 0x49, 0x46, 0x46]);
    expect(stripWavHeader(wav).length).toBe(4);
    expect(stripWavHeader(new Uint8Array(48)).length).toBe(48);
  });
  it('finds audio parts in a streamed payload', () => {
    const p = { candidates: [{ content: { parts: [{ inlineData: { data: 'AAA=', mimeType: 'audio/l16; rate=24000' } }, { text: 'x' }] } }] };
    expect(audioParts(p)).toEqual([{ data: 'AAA=', mime: 'audio/l16; rate=24000' }]);
    expect(audioParts({})).toEqual([]);
  });
});
