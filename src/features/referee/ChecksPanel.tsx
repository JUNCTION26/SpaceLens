import { memo, useEffect, useMemo, useState } from 'react';
import { useShownFurniture, useStore } from '../../core/store';
import type { FurnitureItem, ValidationResult } from '../../core/types';
import { findFreeSpot } from '../objects/placement';
import { summarize, validateLayout } from './validate';
import './referee.css';

const CHIP = { pass: 'chip-ok', fail: 'chip-bad', unknown: 'chip-warn' } as const;

/** Returns `value` after it has been stable for `ms`. */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Number that pulses briefly when it changes. */
function Count({ n, cls, label }: { n: number; cls: string; label: string }) {
  return (
    <span className={`chip ${cls}`}>
      <span key={n} className="referee-pop">{n}</span> {label}
    </span>
  );
}

function Ring({ pass, total }: { pass: number; total: number }) {
  const r = 22, c = 2 * Math.PI * r;
  const frac = total ? pass / total : 1;
  const ok = pass === total;
  return (
    <svg className="referee-ring" width="56" height="56" viewBox="0 0 56 56" role="img" aria-label={`${pass} of ${total} checks pass`}>
      <circle cx="28" cy="28" r={r} fill="none" stroke="var(--line)" strokeWidth="6" />
      <circle cx="28" cy="28" r={r} fill="none" stroke={ok ? 'var(--ok)' : 'var(--bad)'} strokeWidth="6" strokeLinecap="round"
        strokeDasharray={`${c * frac} ${c}`} transform="rotate(-90 28 28)" className="referee-arc" />
      <text x="28" y="33" textAnchor="middle" fontSize="15" fontWeight="700" fill="var(--text)">{ok ? '✓' : total - pass}</text>
    </svg>
  );
}

interface Group { key: string; title: string; item?: FurnitureItem; results: ValidationResult[] }

export const ChecksPanel = memo(function ChecksPanel() {
  const model = useStore((s) => s.model);
  const requirements = useStore((s) => s.requirements);
  const shown = useShownFurniture();
  const furniture = useDebounced(shown, 150);
  const [showPass, setShowPass] = useState(false);
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
    <section className="panel referee" aria-label="Checks">
      <div className="referee-head">
        <Ring pass={sum.pass} total={total} />
        <div>
          <strong>{sum.fail ? `${sum.fail} to fix` : 'All clear'}</strong>
          <div className="row referee-counts" aria-live="polite">
            <Count n={sum.pass} cls={CHIP.pass} label="pass" />
            <Count n={sum.fail} cls={CHIP.fail} label="fail" />
            {sum.unknown > 0 && <Count n={sum.unknown} cls={CHIP.unknown} label="unknown" />}
          </div>
        </div>
      </div>
      <ul className="list referee-list">
        {groups.map((g) => {
          const failing = g.results.some((r) => r.result === 'fail');
          return (
            <li key={g.key} className="referee-group">
              <div className="row referee-group-head">
                <strong>{g.title}</strong>
                <span className="referee-actions">
                  <button className="btn btn-sm" onClick={() => show(g)}>Show me</button>
                  {g.item && failing && <button className="btn btn-sm" onClick={() => fix(g)} title="Move to the nearest free spot">Fix</button>}
                </span>
              </div>
              <ul className="referee-sentences">
                {g.results.map((r) => (
                  <li key={r.id}><span className={`chip ${CHIP[r.result]}`}>{r.rule}</span> {r.details}</li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
      {passes.length > 0 && (
        <>
          <button className="btn btn-sm" aria-expanded={showPass} onClick={() => setShowPass((v) => !v)}>
            {showPass ? 'Hide' : 'Show'} {passes.length} passed
          </button>
          {showPass && (
            <ul className="list referee-list">
              {passes.map((r) => <li key={r.id} className="referee-item"><span className="chip chip-ok">{r.rule}</span> <span className="referee-details">{r.details}</span></li>)}
            </ul>
          )}
        </>
      )}
    </section>
  );
});
