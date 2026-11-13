import { useMemo, useState } from 'react';
import { useStore } from '../core/store';
import { sampleRoom } from '../core/sample';
import { useUi, type CaptureKind } from './uiStore';
import { Settings } from './Settings';

const OPTIONS: Array<{ kind: CaptureKind; title: string; text: string; icon: string }> = [
  { kind: 'scan', title: 'Scan with phone', text: 'Walk the room with your camera.', icon: 'M7 3H5a2 2 0 0 0-2 2v2M17 3h2a2 2 0 0 1 2 2v2M7 21H5a2 2 0 0 1-2-2v-2M17 21h2a2 2 0 0 0 2-2v-2M7 12h10' },
  { kind: 'photos', title: 'Use photos', text: 'Add a few photos of the room.', icon: 'M4 7h3l2-3h6l2 3h3v12H4zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z' },
  { kind: 'import', title: 'Import a floor plan', text: 'PDF or image of a plan or drawing.', icon: 'M6 3h9l5 5v13H6zM14 3v6h6M9 14h8M9 18h5' },
  { kind: 'draw', title: 'Draw with measurements', text: 'Type the wall lengths you measured.', icon: 'M4 20 20 4M4 20h6M4 20v-6M14 4h6v6' },
];

/** Isometric hero drawn from the real sample room polygon and ceiling height. */
function Hero() {
  const geo = useMemo(() => {
    const m = sampleRoom();
    const poly = m.spaces[0].polygon;
    const h = m.ceilingM;
    const s = 26;
    const iso = (x: number, y: number, z: number): [number, number] => [(x - y) * 0.866 * s, (x + y) * 0.5 * s - z * s];
    const path = (z: number) => poly.map((p, i) => `${i ? 'L' : 'M'}${iso(p.x, p.y, z).join(' ')}`).join(' ') + ' Z';
    const verticals = poly.map((p) => `M${iso(p.x, p.y, 0).join(' ')} L${iso(p.x, p.y, h).join(' ')}`).join(' ');
    const pts = poly.flatMap((p) => [iso(p.x, p.y, 0), iso(p.x, p.y, h)]);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const pad = 24;
    const vb = `${Math.min(...xs) - pad} ${Math.min(...ys) - pad} ${Math.max(...xs) - Math.min(...xs) + pad * 2} ${Math.max(...ys) - Math.min(...ys) + pad * 2}`;
    const labels = poly.slice(0, 2).map((a, i) => {
      const b = poly[i + 1];
      const mid = iso((a.x + b.x) / 2, (a.y + b.y) / 2, 0);
      return { x: mid[0], y: mid[1] + 16, t: `${Math.hypot(b.x - a.x, b.y - a.y).toFixed(2)} m` };
    });
    return { floor: path(0), ceil: path(h), verticals, vb, labels };
  }, []);
  return (
    <svg className="hero-svg" viewBox={geo.vb} role="img" aria-label="Sample room outline rising into 3D">
      <path className="hero-floor" d={geo.floor} pathLength={1} />
      <path className="hero-walls" d={geo.verticals} />
      <path className="hero-ceil" d={geo.ceil} pathLength={1} />
      {geo.labels.map((l, i) => <text key={i} className="hero-label" x={l.x} y={l.y} textAnchor="middle">{l.t}</text>)}
    </svg>
  );
}

export function Logo() {
  return (
    <svg className="logo" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3 21 8v8l-9 5-9-5V8z" /><path d="M3 8l9 5 9-5M12 13v8" />
    </svg>
  );
}

export function Home() {
  const dispatch = useStore((s) => s.dispatch);
  const setMode = useStore((s) => s.setMode);
  const openCapture = useUi((s) => s.openCapture);
  const setSettingsOpen = useUi((s) => s.setSettingsOpen);
  const [open, setOpen] = useState(false);
  return (
    <div className="home">
      <header className="home-top">
        <span className="brand"><Logo /><span>SpaceLens</span></span>
        <button className="btn btn-ghost btn-sm" onClick={() => setSettingsOpen(true)}>Settings</button>
      </header>
      <section className="home-hero">
        <div className="home-copy">
          <h1>Measure a room, redesign it, walk through it.</h1>
          <p className="muted">Turn a scan, photo or floor plan into a measured room. Try layouts that fit, then step inside.</p>
          {!open ? (
            <button className="btn btn-primary btn-xl" onClick={() => setOpen(true)} aria-expanded={false}>Create a space</button>
          ) : (
            <div className="home-options">
              {OPTIONS.map((o, i) => (
                <button key={o.kind} className="card home-option" style={{ animationDelay: `${i * 50}ms` }} onClick={() => openCapture(o.kind)}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d={o.icon} /></svg>
                  <span><strong>{o.title}</strong><span className="muted">{o.text}</span></span>
                </button>
              ))}
            </div>
          )}
          <button className="btn btn-ghost" onClick={() => { dispatch({ type: 'REPLACE_MODEL', model: sampleRoom() }); setMode('design'); }}>
            Open sample room <span className="chip">Sample</span>
          </button>
        </div>
        <div className="home-art"><Hero /></div>
      </section>
      <Settings />
    </div>
  );
}
