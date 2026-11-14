import { memo, useEffect, useMemo, useState } from 'react';
import { useShownFurniture, useStore } from '../../core/store';
import type { FurnitureItem, ValidationResult } from '../../core/types';
import { findFreeSpot } from '../objects/placement';
import { summarize, validateLayout } from './validate';
import { Icon } from '../../ui/icons';
import './referee.css';

/** Returns `value` after it has been stable for `ms`. */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

interface Group { key: string; title: string; item?: FurnitureItem; results: ValidationResult[] }

export const ChecksPanel = memo(function ChecksPanel() {
  const model = useStore((s) => s.model);
  const requirements = useStore((s) => s.requirements);
  const shown = useShownFurniture();
  const furniture = useDebounced(shown, 150);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const results = useMemo(() => validateLayout(model, furniture, requirements), [model.version, furniture, requirements]);

  const { sum, groups, passes } = useMemo(() => {
    const byId = new Map(furniture.map((f) => [f.id, f]));
    const map = new Map<string, Group>();
    const passes: ValidationResult[] = [];
    for (const r of results) {
      if (r.result === 'pass') { passes.push(r); continue; }
      const item = r.subjectIds.map((id) => byId.get(id)).find(Boolean);
      const key = item?.id ?? '__room';
      let g = map.get(key);
      if (!g) map.set(key, (g = { key, title: item?.name ?? 'Room', item, results: [] }));
      g.results.push(r);
    }
    const groups = [...map.values()].sort((a, b) =>
      Number(b.results.some((r) => r.result === 'fail')) - Number(a.results.some((r) => r.result === 'fail')));
    return { sum: summarize(results), groups, passes };
  }, [results, furniture]);

  const show = (g: Group) => {
    const st = useStore.getState();
    const ids = [...new Set(g.results.flatMap((r) => r.subjectIds))];
    st.setAnalysis({ highlights: [{ ids, color: 'var(--bad)', label: g.title }] });
    if (g.item) st.select({ kind: 'furniture', id: g.item.id });
  };

  const fix = (g: Group) => {
    if (!g.item) return;
    const st = useStore.getState();
    const pose = findFreeSpot(st.model, g.item, furniture);
    st.dispatch({ type: 'UPDATE_OBJECT', id: g.item.id, patch: pose });
    st.select({ kind: 'furniture', id: g.item.id });
  };

  const total = sum.pass + sum.fail + sum.unknown;

  return (
    <section className="referee" aria-label="Checks">
      <div className="referee-head" aria-live="polite">
        <span className={`referee-dot ${sum.fail ? 'bad' : sum.unknown ? 'warn' : 'ok'}`} aria-hidden="true" />
        <span>{sum.fail ? `${sum.fail} to fix` : 'All clear'}</span>
        <span className="referee-meta">{sum.pass}/{total} pass{sum.unknown ? ` · ${sum.unknown} unknown` : ''}</span>
      </div>
      {groups.length > 0 && (
        <ul className="referee-list">
          {groups.map((g) => {
            const failing = g.results.some((r) => r.result === 'fail');
            return (
              <li key={g.key} className="referee-group">
                <div className="referee-group-head">
                  <span className={`referee-dot ${failing ? 'bad' : 'warn'}`} aria-hidden="true" />
                  <span className="referee-title">{g.title}</span>
                  <button className="icon-btn" title="Show" aria-label={`Show ${g.title}`} onClick={() => show(g)}><Icon name="eye" size={14} /></button>
                  {g.item && failing && <button className="icon-btn" title="Move to the nearest free spot" aria-label={`Fix ${g.title}`} onClick={() => fix(g)}><Icon name="check" size={14} /></button>}
                </div>
                <ul className="referee-sentences">
                  {g.results.map((r) => <li key={r.id}><span className="referee-rule">{r.rule}</span> {r.details}</li>)}
                </ul>
              </li>
            );
          })}
        </ul>
      )}
      {passes.length > 0 && (
        <details className="referee-passes">
          <summary>{passes.length} passed</summary>
          <ul className="referee-sentences">
            {passes.map((r) => <li key={r.id}><span className="referee-rule">{r.rule}</span> {r.details}</li>)}
          </ul>
        </details>
      )}
    </section>
  );
});
