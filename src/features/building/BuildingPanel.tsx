import { useMemo, useState } from 'react';
import { useStore } from '../../core/store';
import type { Vec2 } from '../../core/types';
import { Icon } from '../../ui/icons';
import { toSpaceModel } from './assemble';
import { fmtSek, signedArea } from '../../core/geometry';
import type { SpaceModel } from '../../core/types';
import { wallEdges } from '../sim/walls';
import { buildingBill, furnishBuilding, type RoomProgress } from './furnish';
import { lShell, rectShell, type BuildingPlan, type ShellEntrance, type ShellWindow } from './partition';
import { planBuildingAsync } from './planAsync';
import { FloorChips } from './FloorChips';
import { programmeFromSentence, shellForArea } from './sentence';
import { programmeArea, programmeFromBrief, TEMPLATES, type Privacy, type ProgrammeRoom, type RoomProgramme } from './programme';
import { planSvg } from './render';
import './building.css';

type ShellKind = 'rect' | 'L' | 'current';

const num = (s: string, lo: number, hi: number, d: number) => { const v = Number(s.replace(',', '.')); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
const shellArea = (p: Vec2[]) => { let s = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a.x * b.y - b.x * a.y; } return Math.abs(s / 2); };

/** Compass name of a wall from its outward side (clockwise polygon, y down). */
function wallLabel(p: Vec2[], i: number) {
  const a = p[i], b = p[(i + 1) % p.length];
  const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy);
  const ox = dy, oy = -dx; // outward normal for a clockwise-on-screen polygon
  const side = Math.abs(ox) > Math.abs(oy) ? (ox > 0 ? 'East' : 'West') : (oy > 0 ? 'South' : 'North');
  return `${side} ${i + 1} · ${L.toFixed(1)} m`;
}
const wallLen = (p: Vec2[], i: number) => Math.hypot(p[(i + 1) % p.length].x - p[i].x, p[(i + 1) % p.length].y - p[i].y);

interface WallRow { kind: 'Outer' | 'Inner'; thicknessCm: number; lengthM: number; doors: number; windows: number; count: number }

/** Builder's wall schedule: outer and inner walls by thickness, with lengths and openings. */
export function wallSchedule(model: SpaceModel): WallRow[] {
  const rows = new Map<string, WallRow>();
  for (const e of wallEdges(model)) {
    if (!e.owner) continue;
    const kind = e.neighbour ? 'Inner' : 'Outer';
    const thicknessCm = Math.round((e.neighbour ? e.thicknessM + e.neighbourThicknessM : e.thicknessM) * 100);
    const key = `${kind}${thicknessCm}`;
    const r = rows.get(key) ?? { kind, thicknessCm, lengthM: 0, doors: 0, windows: 0, count: 0 };
    r.lengthM += e.length; r.count++;
    r.doors += e.gaps.filter((g) => g.kind !== 'window').length;
    r.windows += e.gaps.filter((g) => g.kind === 'window').length;
    rows.set(key, r);
  }
  return [...rows.values()].sort((a, b) => (a.kind === b.kind ? b.thicknessCm - a.thicknessCm : a.kind === 'Outer' ? -1 : 1));
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

function Bar({ value }: { value: number }) {
  const v = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return <span className="bld-bar" role="img" aria-label={`${v} of 100`}><span style={{ width: `${v}%`, background: v >= 85 ? 'var(--ok)' : v >= 60 ? 'var(--warn)' : 'var(--bad)' }} /></span>;
}

export function PlanCard({ plan, onUse }: { plan: BuildingPlan; onUse: () => void }) {
  const svg = useMemo(() => planSvg(plan, { px: 18, labels: true, pad: 0.7 }), [plan]);
  return (
    <div className="card bld-card">
      <div className="bld-card-head">
        <b>{plan.name}</b>
      </div>
      <div className="bld-thumb" dangerouslySetInnerHTML={{ __html: svg }} />
      <div className="bld-stats">
        <span><b>{plan.internalWallM.toFixed(1)} m</b> internal walls</span>
        <span><b>{(plan.circulationShare * 100).toFixed(0)}%</b> circulation</span>
      </div>
      <ul className="bld-criteria">
        {plan.criteria.map((c) => (
          <li key={c.id} title={c.detail}><span>{c.name}</span><Bar value={c.score} /></li>
        ))}
      </ul>
      {plan.issues.length > 0 && (
        <ul className="bld-issues">{plan.issues.slice(0, 4).map((t) => <li key={t}><Icon name="alert" size={13} /> {t}</li>)}</ul>
      )}
      <button className="btn btn-primary btn-sm" onClick={onUse}><Icon name="check" /> Use this plan</button>
    </div>
  );
}

function PlanThumb({ plan, onUse }: { plan: BuildingPlan; onUse: () => void }) {
  const svg = useMemo(() => planSvg(plan, { px: 10, labels: false, pad: 0.4 }), [plan]);
  return <button className="bld-opt" onClick={onUse} aria-label={`Use ${plan.name}`} title={plan.name} dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function BuildingPanel() {
  const model = useStore((s) => s.model);
  const dispatch = useStore((s) => s.dispatch);
  const toast = useStore((s) => s.toast);

  // 1. shell
  const [kind, setKind] = useState<ShellKind>('rect');
  const [w, setW] = useState('10'), [d, setD] = useState('12');
  const [legW, setLegW] = useState('6'), [armD, setArmD] = useState('6');
  const current = model.spaces.length === 1 ? model.spaces[0] : null;
  const shell: Vec2[] = useMemo(() => {
    const W = num(w, 4, 80, 10), D = num(d, 4, 80, 12);
    if (kind === 'L') return lShell(W, D, Math.min(num(legW, 2.5, 60, 6), W - 2.5), Math.min(num(armD, 2.5, 60, 6), D - 2.5));
    if (kind === 'current' && current) return current.polygon;
    return rectShell(W, D);
  }, [kind, w, d, legW, armD, current]);
  const [entWall, setEntWall] = useState(2);
  const [entPos, setEntPos] = useState(0.5);
  const [noWindows, setNoWindows] = useState<number[]>([]);
  const wallCount = shell.length;
  const ew = Math.min(entWall, wallCount - 1);

  // 2. programme
  const [tpl, setTpl] = useState<string>('villa');
  const [prog, setProg] = useState<RoomProgramme>(() => TEMPLATES[0].make());
  const [brief, setBrief] = useState('');
  const [reading, setReading] = useState(false);
  const setRoom = (i: number, patch: Partial<ProgrammeRoom>) => setProg({ ...prog, rooms: prog.rooms.map((r, k) => (k === i ? { ...r, ...patch } : r)) });

  // 3. options
  const [plans, setPlans] = useState<BuildingPlan[]>([]);
  const [planning, setPlanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usedPlan, setUsedPlan] = useState<BuildingPlan | null>(null);

  // 4. furnish
  const [progress, setProgress] = useState<RoomProgress[]>([]);
  const [furnishing, setFurnishing] = useState(false);

  const shellNow = shell;
  const shellM2 = shellArea(shell);
  const progM2 = programmeArea(prog);

  const inputs = (shell: Vec2[] = shellNow): { entrances: ShellEntrance[]; windows: ShellWindow[] } => {
    if (kind === 'current' && current) {
      const doors = model.openings.filter((o) => o.spaceId === current.id && o.kind === 'door');
      const wins = model.openings.filter((o) => o.spaceId === current.id && o.kind === 'window');
      const entrances = doors.length ? doors.map((o) => ({ wallIndex: o.wallIndex, offsetM: o.offsetM, widthM: o.widthM })) : [{ wallIndex: ew, offsetM: wallLen(shell, ew) * entPos }];
      return { entrances, windows: wins.map((o) => ({ wallIndex: o.wallIndex, offsetM: o.offsetM, widthM: o.widthM })) };
    }
    const all = shell.map((_, i) => i);
    const windows = noWindows.length ? all.filter((i) => !noWindows.includes(i)).map((i) => ({ wallIndex: i })) : [];
    return { entrances: [{ wallIndex: ew, offsetM: Math.round(wallLen(shell, ew) * entPos * 100) / 100 }], windows };
  };

  const readBrief = async () => {
    if (!brief.trim()) return;
    setReading(true);
    try {
      const s = programmeFromSentence(brief);
      if (s.recognised) {
        // a sentence sizes the shell itself, unless a drawn room is the shell
        let sh = shell;
        if (kind !== 'current') { const { w: sw, d: sd } = shellForArea(s.areaM2); setKind('rect'); setW(String(sw)); setD(String(sd)); sh = rectShell(sw, sd); }
        setProg(s.programme); setTpl(''); setPlans([]);
        await propose(s.programme, sh);
      } else { const p = await programmeFromBrief(brief, { shellAreaM2: shellM2 }); setProg(p); setTpl(''); setPlans([]); }
    } finally { setReading(false); }
  };

  const propose = async (p: RoomProgramme = prog, sh: Vec2[] = shell) => {
    setPlanning(true); setError(null);
    try {
      const sideIdx = Math.min(entWall, sh.length - 1);
      const { entrances, windows } = kind === 'current' ? inputs(sh) : { entrances: [{ wallIndex: sideIdx, offsetM: Math.round(wallLen(sh, sideIdx) * entPos * 100) / 100 }], windows: noWindows.length ? sh.map((_, i) => i).filter((i) => !noWindows.includes(i)).map((i) => ({ wallIndex: i })) : [] };
      // searched in a worker, so the panel and the 3D view keep responding
      const res = await planBuildingAsync(sh, entrances, windows, p, { count: 3, seed: 1 });
      setPlans(res);
      if (!res.length) setError('No plan fits');
    } catch (e) { setError((e as Error).message); }
    finally { setPlanning(false); }
  };

  /** Generated plans stay consistent as a whole: to resize a room, plan again with it larger. */
  const enlarge = (programmeId: string, name: string) => {
    const next = { ...prog, rooms: prog.rooms.map((r) => r.id === programmeId ? { ...r, preferredAreaM2: Math.round(r.preferredAreaM2 * 1.25 * 2) / 2, minAreaM2: Math.round(Math.max(r.minAreaM2, r.preferredAreaM2) * 2) / 2 } : r) };
    setProg(next); setTpl('');
    toast(`Planning again with a larger ${name}`, 'info');
    void propose(next);
  };

  const walkThrough = () => {
    const st = useStore.getState();
    if (st.view === '2d') st.setView('split');
    setTimeout(() => window.dispatchEvent(new Event('spacelens:walk')), 300);
  };

  const schedule = useMemo(() => (usedPlan ? wallSchedule(model) : []), [usedPlan, model]);
  const bill = useMemo(() => (usedPlan && model.furniture.length ? buildingBill(model) : null), [usedPlan, model]);

  const use = (p: BuildingPlan) => {
    dispatch({ type: 'REPLACE_MODEL', model: toSpaceModel(p, model) });
    setUsedPlan(p); setProgress([]);
    toast(`Plan applied: ${p.rooms.length} rooms`, 'ok');
  };

  const furnish = async () => {
    setFurnishing(true);
    const m = useStore.getState().model;
    const briefs: Record<string, string> = {};
    for (const r of prog.rooms) if (r.brief) briefs[`room-${r.id}`] = r.brief;
    try {
      const res = await furnishBuilding(m, briefs, { onRoom: (p) => setProgress((cur) => { const next = cur.length ? [...cur] : m.spaces.map((s) => ({ spaceId: s.id, name: s.name, status: 'waiting' as const })); const i = next.findIndex((x) => x.spaceId === p.spaceId); if (i >= 0) next[i] = p; return next; }) });
      const n = res.rooms.filter((r) => r.status === 'done').length;
      dispatch({ type: 'SET_FURNITURE', items: res.furniture, label: `Furnished ${n} rooms` });
      toast(`Furnished ${n} room${n === 1 ? '' : 's'}`, n ? 'ok' : 'warn');
    } catch (e) { toast(`Furnishing failed: ${(e as Error).message}`, 'error'); }
    finally { setFurnishing(false); }
  };

  const setup = (<>
      <section className="panel">
        <details className="bld-sub"><summary>Shell · {shellM2.toFixed(0)} m²</summary>
        <div className="seg" role="group" aria-label="Shell shape">
          <button className={kind === 'rect' ? 'on' : ''} onClick={() => setKind('rect')}>Rectangle</button>
          <button className={kind === 'L' ? 'on' : ''} onClick={() => setKind('L')}>L-shape</button>
          <button className={kind === 'current' ? 'on' : ''} onClick={() => setKind('current')} disabled={!current}>Current room</button>
        </div>
        {kind !== 'current' && (
          <div className="grid2">
            <label className="field"><span>Width (m)</span><input inputMode="decimal" value={w} onChange={(e) => setW(e.target.value)} /></label>
            <label className="field"><span>Depth (m)</span><input inputMode="decimal" value={d} onChange={(e) => setD(e.target.value)} /></label>
            {kind === 'L' && <label className="field"><span>Leg width (m)</span><input inputMode="decimal" value={legW} onChange={(e) => setLegW(e.target.value)} /></label>}
            {kind === 'L' && <label className="field"><span>Arm depth (m)</span><input inputMode="decimal" value={armD} onChange={(e) => setArmD(e.target.value)} /></label>}
          </div>
        )}
        {(kind !== 'current' || !model.openings.some((o) => o.spaceId === current?.id && o.kind === 'door')) && (
          <div className="grid2">
            <label className="field"><span>Entrance wall</span>
              <select value={ew} onChange={(e) => setEntWall(Number(e.target.value))}>
                {shell.map((_, i) => <option key={i} value={i}>{wallLabel(shell, i)}</option>)}
              </select>
            </label>
            <label className="field"><span>Entrance position</span><input type="range" min={0.1} max={0.9} step={0.05} value={entPos} onChange={(e) => setEntPos(Number(e.target.value))} /></label>
          </div>
        )}
        {kind !== 'current' && (
          <fieldset className="bld-walls">
            <legend className="section-label">Windows</legend>
            {shell.map((_, i) => (
              <label key={i} className="row bld-small">
                <input type="checkbox" checked={!noWindows.includes(i)} onChange={(e) => setNoWindows(e.target.checked ? noWindows.filter((x) => x !== i) : [...noWindows, i])} />
                {wallLabel(shell, i)}
              </label>
            ))}
          </fieldset>
        )}
        </details>
      </section>

      <section className="panel">
        <h3>Rooms</h3>
        <div className="row">
          <select value={tpl} onChange={(e) => { const t = TEMPLATES.find((x) => x.id === e.target.value); setTpl(e.target.value); if (t) { setProg(t.make()); setPlans([]); } }} aria-label="Template">
            {!tpl && <option value="">Custom</option>}
            {TEMPLATES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </div>
        <div className="row bld-brief">
          <input value={brief} onChange={(e) => setBrief(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') readBrief(); }} placeholder="Describe it" aria-label="Describe the building" />
          <button className="btn btn-sm" onClick={readBrief} disabled={reading || !brief.trim()}>Read</button>
        </div>
        <details className="bld-sub">
        <summary>{prog.rooms.length} rooms · {progM2.toFixed(0)} m²</summary>
        <table className="bld-table">
          <thead><tr><th>Room</th><th>m²</th><th>Min width</th><th title="Needs a window">Window</th><th>Zone</th><th><span className="sr-only">Remove</span></th></tr></thead>
          <tbody>
            {prog.rooms.map((r, i) => (
              <tr key={r.id}>
                <td><input value={r.name} onChange={(e) => setRoom(i, { name: e.target.value })} aria-label="Room name" /></td>
                <td><input inputMode="decimal" value={r.preferredAreaM2} onChange={(e) => { const v = num(e.target.value, 1, 400, r.preferredAreaM2); setRoom(i, { preferredAreaM2: v, minAreaM2: Math.min(r.minAreaM2, v) }); }} aria-label={`${r.name} area`} /></td>
                <td><input inputMode="decimal" value={r.minWidthM} onChange={(e) => setRoom(i, { minWidthM: num(e.target.value, 0.8, 10, r.minWidthM) })} aria-label={`${r.name} minimum width`} /></td>
                <td><input type="checkbox" checked={r.needsWindow} onChange={(e) => setRoom(i, { needsWindow: e.target.checked })} aria-label={`${r.name} needs a window`} /></td>
                <td>
                  <select value={r.privacy} onChange={(e) => setRoom(i, { privacy: e.target.value as Privacy })} aria-label={`${r.name} zone`}>
                    <option value="public">Public</option><option value="private">Private</option><option value="service">Service</option>
                  </select>
                </td>
                <td><button className="btn btn-ghost btn-sm" onClick={() => setProg({ ...prog, rooms: prog.rooms.filter((_, k) => k !== i) })} aria-label={`Remove ${r.name}`}><Icon name="x" /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="row">
          <button className="btn btn-sm" onClick={() => setProg({ ...prog, rooms: [...prog.rooms, { id: `room-${Date.now().toString(36)}`, name: 'New room', purpose: 'room', minAreaM2: 7, preferredAreaM2: 9, minWidthM: 2.4, needsWindow: true, adjacentTo: [], privacy: 'private' }] })}><Icon name="plus" /> Add room</button>
          <span className={`muted bld-small${progM2 > shellM2 * 0.9 ? ' bld-warn' : ''}`}>{progM2.toFixed(0)} / {shellM2.toFixed(0)} m²</span>
        </div>
        </details>
      </section>

      <section className="panel">
        <h3>Plans</h3>
        <button className="btn btn-primary" onClick={() => propose()} disabled={planning || !prog.rooms.length}>{planning ? <span className="intent-spin" aria-label="Working" /> : <Icon name="layout" />} {plans.length ? 'Plan again' : 'Propose plans'}</button>
        {error && <p className="bld-error" role="alert">{error}</p>}
        {plans.length > 0 && (
          <div className="bld-opts" role="group" aria-label="Plan options">
            {plans.map((p) => <PlanThumb key={p.id} plan={p} onUse={() => use(p)} />)}
          </div>
        )}
        {plans.length > 0 && (
          <details className="bld-sub"><summary>Details</summary>
            <div className="bld-cards">
              {plans.map((p) => <PlanCard key={p.id} plan={p} onUse={() => use(p)} />)}
            </div>
          </details>
        )}
      </section>

  </>);

  const roomBriefs = useMemo(() => { const b: Record<string, string> = {}; for (const r of prog.rooms) if (r.brief) b[`room-${r.id}`] = r.brief; return b; }, [prog]);

  return (
    <div className="bld">
      <FloorChips briefs={roomBriefs} />
      {usedPlan && (
        <section className="panel">
          <h3>Your plan</h3>
          <div className="row bld-actions">
            <button className="btn btn-primary" onClick={furnish} disabled={furnishing}>{furnishing ? <span className="intent-spin" aria-label="Working" /> : <Icon name="sofa" />} Furnish</button>
            <button className="btn" onClick={walkThrough}><Icon name="walk" /> Walk</button>
          </div>
          {!furnishing && progress.some((p) => p.status === 'failed') && (
            <span className="chip chip-warn" title={progress.filter((p) => p.status === 'failed').map((p) => p.name).join(', ')}>
              {progress.filter((p) => p.status === 'failed').length} no fit
            </span>
          )}
          {bill && (
            <details className="bld-sub">
              <summary><b>{plural(bill.items, 'item')}</b> · {fmtSek(bill.totalSek)}</summary>
              <table className="bld-table bld-bill">
                <thead><tr><th>Item</th><th>Qty</th><th>Total</th></tr></thead>
                <tbody>{bill.lines.map((l) => (
                  <tr key={`${l.catalogId}|${l.name}`}><td>{l.name}</td><td>{l.qty}</td><td>{fmtSek(l.totalSek)}</td></tr>
                ))}</tbody>
              </table>
            </details>
          )}

          <details className="bld-sub">
          <summary>Details</summary>
          <h4 className="section-label">Walls</h4>
          <table className="bld-table bld-schedule">
            <thead><tr><th>Wall</th><th>Thickness</th><th>Length</th><th>Openings</th></tr></thead>
            <tbody>{schedule.map((r) => (
              <tr key={`${r.kind}:${r.thicknessCm}`}>
                <td>{r.kind}</td><td>{r.thicknessCm} cm</td><td>{r.lengthM.toFixed(1)} m</td>
                <td className="muted">{[r.doors ? plural(r.doors, 'door') : '', r.windows ? plural(r.windows, 'window') : ''].filter(Boolean).join(', ')}</td>
              </tr>
            ))}</tbody>
          </table>

          <h4 className="section-label">Room sizes</h4>
          <ul className="list bld-rooms">
            {usedPlan.rooms.map((r) => (
              <li key={r.id}>
                <span className="bld-grow">{r.name}</span>
                <span className="muted">{r.areaM2.toFixed(0)} m²</span>
                {r.programmeId && prog.rooms.some((x) => x.id === r.programmeId) && (
                  <button className="btn btn-ghost btn-sm" disabled={planning} onClick={() => enlarge(r.programmeId!, r.name)} aria-label={`Plan again with a larger ${r.name}`} title="Plan again with this room larger"><Icon name="maximize" /></button>
                )}
              </li>
            ))}
          </ul>
          </details>
        </section>
      )}
      {!usedPlan && model.spaces.length > 1 && (
        <section className="panel">
          <h3>Your plan</h3>
          <div className="muted bld-small">{model.spaces.length} rooms · {model.spaces.reduce((t, sp) => t + Math.abs(signedArea(sp.polygon)), 0).toFixed(0)} m²</div>
          <div className="row bld-actions">
            <button className="btn btn-primary" onClick={walkThrough}><Icon name="walk" /> Walk</button>
          </div>
        </section>
      )}
      {usedPlan || model.spaces.length > 1 ? (
        <details className="bld-sub bld-edit">
          <summary>{usedPlan ? 'Edit plan' : 'New plan'}</summary>
          {setup}
        </details>
      ) : setup}
    </div>
  );
}
