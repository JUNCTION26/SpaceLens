import { useEffect, useRef, useState } from 'react';
import { useShownFurniture, useStore } from '../../core/store';
import { useUi } from '../../ui/uiStore';
import { notify } from '../../ui/notify';
import { captureFrame, type Frame } from './capture';
import { buildPrompt, STYLES, type RenderStyle } from './prompt';
import { generateImage, RenderError } from './generate';
import './render.css';

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
      const prompt = buildPrompt({ model, furniture, style, requirements });
      const out = await generateImage(frame.dataUrl, prompt, abort.current.signal);
      const shot: Shot = { id: seq.current++, frame, image: out.dataUrl, style, model: out.model, secs: Math.round((Date.now() - t0) / 1000) };
      setShots((s) => [shot, ...s].slice(0, 8));
      setCurrent(shot.id);
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      const err = e instanceof Error ? e : new Error('The render failed.');
      setError(err);
      const needsKey = err instanceof RenderError && ['nokey', 'quota', 'blocked'].includes(err.reason);
      notify(err.message, { tone: 'error', actions: [{ label: 'Retry', run: () => void run() }, ...(needsKey ? [{ label: 'Open settings', run: openSettings }] : [])] });
    } finally { setBusy(false); }
  };

  const shot = shots.find((s) => s.id === current) ?? null;
  const download = () => {
    if (!shot) return;
    const a = document.createElement('a');
    a.href = shot.image;
    a.download = `${(model.name || 'room').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-render.png`;
    a.click();
  };

  return (
    <div className="render">
      <h2>Render</h2>
      <div className="row" role="group" aria-label="Style">
        {STYLES.map((s) => <button key={s.id} className="chip" aria-pressed={style === s.id} onClick={() => setStyle(s.id)}>{s.label}</button>)}
      </div>
      <div className="row">
        <button className="go" disabled={busy} onClick={() => void run()}>{busy ? `Rendering... ${secs}s` : 'Render this view'}</button>
        {busy && <button className="chip" onClick={() => abort.current?.abort()}>Cancel</button>}
        {shot && <button className="chip" onClick={download}>Download</button>}
      </div>
      {error && (
        <div className="msg" role="alert">
          {error.message}{' '}
          <button className="chip" onClick={() => void run()}>Retry</button>{' '}
          <button className="chip" onClick={openSettings}>Settings</button>
        </div>
      )}
      {shot && <Compare before={shot.frame.dataUrl} after={shot.image} />}
      {shot && <div className="label">{STYLES.find((s) => s.id === shot.style)?.label}, {shot.secs}s, {shot.model}</div>}
      {shots.length > 1 && (
        <div className="hist" aria-label="Earlier renders">
          {shots.map((s) => <button key={s.id} aria-current={s.id === current} aria-label={`Render ${s.id}`} onClick={() => setCurrent(s.id)}><img src={s.image} alt="" /></button>)}
        </div>
      )}
    </div>
  );
}

export default RenderPanel;
