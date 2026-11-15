import { useEffect, useRef, useState } from 'react';
import { useShownFurniture, useStore } from '../../core/store';
import { useUi } from '../../ui/uiStore';
import { Icon } from '../../ui/icons';
import { captureFrame, type Frame } from './capture';
import { buildPrompt, cacheKey, STYLES, type RenderStyle } from './prompt';
import { generateImage, RenderError } from './generate';
import './render.css';

const cache = new Map<string, { image: string; model: string }>();
const frameSig = (u: string) => { let h = u.length; for (let i = 0; i < u.length; i += 97) h = (Math.imul(h, 31) + u.charCodeAt(i)) | 0; return h.toString(36); };

interface Shot { id: number; frame: Frame; image: string; style: RenderStyle; model: string; secs: number }

function Compare({ before, after }: { before: string; after: string }) {
  const [pos, setPos] = useState(50);
  return (
    <div className="ba" style={{ ['--pos' as string]: `${pos}%` }}>
      <img src={before} alt="3D frame" />
      <img className="top" src={after} alt="AI impression" />
      <span className="tag" style={{ left: 8 }}>3D</span>
      <span className="tag" style={{ right: 8 }}>AI</span>
      <div className="bar" />
      <input type="range" min={0} max={100} value={pos} aria-label="Compare 3D frame and render" onChange={(e) => setPos(Number(e.target.value))} />
    </div>
  );
}

export function RenderPanel() {
  const model = useStore((s) => s.model);
  const requirements = useStore((s) => s.requirements);
  const furniture = useShownFurniture();
  const [style, setStyle] = useState<RenderStyle>('daylight');
  const [busy, setBusy] = useState(false);
  const [secs, setSecs] = useState(0);
  const [error, setError] = useState<Error | null>(null);
  const [shots, setShots] = useState<Shot[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  const [current, setCurrent] = useState<number | null>(null);
  const abort = useRef<AbortController | null>(null);
  const seq = useRef(1);

  useEffect(() => {
    if (!busy) return;
    const t0 = Date.now();
    const t = setInterval(() => setSecs(Math.round((Date.now() - t0) / 1000)), 500);
    return () => clearInterval(t);
  }, [busy]);
  useEffect(() => () => abort.current?.abort(), []);

  const openSettings = () => useUi.getState().setSettingsOpen(true);

  const run = async () => {
    setBusy(true); setSecs(0); setError(null);
    const t0 = Date.now();
    abort.current = new AbortController();
    try {
      const frame = await captureFrame(model, furniture);
      setPreview(frame.dataUrl);
      const key = cacheKey(model, furniture, frameSig(frame.dataUrl), style);
      const hit = cache.get(key);
      const prompt = buildPrompt({ model, furniture, style, requirements });
      const out = hit ? { dataUrl: hit.image, model: hit.model } : await generateImage(frame.dataUrl, prompt, abort.current.signal);
      if (!hit) cache.set(key, { image: out.dataUrl, model: out.model });
      const shot: Shot = { id: seq.current++, frame, image: out.dataUrl, style, model: out.model, secs: Math.round((Date.now() - t0) / 1000) };
      setShots((s) => [shot, ...s].slice(0, 8));
      setCurrent(shot.id);
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      const err = e instanceof Error ? e : new Error('The render failed.');
      setError(err);
    } finally { setBusy(false); setPreview(null); }
  };

  const shot = shots.find((s) => s.id === current) ?? null;
  const download = () => {
    if (!shot) return;
    const a = document.createElement('a');
    a.href = shot.image;
    a.download = `${(model.name || 'room').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-render.${shot.image.startsWith('data:image/jpeg') ? 'jpg' : 'png'}`;
    a.click();
  };

  const word = error instanceof RenderError ? ({ nokey: 'Key', quota: 'Quota', blocked: 'Blocked' } as Record<string, string>)[error.reason] ?? 'Failed' : 'Failed';
  const needsKey = error instanceof RenderError && ['nokey', 'quota', 'blocked'].includes(error.reason);

  return (
    <div className="render">
      <div className="row" role="group" aria-label="Style">
        {STYLES.map((s) => <button key={s.id} className="chip" aria-pressed={style === s.id} onClick={() => setStyle(s.id)}>{s.label}</button>)}
      </div>
      <div className="row">
        <button className="go" disabled={busy} onClick={() => void run()}>{busy ? `${secs}s` : 'Render'}</button>
        {busy && <button className="chip" onClick={() => abort.current?.abort()} aria-label="Cancel"><Icon name="x" size={14} /></button>}
      </div>
      {error && (
        <div className="msg" role="alert" aria-label={error.message}>
          <span title={error.message}>{word}</span>{' '}
          <button className="chip" onClick={() => void run()} aria-label="Retry"><Icon name="redo" size={14} /></button>{' '}
          {needsKey && <button className="chip" onClick={openSettings} aria-label="Settings"><Icon name="settings" size={14} /></button>}
        </div>
      )}
      {busy && preview && <div className="ba shimmer" aria-busy="true"><img src={preview} alt="3D frame" /></div>}
      {!busy && shot && <Compare before={shot.frame.dataUrl} after={shot.image} />}
      {shot && <div className="row"><button className="chip" onClick={download} aria-label="Download" title="Download"><Icon name="download" size={14} /></button></div>}
      {shots.length > 1 && (
        <div className="hist" aria-label="Earlier renders">
          {shots.map((s) => <button key={s.id} aria-current={s.id === current} aria-label={`Render ${s.id}`} onClick={() => setCurrent(s.id)}><img src={s.image} alt="" /></button>)}
        </div>
      )}
    </div>
  );
}

export default RenderPanel;
