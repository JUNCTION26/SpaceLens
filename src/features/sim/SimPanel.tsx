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
import './sim.css';

const EXTRA: PassageItem[] = [
  { id: 'cat:sofa', name: 'Sofa 2.2 x 0.95', w: 2.2, d: 0.95, h: 0.85 },
  { id: 'cat:shelf', name: 'Bookshelf 1.8 x 0.6', w: 1.8, d: 0.6, h: 2.0 },
  { id: 'cat:bed', name: 'Bed 1.6 x 2.0', w: 1.6, d: 2.0, h: 0.5 },
  { id: 'cat:wardrobe', name: 'Wardrobe 1.0 x 0.6', w: 1.0, d: 0.6, h: 2.0 },
];
const ICONS: Record<BodyProfileId, string> = { adult: '\u{1F9CD}', child: '\u{1F9D2}', wheelchair: '\u{1F9BD}', stroller: '\u{1F6BC}', cart: '\u{1F6D2}' };
const LAYERS: Array<[keyof Layers, string]> = [['routes', 'Routes'], ['heat', 'Heat'], ['sightlines', 'Sightlines']];

export function SimPanel() {
  const model = useStore((s) => s.model);
  const layers = useStore((s) => s.layers);
  const analysis = useStore((s) => s.analysis);
  const selection = useStore((s) => s.selection);
  const setAnalysis = useStore((s) => s.setAnalysis);
  const toggleLayer = useStore((s) => s.toggleLayer);
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

  return (
    <div className="sim">
      <section className="card">
        <div className="row sim-head"><strong>Can I get everywhere?</strong>
          <div className="sim-layers">{LAYERS.map(([k, l]) => (
            <label key={k} className="sim-toggle"><input type="checkbox" checked={layers[k]} onChange={() => toggleLayer(k)} /> {l}</label>
          ))}</div>
        </div>
        <div className="sim-profiles" role="group" aria-label="Who is moving">{PROFILES.map((pr) => (
          <button key={pr.id} className={`sim-profile${pr.id === profile ? ' on' : ''}`} aria-pressed={pr.id === profile} onClick={() => setProfile(pr.id)}>
            <span className="sim-icon" aria-hidden="true">{ICONS[pr.id]}</span>
            <span>{pr.label}</span>
            <span className="muted">{pr.widthM.toFixed(2)} m</span>
          </button>
        ))}</div>
        {(() => {
          const rs = analysis.routes.filter((r) => r.profile === profile);
          if (showSpin && routesBusy) return <p className="muted"><span className="sim-spin" aria-hidden="true" /> Checking...</p>;
          if (!rs.length) return <p className="muted">No doors to start from yet.</p>;
          const bad = rs.filter((r) => !r.ok);
          const worst = [...(bad.length ? bad : rs)].filter((r) => r.narrowestM != null).sort((x, y) => x.narrowestM! - y.narrowestM!)[0];
          return (
            <div className={`sim-verdict ${bad.length ? 'bad' : 'ok'}`}>
              <strong>{bad.length ? `No, ${bad.length} of ${rs.length} spots blocked` : 'Yes, every spot is reachable'}</strong>
              {worst && <span>Narrowest: {worst.narrowestM!.toFixed(2)} m{worst.narrowestM! < p.widthM ? `, needs ${p.widthM.toFixed(2)} m` : ''} ({worst.label})</span>}
              {worst?.narrowestAt && <button className="btn btn-sm" onClick={() => showSpot(worst.id)}>{focusId === worst.id && layers.routes ? 'Shown' : 'Show'}</button>}
            </div>
          );
        })()}
        {turn && <p className={turn.ok ? 'sim-ok' : 'sim-bad'}>{turn.ok ? '1.5 m turning circle fits' : 'No reachable spot for a 1.5 m turning circle'}</p>}
        <details>
          <summary className="muted">Each route</summary>
          <ul className="list sim-list">
            {analysis.routes.map((r) => (
              <li key={r.id}>
                <span className={`chip ${r.ok ? 'chip-ok' : 'chip-bad'}`}>{r.ok ? 'Clear' : 'Blocked'}</span>
                <span>{r.label}</span>
                <span className="muted">{r.lengthM != null ? `${r.lengthM.toFixed(1)} m` : ''}{r.narrowestM != null ? ` · narrowest ${r.narrowestM.toFixed(2)} m` : ''}</span>
              </li>
            ))}
          </ul>
          <button className="btn btn-ghost btn-sm" onClick={checkRoutes}>Check again</button>
        </details>
        <p className="muted sim-note">Rugs ignored, 5 cm grid.</p>
      </section>

      <section className="card">
        <strong title={`Assumes: ${PASSAGE_ASSUMPTIONS.join('. ')}.`}>Will it fit through the door?</strong>
        <div className="sim-items" role="listbox" aria-label="Item">
          {items.map((i) => {
            const k = 28 / Math.max(i.w, i.d, 0.1);
            return (
              <button key={i.id} role="option" aria-selected={i.id === itemId} className={`sim-item${i.id === itemId ? ' on' : ''}`} onClick={() => setItemId(i.id)}>
                <span className="sim-shape" style={{ width: Math.max(4, i.w * k), height: Math.max(4, i.d * k) }} aria-hidden="true" />
                <span className="sim-item-name">{i.name}</span>
                <span className="muted">{i.w.toFixed(2)} x {i.d.toFixed(2)}</span>
              </button>
            );
          })}
        </div>
        <label className="field">Door
          <select value={door} onChange={(e) => setDoorId(e.target.value)}>
            {doors.map((d, i) => <option key={d.id} value={d.id}>Door {i + 1} ({d.widthM.toFixed(2)} m)</option>)}
          </select>
        </label>
        <div className="row">
          <button className="btn btn-primary btn-sm" disabled={busy || !door} onClick={runPassage}>{busy ? <><span className="sim-spin" aria-hidden="true" /> Testing...</> : 'Test'}</button>
          <button className="btn btn-ghost btn-sm" disabled={!passage?.ok} onClick={play}>Replay</button>
        </div>
        {passage && (
          <div className={`sim-verdict ${passage.ok ? 'ok' : 'bad'}`}>
            <strong>{passage.ok ? 'Yes, it fits.' : 'No, it gets stuck.'}</strong>
            <span>{passage.details}</span>
          </div>
        )}
      </section>

      <details className="card sim-more">
        <summary><strong>More</strong></summary>
      <section className="card">
        <strong>Sightlines</strong>
        <p className="muted sim-note">From {sel ? sel.name : 'room centre'}. Items over {EYE_M} m block a seated eye at {EYE_M} m.</p>
        <button className="btn btn-sm" onClick={sight}>Cast sightlines</button>
        {seen.length > 0 && <p className="muted">{seen.filter((s) => s.visible).length} of {seen.length} openings visible</p>}
      </section>

      <section className="card">
        <strong title={`Assumes: ${CROWD_ASSUMPTIONS}.`}>Crowd</strong>
        <label className="field">Agents: {agents}
          <input type="range" min={5} max={60} value={agents} onChange={(e) => setAgents(Number(e.target.value))} />
        </label>
        <label className="field">Seed
          <input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value) || 0)} />
        </label>
        <button className="btn btn-sm" onClick={runCrowdSim}>Run</button>
        {crowd.cur && (
          <div className="sim-stats">
            <div className="stat"><span className="muted">Mean path</span> {crowd.cur.meanPathM.toFixed(1)} m{crowd.prev && <span className="muted"> (was {crowd.prev.meanPathM.toFixed(1)})</span>}</div>
            <div className="stat"><span className="muted">Through gaps under 0.45 m</span> {crowd.cur.tightPct.toFixed(0)}%{crowd.prev && <span className="muted"> (was {crowd.prev.tightPct.toFixed(0)}%)</span>}</div>
          </div>
        )}
      </section>
      </details>
    </div>
  );
}
