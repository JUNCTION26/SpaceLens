import { useEffect, useMemo, useRef, useState } from 'react';
import { area as polyArea, fmtSek } from '../../core/geometry';
import { useStore } from '../../core/store';
import type { Space, SpaceModel } from '../../core/types';
import { Icon } from '../../ui/icons';
import { assessSafety, SAFETY_DEFAULTS } from '../safety/assess';
import { buildingBill, furnishBuilding, roomPurpose } from './furnish';
import { editRoom, refurnishRoom, ROOM_USES } from './refurnish';
import './building.css';

const focusRoom = (id: string) => {
  useStore.getState().select({ kind: 'space', id });
  window.dispatchEvent(new CustomEvent('spacelens:camera', { detail: { shot: 'top-down', seconds: 1 } }));
};

/** The model with every room except `spaceId` marked as skipped, so one room can be furnished in place. */
function onlyRoom(model: SpaceModel, spaceId: string): SpaceModel {
  return { ...model, furniture: [], spaces: model.spaces.map((s) => (s.id === spaceId ? s : { ...s, purpose: 'stair' })) };
}

type Status = 'running' | 'done' | 'skipped' | 'failed';

function Ring({ done, total }: { done: number; total: number }) {
  const r = 9, c = 2 * Math.PI * r, f = total ? Math.min(1, done / total) : 0;
  return (
    <svg className="fl-ring" width="26" height="26" viewBox="0 0 24 24" role="img" aria-label={`${done} of ${total} rooms`}>
      <circle cx="12" cy="12" r={r} fill="none" stroke="var(--line)" strokeWidth="3" />
      <circle cx="12" cy="12" r={r} fill="none" stroke="var(--accent, currentColor)" strokeWidth="3" strokeDasharray={`${c * f} ${c}`} strokeLinecap="round" transform="rotate(-90 12 12)" />
    </svg>
  );
}

export function FloorChips({ briefs = {} }: { briefs?: Record<string, string> }) {
  const model = useStore((s) => s.model);
  const selection = useStore((s) => s.selection);
  const dispatch = useStore((s) => s.dispatch);
  const [status, setStatus] = useState<Record<string, Status>>({});
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [finished, setFinished] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const seeds = useRef<Record<string, number>>({});
  const changed = useRef<Set<string>>(new Set());

  const running = progress !== null && !finished;

  /** Furnish one room against the latest model and put the result in place at once. */
  const furnishRoom = async (spaceId: string, signal?: AbortSignal): Promise<Status> => {
    const seed = (seeds.current[spaceId] = (seeds.current[spaceId] ?? 0) + 1);
    setStatus((s) => ({ ...s, [spaceId]: 'running' }));
    let st: Status = 'failed';
    try {
      const m = useStore.getState().model;
      const brief = changed.current.has(spaceId) ? undefined : briefs[spaceId];
      const res = await furnishBuilding(onlyRoom(m, spaceId), brief ? { [spaceId]: brief } : {}, { parallel: 1, seed, signal, timeBudgetMs: 900 });
      const r = res.rooms.find((x) => x.spaceId === spaceId);
      st = (r?.status === 'done' || r?.status === 'skipped') ? r.status : 'failed';
      if (r?.status === 'done' && !signal?.aborted) {
        const cur = useStore.getState().model;
        const items = res.furniture;
        dispatch({ type: 'SET_FURNITURE', items: refurnishRoom(cur, spaceId, items).furniture, label: `Furnished ${cur.spaces.find((x) => x.id === spaceId)?.name ?? 'room'}` });
      }
    } catch { st = 'failed'; }
    setStatus((s) => ({ ...s, [spaceId]: st }));
    return st;
  };

  const furnishAll = async () => {
    const ctl = new AbortController();
    abort.current = ctl;
    const ids = useStore.getState().model.spaces.map((s) => s.id);
    setFinished(false); setStatus({}); setProgress({ done: 0, total: ids.length });
    let next = 0, done = 0;
    await Promise.all(Array.from({ length: Math.min(2, ids.length) }, async () => {
      while (next < ids.length && !ctl.signal.aborted) {
        await furnishRoom(ids[next++], ctl.signal);
        setProgress({ done: ++done, total: ids.length });
      }
    }));
    setFinished(true);
    abort.current = null;
  };

  const stop = () => abort.current?.abort();

  const reroll = async (id: string) => { if (!running) await furnishRoom(id); };

  const rename = (id: string, name: string) => {
    setEditing(null);
    const cur = useStore.getState().model;
    if (!name.trim() || name.trim() === cur.spaces.find((s) => s.id === id)?.name) return;
    dispatch({ type: 'REPLACE_MODEL', model: editRoom(cur, id, { name }) });
  };

  const changeUse = async (id: string, purpose: string) => {
    changed.current.add(id);
    dispatch({ type: 'REPLACE_MODEL', model: editRoom(useStore.getState().model, id, { purpose }) });
    await furnishRoom(id);
  };

  // building numbers, worked out after the model settles
  const [safety, setSafety] = useState<{ people: number; longest: number | null; blocked: boolean } | null>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        const r = assessSafety(model, model.furniture);
        const lens = r.egress.map((e) => e.lengthM).filter((x): x is number => x != null);
        setSafety({ people: r.occupancy.total, longest: lens.length ? Math.max(...lens) : null, blocked: r.egress.some((e) => e.exitsReachable === 0) });
      } catch { setSafety(null); }
    }, 500);
    return () => clearTimeout(t);
  }, [model]);

  const totalArea = useMemo(() => model.spaces.reduce((t, s) => t + polyArea(s.polygon), 0), [model.spaces]);
  const bill = useMemo(() => (finished ? buildingBill(model) : null), [finished, model]);
  const doneRooms = Object.values(status).filter((s) => s === 'done').length;

  if (!model.spaces.length) return null;
  const selId = selection?.kind === 'space' ? selection.id : null;
  const longWarn = safety ? safety.blocked || (safety.longest ?? 0) > SAFETY_DEFAULTS.maxTravelM : false;

  const chip = (s: Space) => {
    const st = status[s.id];
    const on = selId === s.id;
    return (
      <span key={s.id} className={`chip fl-chip${on ? ' on' : ''}${st === 'failed' ? ' chip-warn' : ''}`}>
        {editing === s.id ? (
          <input className="fl-rename" autoFocus defaultValue={s.name} aria-label="Room name" onBlur={(e) => rename(s.id, e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') rename(s.id, (e.target as HTMLInputElement).value); if (e.key === 'Escape') setEditing(null); }} />
        ) : (
          <button className="fl-name" onClick={() => focusRoom(s.id)} onDoubleClick={() => setEditing(s.id)} aria-pressed={on} title={s.name}>
            {st === 'running' && <span className="intent-spin" aria-label="Working" />}
            <span className="fl-label">{s.name}</span> <span className="muted">{polyArea(s.polygon).toFixed(0)} m²</span>
          </button>
        )}
        {on && (
          <select className="fl-use" value={roomPurpose(s)} onChange={(e) => changeUse(s.id, e.target.value)} disabled={running || st === 'running'} aria-label={`${s.name} use`}>
            {!ROOM_USES.some((u) => u.purpose === roomPurpose(s)) && <option value={roomPurpose(s)}>{roomPurpose(s) || 'Room'}</option>}
            {ROOM_USES.map((u) => <option key={u.purpose} value={u.purpose}>{u.label}</option>)}
          </select>
        )}
        <button className="fl-icon" onClick={() => reroll(s.id)} disabled={running || st === 'running'} aria-label={`Re-roll ${s.name}`} title="Re-roll"><Icon name="rotate" size={12} /></button>
      </span>
    );
  };

  return (
    <section className="fl">
      <div className="fl-chips" role="group" aria-label="Rooms">{model.spaces.map(chip)}</div>
      <div className="row bld-actions">
        <button className="btn" onClick={furnishAll} disabled={running}>
          {progress && !finished ? <Ring done={progress.done} total={progress.total} /> : <Icon name="sofa" />} Furnish all
        </button>
        {running && <button className="btn btn-ghost" onClick={stop} aria-label="Stop"><Icon name="x" /></button>}
      </div>
      <div className="fl-chips" role="group" aria-label="Building numbers" aria-live="polite">
        <span className="chip">{totalArea.toFixed(0)} m²</span>
        <span className="chip">{model.spaces.length} <span className="sr-only">rooms</span><Icon name="layout" size={12} /></span>
        <span className="chip" title="People">{safety ? safety.people : '–'} <span className="sr-only">people</span><Icon name="walk" size={12} /></span>
        <span className={`chip${longWarn ? ' chip-warn' : ''}`} title="Longest escape">{safety?.longest != null ? `${safety.longest.toFixed(0)} m` : '–'} <span className="sr-only">longest escape</span>{longWarn && <Icon name="alert" size={12} />}</span>
        {bill && !running && <>
          <span className="chip">{bill.items} <span className="sr-only">items</span><Icon name="sofa" size={12} /></span>
          <span className="chip">{fmtSek(bill.totalSek)}</span>
          <span className={`chip${doneRooms < model.spaces.length ? ' chip-warn' : ' chip-ok'}`}>{doneRooms}/{model.spaces.length} <span className="sr-only">rooms done</span><Icon name="check" size={12} /></span>
        </>}
      </div>
    </section>
  );
}
