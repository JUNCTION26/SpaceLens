import { useMemo } from 'react';
import { useStore } from '../core/store';
import { sampleRoom } from '../core/sample';
import { useUi, type CaptureKind } from './uiStore';
import { Settings } from './Settings';
import './home.css';

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
    const cx = poly.reduce((a, p) => a + p.x, 0) / poly.length;
    const cy = poly.reduce((a, p) => a + p.y, 0) / poly.length;
    const boxAt = (x: number, y: number, w: number, d: number, bh: number) => {
      const c = [[x, y], [x + w, y], [x + w, y + d], [x, y + d]];
      const top = c.map(([a, b], i) => `${i ? 'L' : 'M'}${iso(a, b, bh).join(' ')}`).join(' ') + ' Z';
      const front = [[x + w, y], [x + w, y + d], [x + w, y + d, bh], [x + w, y, bh]].map(([a, b, z = 0], i) => `${i ? 'L' : 'M'}${iso(a, b, z).join(' ')}`).join(' ') + ' Z';
      const side = [[x, y + d], [x + w, y + d], [x + w, y + d, bh], [x, y + d, bh]].map(([a, b, z = 0], i) => `${i ? 'L' : 'M'}${iso(a, b, z).join(' ')}`).join(' ') + ' Z';
      return { top, front, side };
    };
    const furniture = [
      boxAt(cx - 1.4, cy - 1.2, 2, 0.9, 0.45),
      boxAt(cx + 0.2, cy + 0.3, 0.9, 0.9, 0.42),
      boxAt(cx - 1.2, cy + 0.4, 0.6, 0.6, 0.75),
    ];
    return { floor: path(0), ceil: path(h), verticals, vb, labels, furniture };
  }, []);
  return (
    <svg className="hero-svg" viewBox={geo.vb} role="img" aria-label="Sample room outline rising into 3D">
      <path className="hero-floor" d={geo.floor} pathLength={1} />
      <path className="hero-walls" d={geo.verticals} />
      {geo.furniture.map((f, i) => (
        <g key={i} className="hero-furn" style={{ animationDelay: `${1.6 + i * 0.25}s` }}>
          <path className="hf-side" d={f.side} /><path className="hf-front" d={f.front} /><path className="hf-top" d={f.top} />
        </g>
      ))}
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
  const recent = useMemo(() => {
    try {
      const raw = localStorage.getItem('spacelens.model.v1');
      const m = raw ? (JSON.parse(raw) as { name?: string; spaces?: unknown[] }) : null;
      return m && m.spaces && m.spaces.length ? (m.name || 'Untitled room') : null;
    } catch { return null; }
  }, []);
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
          <h2 className="home-create">Create a space</h2>
          <div className="home-options">
            {OPTIONS.map((o, i) => (
              <button key={o.kind} className="card home-option" style={{ animationDelay: `${i * 50}ms` }} onClick={() => openCapture(o.kind)}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d={o.icon} /></svg>
                <span><strong>{o.title}</strong><span className="muted">{o.text}</span></span>
              </button>
            ))}
          </div>
          <div className="home-secondary">
            <button className="btn" onClick={() => { dispatch({ type: 'REPLACE_MODEL', model: sampleRoom() }); setMode('design'); }}>
              Try the sample room <span className="chip">Sample</span>
            </button>
            <button className="btn btn-ghost home-demo" onClick={() => window.dispatchEvent(new Event('spacelens:demo'))}>Watch a guided demo</button>
          </div>
          {recent && (
            <div className="home-recent">
              <span className="muted">Recent</span>
              <button className="card home-recent-item" onClick={() => setMode('design')}>{recent}<span className="muted">Open</span></button>
            </div>
          )}
        </div>
        <div className="home-art"><Hero /></div>
      </section>
      <Settings />
    </div>
  );
}
