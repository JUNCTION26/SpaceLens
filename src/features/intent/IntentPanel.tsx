import { useState } from 'react';
import { useStore } from '../../core/store';
import type { Requirements } from '../../core/types';
import { CATALOG } from '../furniture/catalog';
import { generateLayouts } from '../layout/solver';
import { useUi } from '../../ui/uiStore';
import { compileIntent } from './compile';
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

  const patch = (p: Partial<Requirements>) => setReq((r) => (r ? { ...r, ...p } : r));

  async function compile() {
    if (!text.trim()) return;
    setCompiling(true);
    try { setReq(await compileIntent(text, useStore.getState().model)); setTriedGen(false); }
    finally { setCompiling(false); }
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
        <textarea className="intent-text" rows={4} value={text} onChange={(e) => setText(e.target.value)}
          placeholder="Home office for two, under 12 000 kr" />
      </label>
      <div className="intent-examples">
        {EXAMPLES.map((ex) => <button key={ex} className="chip" onClick={() => setText(ex)}>{ex}</button>)}
      </div>
      <button className="btn btn-primary" disabled={compiling || !text.trim()} onClick={compile}>
        {compiling ? 'Compiling...' : 'Compile'}
      </button>

      {req && (
        <div className="intent-form card">
          <div className="row intent-head">
            <strong>Program</strong>
            <span className={`chip ${req.compiledBy === 'gemini' ? 'chip-ok' : ''}`}>{req.compiledBy === 'gemini' ? 'Gemini' : 'Rules'}</span>
          </div>

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

          <div className="intent-sub">Clear route to</div>
          <div className="row">
            {(['window', 'door'] as const).map((k) => (
              <button key={k} className={`chip ${req.routeTargets.some((t) => t.kind === k) ? 'chip-ok' : ''}`}
                aria-pressed={req.routeTargets.some((t) => t.kind === k)} onClick={() => toggleTarget(k)}>{k === 'window' ? 'Window' : 'Door'}</button>
            ))}
          </div>

          {req.notes.length > 0 && <ul className="intent-notes muted">{req.notes.map((n) => <li key={n}>{n}</li>)}</ul>}

          <button className="btn btn-primary" disabled={!!busy || !req.items.length} onClick={() => generate(req)}>Generate layouts</button>

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
      )}
    </div>
  );
}
