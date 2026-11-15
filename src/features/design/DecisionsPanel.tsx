import { useMemo } from 'react';
import { useStore } from '../../core/store';
import type { LayoutCandidate, SpaceModel } from '../../core/types';
import { Icon } from '../../ui/icons';
import { evaluateKnowledge, importance } from './knowledge';
import type { FullReport } from './pipeline';
import './design.css';



const TRAILING = /^(by|the|a|an|with|and|of|to|near|at|on|in|for|from|facing|along)$/i;
/** At most two words, never ending on a small joining word: rule and layout names are labels, not sentences. */
export function shortLabel(t: string): string {
  const w = t.replace(/[.:,(].*$/, '').trim().split(/\s+/).slice(0, 2);
  while (w.length > 1 && TRAILING.test(w[w.length - 1])) w.pop();
  return w.join(' ');
}

/** At most three words: relation chips are already that short; anything longer is cut, never wrapped. */
const chip3 = (t: string) => t.trim().split(/\s+/).slice(0, 3).join(' ');

interface Row { label: string; pass: boolean; item?: string; score: number; full: string }

/** Good and bad chips (1-3 words) from the measured relations: broken ones first, then what holds. */
export function chipRows(model: SpaceModel, furniture: LayoutCandidate['furniture']): Row[] {
  let verdicts: ReturnType<typeof evaluateKnowledge>['verdicts'];
  try { verdicts = evaluateKnowledge(model, furniture).verdicts; } catch { return []; }
  const seen = new Set<string>();
  const take = (v: (typeof verdicts)[number]): Row | null => {
    const label = chip3(v.chip);
    if (seen.has(label)) return null;
    seen.add(label);
    return { label, pass: v.pass, item: v.itemIds[0], score: v.score, full: v.chip };
  };
  const bad = verdicts.filter((v) => !v.pass).sort((a, b) => importance(b) - importance(a)).map(take).filter((r): r is Row => !!r).slice(0, 4);
  const good = verdicts.filter((v) => v.pass && v.score >= 0.95).sort((a, b) => Number(b.hard) - Number(a.hard) || b.weight - a.weight).map(take).filter((r): r is Row => !!r);
  return [...bad, ...good].slice(0, 6);
}

/** "Why": up to six ticks or crosses. Tapping one selects the piece it is about, so the room shows it. */
export function DecisionsPanel({ report, model: modelProp, candidate: candProp }: { model?: SpaceModel; candidate?: LayoutCandidate; report: FullReport }) {
  const storeModel = useStore((s) => s.model);
  const storeCand = useStore((s) => s.candidates.find((c) => c.id === report.candidateId));
  const model = modelProp ?? storeModel;
  const cand = candProp ?? storeCand;
  const rows = useMemo(() => {
    const chips = cand && model?.spaces.length ? chipRows(model, cand.furniture) : [];
    if (chips.length) return chips;
    // No layout to measure: the rule verdicts as two-word labels.
    const byName = new Map<string, Row>();
    for (const v of report.verdicts) {
      const label = shortLabel(v.name);
      const cur = byName.get(label);
      const failItem = !v.pass ? v.itemIds[0] : undefined;
      if (!cur) byName.set(label, { label, pass: v.pass, item: failItem ?? v.itemIds[0], score: v.score, full: v.name });
      else { cur.pass = cur.pass && v.pass; cur.score = Math.min(cur.score, v.score); if (failItem) cur.item = failItem; }
    }
    return [...byName.values()].sort((a, b) => Number(a.pass) - Number(b.pass) || a.score - b.score).slice(0, 5);
  }, [report, model, cand]);
  if (!rows.length) return null;
  return (
    <details className="dec" onClick={(e) => e.stopPropagation()}>
      <summary>Why</summary>
      <ul className="dec-ticks">
        {rows.map((r) => (
          <li key={r.label}>
            <button className={r.pass ? 'is-pass' : 'is-fail'} disabled={!r.item} title={r.full} aria-label={`${r.pass ? 'Holds' : 'Broken'}: ${r.full}`}
              onClick={() => r.item && useStore.getState().select({ kind: 'furniture', id: r.item })}>
              <Icon name={r.pass ? 'check' : 'x'} size={14} /><span>{r.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}
