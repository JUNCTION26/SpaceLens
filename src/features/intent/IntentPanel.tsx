import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../core/store';
import type { Requirements } from '../../core/types';
import { CATALOG } from '../furniture/catalog';
import { generateLayouts } from '../layout/solver';
import { useUi } from '../../ui/uiStore';
import { compileWithMeta, diffRequirements, refineIntent, type CompileMeta } from './refine';
import './intent.css';

const EXAMPLES = [
  'Home office for two, keep my desk, clear route to the window, under 12 000 kr',
  'Bedroom I can also work in, sofa bed, 90 cm route',
  'Small cafe for 12 guests',
];

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
  const [follow, setFollow] = useState('');
  const [refining, setRefining] = useState(false);
  const [thread, setThread] = useState<Array<{ ask: string; reply: string; diff: string[]; meta: CompileMeta }>>([]);
  const compileRef = useRef<(t?: string) => Promise<void>>(async () => {});

  useEffect(() => {
    const on = (e: Event) => {
      const t = String((e as CustomEvent).detail ?? '').trim();
      if (!t) return;
      setText(t);
      void compileRef.current(t);
    };
    window.addEventListener('spacelens:request', on);
    return () => window.removeEventListener('spacelens:request', on);
  }, []);

  const patch = (p: Partial<Requirements>) => setReq((r) => (r ? { ...r, ...p } : r));

  async function compile(input?: string) {
    const q = input ?? text;
    if (!q.trim()) return;
    setCompiling(true);
    try {
      const { req: r, meta: m } = await compileWithMeta(q, useStore.getState().model);
      setReq(r); setMeta(m); setTriedGen(false); setThread([]);
      if (r.items.length) void generate(r);
    } catch (e) { useStore.getState().toast(`Could not read that: ${(e as Error).message}`, 'error'); }
    finally { setCompiling(false); }
  }
  compileRef.current = compile;

  async function refine(ask: string) {
    if (!req || !ask.trim()) return;
    setRefining(true);
    try {
      const { next, reply, meta: m } = await refineIntent(req, ask, thread.map((t) => t.ask), useStore.getState().model);
      const diff = diffRequirements(req, next);
      setThread((th) => [...th, { ask, reply, diff, meta: m }].slice(-6));
      setFollow('');
      if (diff.length) { setReq(next); if (next.items.length) void generate(next); }
    } catch (e) { useStore.getState().toast(`Refine failed: ${(e as Error).message}`, 'error'); }
    finally { setRefining(false); }
  }

  async function generate(r: Requirements) {
    const st = useStore.getState();
    st.setBusy('Generating layouts');
    try {
      const { candidates, infeasibility } = await generateLayouts(st.model, r, {
        variants: 4,
        onProgress: (p) => useStore.getState().setBusy(`Generating layouts ${Math.round(p * 100)}%`),
      });
      st.setCandidates(candidates, infeasibility);
      st.setRequirements(r);
      setTriedGen(true);
      if (candidates.length) {
        st.toast(`${candidates.length} layout${candidates.length > 1 ? 's' : ''} ready`, 'ok');
        useUi.getState().setTab('design', 'layouts');
      } else st.toast('No layout fits. See reasons.', 'warn');
    } catch (e) {
      st.toast(`Layout failed: ${(e as Error).message}`, 'error');
    } finally {
      useStore.getState().setBusy(null);
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

  return (
    <div className="intent">
      <label className="field">
        <span>What do you want?</span>
        <textarea className="intent-text" rows={3} value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void compile(); } }}
          placeholder="Home office for two, under 12 000 kr" />
      </label>
      <MicButton onText={(t) => setText((v) => (v ? `${v} ${t}` : t))} />
      <div className="intent-examples">
        {EXAMPLES.map((ex) => <button key={ex} className="chip" onClick={() => setText(ex)}>{ex}</button>)}
      </div>
      <button className="btn btn-primary" disabled={compiling || !text.trim()} onClick={() => compile()}>
        {compiling ? 'Reading...' : busy ? 'Designing...' : 'Design it'}
      </button>
      {meta?.error && <CompilerBadge meta={meta} />}

      {req && (
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
              {it.qty > 1 ? `${it.qty} ` : ''}{it.keepExistingId ? `${model.furniture.find((f) => f.id === it.keepExistingId)?.name ?? it.catalogId} (kept)` : CATALOG.find((c) => c.id === it.catalogId)?.name ?? it.catalogId}
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

      {req && candidates.length > 0 && (
        <div className="intent-chat card">
          {thread.map((t, i) => (
            <div key={i} className="intent-turn">
              <div className="intent-ask">{t.ask}</div>
              <div>{t.reply}</div>
              {t.diff.length > 0 ? <div className="intent-diff">{t.diff.map((d) => <span key={d} className="chip">{d}</span>)}</div> : <div className="muted">Nothing changed.</div>}
              {t.meta.error && <CompilerBadge meta={t.meta} />}
            </div>
          ))}
          <div className="row intent-follow">
            <input aria-label="Refine" value={follow} disabled={refining} placeholder="Make it cozier, add a reading chair, cheaper"
              onChange={(e) => setFollow(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void refine(follow); }} />
            <MicButton onText={(t) => setFollow(t)} />
            <button className="btn btn-sm btn-primary" disabled={refining || !follow.trim()} onClick={() => refine(follow)}>{refining ? '...' : 'Send'}</button>
          </div>
        </div>
      )}

      {req && (
        <details className="intent-details">
        <summary>Edit details</summary>
        <div className="intent-form card">
          {req.questions.length > 0 && (
            <ul className="intent-questions">{req.questions.map((q) => <li key={q}>{q}</li>)}</ul>
          )}

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

          {req.notes.length > 0 && <ul className="intent-notes muted">{req.notes.map((n) => <li key={n}>{n}</li>)}</ul>}

          {triedGen && candidates.length === 0 && infeasibility && (
            <div className="intent-infeasible">
              <strong>No layout fits</strong>
              <ul>{infeasibility.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
              <div className="row">
                {infeasibility.relaxations.map((rx) => (
                  <button key={rx.label} className="btn btn-sm" disabled={!!busy} onClick={() => relax(rx.patch)}>{rx.label}</button>
                ))}
              </div>
            </div>
          )}
        </div>
        </details>
      )}
    </div>
  );
}

function CompilerBadge({ meta }: { meta: CompileMeta }) {
  const tokens = meta.inTokens + meta.outTokens;
  return (
    <div className={`intent-badge ${meta.error ? 'intent-badge-warn' : ''}`}>
      {meta.by === 'gemini' ? `${meta.model ?? 'Gemini'} · ${(meta.ms / 1000).toFixed(1)} s · ${tokens} tokens` : 'Rules'}
      {meta.error && <span> · {meta.error}</span>}
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
  return <button className={`btn btn-sm intent-mic ${on ? 'chip-ok' : ''}`} aria-pressed={on} aria-label={on ? 'Stop voice input' : 'Speak your request'} onClick={toggle}>{on ? 'Listening...' : 'Speak'}</button>;
}

