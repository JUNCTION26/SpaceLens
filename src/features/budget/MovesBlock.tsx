import { useEffect, useMemo, useState } from 'react';
import type { SpaceModel } from '../../core/types';
import { Icon } from '../../ui/icons';
import { kr } from './money';
import { applyMoves, planBudget, totalAfter, type Move } from './plan';

interface Props {
  model: SpaceModel;
  target: number;
  onApply: (items: SpaceModel['furniture'], count: number) => void;
}

const VERB = { swap: 'Swap', drop: 'Drop', keep: 'Keep' } as const;

/** Moves toward the budget, one toggle each, and a bar that turns green once they add up. */
export function MovesBlock({ model, target, onApply }: Props) {
  const plan = useMemo(() => planBudget(model, target), [model, target]);
  const [on, setOn] = useState<Set<string>>(new Set());
  // A new suggestion starts with its suggested moves switched on.
  useEffect(() => { setOn(new Set(plan.moves.filter((m) => m.suggested).map((m) => m.id))); }, [plan]);

  const chosen = useMemo(() => {
    const seen = new Set<string>();
    return plan.moves.filter((m) => on.has(m.id) && m.kind !== 'keep' && !seen.has(m.itemId) && !!seen.add(m.itemId));
  }, [plan, on]);
  const spent = totalAfter(model, chosen);
  const over = spent - target;
  const scale = Math.max(target, spent, 1);
  const good = over <= 0;
  const toggle = (m: Move) => setOn((o) => {
    const n = new Set(o);
    if (n.has(m.id)) n.delete(m.id);
    else { for (const x of plan.moves) if (x.itemId === m.itemId) n.delete(x.id); n.add(m.id); }
    return n;
  });
  const apply = () => {
    const ops = applyMoves(model, chosen);
    if (!ops.length) return;
    const gone = new Set<string>(), patch = new Map<string, object>();
    for (const o of ops) { if (o.type === 'REMOVE_OBJECT') gone.add(o.id); else if (o.type === 'UPDATE_OBJECT') patch.set(o.id, o.patch); }
    onApply(model.furniture.filter((f) => !gone.has(f.id)).map((f) => (patch.has(f.id) ? { ...f, ...patch.get(f.id) } : f)), ops.length);
  };
  const rows = plan.moves;

  return (
    <section className="budget-block" aria-label="Moves">
      <div className={`budget-bar budget-moves-bar ${good ? 'good' : 'short'}`} role="img" aria-label={`${kr(spent)} against a budget of ${kr(target)}${over > 0 ? `, ${kr(over)} over` : ''}`}>
        <i className="budget-fill" style={{ width: `${(Math.min(spent, target) / scale) * 100}%` }} />
        {over > 0 && <i className="budget-over" style={{ width: `${(over / scale) * 100}%` }} />}
        <b className="budget-mark" style={{ left: `${(target / scale) * 100}%` }} />
      </div>
      <div className="budget-legend">
        <span className={good ? 'ok' : 'bad'}>{kr(spent)}</span>
        <span>{over > 0 ? `+${kr(over)}` : `−${kr(-over)}`}</span>
      </div>
      <ul className="budget-list">
        {rows.map((m) => {
          const keep = m.kind === 'keep';
          return (
            <li key={m.id} className={`budget-swap${!keep && !on.has(m.id) ? ' off' : ''}`}>
              <label>
                <input type="checkbox" checked={keep ? true : on.has(m.id)} disabled={keep} onChange={() => toggle(m)} aria-label={`${VERB[m.kind]} ${m.name}`} title={m.tag} />
                <span className="budget-swap-body">
                  <span className="budget-swap-top"><b>{VERB[m.kind]} {m.name}</b>{!keep && <span className="ok">{`−${kr(m.savingSek)}`}</span>}</span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      <button type="button" className="btn btn-primary budget-wide" onClick={apply} disabled={!chosen.length}>
        <Icon name="check" />Apply {chosen.length}
      </button>
    </section>
  );
}
