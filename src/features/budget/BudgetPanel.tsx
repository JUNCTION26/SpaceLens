import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../core/store';
import { aiReady } from '../../core/ai';
import { Icon } from '../../ui/icons';
import { argueItems, polishArguments, type Argument } from './argue';
import { costOf, kr, totalOf } from './money';
import { applySwaps, newFailures, optimiseBudget, type BudgetPlan } from './optimise';
import { planPhases } from './phases';
import { MovesBlock } from './MovesBlock';
import './budget.css';

const LS = 'spacelens.budget.v1';
interface Saved { target: Record<string, number>; monthly: number }
function loadSaved(): Saved {
  try { const s = localStorage.getItem(LS); if (s) { const v = JSON.parse(s) as Partial<Saved>; return { target: v.target ?? {}, monthly: v.monthly ?? 0 }; } } catch { /* storage blocked */ }
  return { target: {}, monthly: 0 };
}
function save(v: Saved) { try { localStorage.setItem(LS, JSON.stringify(v)); } catch { /* storage blocked */ } }

const KIND_LABEL = { replace: 'Cheaper model', downsize: 'Smaller size', drop: 'Leave out' } as const;
const num = (s: string) => { const n = Math.round(Number(s.replace(/[\s ]/g, ''))); return Number.isFinite(n) && n >= 0 ? n : 0; };

export function BudgetPanel() {
  const model = useStore((s) => s.model);
  const requirements = useStore((s) => s.requirements);
  const dispatch = useStore((s) => s.dispatch);
  const toast = useStore((s) => s.toast);
  const furniture = model.furniture;

  const [saved, setSaved] = useState<Saved>(loadSaved);
  const buyNow = useMemo(() => totalOf(furniture), [furniture]);
  const target = saved.target[model.id] ?? Math.max(1000, Math.ceil((buyNow * 0.8) / 500) * 500);
  const [result, setResult] = useState<BudgetPlan | null>(null);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [args, setArgs] = useState<Argument[] | null>(null);
  const [polishing, setPolishing] = useState(false);
  const version = useRef(model.version);

  // A plan belongs to the layout it was made for.
  useEffect(() => {
    if (version.current !== model.version) { version.current = model.version; setResult(null); setOff(new Set()); setArgs(null); }
  }, [model.version]);

  const update = (v: Saved) => { setSaved(v); save(v); };
  const setTarget = (n: number) => { update({ ...saved, target: { ...saved.target, [model.id]: n } }); };

  const chosen = useMemo(() => (result ? result.plan.filter((s) => !off.has(s.id)) : []), [result, off]);
  const after = useMemo(() => applySwaps(furniture, chosen), [furniture, chosen]);
  const afterTotal = totalOf(after);
  const broken = useMemo(() => (chosen.length ? newFailures(model, furniture, after, requirements) : []), [chosen, model, furniture, after, requirements]);

  const shown = result ? after : furniture;
  const shownTotal = result ? afterTotal : buyNow;
  const owned = furniture.filter((f) => f.owned || f.priceStatus === 'owned').length;
  const fromListing = furniture.filter((f) => costOf(f) > 0 && f.listing && f.listing.price != null).length;
  const estimates = furniture.filter((f) => costOf(f) > 0).length - fromListing;
  const over = Math.max(0, shownTotal - target);
  const scale = Math.max(target, shownTotal, 1);

  const run = () => {
    setBusy(true); setArgs(null);
    // Let the button repaint before the search blocks the thread.
    setTimeout(() => {
      try { setResult(optimiseBudget(model, furniture, target, { req: requirements })); setOff(new Set()); }
      finally { setBusy(false); }
    }, 30);
  };
  const apply = () => {
    if (!chosen.length || broken.length) return;
    dispatch({ type: 'SET_FURNITURE', items: after, label: `Applied budget plan (${chosen.length} ${chosen.length === 1 ? 'change' : 'changes'})` });
    
  };
  const toggle = (id: string) => setOff((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const phases = useMemo(() => planPhases(shown, saved.monthly), [shown, saved.monthly]);
  const reasons = useMemo(() => args ?? argueItems(furniture, chosen), [args, furniture, chosen]);
  const polish = async () => { setPolishing(true); try { setArgs(await polishArguments(argueItems(furniture, chosen))); } finally { setPolishing(false); } };

  const max = Math.max(10000, Math.ceil((buyNow * 1.5) / 1000) * 1000);
  const status = !result ? null : result.feasible ? 'ok' : 'bad';

  if (!furniture.length) return <div className="budget"><p className="budget-note muted">No furniture yet</p></div>;

  return (
    <div className="budget">
      <section className="budget-block" aria-label="Target">
        <div className="budget-row">
          <label htmlFor="budget-target" className="budget-label">Budget</label>
          <span className="budget-input"><input id="budget-target" inputMode="numeric" value={String(target)} onChange={(e) => setTarget(num(e.target.value))} /><span>kr</span></span>
        </div>
        <input type="range" aria-label="Budget" min={0} max={max} step={100} value={Math.min(target, max)} onChange={(e) => setTarget(num(e.target.value))} />
        <div className="budget-bar" role="img" aria-label={`${kr(shownTotal)} to buy against a budget of ${kr(target)}${over ? `, ${kr(over)} over` : ''}`}>
          <i className="budget-fill" style={{ width: `${(Math.min(shownTotal, target) / scale) * 100}%` }} />
          {over > 0 && <i className="budget-over" style={{ width: `${(over / scale) * 100}%` }} />}
          <b className="budget-mark" style={{ left: `${(target / scale) * 100}%` }} />
        </div>
        <div className="budget-legend">
          <span><i className="dot fill" />To buy {kr(shownTotal)}</span>
          {over > 0 && <span className="bad"><i className="dot over" />Over {kr(over)}</span>}
          {owned > 0 && <span><i className="dot owned" />{owned} owned</span>}
        </div>
        <button type="button" className="btn btn-primary budget-wide" onClick={run} disabled={busy}>
          <Icon name="sparkles" />{busy ? 'Working' : result ? 'Optimise again' : 'Optimise'}
        </button>
      </section>

      <MovesBlock model={model} target={target} onApply={(items, n) => dispatch({ type: 'SET_FURNITURE', items, label: `Applied budget moves (${n})` })} />

      {result && (
        <section className="budget-block" aria-label="Plan" aria-live="polite">
          {result.plan.length > 0 && (
            <ul className="budget-list">
              {result.plan.map((s) => (
                <li key={s.id} className={`budget-swap${off.has(s.id) ? ' off' : ''}`}>
                  <label>
                    <input type="checkbox" checked={!off.has(s.id)} onChange={() => toggle(s.id)} />
                    <span className="budget-swap-body">
                      <span className="budget-swap-top"><b>{KIND_LABEL[s.kind]}</b><span className="ok">{`−${kr(s.saving)}`}</span></span>
                      <span className="budget-ba">
                        <span>{s.before.name} <em>{kr(s.before.priceSek)}</em></span>
                        <Icon name="redo" size={12} aria-hidden="true" />
                        <span>{s.after ? s.after.name : 'None'} <em>{kr(s.after?.priceSek ?? 0)}</em></span>
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {chosen.length > 0 && (
            <p className={`budget-note ${broken.length ? 'bad' : 'muted'}`}>
              {broken.length ? <span title={broken[0].details}>Fails a check</span> : `Score ${result.scoreBefore} → ${result.scoreAfter}`}
            </p>
          )}
          {result.plan.length > 0 && (
            <button type="button" className="btn budget-wide" onClick={apply} disabled={!chosen.length || broken.length > 0}>
              <Icon name="check" />Apply {chosen.length}
            </button>
          )}
        </section>
      )}

      <details className="budget-block" aria-label="Phases">
        <summary>Phases</summary>
        <div className="budget-row">
          <label htmlFor="budget-monthly" className="budget-label">Per month</label>
          <span className="budget-input"><input id="budget-monthly" inputMode="numeric" placeholder="0" value={saved.monthly ? String(saved.monthly) : ''} onChange={(e) => update({ ...saved, monthly: num(e.target.value) })} /><span>kr</span></span>
        </div>
        <ol className="budget-phases">
          {phases.map((p) => (
            <li key={p.key} className={p.items.length ? '' : 'empty'}>
              <div className="budget-phase-head">
                <b>{p.label}</b><span>{kr(p.total)}</span>
              </div>
              {p.paidByMonth ? <p className="budget-note muted">Month {p.paidByMonth}</p> : null}
              {p.items.length > 0 && <p className="budget-note budget-items" title={`${p.why} ${p.items.map((f) => f.name).join(', ')}`}>{p.items.length} items</p>}
            </li>
          ))}
        </ol>
      </details>

      <details className="budget-block budget-why">
        <summary>Why</summary>
        <ul className="budget-list">
          {reasons.map((a) => <li key={a.itemId} className="budget-reason">{a.text}</li>)}
        </ul>
        {aiReady() && <button type="button" className="btn btn-sm" onClick={polish} disabled={polishing}>{polishing ? 'Rewording' : 'Reword'}</button>}
      </details>
    </div>
  );
}

export default BudgetPanel;
