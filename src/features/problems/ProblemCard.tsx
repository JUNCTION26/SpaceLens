import { useProblems } from './store';
import type { Fix, Problem } from './types';
import './problems.css';

/** Coloured dot for a severity; the text next to it carries the meaning. */
export function SeverityDot({ severity }: { severity: Problem['severity'] }) {
  return <i className={`pb-dot pb-${severity}`} aria-hidden="true" />;
}

/** Fix buttons: hovering one previews it on the plan, clicking applies it. */
export function FixButtons({ problem, max = 3, compact = false }: { problem: Problem; max?: number; compact?: boolean }) {
  const setPreview = useProblems((s) => s.setPreview);
  const applyFix = useProblems((s) => s.applyFix);
  const finding = useProblems((s) => s.finding);
  const fixes = problem.fixes.slice(0, max);
  if (!fixes.length) return finding ? <span className="pb-finding" aria-live="polite">Finding fixes</span> : null;
  const run = (f: Fix) => () => applyFix(problem, f);
  return (
    <div className={`pb-fixes${compact ? ' is-compact' : ''}`}>
      {fixes.map((f, i) => (
        <button key={f.id} type="button"
          className={`pb-fix${i === 0 && f.kind !== 'remove' ? ' is-primary' : ''}${f.kind === 'remove' ? ' is-remove' : ''}`}
          onPointerEnter={() => setPreview(f)} onPointerLeave={() => setPreview(null)}
          onFocus={() => setPreview(f)} onBlur={() => setPreview(null)}
          onClick={run(f)}
          title={f.kind === 'go' ? undefined : f.safe ? 'Checked: clears this without causing a new problem' : f.kind === 'remove' ? 'Takes it out of the plan. You can undo.' : undefined}>
          {f.label}
        </button>
      ))}
    </div>
  );
}

/** Compact card: what is wrong in one sentence, then one to three fixes. */
export function ProblemCard({ problems, style, onEnter, onLeave, onClose }: {
  problems: Problem[]; style?: React.CSSProperties; onEnter?: () => void; onLeave?: () => void; onClose?: () => void;
}) {
  const shown = problems.slice(0, 2);
  const more = problems.length - shown.length;
  return (
    <div className="pb-card" role="dialog" aria-label="Problem and fixes" style={style}
      onPointerEnter={onEnter} onPointerLeave={onLeave} onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose?.(); }}>
      {shown.map((p) => (
        <div key={p.id} className="pb-card-row">
          <p className="pb-card-title"><SeverityDot severity={p.severity} />{p.title}</p>
          <FixButtons problem={p} />
        </div>
      ))}
      {more > 0 && <button type="button" className="pb-more" onClick={() => window.dispatchEvent(new Event('spacelens:checks'))}>{more} more in Checks</button>}
    </div>
  );
}
