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

  const checkRoutes = () => {
    const r = runRoutes(model, furniture, profile);
    setTurn(r.turn);
    setAnalysis({ routes: r.routes });
  };
  // auto re-run when the model or shown furniture change
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (!layers.routes) return;
    const t = setTimeout(checkRoutes, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model.version, furniture, profile, layers.routes]);

  const runPassage = () => {
    const it = items.find((i) => i.id === itemId); if (!it || !door) return;
    setBusy(true);
    setTimeout(() => { setAnalysis({ passage: testPassage(model, furniture, it, door) }); setBusy(false); }, 10);
  };

  // Play: step the shared passage result through its poses so plan/3D views animate it
  const playRef = useRef<number | null>(null);
  const play = () => {
    const p = useStore.getState().analysis.passage; if (!p?.ok || !p.poses.length) return;
    const all: PassagePose[] = p.poses; let i = 1;
    if (playRef.current) clearInterval(playRef.current);
    playRef.current = window.setInterval(() => {
      setAnalysis({ passage: { ...p, poses: all.slice(0, i) } });
      if (++i > all.length) { clearInterval(playRef.current!); playRef.current = null; }
    }, 60);
  };
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
        <div className="row sim-head"><strong>Routes</strong>
          <div className="sim-layers">{LAYERS.map(([k, l]) => (
            <label key={k} className="sim-toggle"><input type="checkbox" checked={layers[k]} onChange={() => toggleLayer(k)} /> {l}</label>
          ))}</div>
        </div>
        <div className="sim-chips">{PROFILES.map((pr) => (
          <button key={pr.id} className={`chip${pr.id === profile ? ' chip-ok' : ''}`} aria-pressed={pr.id === profile} onClick={() => setProfile(pr.id)}>{pr.label}</button>
        ))}</div>
        <p className="muted sim-note">Assumes: {p.note}. Rugs ignored, 5 cm grid.</p>
        <button className="btn btn-primary btn-sm" onClick={checkRoutes}>Check routes</button>
        <ul className="list sim-list">
          {analysis.routes.map((r) => (
            <li key={r.id}>
              <span className={`chip ${r.ok ? 'chip-ok' : 'chip-bad'}`}>{r.ok ? 'Clear' : 'Blocked'}</span>
              <span>{r.label}</span>
              <span className="muted">{r.lengthM != null ? `${r.lengthM.toFixed(1)} m` : ''}{r.narrowestM != null ? ` · narrowest ${r.narrowestM.toFixed(2)} m` : ''}</span>
            </li>
          ))}
          {!analysis.routes.length && <li className="muted">No routes yet.</li>}
        </ul>
        {turn && <p className={turn.ok ? 'sim-ok' : 'sim-bad'}>{turn.ok ? `1.5 m turning circle fits at ${turn.at!.x.toFixed(1)}, ${turn.at!.y.toFixed(1)}` : 'No reachable spot for a 1.5 m turning circle'}</p>}
      </section>

      <section className="card">
        <strong>Will it get through the door?</strong>
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
          <button className="btn btn-primary btn-sm" disabled={busy || !door} onClick={runPassage}>{busy ? 'Testing...' : 'Test'}</button>
          <button className="btn btn-ghost btn-sm" disabled={!passage?.ok} onClick={play}>Play</button>
        </div>
        {passage && <p><span className={`chip ${passage.ok ? 'chip-ok' : 'chip-bad'}`}>{passage.ok ? 'Fits' : 'Stuck'}</span> {passage.details}</p>}
        <p className="muted sim-note">Assumes: {PASSAGE_ASSUMPTIONS.join('. ')}.</p>
      </section>

      <section className="card">
        <strong>Sightlines</strong>
        <p className="muted sim-note">From {sel ? sel.name : 'room centre'}. Items over {EYE_M} m block a seated eye at {EYE_M} m.</p>
        <button className="btn btn-sm" onClick={sight}>Cast sightlines</button>
        {seen.length > 0 && <p className="muted">{seen.filter((s) => s.visible).length} of {seen.length} openings visible</p>}
      </section>

      <section className="card">
        <strong>Crowd</strong>
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
        <p className="muted sim-note">Assumes: {CROWD_ASSUMPTIONS}.</p>
      </section>
    </div>
  );
}
