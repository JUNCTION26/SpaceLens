import { shortRelax } from '../layout/relax';
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../core/store';
import type { Requirements } from '../../core/types';
import { CATALOG } from '../furniture/catalog';
import { designRoom, type Stage } from '../design/pipeline';
import { useReports } from '../design/reportStore';
import { aiReady } from '../../core/ai';
import { applyRoomOps, wantsNewRoom } from '../agent/actions';
import { followUpRoom, isFollowUp, resetFollowMemory, compileWithMeta, type CompileMeta } from './refine';
import { Icon } from '../../ui/icons';
import { showLayouts, isFinalResult, pickAuto, failReason, wholeRoomAsk } from '../layout/progress';
import { takePendingBrief } from '../demo/starts';
import './intent.css';

const two = (t: string) => t.split(/\s+/).slice(0, 2).join(' ');
const EXAMPLES = ['Cat room for Gerard', 'Home office for two', 'Tiny studio'];

export function IntentPanel() {
  const model = useStore((s) => s.model);
  const stored = useStore((s) => s.requirements);
  const infeasibility = useStore((s) => s.infeasibility);
  const candidates = useStore((s) => s.candidates);
  const busy = useStore((s) => s.busy);
  const [text, setText] = useState('');
  const [req, setReq] = useState<Requirements | null>(stored);
  const [compiling, setCompiling] = useState(false);
  const [triedGen, setTriedGen] = useState(false);
  const [meta, setMeta] = useState<CompileMeta | null>(null);
  const [adjust, setAdjust] = useState(false);
  const [chip, setChip] = useState('');
  const [retry, setRetry] = useState<{ label: string; reason: string; run: () => void } | null>(null);
  const [cannot, setCannot] = useState<{ nearest: string; label: string } | null>(null);
  const compileRef = useRef<(t?: string, fresh?: boolean) => Promise<void>>(async () => {});
  const runRef = useRef<AbortController | null>(null);
  const briefRef = useRef('');
  const stages = useReports((s) => s.stages);
  const running = useReports((s) => s.running);
  useEffect(() => () => runRef.current?.abort(), []);

  useEffect(() => {
    const on = (e: Event) => {
      const t = String((e as CustomEvent).detail ?? '').trim();
      if (!t) return;
      setText(t);
      void compileRef.current(t);
    };
    // A one-click start may have left a brief to run as soon as this panel opens.
    const pending = takePendingBrief();
    if (pending) { setText(pending); void compileRef.current(pending); }
    window.addEventListener('spacelens:request', on);
    return () => window.removeEventListener('spacelens:request', on);
  }, []);

  const patch = (p: Partial<Requirements>) => setReq((r) => (r ? { ...r, ...p } : r));

  /** A follow-up on a room that has furniture: change it in place, one undo step. Returns true when handled. */
  async function followUp(q: string): Promise<boolean> {
    const st = useStore.getState();
    if (!isFollowUp(st.model, q) || wantsNewRoom(q)) return false;
    setCompiling(true);
    try {
      const r = await followUpRoom(st.model, q, st.past.at(-1)?.furniture);
      if (!r.ok) { setCannot({ nearest: r.nearest, label: r.reason }); setChip(''); return true; }
      setCannot(null);
      if (r.undo && !r.ops.length) useStore.getState().undo();
      else if (r.ops.length) applyRoomOps(r.ops, r.label);
      else return false;
      setChip(r.label); setText('');
      return true;
    } catch { return false; }
    finally { setCompiling(false); }
  }

  /** "start over" and "another layout" act on the whole design; each is one undoable step at most. */
  function wholeRoom(kind: 'again' | 'reset'): boolean {
    const st = useStore.getState();
    if (kind === 'reset') {
      runRef.current?.abort(); resetFollowMemory();
      if (st.model.furniture.length) st.dispatch({ type: 'SET_FURNITURE', items: [], label: 'Started over' });
      st.setCandidates([]); st.setRequirements(null);
      useReports.getState().setStages([], false);
      setReq(null); setTriedGen(false); setCannot(null); setRetry(null); setChip('Cleared'); setText('');
      return true;
    }
    const r = req ?? st.requirements;
    if (!r?.items.length) return false;
    setText(''); setChip(''); void generate(r, true);
    return true;
  }

  async function compile(input?: string, fresh = false) {
    const q = input ?? text;
    if (!q.trim()) return;
    setRetry(null);
    const whole = fresh ? null : wholeRoomAsk(q);
    if (whole && wholeRoom(whole)) return;
    if (!fresh && await followUp(q)) return;
    setCompiling(true);
    briefRef.current = q; resetFollowMemory();
    try {
      const { req: r, meta: m } = await compileWithMeta(q, useStore.getState().model);
      setReq(r); setMeta(m); setTriedGen(false);
      if (r.items.length) void generate(r);
    } catch (e) {
      console.error(e);
      setChip(''); setRetry({ label: 'Retry', reason: failReason({ offline: !aiReady(), error: e }), run: () => void compileRef.current(q, true) });
    }
    finally { setCompiling(false); }
  }
  compileRef.current = compile;

  async function generate(r: Requirements, another = false) {
    runRef.current?.abort();
    const ctrl = new AbortController();
    runRef.current = ctrl;
    const st = useStore.getState();
    const rs = useReports.getState();
    const wasOffline = !aiReady();
    setRetry(null); setChip('');
    st.setBusy('Designing');
    rs.setStages([], true);
    try {
      const res = await designRoom(st.model, r, {
        variants: 3, signal: ctrl.signal, brief: briefRef.current,
        onStage: (s) => { if (runRef.current === ctrl) useReports.getState().setStages(s); },
        // The room fills in as pieces arrive: whatever exists is previewed, never applied, until the run is final.
        onProgress: (p) => { if (runRef.current === ctrl && p.candidates.length) showLayouts(p); },
      });
      if (runRef.current !== ctrl) return;
      showLayouts(res);
      st.setRequirements(r);
      setTriedGen(true);
      const now = useStore.getState();
      // One sentence furnishes the room: the best final layout is applied as one undo step; the others wait on Layouts.
      const best = isFinalResult(res) ? pickAuto(res.candidates, res.reports, another ? now.model.furniture : undefined) : null;
      if (best) { now.applyCandidate(best.id); }
      else {
        const pending = res.candidates.length > 0;
        setRetry({ label: 'Retry', reason: failReason({ offline: wasOffline, infeasible: !pending && !!res.infeasibility }), run: () => void generate(r) });
        if (!pending) useStore.getState().previewCandidate(null);
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        console.error(e);
        useStore.getState().previewCandidate(null);
        setRetry({ label: 'Retry', reason: failReason({ offline: wasOffline, error: e }), run: () => void generate(r) });
      }
    } finally {
      if (runRef.current === ctrl) {
        runRef.current = null;
        useStore.getState().setBusy(null);
        useReports.getState().setStages(useReports.getState().stages, false);
      }
    }
  }

  const relax = (p: Partial<Requirements>) => { if (!req) return; const next = { ...req, ...p }; setReq(next); void generate(next); };
  const toggleTarget = (kind: 'window' | 'door') => req && patch({
    routeTargets: req.routeTargets.some((t) => t.kind === kind) ? req.routeTargets.filter((t) => t.kind !== kind) : [...req.routeTargets, { kind }],
  });
  const toggleLock = (id: string, catalogId: string) => {
    if (!req) return;
    const on = req.lockedIds.includes(id);
    patch({
      lockedIds: on ? req.lockedIds.filter((x) => x !== id) : [...req.lockedIds, id],
      items: on ? req.items.filter((i) => i.keepExistingId !== id) : [...req.items, { catalogId, qty: 1, keepExistingId: id }],
    });
  };
  const setItem = (idx: number, p: Partial<Requirements['items'][number]>) => req && patch({ items: req.items.map((it, i) => (i === idx ? { ...it, ...p } : it)) });

  const itemName = (it: Requirements['items'][number]) => it.keepExistingId
    ? `${model.furniture.find((f) => f.id === it.keepExistingId)?.name ?? it.catalogId} (kept)`
    : CATALOG.find((c) => c.id === it.catalogId)?.name ?? it.catalogId;

  return (
    <div className="intent">
      <div className="intent-composer">
        <textarea className="intent-text" rows={3} value={text} aria-label="Describe your space" onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void compile(); } }}
          placeholder="Describe" />
        <div className="intent-composer-bar">
          <MicButton onText={(t) => setText((v) => (v ? `${v} ${t}` : t))} />
          <button className="btn btn-primary btn-sm intent-send" disabled={compiling || !text.trim()} onClick={() => compile()} aria-label="Design it">
            {compiling || busy ? <span className="intent-spin" aria-label="Working" /> : <Icon name="send" size={14} />}
          </button>
        </div>
      </div>
      {!text && !req && !chip && !cannot && !retry && !compiling && (
        <div className="intent-chips">{EXAMPLES.map((x) => <button key={x} className="chip" onClick={() => { setText(x); void compile(x, true); }}>{x}</button>)}</div>
      )}
      {(cannot || retry) && (
        <div className="intent-chips" role="status">
          {retry && <button className="chip" onClick={() => { const r = retry; setRetry(null); r.run(); }}>{retry.label}</button>}
          {retry && <span className="chip chip-muted">{retry.reason}</span>}
          {cannot && <button className="chip" title={`${cannot.label}: ${cannot.nearest}`} onClick={() => { const n = cannot.nearest; setCannot(null); setText(n); void compile(n); }}>{two(cannot.nearest)}</button>}
        </div>
      )}
      {stages.length > 0 && <StageList stages={stages} running={running} onStop={() => runRef.current?.abort()} />}

      {req && !running && (
        <div className="intent-summary">
          <button className="btn btn-ghost btn-sm" aria-expanded={adjust} onClick={() => setAdjust((a) => !a)}>{adjust ? 'Done' : 'Adjust'}</button>
        </div>
      )}

      {req && adjust && (
        <div className="intent-chips" aria-label="Program">
          <input className="chip intent-chip-in" aria-label="Purpose" value={req.purpose} placeholder="Purpose" onChange={(e) => patch({ purpose: e.target.value })} />
          <span className="chip intent-step">
            <button aria-label="Fewer people" onClick={() => patch({ people: Math.max(1, req.people - 1) })}>-</button>
            {req.people} {req.people === 1 ? 'person' : 'people'}
            <button aria-label="More people" onClick={() => patch({ people: Math.min(50, req.people + 1) })}>+</button>
          </span>
          <label className="chip">
            <input className="intent-chip-num" type="number" min={0} step={500} aria-label="Budget in kr" value={req.budgetSek ?? ''} placeholder="Any"
              onChange={(e) => patch({ budgetSek: e.target.value === '' ? null : Math.max(0, Number(e.target.value)) })} /> kr
          </label>
          {req.items.map((it, i) => (
            <span className="chip intent-step" key={i}>
              {!it.keepExistingId && <button aria-label="Fewer" onClick={() => (it.qty > 1 ? setItem(i, { qty: it.qty - 1 }) : patch({ items: req.items.filter((_, j) => j !== i) }))}>-</button>}
              {it.qty > 1 ? `${it.qty} ` : ''}{itemName(it)}
              {!it.keepExistingId && <button aria-label="More" onClick={() => setItem(i, { qty: Math.min(20, it.qty + 1) })}>+</button>}
            </span>
          ))}
          {(['window', 'door'] as const).map((k) => (
            <button key={k} className={`chip ${req.routeTargets.some((t) => t.kind === k) ? 'chip-ok' : ''}`}
              aria-pressed={req.routeTargets.some((t) => t.kind === k)} onClick={() => toggleTarget(k)}>Route to {k}</button>
          ))}
          <span className="chip intent-step">
            <button aria-label="Narrower route" onClick={() => patch({ minRouteWidthM: Math.max(0.6, Math.round(req.minRouteWidthM * 100 - 5) / 100) })}>-</button>
            {Math.round(req.minRouteWidthM * 100)} cm route
            <button aria-label="Wider route" onClick={() => patch({ minRouteWidthM: Math.min(2, Math.round(req.minRouteWidthM * 100 + 5) / 100) })}>+</button>
          </span>
          <button className="btn btn-sm" disabled={!!busy || !req.items.length} onClick={() => generate(req)}>Regenerate</button>
        </div>
      )}

      {triedGen && candidates.length === 0 && infeasibility && (
        <div className="intent-infeasible">
          <span className="chip chip-muted">No fit</span>
          <div className="row">
            {infeasibility.relaxations.map((rx) => (
              <button key={rx.label} className="btn btn-sm" disabled={!!busy} onClick={() => relax(rx.patch)} title={rx.label}>{shortRelax(rx.label)}</button>
            ))}
          </div>
        </div>
      )}

      {req && (
        <details className="intent-details">
        <summary>More</summary>
        <div className="intent-form card">

          <div className="intent-grid">
            <label className="field"><span>Purpose</span>
              <input value={req.purpose} onChange={(e) => patch({ purpose: e.target.value })} /></label>
            <label className="field"><span>People</span>
              <input type="number" min={1} max={50} value={req.people} onChange={(e) => patch({ people: Math.max(1, Number(e.target.value) || 1) })} /></label>
            <label className="field"><span>Budget (kr)</span>
              <input type="number" min={0} step={500} value={req.budgetSek ?? ''} placeholder="None"
                onChange={(e) => patch({ budgetSek: e.target.value === '' ? null : Math.max(0, Number(e.target.value)) })} /></label>
            <label className="field"><span>Route width (cm)</span>
              <input type="number" min={60} max={200} value={Math.round(req.minRouteWidthM * 100)}
                onChange={(e) => patch({ minRouteWidthM: Math.min(2, Math.max(0.6, (Number(e.target.value) || 90) / 100)) })} /></label>
            <label className="field intent-wide"><span>Style</span>
              <input value={req.style} onChange={(e) => patch({ style: e.target.value })} /></label>
          </div>

          <div className="intent-sub">Items</div>
          <div className="list">
            {req.items.map((it, i) => (
              <div className="row intent-item" key={i}>
                {it.keepExistingId ? (
                  <span className="intent-kept">{model.furniture.find((f) => f.id === it.keepExistingId)?.name ?? it.catalogId} <span className="muted">kept</span></span>
                ) : (
                  <select aria-label="Item" value={it.catalogId} onChange={(e) => setItem(i, { catalogId: e.target.value })}>
                    {!CATALOG.some((c) => c.id === it.catalogId) && <option value={it.catalogId}>{it.catalogId}</option>}
                    {CATALOG.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                )}
                <input aria-label="Quantity" className="intent-qty" type="number" min={1} max={20} value={it.qty} disabled={!!it.keepExistingId}
                  onChange={(e) => setItem(i, { qty: Math.min(20, Math.max(1, Number(e.target.value) || 1)) })} />
                <button className="btn btn-ghost btn-sm" aria-label="Remove item"
                  onClick={() => patch({ items: req.items.filter((_, j) => j !== i), lockedIds: it.keepExistingId ? req.lockedIds.filter((x) => x !== it.keepExistingId) : req.lockedIds })}>×</button>
              </div>
            ))}
          </div>
          <button className="btn btn-sm" disabled={!CATALOG.length} onClick={() => patch({ items: [...req.items, { catalogId: CATALOG[0].id, qty: 1 }] })}>Add item</button>

          {model.furniture.length > 0 && (<>
            <div className="intent-sub">Keep in place</div>
            {model.furniture.map((f) => (
              <label key={f.id} className="row intent-check">
                <input type="checkbox" checked={req.lockedIds.includes(f.id)} onChange={() => toggleLock(f.id, f.catalogId)} />
                {f.name}
              </label>
            ))}
          </>)}


        </div>
        </details>
      )}
    </div>
  );
}

/** While the design runs: a thin progress bar and a stop button. Results simply appear. */
function StageList({ stages, running, onStop }: { stages: Stage[]; running: boolean; onStop: () => void }) {
  if (!running) return null;
  const done = stages.filter((x) => x.status !== 'running' && x.status !== undefined).length;
  const pct = stages.length ? Math.max(8, Math.round((done / stages.length) * 100)) : 8;
  return (
    <div className="intent-progress" role="progressbar" aria-label="Designing" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <span className="intent-track"><i style={{ width: `${pct}%` }} /></span>
      <button className="icon-btn" onClick={onStop} aria-label="Stop" title="Stop"><Icon name="x" size={14} /></button>
    </div>
  );
}

type Rec = { lang: string; interimResults: boolean; onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void; onend: () => void; onerror: () => void; start: () => void; stop: () => void };
type RecWin = { webkitSpeechRecognition?: new () => Rec; SpeechRecognition?: new () => Rec };

function MicButton({ onText }: { onText: (t: string) => void }) {
  const w = window as unknown as RecWin;
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  const [on, setOn] = useState(false);
  const rec = useRef<Rec | null>(null);
  useEffect(() => () => rec.current?.stop(), []);
  if (!Ctor) return null;
  const toggle = () => {
    if (on) { rec.current?.stop(); return; }
    const r = new Ctor();
    r.lang = navigator.language || 'en-US';
    r.interimResults = false;
    r.onresult = (e) => onText(Array.from(e.results).map((x) => x[0].transcript).join(' '));
    r.onend = () => setOn(false);
    r.onerror = () => setOn(false);
    rec.current = r; setOn(true); r.start();
  };
  return <button className={`btn btn-ghost btn-sm intent-mic${on ? ' on' : ''}`} aria-pressed={on} aria-label={on ? 'Stop voice input' : 'Speak your request'} title={on ? 'Listening' : 'Speak'} onClick={toggle}><Icon name="mic" size={14} /></button>;
}

