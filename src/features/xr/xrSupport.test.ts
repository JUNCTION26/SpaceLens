import { describe, it, expect, vi } from 'vitest';
import { detectXR, isIOS, sessionInit, NO_XR } from './xrSupport';

const xr = (vr: unknown, ar: unknown) => ({
  isSessionSupported: vi.fn(async (m: string) => { const v = m === 'immersive-vr' ? vr : ar; if (v === 'throw') throw new Error('x'); return v as boolean; }),
  requestSession: vi.fn(),
});

describe('detectXR', () => {
  it('nothing without navigator.xr', async () => {
    expect(await detectXR({ userAgent: 'Chrome' })).toEqual(NO_XR);
    expect(await detectXR(null)).toEqual(NO_XR);
  });
  it('true only when isSessionSupported resolves true', async () => {
    expect(await detectXR({ xr: xr(true, false) })).toEqual({ vr: true, ar: false, quickLook: false });
    expect(await detectXR({ xr: xr(false, true) })).toEqual({ vr: false, ar: true, quickLook: false });
    expect(await detectXR({ xr: xr('yes', 1) })).toEqual(NO_XR);
  });
  it('rejections count as unsupported', async () => {
    expect(await detectXR({ xr: xr('throw', 'throw') })).toEqual(NO_XR);
  });
  it('iOS gets Quick Look only', async () => {
    const n = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', xr: xr(true, true) };
    expect(await detectXR(n)).toEqual({ vr: false, ar: false, quickLook: true });
    expect(isIOS({ userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 5 })).toBe(true);
    expect(isIOS({ userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 0 })).toBe(false);
  });
  it('hit-test is requested for AR only', () => {
    expect(sessionInit('immersive-ar').optionalFeatures).toContain('hit-test');
    expect(sessionInit('immersive-vr').optionalFeatures).not.toContain('hit-test');
  });
});
