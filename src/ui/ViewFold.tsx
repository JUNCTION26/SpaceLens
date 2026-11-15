import { useEffect } from 'react';
import { create } from 'zustand';
import { useStore } from '../core/store';
import type { Layers, Opening, SourceKind, Space } from '../core/types';
import type { XRMode } from '../features/xr/xrSupport';

/** Wall and opening colours on the plan's Sources layer. */
export const PROV: Record<SourceKind, string> = {
  'user-measured': '#2fbf71', 'ar-depth': '#3fa7ff', 'photo-inferred': '#f0a030', 'pdf-annotation': '#a77bff',
  manual: '#5ed1c9', catalog: '#9aa4b2', generated: '#e86fb0', sample: '#8a8f98',
};
const PROV_LABEL: Record<SourceKind, string> = {
  'user-measured': 'Measured', 'ar-depth': 'Phone scan', 'photo-inferred': 'From photo', 'pdf-annotation': 'From drawing',
  manual: 'Manual', catalog: 'Catalog', generated: 'Generated', sample: 'Example',
};
const LAYER_LABEL: Record<keyof Layers, string> = {
  dimensions: 'Sizes', clearance: 'Clearance', routes: 'Routes', provenance: 'Sources', heat: 'Heat', sightlines: 'Views',
};
function usedKinds(m: { spaces: Space[]; openings: Opening[] }) {
  const s = new Set<SourceKind>();
  m.spaces.forEach((sp) => sp.walls.forEach((w) => s.add(w.sourceKind)));
  m.openings.forEach((o) => s.add(o.sourceKind));
  return s;
}

export type CamMode = 'orbit' | 'walk';
export type Quality = 'high' | 'low';
export type ViewAngle = 'corner' | 'top' | 'front';

export const EYES = [
  { id: 'standing', label: 'Standing', h: 1.6 },
  { id: 'seated', label: 'Seated', h: 1.2 },
  { id: 'child', label: 'Child', h: 1.0 },
  { id: 'wheelchair', label: 'Wheelchair', h: 1.2 },
];

const START_QUALITY: Quality = typeof window !== 'undefined' && (window.devicePixelRatio || 1) < 1.25 && (navigator.hardwareConcurrency || 8) <= 4 ? 'low' : 'high';

/** View options shared by the top bar, the View fold in the left panel and the two views. */
interface ViewPrefs {
  cam: CamMode;
  eyeId: string;
  cutaway: boolean;
  figure: boolean;
  showBefore: boolean;
  hour: number;
  quality: Quality;
  tilt: boolean;
  /** Set by the 3D view while it runs a tour. */
  touring: boolean;
  /** Set by the 3D view while an immersive session runs. */
  xrMode: XRMode | null;
  /** The views fill the screen (Fullscreen API). */
  full: boolean;
  /** The views fill the window where the Fullscreen API is missing or refused. */
  pseudo: boolean;
  /** The plan's scale bar: a round length in metres and its width on screen, published by the plan. */
  scale: { m: number; px: number } | null;
}
export const useViewPrefs = create<ViewPrefs>(() => ({
  cam: 'orbit', eyeId: 'standing', cutaway: true, figure: false, showBefore: false, hour: 15, quality: START_QUALITY, tilt: false,
  touring: false, xrMode: null, full: false, pseudo: false, scale: null,
}));
export const setViewPrefs = (p: Partial<ViewPrefs>) => useViewPrefs.setState(p);

const emit = (name: string, detail?: unknown) => window.dispatchEvent(new CustomEvent(name, { detail }));

/** Full screen for the views area (both panes). Falls back to filling the window. */
export function toggleStageFull() {
  const { pseudo } = useViewPrefs.getState();
  if (pseudo) { setViewPrefs({ pseudo: false }); return; }
  if (typeof document === 'undefined') return;
  if (document.fullscreenElement) { void document.exitFullscreen().catch(() => {}); return; }
  const el = document.querySelector<HTMLElement>('.stage');
  if (!el) return;
  const p = el.requestFullscreen?.();
  if (!p) { setViewPrefs({ pseudo: true }); return; }
  p.catch(() => setViewPrefs({ pseudo: true }));
}

/** Keeps the full screen flag in step with the browser, and lets Esc leave the window-filling fallback. */
export function useStageFullSync() {
  const pseudo = useViewPrefs((s) => s.pseudo);
  useEffect(() => {
    const on = () => setViewPrefs({ full: !!document.fullscreenElement?.classList.contains('stage') });
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  useEffect(() => {
    if (!pseudo) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setViewPrefs({ pseudo: false }); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [pseudo]);
}

/** Walk on or off. From the plan alone, a 3D pane opens first. */
export function toggleWalk() {
  const v = useViewPrefs.getState();
  if (v.touring) { emit('spacelens:stop-tour'); return; }
  const st = useStore.getState();
  if (st.view === '2d' && st.mode !== 'experience') { st.setView('split'); setViewPrefs({ cam: 'walk' }); return; }
  setViewPrefs({ cam: v.cam === 'walk' ? 'orbit' : 'walk' });
}

/** Look around by turning the phone; asks for motion access where the browser needs it. */
async function startTilt() {
  const D = (window as unknown as { DeviceOrientationEvent?: { requestPermission?: () => Promise<string> } }).DeviceOrientationEvent;
  if (!D) { useStore.getState().toast('No motion sensor', 'warn'); return; }
  if (typeof D.requestPermission === 'function') {
    try { if ((await D.requestPermission()) !== 'granted') { useStore.getState().toast('Motion not allowed', 'warn'); return; } } catch { return; }
  }
  setViewPrefs({ tilt: true });
}

const COARSE = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
const CAN_RECORD = typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement !== 'undefined' && 'captureStream' in HTMLCanvasElement.prototype;
const LAYER_KEYS: Array<keyof Layers> = ['dimensions', 'clearance', 'routes', 'provenance', 'heat'];
const hhmm = (h: number) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;

/** Camera, light, layers and scale for the two views, in one closed fold at the bottom of the left panel. */
export function ViewFold() {
  const p = useViewPrefs();
  const layers = useStore((s) => s.layers);
  const toggleLayer = useStore((s) => s.toggleLayer);
  const model = useStore((s) => s.model);
  const activeCandidateId = useStore((s) => s.activeCandidateId);
  const view = useStore((s) => s.view);
  const mode = useStore((s) => s.mode);
  const has3d = mode === 'experience' || view !== '2d';
  const has2d = mode !== 'experience' && view !== '3d';
  const multi = model.spaces.length > 1;
  const walking = p.cam === 'walk';
  const kinds = layers.provenance ? [...usedKinds(model)] as SourceKind[] : [];

  return (
    <details className="settings-group settings-adv view-fold">
      <summary><h3>View</h3></summary>
      <div className="view-fold-row">
        <button className="btn btn-sm" onClick={() => emit('spacelens:reset-view')}>Fit</button>
        {has3d && (['corner', 'top', 'front'] as ViewAngle[]).map((v) => (
          <button key={v} className="btn btn-sm" onClick={() => emit('spacelens:view-angle', v)}>{v === 'corner' ? 'Corner' : v === 'top' ? 'Top' : 'Front'}</button>
        ))}
      </div>
      {has3d && multi && (
        <div className="view-fold-row">
          {p.touring
            ? <button className="btn btn-sm" onClick={() => emit('spacelens:stop-tour')}>Stop tour</button>
            : <><button className="btn btn-sm" onClick={() => emit('spacelens:auto-tour', { record: false })}>Auto tour</button>
              {CAN_RECORD && <button className="btn btn-sm" onClick={() => emit('spacelens:auto-tour', { record: true })}>Record tour</button>}</>}
        </div>
      )}
      {has3d && walking && (
        <label className="view-fold-field">Eye height
          <select value={p.eyeId} onChange={(e) => setViewPrefs({ eyeId: e.target.value })}>
            {EYES.map((e) => <option key={e.id} value={e.id}>{e.label} {e.h} m</option>)}
          </select>
        </label>
      )}
      {has3d && walking && COARSE && <label className="view-fold-check"><input type="checkbox" checked={p.tilt} onChange={(e) => { if (e.target.checked) void startTilt(); else setViewPrefs({ tilt: false }); }} /> Phone look</label>}
      {has3d && !walking && <label className="view-fold-check"><input type="checkbox" checked={p.cutaway} onChange={(e) => setViewPrefs({ cutaway: e.target.checked })} /> Cut away</label>}
      {has3d && !walking && <label className="view-fold-check"><input type="checkbox" checked={p.figure} onChange={(e) => setViewPrefs({ figure: e.target.checked })} /> 1.75 m person</label>}
      {has3d && activeCandidateId && <label className="view-fold-check"><input type="checkbox" checked={p.showBefore} onChange={(e) => setViewPrefs({ showBefore: e.target.checked })} /> Show before</label>}
      {has3d && (
        <label className="view-fold-field scene3d-sun">Time <span className="view-fold-val">{hhmm(p.hour)}</span>
          <input type="range" min={6} max={23} step={0.25} value={p.hour} onChange={(e) => setViewPrefs({ hour: Number(e.target.value) })} aria-label="Time of day" />
        </label>
      )}
      {has3d && <label className="view-fold-check"><input type="checkbox" checked={p.quality === 'high'} onChange={(e) => setViewPrefs({ quality: e.target.checked ? 'high' : 'low' })} /> HQ</label>}
      {has2d && (
        <div className="view-fold-layers" role="group" aria-label="Layers">
          {LAYER_KEYS.map((k) => (
            <label key={k} className="view-fold-check"><input type="checkbox" checked={layers[k]} onChange={() => toggleLayer(k)} /> {LAYER_LABEL[k]}</label>
          ))}
        </div>
      )}
      {has2d && kinds.length > 0 && (
        <div className="view-fold-legend">
          {kinds.map((k) => <span key={k}><i style={{ background: PROV[k] }} />{PROV_LABEL[k]}</span>)}
        </div>
      )}
      {has2d && p.scale && (
        <div className="view-fold-scale" aria-label="Plan scale">
          <svg width={p.scale.px} height={10} aria-hidden="true"><rect x={0} y={2} width={p.scale.px / 2} height={5} /><rect x={p.scale.px / 2} y={2} width={p.scale.px / 2} height={5} className="hollow" /></svg>
          <span>{p.scale.m >= 1 ? `${p.scale.m} m` : `${Math.round(p.scale.m * 100)} cm`}</span>
        </div>
      )}
    </details>
  );
}
