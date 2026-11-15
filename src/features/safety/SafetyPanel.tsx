import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../core/store';
import { centroid } from '../../core/geometry';
import { applyOp } from '../../core/ops';
import type { RouteResult } from '../../core/types';
import { Icon } from '../../ui/icons';
import { RuleSelector } from '../jurisdiction/RuleSelector';
import { applyPack, packFor, type PackId } from '../jurisdiction/rulepacks';
import { assessSafety, SAFETY_DEFAULT_INFO, SAFETY_DEFAULTS, type SafetyConfig, type SafetyFinding, type SafetyKey, type SafetyReport } from './assess';
import { ReportButton } from './ReportButton';
import { assessAccess, type AccessReport } from './access';
import { planPlacement, type PlacementResult } from './placement';
import { DrillButton, useDrill } from './DrillButton';
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

/** Findings are long sentences; the row shows the first four words, the full text is the tooltip. */
const clip = (t: string, n = 4) => { const w = t.replace(/\([^)]*\)/g, '').split(/\s+/).filter(Boolean); return w.length > n ? `${w.slice(0, n).join(' ')}\u2026` : w.join(' '); };
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

  const [saved, setSaved] = useState<Saved>(loadSaved);
  const [country, setCountry] = useState<PackId>('generic');
  const [tab, setTab] = useState<'fire' | 'access'>('fire');
  const people = useDrill((d) => d.people);
  const [report, setReport] = useState<SafetyReport | null>(null);
  const [slow, setSlow] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  const [here, setHere] = useState('');
  const [play, setPlay] = useState<{ t: number; on: boolean } | null>(null);
  const timer = useRef<number | null>(null);
  const [acc, setAcc] = useState<AccessReport | null>(null);
  const [plc, setPlc] = useState<PlacementResult | null>(null);
  const [showRoutes, setShowRoutes] = useState(false);
  const [showEquip, setShowEquip] = useState(false);

  const exitOverrides = useMemo(() => saved.exits[model.id] ?? {}, [saved, model.id]);
  const occupancy = people ?? undefined;

  useEffect(() => {
    const spin = setTimeout(() => setSlow(true), 300);
    const t = setTimeout(() => {
      setReport(assessSafety(model, model.furniture, { config: saved.config, exitOverrides, occupancy: Number.isFinite(occupancy) ? occupancy : undefined }));
      setSlow(false); clearTimeout(spin);
    }, 40);
    return () => { clearTimeout(t); clearTimeout(spin); };
  }, [model, saved.config, exitOverrides, occupancy]);

  useEffect(() => {
    const t = setTimeout(() => {
      const opts = { pack: packFor(country), config: saved.config, exitOverrides };
      try { setAcc(assessAccess(model, model.furniture, opts)); } catch { setAcc(null); }
      try { setPlc(planPlacement(model, model.furniture, opts)); } catch { setPlc(null); }
    }, 400);
    return () => clearTimeout(t);
  }, [model, country, saved.config, exitOverrides]);

  useEffect(() => {
    if (showRoutes && acc) { setAnalysis({ highlights: acc.highlights, routes: acc.routes.map((r) => ({ id: `access:${r.id}`, profile: 'wheelchair', points: r.points, ok: r.ok, lengthM: null, narrowestM: null, label: r.label })) }); toggleLayer('routes', true); }
    else if (showEquip && plc) setAnalysis({ highlights: plc.highlights });
  }, [showRoutes, showEquip, acc, plc, setAnalysis, toggleLayer]);
  useEffect(() => () => { if (useStore.getState().analysis) setAnalysis({ highlights: [], routes: [] }); }, [setAnalysis]);

  const toggleRoutes = () => { const on = !showRoutes; setShowRoutes(on); if (on) setShowEquip(false); else setAnalysis({ highlights: [], routes: [] }); };
  const toggleEquip = () => { const on = !showEquip; setShowEquip(on); if (on) setShowRoutes(false); setAnalysis(on ? { highlights: plc?.highlights ?? [], routes: [] } : { highlights: [], routes: [] }); };
  const fixAccess = (ops: import('../../core/types').Op[]) => {
    try { let m = model; for (const op of ops) m = applyOp(m, op); dispatch({ type: 'REPLACE_MODEL', model: m }); } catch { /* keep model */ }
  };

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

  const onCountry = (id: PackId, pack: Parameters<typeof applyPack>[0]) => { setCountry(id); update({ ...saved, config: { ...applyPack(pack) } }); };

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

  if (!report) return <div className="safety"><span className="safety-spin" role="status" aria-label="Checking" /></div>;

  const list = report.findings.filter((f) => f.area === tab);
  const ev = report.evacuation;
  const left = play?.on && ev ? ev.agents.filter((a) => a.clearS > play.t).length : 0;
  const unreachable = acc ? acc.destinations.filter((d) => !d.reachable).slice(0, 6) : [];

  const row = (f: SafetyFinding) => (
    <li key={f.id} className={`safety-item sev-${f.severity}`}>
      <span className="safety-sevdot" aria-hidden="true" />
      <span className="safety-title" title={`${f.title}. ${f.message}`}>{clip(f.title)}</span>
      <button className="icon-btn" aria-pressed={shown === f.id} aria-label="Show" title="Show" onClick={() => show(f)}><Icon name="eye" size={14} /></button>
      {f.fix && <button className="btn btn-sm" onClick={() => fix(f)} title={f.fix.label}><Icon name="check" size={14} /> Fix</button>}
    </li>
  );

  return (
    <div className="safety">
      <div className="safety-country">
        <RuleSelector mode="select" country={country} onChange={onCountry} />
        <ReportButton model={model} assessment={report} pack={packFor(country)} />
        {slow && <span className="safety-spin" role="status" aria-label="Checking" />}
      </div>

      <div className="seg safety-tabs" role="tablist" aria-label="Checks">
        {(['fire', 'access'] as const).map((a) => (
          <button key={a} role="tab" aria-selected={tab === a} className={tab === a ? 'on' : ''} onClick={() => setTab(a)}>
            {a === 'fire' ? 'Fire' : 'Access'}
          </button>
        ))}
      </div>

      {tab === 'fire' && (
        <>
          <DrillButton onStart={evacuate} extra={<>
            {play?.on && <span className="safety-chip" title="Inside">{Math.round(play.t)} s · {left}</span>}
            {!play?.on && ev && ev.unreachable > 0 && <span className="safety-chip bad" title="Trapped">{ev.unreachable} trapped</span>}
            {!play?.on && ev?.bottleneck && <span className="safety-chip" title={`Bottleneck: ${ev.bottleneck.label}, ${ev.bottleneck.people} people`}>{clip(ev.bottleneck.label)}</span>}
          </>} />

          {list.length > 0 && <ul className="safety-list">{list.map(row)}</ul>}

          {plc && plc.suggestions.length > 0 && (
            <div className="safety-adv" role="group" aria-label="Equipment">
              <button className="btn btn-sm btn-ghost" aria-pressed={showEquip} onClick={toggleEquip}><Icon name="eye" size={14} /> Equipment</button>
              <div className="safety-chips">
                {([['smoke-alarm', 'Alarms'], ['extinguisher', 'Extinguishers'], ['exit-sign', 'Signs'], ['fire-blanket', 'Blankets']] as const).map(([k, n]) => {
                  const c = plc.suggestions.filter((x) => x.kind === k).length;
                  return c ? <span key={k} className="safety-chip">{n} {c}</span> : null;
                })}
              </div>
            </div>
          )}

          <details className="safety-block safety-more">
            <summary>More</summary>
            <div className="safety-fold">
              <div className="safety-sub">Exits</div>
              {report.doors.map((d) => (
                <label key={d.id} className="safety-check">
                  <input type="checkbox" checked={d.exit} onChange={(e) => setExit(d.id, e.target.checked)} />
                  <span>{d.label}</span>
                </label>
              ))}
              <label className="safety-row">
                <span>You are here</span>
                <select value={here} onChange={(e) => setHere(e.target.value)}>
                  <option value="">-</option>
                  {model.spaces.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
              <button className="btn safety-wide" onClick={download}><Icon name="download" size={14} /> Exit plan</button>
              <details className="safety-sub-fold">
                <summary>Assumptions</summary>
                <RuleSelector mode="list" country={country} onChange={onCountry} />
                {GROUPS.map(([g, name]) => (
                  <fieldset key={g} className="safety-defaults">
                    <legend>{name}</legend>
                    {(Object.keys(SAFETY_DEFAULT_INFO) as SafetyKey[]).filter((k) => SAFETY_DEFAULT_INFO[k].group === g).map((k) => (
                      <label key={k} className="safety-def" title={SAFETY_DEFAULT_INFO[k].why}>
                        <span className="safety-def-name">{SAFETY_DEFAULT_INFO[k].label}</span>
                        <input type="number" step="any" min={0} value={saved.config[k] ?? ''} placeholder={String(SAFETY_DEFAULTS[k])} onChange={(e) => setCfg(k, e.target.value)} />
                        <span className="muted safety-unit">{SAFETY_DEFAULT_INFO[k].unit}</span>
                      </label>
                    ))}
                  </fieldset>
                ))}
                {Object.keys(saved.config).length > 0 && <button className="btn btn-sm btn-ghost" onClick={() => update({ ...saved, config: {} })}>Reset</button>}
                <div className="safety-sub">Not checked</div>
                <ul className="safety-na">{report.notAssessed.map((t) => <li key={t}>{t}</li>)}</ul>
              </details>
            </div>
          </details>
        </>
      )}

      {tab === 'access' && (
        <>
          {acc && acc.total > 0 && (
            <div className="safety-adv-head">
              <span className={`safety-chip ${acc.reachableCount === acc.total ? 'ok' : 'bad'}`} title="Reachable">{acc.reachableCount}/{acc.total}</span>
              <button className="btn btn-sm btn-ghost" aria-pressed={showRoutes} onClick={toggleRoutes}><Icon name="eye" size={14} /> Routes</button>
            </div>
          )}
          <ul className="safety-list">
            {unreachable.map((d) => (
              <li key={d.id} className="safety-item sev-important">
                <span className="safety-sevdot" aria-hidden="true" />
                <span className="safety-title" title={d.label}>{clip(d.label)}</span>
                {d.fix && <button className="btn btn-sm" onClick={() => fixAccess(d.fix!.ops)} title={d.fix.label}><Icon name="check" size={14} /> Fix</button>}
              </li>
            ))}
            {list.map(row)}
          </ul>
        </>
      )}
    </div>
  );
}
