import { useMemo } from 'react';
import { useStore } from '../../core/store';
import type { LayoutCandidate, SpaceModel } from '../../core/types';
import { Icon } from '../../ui/icons';
import type { FullReport } from './pipeline';
import './design.css';



const TRAILING = /^(by|the|a|an|with|and|of|to|near|at|on|in|for|from|facing|along)$/i;
/** At most two words, never ending on a small joining word: rule and layout names are labels, not sentences. */
export function shortLabel(t: string): string {
  const w = t.replace(/[.:,(].*$/, '').trim().split(/\s+/).slice(0, 2);
  while (w.length > 1 && TRAILING.test(w[w.length - 1])) w.pop();
  return w.join(' ');
}

/** "Why": up to five ticks or crosses. Tapping one selects the piece it is about, so the room shows it. */
export function DecisionsPanel({ report }: { model?: SpaceModel; candidate?: LayoutCandidate; report: FullReport }) {
  const rows = useMemo(() => {
    const byName = new Map<string, { label: string; pass: boolean; item?: string; score: number; full: string }>();
    for (const v of report.verdicts) {
      const label = shortLabel(v.name);
      const cur = byName.get(label);
      const failItem = !v.pass ? v.itemIds[0] : undefined;
      if (!cur) byName.set(label, { label, pass: v.pass, item: failItem ?? v.itemIds[0], score: v.score, full: v.name });
      else { cur.pass = cur.pass && v.pass; cur.score = Math.min(cur.score, v.score); if (failItem) cur.item = failItem; }
    }
    // Problems first, then the strongest passes.
    return [...byName.values()].sort((a, b) => Number(a.pass) - Number(b.pass) || a.score - b.score).slice(0, 5);
  }, [report]);
  if (!rows.length) return null;
  return (
    <details className="dec" onClick={(e) => e.stopPropagation()}>
      <summary>Why</summary>
      <ul className="dec-ticks">
        {rows.map((r) => (
          <li key={r.label}>
            <button className={r.pass ? 'is-pass' : 'is-fail'} disabled={!r.item} title={r.full}
              onClick={() => r.item && useStore.getState().select({ kind: 'furniture', id: r.item })}>
              <Icon name={r.pass ? 'check' : 'x'} size={14} /><span>{r.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}
