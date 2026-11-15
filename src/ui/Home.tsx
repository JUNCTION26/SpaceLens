import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../core/store';
import { sampleRoom } from '../core/sample';
import { useUi, type CaptureKind } from './uiStore';
import { Settings } from './Settings';
import { Icon } from './icons';
import { runStart, type StartKind } from '../features/demo/starts';
import './home.css';

/** One-click starts: each lands on a finished result in seconds, no key needed. */
const STARTS: Array<{ kind: StartKind; title: string; text: string; icon: string }> = [
  { kind: 'plan', title: 'Plan to 3D', text: 'Real apartment', icon: 'file' },
  { kind: 'villa', title: 'Plan a villa', text: '3 bedrooms', icon: 'grid' },
  { kind: 'room', title: 'Design a room', text: 'Home office', icon: 'layout' },
];

const EXAMPLES = ['A room for my cat Gerard', 'a calm home office', 'a ramen bar', 'a kids room for two'];

/* eslint-disable @typescript-eslint/no-explicit-any */
const SpeechCtor = (): (new () => any) | undefined =>
  typeof window === 'undefined' ? undefined : ((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition);

const OPTIONS: Array<{ kind: CaptureKind; title: string; icon: string }> = [
  { kind: 'scan', title: 'Scan with phone', icon: 'camera' },
  { kind: 'photos', title: 'Use photos', icon: 'image' },
  { kind: 'import', title: 'Import a plan', icon: 'file' },
  { kind: 'draw', title: 'Draw by hand', icon: 'ruler' },
];

/** Looping preview: an empty room, furniture arriving piece by piece, a dot walking through. */
const ISO = (x: number, y: number, z = 0): [number, number] => [(x - y) * 17.3 + 120, (x + y) * 10 - z * 20 + 18];
const P = (pts: Array<[number, number, number?]>) => pts.map(([x, y, z], i) => `${i ? 'L' : 'M'}${ISO(x, y, z).map((n) => n.toFixed(1)).join(' ')}`).join(' ') + ' Z';
function box(x: number, y: number, w: number, d: number, h: number) {
  return {
    top: P([[x, y, h], [x + w, y, h], [x + w, y + d, h], [x, y + d, h]]),
    front: P([[x + w, y, 0], [x + w, y + d, 0], [x + w, y + d, h], [x + w, y, h]]),
    side: P([[x, y + d, 0], [x + w, y + d, 0], [x + w, y + d, h], [x, y + d, h]]),
  };
}
const PIECES = [box(0.4, 0.4, 1.8, 0.8, 0.5), box(3.4, 0.4, 1.4, 0.7, 0.9), box(0.5, 3.4, 1, 1, 0.5), box(3.6, 3.2, 1.1, 1.1, 0.45)];
const WALK = `M${ISO(2.6, 5.2).join(' ')} L${ISO(2.6, 2.4).join(' ')} L${ISO(5, 2.4).join(' ')}`;

function Hero() {
  return (
    <svg className="hero-svg" viewBox="0 0 240 150" role="img" aria-label="An empty room filling with furniture while a person walks through it">
      <path className="hr-wall" d={P([[0, 0, 0], [0, 0, 2.4], [6, 0, 2.4], [6, 0, 0]])} />
      <path className="hr-wall" d={P([[0, 0, 0], [0, 0, 2.4], [0, 6, 2.4], [0, 6, 0]])} />
      <path className="hr-floor" d={P([[0, 0], [6, 0], [6, 6], [0, 6]])} />
      {PIECES.map((f, i) => (
        <g key={i} className="hr-furn" style={{ animationDelay: `${0.9 + i * 0.7}s` }}>
          <path className="hf-side" d={f.side} /><path className="hf-front" d={f.front} /><path className="hf-top" d={f.top} />
        </g>
      ))}
      <path className="hr-trail" d={WALK} />
      <circle className="hr-walker" r="3.4" style={{ offsetPath: `path('${WALK}')` }} />
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
  const openSection = useUi((s) => s.openSection);
  const [text, setText] = useState('');
  const [ex, setEx] = useState(0);
  const [listening, setListening] = useState(false);
  const recRef = useRef<any>(null);
  const canListen = useMemo(() => !!SpeechCtor(), []);
  useEffect(() => {
    if (text || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const t = setInterval(() => setEx((i) => (i + 1) % EXAMPLES.length), 3000);
    return () => clearInterval(t);
  }, [text]);
  useEffect(() => () => recRef.current?.abort?.(), []);
  /** Opens Describe with the words as the brief; the panel runs it as soon as it is open. */
  const submit = (raw: string) => {
    const brief = raw.trim();
    if (!brief) return;
    const st = useStore.getState();
    if (!st.model.spaces.length) dispatch({ type: 'REPLACE_MODEL', model: sampleRoom() });
    setMode('design');
    st.setView('split');
    openSection('describe');
    setTimeout(() => window.dispatchEvent(new CustomEvent('spacelens:request', { detail: brief })), 400);
  };
  const listen = () => {
    const C = SpeechCtor();
    if (!C) return;
    if (listening) { recRef.current?.stop?.(); return; }
    const r = new C();
    r.lang = navigator.language || 'en-US'; r.interimResults = false; r.continuous = false;
    r.onresult = (e: any) => { const t = String(e.results?.[0]?.[0]?.transcript ?? '').trim(); if (t) { setText(t); submit(t); } };
    r.onend = () => setListening(false);
    r.onerror = () => setListening(false);
    recRef.current = r; setListening(true);
    try { r.start(); } catch { setListening(false); }
  };
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
          <form className="home-ask" onSubmit={(e) => { e.preventDefault(); submit(text); }}>
            <input
              className="home-ask-input" value={text} onChange={(e) => setText(e.target.value)}
              placeholder={EXAMPLES[ex]} aria-label="Describe the space you want" enterKeyHint="go" autoComplete="off"
            />
            {canListen && <button type="button" className={`home-ask-btn${listening ? ' on' : ''}`} onClick={listen} aria-label="Speak" aria-pressed={listening} title="Speak"><Icon name="mic" size={18} /></button>}
            <button type="button" className="home-ask-btn" onClick={() => openSection('capture')} aria-label="Room from a photo" title="Room from a photo"><Icon name="camera" size={18} /></button>
          </form>
          <div className="home-quick" role="group" aria-label="Try it in one click">
            {STARTS.map((s) => (
              <button key={s.kind} className="home-quick-card" onClick={() => { void runStart(s.kind); }}>
                <span className="home-quick-icon"><Icon name={s.icon} size={18} /></span>
                <span className="home-quick-text"><strong>{s.title}</strong></span>
              </button>
            ))}
          </div>
          <details className="home-start">
            <summary>Your own space</summary>
            {recent && <button className="home-row" onClick={() => setMode('design')}><Icon name="home" size={16} /><span>Continue {recent}</span><Icon name="chevronRight" size={14} className="home-row-go" /></button>}
            {OPTIONS.map((o) => (
              <button key={o.kind} className="home-row" onClick={() => openCapture(o.kind)}>
                <Icon name={o.icon} size={16} /><span>{o.title}</span><Icon name="chevronRight" size={14} className="home-row-go" />
              </button>
            ))}
            <button className="home-row" onClick={openSample}><Icon name="sofa" size={16} /><span>Sample room</span><Icon name="chevronRight" size={14} className="home-row-go" /></button>
          </details>
        </div>
        <div className="home-art"><Hero /></div>
      </main>
      <Settings />
    </div>
  );
}
