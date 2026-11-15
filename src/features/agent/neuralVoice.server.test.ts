import { describe, expect, it, vi } from 'vitest';
import { clipSpeech } from './neuralVoice';

describe('server speech clip', () => {
  it('decodes one base64 PCM clip and plays it at the mime rate', async () => {
    const pcm = btoa(String.fromCharCode(0x00, 0x40, 0x00, 0x80));
    const f = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ model: 'm', mimeType: 'audio/l16; rate=16000', data: pcm }) });
    vi.stubGlobal('fetch', f);
    const got: { n: number; rate: number; v0: number }[] = [];
    await clipSpeech({ kind: 'server', base: 'https://api.test' }, 'hi', (s, rate) => got.push({ n: s.length, rate, v0: s[0] }));
    expect(f.mock.calls[0][0]).toBe('https://api.test/v1/speech');
    expect(got).toEqual([{ n: 2, rate: 16000, v0: 0.5 }]);
    vi.unstubAllGlobals();
  });
});
