import { useEffect, useState } from 'react';
import type * as THREE from 'three';
import { useStore } from '../../core/store';

export type XRMode = 'immersive-vr' | 'immersive-ar';

export interface XRSystemLike { isSessionSupported(m: string): Promise<boolean>; requestSession(m: string, o?: unknown): Promise<unknown> }
export interface NavLike { xr?: XRSystemLike; userAgent?: string; platform?: string; maxTouchPoints?: number }

export interface XRSupport {
  /** immersive-vr resolved true. */
  vr: boolean;
  /** immersive-ar resolved true. */
  ar: boolean;
  /** iPhone/iPad Safari: the only AR path is the USDZ Quick Look button. */
  quickLook: boolean;
}
export const NO_XR: XRSupport = { vr: false, ar: false, quickLook: false };

const nav = (): NavLike | null => (typeof navigator !== 'undefined' ? (navigator as unknown as NavLike) : null);

/** iPhone, iPad (including iPadOS reporting as Mac with touch). */
export function isIOS(n: NavLike | null): boolean {
  if (!n) return false;
  const ua = n.userAgent ?? '';
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return n.platform === 'MacIntel' && (n.maxTouchPoints ?? 0) > 1;
}

/**
 * Which immersive paths this browser really offers. A mode is true only when navigator.xr exists and
 * isSessionSupported(mode) resolved true. Never throws. iOS gets Quick Look only.
 */
export async function detectXR(n: NavLike | null = nav()): Promise<XRSupport> {
  if (!n) return NO_XR;
  if (isIOS(n)) return { vr: false, ar: false, quickLook: true };
  const xr = n.xr;
  if (!xr || typeof xr.isSessionSupported !== 'function') return NO_XR;
  const check = async (m: XRMode) => {
    try { return (await xr.isSessionSupported(m)) === true; } catch { return false; }
  };
  const [vr, ar] = await Promise.all([check('immersive-vr'), check('immersive-ar')]);
  return { vr, ar, quickLook: false };
}

/** Which immersive modes this browser can start. All false until detection resolves true. */
export function useXRSupport(): XRSupport {
  const [sup, setSup] = useState<XRSupport>(NO_XR);
  useEffect(() => {
    let alive = true;
    detectXR().then((s) => { if (alive) setSup(s); }).catch(() => undefined);
    return () => { alive = false; };
  }, []);
  return sup;
}

/** True when the active session granted the hit-test feature. */
export function sessionHasHitTest(session: XRSession | null | undefined): boolean {
  const f = (session as unknown as { enabledFeatures?: string[] } | null | undefined)?.enabledFeatures;
  return Array.isArray(f) && f.includes('hit-test');
}

interface CamLike { position: THREE.Vector3; quaternion: THREE.Quaternion; fov?: number; updateProjectionMatrix?: () => void }
interface ControlsLike { enabled: boolean }
export interface EnterOpts {
  camera?: CamLike | null;
  controls?: ControlsLike | null;
  /** Short message shown to the user, for example "VR unavailable". */
  onError?: (text: string) => void;
}

export const MODE_FAIL: Record<XRMode, string> = { 'immersive-vr': 'VR unavailable', 'immersive-ar': 'AR unavailable' };

/** Pure: which optional features to ask for. hit-test and anchors only matter in AR. */
export function sessionInit(mode: XRMode): { optionalFeatures: string[] } {
  const common = ['local-floor', 'bounded-floor', 'hand-tracking'];
  return { optionalFeatures: mode === 'immersive-ar' ? [...common, 'hit-test', 'dom-overlay'] : common };
}

/**
 * Start (or end) an immersive session. Call it straight from a click handler: requestSession must run
 * inside the user gesture, so nothing is awaited before it. Resolves false and reports a short message
 * when the session could not start; it never throws. On session end it restores the camera, renderer
 * size, pixel ratio and controls, and it ends the session if the tab is hidden or the GL context is lost.
 */
export function enterXR(gl: THREE.WebGLRenderer | null, mode: XRMode, opts: EnterOpts = {}): Promise<boolean> {
  const fail = () => { try { (opts.onError ?? ((t) => useStore.getState().toast(t, 'warn')))(MODE_FAIL[mode]); } catch { /* ignore */ } return false; };
  try {
    const xr = nav()?.xr;
    if (!xr || !gl || typeof xr.requestSession !== 'function') return Promise.resolve(fail());
    if (gl.xr.isPresenting) {
      const s = gl.xr.getSession();
      return (s ? s.end().catch(() => undefined) : Promise.resolve()).then(() => false);
    }
    // First statement that touches the platform is requestSession, still in the gesture.
    const pending = xr.requestSession(mode, sessionInit(mode));
    return pending.then(async (raw) => {
      const session = raw as XRSession;
      const saved = {
        ratio: gl.getPixelRatio(),
        size: (() => { const v = { x: 0, y: 0 }; gl.getSize(v as unknown as THREE.Vector2); return v; })(),
        pos: opts.camera?.position.clone(), quat: opts.camera?.quaternion.clone(), fov: opts.camera?.fov,
        controls: opts.controls?.enabled,
        xrEnabled: gl.xr.enabled,
      };
      const canvas = gl.domElement;
      const onHidden = () => { if (document.visibilityState === 'hidden') session.end().catch(() => undefined); };
      const onLost = (e: Event) => { e.preventDefault(); session.end().catch(() => undefined); useStore.getState().toast(MODE_FAIL[mode], 'warn'); };
      document.addEventListener('visibilitychange', onHidden);
      canvas.addEventListener('webglcontextlost', onLost);
      session.addEventListener('end', () => {
        document.removeEventListener('visibilitychange', onHidden);
        canvas.removeEventListener('webglcontextlost', onLost);
        try {
          gl.xr.enabled = saved.xrEnabled;
          gl.setPixelRatio(saved.ratio);
          gl.setSize(saved.size.x, saved.size.y, false);
          const c = opts.camera;
          if (c) {
            if (saved.pos) c.position.copy(saved.pos);
            if (saved.quat) c.quaternion.copy(saved.quat);
            if (saved.fov !== undefined) c.fov = saved.fov;
            c.updateProjectionMatrix?.();
          }
          if (opts.controls && saved.controls !== undefined) opts.controls.enabled = saved.controls;
        } catch { /* restoring is best effort */ }
      });
      if (opts.controls) opts.controls.enabled = false;
      try {
        gl.xr.enabled = true;
        gl.xr.setReferenceSpaceType('local-floor');
        await gl.xr.setSession(session);
        return true;
      } catch {
        session.end().catch(() => undefined);
        return fail();
      }
    }).catch(fail);
  } catch { return Promise.resolve(fail()); }
}
