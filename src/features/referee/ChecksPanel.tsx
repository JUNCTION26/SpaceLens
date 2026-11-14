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
          ? <button type="button" className="referee-title" onClick={show} title="Select it on the plan">{p.title}</button>
          : <p className="referee-title">{p.title}</p>}
        <FixButtons problem={p} compact />
      </div>
    </li>
  );
}

export const ChecksPanel = memo(function ChecksPanel() {
  const problems = useProblems((s) => s.problems);
  const checks = useProblems((s) => s.checks);
  const fixingAll = useProblems((s) => s.fixingAll);
  const fixAll = useProblems((s) => s.fixAll);
  const main = problems.filter(counts);
  const tips = problems.filter((p) => !counts(p));
  const auto = main.filter((p) => p.fixes.some((f) => f.safe)).length;
  const passes = checks.filter((r) => r.result === 'pass');
  const total = checks.filter((r) => r.result !== 'unknown').length;

  return (
    <section className="referee" aria-label="Checks">
      <div className="referee-head" aria-live="polite">
        <span className={`referee-dot ${main.some((p) => p.severity === 'error') ? 'bad' : main.length ? 'warn' : 'ok'}`} aria-hidden="true" />
        <span className="referee-count">{main.length ? `${main.length} to fix` : 'All clear'}</span>
        <span className="referee-meta">{passes.length} of {total} checks pass</span>
        {auto > 0 && (
          <button type="button" className="btn btn-sm btn-primary referee-fixall" onClick={() => void fixAll()} disabled={fixingAll}
            title="Runs only fixes that were checked to clear a problem without causing another. Undo puts everything back.">
            {fixingAll ? 'Fixing' : auto === main.length ? 'Fix all' : `Fix ${auto} automatically`}
          </button>
        )}
      </div>
      {!main.length && !tips.length && <p className="referee-empty">Nothing overlaps, every door opens and every use zone is free.</p>}
      {main.length > 0 && <ul className="referee-list">{main.map((p) => <Row key={p.id} p={p} />)}</ul>}
      {tips.length > 0 && (
        <details className="referee-passes">
          <summary>{tips.length} {tips.length === 1 ? 'suggestion' : 'suggestions'}</summary>
          <ul className="referee-list">{tips.map((p) => <Row key={p.id} p={p} />)}</ul>
        </details>
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
