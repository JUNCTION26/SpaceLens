import { memo } from 'react';
import { useStore } from '../../core/store';
import { counts, useProblems } from '../problems/store';
import { FixButtons, SeverityDot } from '../problems/ProblemCard';
import type { Problem } from '../problems/types';
import './referee.css';

function Row({ p }: { p: Problem }) {
  const setFocus = useProblems((s) => s.setFocus);
  const show = () => {
    const st = useStore.getState();
    const id = p.itemIds[0] ?? p.openingIds[0];
    if (!id) return;
    st.select(p.itemIds[0] ? { kind: 'furniture', id } : { kind: 'opening', id });
  };
  return (
    <li className="referee-row" onPointerEnter={() => setFocus(p.id)} onPointerLeave={() => setFocus(null)} onFocus={() => setFocus(p.id)} onBlur={() => setFocus(null)}>
      <SeverityDot severity={p.severity} />
      <div className="referee-row-body">
        {p.itemIds.length || p.openingIds.length
          ? <button type="button" className="referee-title" onClick={show} title={p.title}>{clip(p.title)}</button>
          : <p className="referee-title" title={p.title}>{clip(p.title)}</p>}
        <FixButtons problem={p} compact max={2} />
      </div>
    </li>
  );
}

/** Generated titles can run long; show the first four words. */
export const clip = (t: string, n = 4) => { const w = t.split(/\s+/); return w.length > n ? `${w.slice(0, n).join(' ')}…` : t; };

export const ChecksPanel = memo(function ChecksPanel() {
  const problems = useProblems((s) => s.problems);
  const fixingAll = useProblems((s) => s.fixingAll);
  const fixAll = useProblems((s) => s.fixAll);
  const main = problems.filter(counts);
  const tips = problems.filter((p) => !counts(p));
  const auto = main.filter((p) => p.fixes.some((f) => f.safe)).length;

  return (
    <section className="referee" aria-label="Checks">
      <div className="referee-head" aria-live="polite">
        <span className={`referee-dot ${main.some((p) => p.severity === 'error') ? 'bad' : main.length ? 'warn' : 'ok'}`} aria-hidden="true" />
        <span className="referee-count">{main.length ? `${main.length} to fix` : 'All good'}</span>
        {auto > 0 && (
          <button type="button" className="btn btn-sm btn-primary referee-fixall" onClick={() => void fixAll()} disabled={fixingAll}
            title="Only fixes that cause no new problem. Undo reverts all.">
            {fixingAll ? 'Fixing' : auto === main.length ? 'Fix all' : `Fix ${auto}`}
          </button>
        )}
      </div>
      {main.length > 0 && <ul className="referee-list">{main.map((p) => <Row key={p.id} p={p} />)}</ul>}
      {tips.length > 0 && (
        <details className="referee-passes">
          <summary>More</summary>
          <ul className="referee-list">{tips.map((p) => <Row key={p.id} p={p} />)}</ul>
        </details>
      )}
    </section>
  );
});
