import { useProblems } from './store';
import type { Fix, Problem } from './types';
import './problems.css';

/** Coloured dot for a severity; the text next to it carries the meaning. */
export function SeverityDot({ severity }: { severity: Problem['severity'] }) {
  return <i className={`pb-dot pb-${severity}`} aria-hidden="true" />;
}

const clipWords = (t: string, n = 4) => { const w = t.split(/\s+/); return w.length > n ? `${w.slice(0, n).join(' ')}…` : t; };

/** Fix buttons: hovering one previews it on the plan, clicking applies it. */
export function FixButtons({ problem, max = 3, compact = false }: { problem: Problem; max?: number; compact?: boolean }) {
  const setPreview = useProblems((s) => s.setPreview);
  const applyFix = useProblems((s) => s.applyFix);
  const finding = useProblems((s) => s.finding);
  const fixes = problem.fixes.slice(0, max);
  if (!fixes.length) return finding ? <span className="pb-finding" role="status" aria-label="Finding fixes" /> : null;
  const run = (f: Fix) => () => applyFix(problem, f);
  return (
    <div className={`pb-fixes${compact ? ' is-compact' : ''}`}>
      {fixes.map((f, i) => (
        <button key={f.id} type="button"
          className={`pb-fix${i === 0 && f.kind !== 'remove' ? ' is-primary' : ''}${f.kind === 'remove' ? ' is-remove' : ''}`}
          onPointerEnter={() => setPreview(f)} onPointerLeave={() => setPreview(null)}
          onFocus={() => setPreview(f)} onBlur={() => setPreview(null)}
          onClick={run(f)}
          title={f.label}>
          {clipWords(f.label)}
        </button>
      ))}
    </div>
  );
}

/** The hover card used to float over the plan. Problems and their fixes now live only in the checks list in the left panel. */
export function ProblemCard(_props: {
  problems: Problem[]; style?: React.CSSProperties; onEnter?: () => void; onLeave?: () => void; onClose?: () => void;
}) {
  return null;
}
