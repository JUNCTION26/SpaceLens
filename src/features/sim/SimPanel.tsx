import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, useShownFurniture } from '../../core/store';
import type { BodyProfileId, Layers, PassagePose } from '../../core/types';
import { CATALOG } from '../furniture/catalog';
import { PROFILES, profileOf, runRoutes } from './routes';
import type { TurnCheck } from './routes';
import { PASSAGE_ASSUMPTIONS, testPassage } from './passage';
import type { PassageItem } from './passage';
import { castSightlines, EYE_M } from './sightlines';
import { CROWD_ASSUMPTIONS, runCrowd } from './crowd';
import type { CrowdStats } from './crowd';
import { roomCentroid } from './grid';
import { Icon } from '../../ui/icons';
import './sim.css';

const EXTRA: PassageItem[] = [
  { id: 'cat:sofa', name: 'Sofa 2.2 x 0.95', w: 2.2, d: 0.95, h: 0.85 },
  { id: 'cat:shelf', name: 'Bookshelf 1.8 x 0.6', w: 1.8, d: 0.6, h: 2.0 },
  { id: 'cat:bed', name: 'Bed 1.6 x 2.0', w: 1.6, d: 2.0, h: 0.5 },
  { id: 'cat:wardrobe', name: 'Wardrobe 1.0 x 0.6', w: 1.0, d: 0.6, h: 2.0 },
];
const LAYERS: Array<[keyof Layers, string]> = [['routes', 'Routes'], ['heat', 'Heat'], ['sightlines', 'Sightlines']];

export function SimPanel() {
  const model = useStore((s) => s.model);
  const layers = useStore((s) => s.layers);
  const analysis = useStore((s) => s.analysis);
  const selection = useStore((s) => s.selection);
  const setAnalysis = useStore((s) => s.setAnalysis);
  const toggleLayer = useStore((s) => s.toggleLayer);
  const [fitOpen, setFitOpen] = useState(false);
  const furniture = useShownFurniture();

  const [profile, setProfile] = useState<BodyProfileId>('adult');
  const [turn, setTurn] = useState<TurnCheck | null>(null);
  const doors = model.openings.filter((o) => o.kind === 'door' || o.kind === 'opening');
  const items: PassageItem[] = useMemo(() => [
    ...furniture.map((f) => ({ id: f.id, name: f.name, w: f.w, d: f.d, h: f.h })),
    ...CATALOG.map((c) => ({ id: `cat:${c.id}`, name: c.name, w: c.w, d: c.d, h: c.h })),
    ...EXTRA,
  ], [furniture]);
  const [itemId, setItemId] = useState('cat:sofa');
  const [doorId, setDoorId] = useState('');
  const [busy, setBusy] = useState(false);
  const [agents, setAgents] = useState(20);
  const [seed, setSeed] = useState(1);
  const [crowd, setCrowd] = useState<{ cur: CrowdStats | null; prev: CrowdStats | null }>({ cur: null, prev: null });

  useEffect(() => { if (selection?.kind === 'furniture' && items.some((i) => i.id === selection.id)) setItemId(selection.id); }, [selection, items]);
  const door = doorId || doors[0]?.id || '';

  const [routesBusy, setRoutesBusy] = useState(false);
  const [showSpin, setShowSpin] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const checkRoutes = () => {
    const r = runRoutes(model, furniture, profile);
    setTurn(r.turn);
    setAnalysis({ routes: r.routes });
  };
  // run automatically; spinner only if the check takes longer than 300 ms
  useEffect(() => {
    setRoutesBusy(true);
    const spin = setTimeout(() => setShowSpin(true), 300);
    const t = setTimeout(() => { checkRoutes(); setRoutesBusy(false); setShowSpin(false); clearTimeout(spin); }, 30);
    return () => { clearTimeout(t); clearTimeout(spin); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model.version, furniture, profile]);
  const showSpot = (id: string) => { setFocusId(id); toggleLayer('routes', true); };

  const runPassage = () => {
    const it = items.find((i) => i.id === itemId); if (!it || !door) return;
    setBusy(true);
    setTimeout(() => { setAnalysis({ passage: testPassage(model, furniture, it, door) }); setBusy(false); setTimeout(play, 50); }, 10);
  };

  // Play: step the shared passage result through its poses so plan/3D views animate it
  const playRef = useRef<number | null>(null);
  function play() {
    const p = useStore.getState().analysis.passage; if (!p?.ok || !p.poses.length) return;
    const all: PassagePose[] = p.poses; let i = 1;
    if (playRef.current) clearInterval(playRef.current);
    playRef.current = window.setInterval(() => {
      setAnalysis({ passage: { ...p, poses: all.slice(0, i) } });
      if (++i > all.length) { clearInterval(playRef.current!); playRef.current = null; }
    }, 60);
  }
  useEffect(() => () => { if (playRef.current) clearInterval(playRef.current); }, []);

  const sel = selection?.kind === 'furniture' ? furniture.find((f) => f.id === selection.id) : undefined;
  const sight = () => {
    const from = sel ? { x: sel.x, y: sel.y } : roomCentroid(model);
    setAnalysis({ sightlines: castSightlines(model, furniture, from, sel?.id) });
    toggleLayer('sightlines', true);
  };

  const runCrowdSim = () => {
    const r = runCrowd(model, furniture, agents, seed); if (!r) return;
    setAnalysis({ heat: r.heat });
    toggleLayer('heat', true);
    setCrowd((c) => ({ prev: c.cur && c.cur.seed === seed && c.cur.agents === agents ? c.cur : c.prev, cur: r.stats }));
  };

  const p = profileOf(profile);
  const passage = analysis.passage;
  const openings = model.openings.filter((o) => o.kind === 'door' || o.kind === 'opening' || o.kind === 'window');
  const seen = analysis.sightlines.slice(0, openings.length);

  const rs = analysis.routes.filter((r) => r.profile === profile);
  const bad = rs.filter((r) => !r.ok);
  const worst = [...(bad.length ? bad : rs)].filter((r) => r.narrowestM != null).sort((x, y) => x.narrowestM! - y.narrowestM!)[0];

  return (
    <div className="sim">
      <button className="btn btn-primary sim-walk" onClick={() => window.dispatchEvent(new Event('spacelens:walk'))}>
        <Icon name="walk" size={14} /> Walk through
      </button>

      <div className="sim-seg" role="group" aria-label="Who is moving">{PROFILES.map((pr) => (
        <button key={pr.id} className={pr.id === profile ? 'on' : ''} aria-pressed={pr.id === profile} title={pr.note} onClick={() => setProfile(pr.id)}>{pr.label}</button>
      ))}</div>

      <div className="sim-line" aria-live="polite">
        {showSpin && routesBusy ? <span className="muted"><span className="sim-spin" aria-hidden="true" /> Checking</span>
          : !rs.length ? <span className="muted">No doors yet</span>
          : <>
            <span className={`sim-dot ${bad.length ? 'bad' : 'ok'}`} aria-hidden="true" />
            <span>{bad.length ? `${bad.length} of ${rs.length} spots blocked` : 'Every spot reachable'}
              {worst && <span className="muted"> · narrowest {worst.narrowestM!.toFixed(2)} m{worst.narrowestM! < p.widthM ? ` (needs ${p.widthM.toFixed(2)})` : ''}</span>}
              {turn && !turn.ok && <span className="muted"> · no 1.5 m turn</span>}
            </span>
            {worst?.narrowestAt && <button className="icon-btn" title="Show narrowest spot" aria-label="Show narrowest spot" aria-pressed={focusId === worst.id && layers.routes} onClick={() => showSpot(worst.id)}><Icon name="eye" size={14} /></button>}
          </>}
      </div>

      <div className="sim-row">
        <button className="sim-row-head" aria-expanded={fitOpen} onClick={() => setFitOpen((v) => !v)} title={`Assumes: ${PASSAGE_ASSUMPTIONS.join('. ')}.`}>
          <Icon name={fitOpen ? 'chevronDown' : 'chevronRight'} size={14} />
          <span>Fit through the door</span>
          {passage && <span className={`sim-tag ${passage.ok ? 'ok' : 'bad'}`}>{passage.ok ? 'Fits' : 'Stuck'}</span>}
        </button>
        {fitOpen && (
          <div className="sim-body">
            <label className="field">Item
              <select value={itemId} onChange={(e) => setItemId(e.target.value)}>
                {items.map((i) => <option key={i.id} value={i.id}>{i.name} ({i.w.toFixed(2)} x {i.d.toFixed(2)})</option>)}
              </select>
            </label>
            <label className="field">Door
              <select value={door} onChange={(e) => setDoorId(e.target.value)}>
                {doors.map((d, i) => <option key={d.id} value={d.id}>Door {i + 1} ({d.widthM.toFixed(2)} m)</option>)}
              </select>
            </label>
            <div className="row">
              <button className="btn btn-sm" disabled={busy || !door} onClick={runPassage}>{busy ? 'Testing' : 'Test'}</button>
              {passage?.ok && <button className="icon-btn" title="Replay" aria-label="Replay" onClick={play}><Icon name="play" size={14} /></button>}
            </div>
            {passage && <p className="sim-note">{passage.details}</p>}
          </div>
        )}
      </div>

      <details className="sim-more">
        <summary>More</summary>
        <div className="sim-body">
          <div className="sim-layers">{LAYERS.map(([k, l]) => (
            <label key={k} className="sim-toggle"><input type="checkbox" checked={layers[k]} onChange={() => toggleLayer(k)} /> {l}</label>
          ))}</div>
          <details>
            <summary className="muted">Each route</summary>
            <ul className="list sim-list">
              {rs.map((r) => (
                <li key={r.id}>
                  <span className={`sim-dot ${r.ok ? 'ok' : 'bad'}`} role="img" aria-label={r.ok ? 'Clear' : 'Blocked'} />
                  <span>{r.label}</span>
                  <span className="muted">{r.lengthM != null ? `${r.lengthM.toFixed(1)} m` : ''}{r.narrowestM != null ? ` · ${r.narrowestM.toFixed(2)} m` : ''}</span>
                </li>
              ))}
            </ul>
            <button className="btn btn-ghost btn-sm" onClick={checkRoutes}>Check again</button>
          </details>
          <div className="sim-sub">
            <div className="row sim-sub-head"><span>Sightlines</span><button className="btn btn-sm" onClick={sight}>Cast</button></div>
            <p className="muted sim-note">From {sel ? sel.name : 'room centre'}, eye at {EYE_M} m.{seen.length > 0 && ` ${seen.filter((s) => s.visible).length} of ${seen.length} openings visible.`}</p>
          </div>
          <div className="sim-sub">
            <div className="row sim-sub-head"><span title={`Assumes: ${CROWD_ASSUMPTIONS}.`}>Crowd</span><button className="btn btn-sm" onClick={runCrowdSim}>Run</button></div>
            <label className="field">Agents: {agents}
              <input type="range" min={5} max={60} value={agents} onChange={(e) => setAgents(Number(e.target.value))} />
            </label>
            <label className="field">Seed
              <input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value) || 0)} />
            </label>
            {crowd.cur && (
              <p className="muted sim-note">Mean path {crowd.cur.meanPathM.toFixed(1)} m{crowd.prev && ` (was ${crowd.prev.meanPathM.toFixed(1)})`} · {crowd.cur.tightPct.toFixed(0)}% through gaps under 0.45 m{crowd.prev && ` (was ${crowd.prev.tightPct.toFixed(0)}%)`}</p>
            )}
          </div>
          <p className="muted sim-note">Rugs ignored, 5 cm grid.</p>
        </div>
      </details>
    </div>
  );
}
