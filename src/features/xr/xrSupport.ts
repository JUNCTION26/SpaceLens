import { useEffect, useState } from 'react';
import type * as THREE from 'three';

export type XRMode = 'immersive-vr' | 'immersive-ar';

interface XRSystemLike { isSessionSupported(m: string): Promise<boolean>; requestSession(m: string, o?: unknown): Promise<unknown> }
const xrSys = (): XRSystemLike | null =>
  (typeof navigator !== 'undefined' && (navigator as unknown as { xr?: XRSystemLike }).xr) || null;

/** Which immersive modes this browser can start. Both false on desktop/phones without WebXR. */
export function useXRSupport() {
  const [sup, setSup] = useState({ vr: false, ar: false });
  useEffect(() => {
    const xr = xrSys(); if (!xr) return;
    let alive = true;
    const check = (m: XRMode) => xr.isSessionSupported(m).catch(() => false);
    Promise.all([check('immersive-vr'), check('immersive-ar')]).then(([vr, ar]) => { if (alive) setSup({ vr, ar }); });
    return () => { alive = false; };
  }, []);
  return sup;
}

/** Start an immersive session on the renderer. Resolves false if it could not start. */
export async function enterXR(gl: THREE.WebGLRenderer | null, mode: XRMode): Promise<boolean> {
  const xr = xrSys();
  if (!xr || !gl) return false;
  if (gl.xr.isPresenting) { await gl.xr.getSession()?.end(); return false; }
  try {
    const session = await xr.requestSession(mode, { optionalFeatures: ['local-floor', 'hand-tracking', 'bounded-floor'] });
    gl.xr.enabled = true;
    gl.xr.setReferenceSpaceType('local-floor');
    await gl.xr.setSession(session as XRSession);
    return true;
  } catch { return false; }
}
