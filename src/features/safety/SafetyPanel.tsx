import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../core/store';
import { centroid } from '../../core/geometry';
import type { RouteResult } from '../../core/types';
import { Icon } from '../../ui/icons';
import { assessSafety, SAFETY_DEFAULT_INFO, SAFETY_DEFAULTS, type SafetyConfig, type SafetyFinding, type SafetyKey, type SafetyReport } from './assess';
import { evacHeat } from './evac';
import { evacuationPlanSvg } from './plan';
import './safety.css';

const LS = 'spacelens.safety.v1';
interface Saved { config: Partial<SafetyConfig>; exits: Record<string, Record<string, boolean>> }
function loadSaved(): Saved {
  try { const s = localStorage.getItem(LS); if (s) { const v = JSON.parse(s) as Saved; return { config: v.config ?? {}, exits: v.exits ?? {} }; } } catch { /* storage blocked */ }
  return { config: {}, exits: {} };
}
function save(v: Saved) { try { localStorage.setItem(LS, JSON.stringify(v)); } catch { /* storage blocked */ } }

const SEV_LABEL = { critical: 'Critical', important: 'Important', advice: 'Advice' } as const;
const SEV_COLOR = { critical: '#f2555a', important: '#e5a83b', advice: '#6e8bff' } as const;
const GROUPS: Array<['fire' | 'access' | 'sim', string]> = [['fire', 'Fire'], ['access', 'Accessibility'], ['sim', 'Evacuation']];

function routeOf(f: SafetyFinding): RouteResult {
  const pts = f.route && f.route.length > 1 ? f.route : [f.at, { x: f.at.x + 0.01, y: f.at.y }];
  return { id: `safety:${f.id}`, profile: 'adult', points: pts, ok: f.severity === 'advice', lengthM: null, narrowestM: f.measureM ?? null, narrowestAt: f.at, label: f.title };
}

export function SafetyPanel() {
  const model = useStore((s) => s.model);
  const dispatch = useStore((s) => s.dispatch);
  const setAnalysis = useStore((s) => s.setAnalysis);
  const toggleLayer = useStore((s) => s.toggleLayer);
  const toast = useStore((s) => s.toast);

  const [saved, setSaved] = useState<Saved>(loadSaved);
  const [tab, setTab] = useState<'fire' | 'access'>('fire');
  const [occ, setOcc] = useState('');
  const [report, setReport] = useState<SafetyReport | null>(null);
  const [slow, setSlow] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  const [here, setHere] = useState('');
  const [play, setPlay] = useState<{ t: number; on: boolean } | null>(null);
  const timer = useRef<number | null>(null);

  const exitOverrides = useMemo(() => saved.exits[model.id] ?? {}, [saved, model.id]);
  const occupancy = occ.trim() === '' ? undefined : Math.max(0, Math.round(Number(occ)));

  useEffect(() => {
    const spin = setTimeout(() => setSlow(true), 300);
    const t = setTimeout(() => {
      setReport(assessSafety(model, model.furniture, { config: saved.config, exitOverrides, occupancy: Number.isFinite(occupancy) ? occupancy : undefined }));
      setSlow(false); clearTimeout(spin);
    }, 40);
    return () => { clearTimeout(t); clearTimeout(spin); };
  }, [model, saved.config, exitOverrides, occupancy]);

  const stopPlay = () => { if (timer.current) clearInterval(timer.current); timer.current = null; };
  useEffect(() => () => stopPlay(), []);

  const update = (v: Saved) => { setSaved(v); save(v); };
  const setExit = (id: string, on: boolean) => update({ ...saved, exits: { ...saved.exits, [model.id]: { ...exitOverrides, [id]: on } } });
  const setCfg = (k: SafetyKey, raw: string) => {
    const n = Number(raw);
    const next = { ...saved.config };
    if (raw.trim() === '' || !Number.isFinite(n) || n === SAFETY_DEFAULTS[k]) delete next[k]; else next[k] = n;
    update({ ...saved, config: next });
  };

  const show = (f: SafetyFinding) => {
    if (shown === f.id) { setShown(null); setAnalysis({ routes: [], highlights: [] }); return; }
    setShown(f.id);
    setAnalysis({ routes: [routeOf(f)], highlights: f.itemIds.length ? [{ ids: f.itemIds, color: SEV_COLOR[f.severity], label: f.title }] : [] });
    toggleLayer('routes', true);
  };
  const fix = (f: SafetyFinding) => {
    if (!f.fix) return;
    for (const op of f.fix.ops) dispatch(op);
    setShown(null); setAnalysis({ routes: [], highlights: [] });
    toast(`${f.fix.label}. Undo puts it back.`, 'ok');
  };

  const evacuate = () => {
    const ev = report?.evacuation; if (!ev) return;
    stopPlay();
    if (play?.on) { setPlay((p) => (p ? { ...p, on: false } : p)); setAnalysis({ heat: null }); return; }
    setShown(null);
    setAnalysis({ highlights: [], routes: report!.egress.filter((e) => e.pathPoints.length > 1).map((e) => ({ id: `evac:${e.spaceId}`, profile: 'adult', points: e.pathPoints, ok: true, lengthM: e.lengthM, narrowestM: null, label: e.name })) });
    toggleLayer('heat', true); toggleLayer('routes', true);
    let t = 0;
    setPlay({ t, on: true });
    timer.current = window.setInterval(() => {
      t += 0.5;
      if (t > ev.timeToClearS + 0.5) { stopPlay(); setAnalysis({ heat: null }); setPlay({ t: ev.timeToClearS, on: false }); return; }
      setAnalysis({ heat: evacHeat(ev, t) });
      setPlay({ t, on: true });
    }, 100);
  };

  const download = () => {
    if (!report) return;
    const sp = model.spaces.find((s) => s.id === here);
    const svg = evacuationPlanSvg(model, model.furniture, report, { youAreHere: sp ? centroid(sp.polygon) : undefined, exitOverrides });
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    const a = document.createElement('a');
    a.href = url; a.download = `${(model.name || 'space').replace(/[^\w-]+/g, '-').toLowerCase()}-evacuation-plan.svg`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  if (!report) return <div className="safety"><p className="muted"><span className="safety-spin" aria-hidden="true" /> Checking escape routes</p></div>;

  const list = report.findings.filter((f) => f.area === tab);
  const count = (a: 'fire' | 'access') => report.findings.filter((f) => f.area === a && f.severity !== 'advice').length;
  const blocking = report.findings.some((f) => f.severity !== 'advice');
  const ev = report.evacuation;
  const left = play?.on && ev ? ev.agents.filter((a) => a.clearS > play.t).length : 0;

  return (
    <div className="safety">
      <div className="safety-head" aria-live="polite">
        <span className={`safety-dot ${blocking ? 'bad' : 'ok'}`} aria-hidden="true" />
        <span className="safety-headline">{report.headline}</span>
        {slow && <span className="safety-spin" aria-label="Checking" />}
      </div>
      <p className="safety-sub muted">
        {report.exits.length} {report.exits.length === 1 ? 'exit' : 'exits'}
      </p>

      <div className="seg safety-tabs" role="tablist" aria-label="Checks">
        {(['fire', 'access'] as const).map((a) => (
          <button key={a} role="tab" aria-selected={tab === a} className={tab === a ? 'on' : ''} onClick={() => setTab(a)}>
            {a === 'fire' ? 'Fire' : 'Accessibility'}{count(a) ? ` (${count(a)})` : ''}
          </button>
        ))}
      </div>

      {list.length ? (
        <ul className="safety-list">
          {list.map((f) => (
            <li key={f.id} className={`safety-item sev-${f.severity}`}>
              <div className="safety-item-head">
                <span className="safety-sev">{SEV_LABEL[f.severity]}</span>
                <span className="safety-title">{f.title}</span>
              </div>
              <p className="safety-msg">{f.message}</p>
              <div className="safety-actions">
                <button className="btn btn-sm btn-ghost" aria-pressed={shown === f.id} onClick={() => show(f)}><Icon name="eye" size={14} /> Show</button>
                {f.fix && <button className="btn btn-sm" onClick={() => fix(f)} title="Re-checked against these rules"><Icon name="check" size={14} /> {f.fix.label}</button>}
              </div>
            </li>
          ))}
        </ul>
      ) : <p className="muted safety-empty">Nothing found.</p>}

      <section className="safety-block">
        <label className="safety-row">
          <span>People</span>
          <input type="number" min={0} inputMode="numeric" value={occ} placeholder={String(report.occupancy.total)} onChange={(e) => setOcc(e.target.value)} aria-describedby="safety-occ-basis" />
        </label>
        <p id="safety-occ-basis" className="muted safety-note">
          {report.occupancy.overridden ? 'Split by room size.' : report.occupancy.rooms.map((r) => `${r.name}: ${r.people} (${r.basis})`).join('; ')}
        </p>
        <button className="btn btn-primary safety-wide" disabled={!ev || !ev.agents.length} onClick={evacuate}>
          <Icon name={play?.on ? 'pause' : 'play'} size={14} /> {play?.on ? 'Stop' : 'Evacuate'}
        </button>
        {ev && (play?.on
          ? <p className="safety-note" aria-live="polite">{Math.round(play.t)} s · {left} still inside</p>
          : <p className="safety-note">
            Everyone out in about <strong>{Math.round(ev.timeToClearS)} s</strong>{report.evacuationSlowS != null && <> ({Math.round(report.evacuationSlowS)} s at slower pace)</>}.
            {ev.bottleneck && <> Bottleneck: {ev.bottleneck.label}, {ev.bottleneck.people} people{ev.bottleneck.maxWaitS >= 1 ? `, up to ${Math.round(ev.bottleneck.maxWaitS)} s queue` : ''}.</>}
            {ev.unreachable > 0 && <> {ev.unreachable} cannot get out.</>}
          </p>)}
      </section>

      <details className="safety-block">
        <summary>Exits</summary>
        {report.doors.length ? report.doors.map((d) => (
          <label key={d.id} className="safety-check">
            <input type="checkbox" checked={d.exit} onChange={(e) => setExit(d.id, e.target.checked)} />
            <span>{d.label}</span>
          </label>
        )) : <p className="muted safety-note">Add a door to the plan first.</p>}
      </details>

      <section className="safety-block">
        <label className="safety-row">
          <span>You are here</span>
          <select value={here} onChange={(e) => setHere(e.target.value)}>
            <option value="">Not marked</option>
            {model.spaces.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <button className="btn safety-wide" onClick={download}><Icon name="download" size={14} /> Download evacuation plan</button>
      </section>

      <details className="safety-block">
        <summary>What we assumed</summary>
        <p className="muted safety-note">Rules of thumb for planning, not a compliance check.</p>
        {GROUPS.map(([g, name]) => (
          <fieldset key={g} className="safety-defaults">
            <legend>{name}</legend>
            {(Object.keys(SAFETY_DEFAULT_INFO) as SafetyKey[]).filter((k) => SAFETY_DEFAULT_INFO[k].group === g).map((k) => (
              <label key={k} className="safety-def">
                <span className="safety-def-name">{SAFETY_DEFAULT_INFO[k].label}</span>
                <input type="number" step="any" min={0} value={saved.config[k] ?? ''} placeholder={String(SAFETY_DEFAULTS[k])} onChange={(e) => setCfg(k, e.target.value)} />
                <span className="muted safety-unit">{SAFETY_DEFAULT_INFO[k].unit}</span>
                <span className="muted safety-why">{SAFETY_DEFAULT_INFO[k].why}</span>
              </label>
            ))}
          </fieldset>
        ))}
        {Object.keys(saved.config).length > 0 && <button className="btn btn-sm btn-ghost" onClick={() => update({ ...saved, config: {} })}>Reset to defaults</button>}
        <p className="safety-note"><strong>Not assessed</strong></p>
        <ul className="safety-na">{report.notAssessed.map((t) => <li key={t}>{t}</li>)}</ul>
      </details>
    </div>
  );
}
