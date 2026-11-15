import { afterEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
const store = { settings: { geminiKey: '' as string } };
vi.mock('../../core/store', () => ({ getState: () => store }));

import { generateImage } from './generate';

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
afterEach(() => { fetchMock.mockReset(); vi.unstubAllEnvs(); });

describe('generateImage transport', () => {
  it('stays offline with no key and no server', async () => {
    store.settings.geminiKey = '';
    vi.stubEnv('VITE_API_BASE', '');
    await expect(generateImage('data:image/png;base64,AAAA', 'x')).rejects.toMatchObject({ reason: 'nokey' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('uses the server with no key', async () => {
    store.settings.geminiKey = '';
    vi.stubEnv('VITE_API_BASE', 'https://api.test/');
    fetchMock.mockResolvedValueOnce(ok({ model: 'm', mimeType: 'image/png', data: 'QUJD' }));
    const r = await generateImage('data:image/png;base64,AAAA', 'x');
    expect(r.dataUrl).toBe('data:image/png;base64,QUJD');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.test/v1/image');
    expect(JSON.stringify(fetchMock.mock.calls[0][1])).not.toContain('x-goog-api-key');
  });
  it('goes direct with a key and falls through models', async () => {
    store.settings.geminiKey = 'k';
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) });
    fetchMock.mockResolvedValueOnce(ok({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/jpeg', data: 'WFla' } }] } }] }));
    const r = await generateImage('data:image/png;base64,AAAA', 'x');
    expect(r.dataUrl).toBe('data:image/jpeg;base64,WFla');
    expect(String(fetchMock.mock.calls[0][0])).toContain('generativelanguage.googleapis.com');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
