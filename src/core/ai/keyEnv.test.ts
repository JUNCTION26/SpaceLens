import { afterEach, describe, expect, it, vi } from 'vitest';

describe('environment key', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it('is used in development only', async () => {
    vi.stubEnv('VITE_GEMINI_KEY', 'env-key-for-test');
    vi.stubEnv('DEV', true);
    vi.resetModules();
    const dev = await import('../store');
    expect(dev.getState().settings.geminiKey).toBe('env-key-for-test');

    vi.stubEnv('DEV', false);
    vi.resetModules();
    const prod = await import('../store');
    expect(prod.getState().settings.geminiKey).toBe('');
  });
});
