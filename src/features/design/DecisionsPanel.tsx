import { useMemo } from 'react';
import { useStore } from '../../core/store';
import type { LayoutCandidate, RuleVerdict, SpaceModel } from '../../core/types';
import { Icon } from '../../ui/icons';
import type { FullReport } from './pipeline';
import './design.css';



/** What would usually fix a weak rule, by its name. */
export function fixHint(v: RuleVerdict): string {
  const n = `${v.ruleId} ${v.name}`.toLowerCase();
  if (/walk|route|path|aisle|circulation/.test(n)) return 'Clear the route or drop an optional item.';
  if (/door|swing|entr/.test(n)) return 'Clear the door swing.';
  if (/window|daylight|light/.test(n)) return 'Move tall pieces off the window wall.';
  if (/clearance|access|pull|front|use/.test(n)) return 'More free floor in front.';
  if (/wall|back/.test(n)) return 'Back it onto a wall.';
  if (/pair|group|seat|chair|night/.test(n)) return 'Keep it beside its pair.';
  if (/budget|cost|price/.test(n)) return 'Swap for cheaper or drop an optional item.';
  if (/face|view|screen|orient/.test(n)) return 'Turn it to face its target.';
  return v.severity === 'hard' ? 'Must be fixed.' : '';
}

const TRAILING = /^(by|the|a|an|with|and|of|to|near|at|on|in|for|from|facing|along)$/i;
/** At most four words, never ending on a small joining word: rule and layout names are labels, not sentences. */
export function shortLabel(t: string): string {
  const w = t.replace(/[.:,(].*$/, '').trim().split(/\s+/).slice(0, 4);
  while (w.length > 1 && TRAILING.test(w[w.length - 1])) w.pop();
  return w.join(' ');
}

/** "Why": up to five ticks or crosses. Tapping one selects the piece it is about, so the room shows it. */
export function DecisionsPanel({ report }: { model?: SpaceModel; candidate?: LayoutCandidate; report: FullReport }) {
  const rows = useMemo(() => {
    const byName = new Map<string, { label: string; pass: boolean; item?: string; score: number }>();
    for (const v of report.verdicts) {
      const label = shortLabel(v.name);
      const cur = byName.get(label);
      const failItem = !v.pass ? v.itemIds[0] : undefined;
      if (!cur) byName.set(label, { label, pass: v.pass, item: failItem ?? v.itemIds[0], score: v.score });
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
            <button className={r.pass ? 'is-pass' : 'is-fail'} disabled={!r.item}
              onClick={() => r.item && useStore.getState().select({ kind: 'furniture', id: r.item })}>
              <Icon name={r.pass ? 'check' : 'x'} size={14} /><span>{r.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}
