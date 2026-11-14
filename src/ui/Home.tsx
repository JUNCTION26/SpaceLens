import { useMemo } from 'react';
import { useStore } from '../core/store';
import { sampleRoom } from '../core/sample';
import { useUi, type CaptureKind } from './uiStore';
import { Settings } from './Settings';
import { Icon } from './icons';
import './home.css';

const OPTIONS: Array<{ kind: CaptureKind; title: string; icon: string }> = [
  { kind: 'scan', title: 'Scan with phone', icon: 'camera' },
  { kind: 'photos', title: 'Use photos', icon: 'image' },
  { kind: 'import', title: 'Import a floor plan', icon: 'file' },
  { kind: 'draw', title: 'Draw with measurements', icon: 'ruler' },
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
    const cx = poly.reduce((a, p) => a + p.x, 0) / poly.length;
    const cy = poly.reduce((a, p) => a + p.y, 0) / poly.length;
    // Size labels sit just outside the two front edges of the floor.
    const labels = poly.map((a, i) => ({ a, b: poly[(i + 1) % poly.length] }))
      .map(({ a, b }) => {
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const dx = mx - cx, dy = my - cy, d = Math.hypot(dx, dy) || 1;
        const at = iso(mx + (dx / d) * 0.5, my + (dy / d) * 0.5, 0);
        return { x: at[0], y: at[1] + 3, depth: mx + my, t: `${Math.hypot(b.x - a.x, b.y - a.y).toFixed(2)} m` };
      })
      .sort((p, q) => q.depth - p.depth).slice(0, 2);
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
  const openSample = () => { dispatch({ type: 'REPLACE_MODEL', model: sampleRoom() }); setMode('design'); };
  return (
    <div className="home">
      <header className="home-top">
        <span className="brand"><Logo /><span>SpaceLens</span></span>
        <button className="icon-btn" onClick={() => setSettingsOpen(true)} aria-label="Settings" title="Settings"><Icon name="settings" /></button>
      </header>
      <main className="home-hero">
        <div className="home-copy">
          <h1>Measure a room.<br />Design it. Walk through it.</h1>
          <p className="home-pitch">For offices, new homes and dream bedrooms. Every size checked.</p>
          <div className="home-cta">
            {recent
              ? <button className="btn btn-primary btn-xl" onClick={() => setMode('design')}>Continue {recent}<Icon name="chevronRight" /></button>
              : <button className="btn btn-primary btn-xl" onClick={openSample}>Open the sample room<Icon name="chevronRight" /></button>}
            <button className="btn btn-ghost btn-xl" onClick={() => window.dispatchEvent(new Event('spacelens:demo'))}><Icon name="play" />Watch demo</button>
          </div>
          <div className="home-start" role="group" aria-labelledby="home-start-label">
            <div className="home-start-head" id="home-start-label">Start from your space</div>
            {OPTIONS.map((o) => (
              <button key={o.kind} className="home-row" onClick={() => openCapture(o.kind)}>
                <Icon name={o.icon} size={16} /><span>{o.title}</span><Icon name="chevronRight" size={14} className="home-row-go" />
              </button>
            ))}
          </div>
          {recent && <button className="home-link" onClick={openSample}>Or open the sample room</button>}
        </div>
        <div className="home-art" aria-hidden="false"><Hero /></div>
      </main>
      <Settings />
    </div>
  );
}
