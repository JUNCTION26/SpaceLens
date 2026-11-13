import { useMemo, useState } from 'react';
import { useShownFurniture, useStore } from '../../core/store';
import type { ValidationResult } from '../../core/types';
import { summarize, validateLayout } from './validate';
import './referee.css';

const CHIP = { pass: 'chip-ok', fail: 'chip-bad', unknown: 'chip-warn' } as const;

export function ChecksPanel() {
  const model = useStore((s) => s.model);
  const requirements = useStore((s) => s.requirements);
  const furniture = useShownFurniture();
  const [showPass, setShowPass] = useState(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const results = useMemo(() => validateLayout(model, furniture, requirements), [model.version, furniture, requirements]);
  const sum = summarize(results);
  const fails = results.filter((r) => r.result === 'fail');
  const unknown = results.filter((r) => r.result === 'unknown');
  const passes = results.filter((r) => r.result === 'pass');

  const focus = (r: ValidationResult) => {
    const st = useStore.getState();
    st.setAnalysis({ highlights: [{ ids: r.subjectIds, color: 'var(--bad)', label: r.rule }] });
    const first = r.subjectIds.find((id) => furniture.some((f) => f.id === id));
    if (first) st.select({ kind: 'furniture', id: first });
  };

  const row = (r: ValidationResult) => (
    <li key={r.id} className="referee-item">
      {r.result === 'fail' ? (
        <button className="referee-btn" onClick={() => focus(r)} title="Show on plan">
          <span className={`chip ${CHIP.fail}`}>{r.rule}</span> <span className="referee-details">{r.details}</span>
        </button>
      ) : (
        <><span className={`chip ${CHIP[r.result]}`}>{r.rule}</span> <span className="referee-details">{r.details}</span></>
      )}
    </li>
  );

  return (
    <section className="panel referee" aria-label="Independent checks">
      <div className="row referee-head">
        <strong>Checks</strong>
        <span className="chip chip-ok">{sum.pass} pass</span>
        <span className="chip chip-bad">{sum.fail} fail</span>
        <span className="chip chip-warn">{sum.unknown} unknown</span>
      </div>
      <div className="muted referee-sub">Independent checks</div>
      <ul className="list referee-list">
        {fails.map(row)}
        {unknown.map(row)}
      </ul>
      {passes.length > 0 && (
        <>
          <button className="btn btn-sm" aria-expanded={showPass} onClick={() => setShowPass((v) => !v)}>
            {showPass ? 'Hide' : 'Show'} {passes.length} passed
          </button>
          {showPass && <ul className="list referee-list">{passes.map(row)}</ul>}
        </>
      )}
    </section>
  );
}
