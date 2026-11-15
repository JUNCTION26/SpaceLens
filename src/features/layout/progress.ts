import { rankByTaste } from '../taste/apply';
import { activeProfile } from '../taste/state';
import { useStore } from '../../core/store';
import { useReports } from '../design/reportStore';
import type { DesignResult } from '../design/pipeline';
import type { LayoutCandidate } from '../../core/types';
import { fmtSek } from '../../core/geometry';

/** Puts a phase of layouts on screen at once, keeping the previewed card if it is still there. */
export function showLayouts(res: Pick<DesignResult, 'candidates' | 'reports' | 'infeasibility'>) {
  const st = useStore.getState();
  const keep = st.activeCandidateId;
  useReports.getState().setReports(res.reports);
  const taste = activeProfile();
  st.setCandidates(taste ? rankByTaste(res.candidates, taste, st.model) : res.candidates, res.infeasibility ?? null);
  if (keep && res.candidates.some((c) => c.id === keep)) st.previewCandidate(keep);
}

// ---------- pure decisions: what is final, which layout furnishes the room, what it is called ----------

type Cand = Pick<LayoutCandidate, 'id' | 'furniture' | 'metrics'> & { generator?: string; partial?: boolean };

/** A draft or a layout flagged `partial` is only previewed while the run goes on; it is never presented as the result. */
export const isPartial = (c: Cand): boolean => c.id === 'draft' || c.partial === true || /draft/i.test(c.generator ?? '');

/** A run is final once it has layouts and none of them (nor the result itself) is partial. */
export const isFinalResult = (res: { candidates: Cand[]; partial?: boolean }): boolean =>
  res.partial !== true && res.candidates.length > 0 && res.candidates.every((c) => !isPartial(c));

const sameRoom = (a: Array<{ id: string; x: number; y: number; rotation: number }>, b: Array<{ id: string; x: number; y: number; rotation: number }>) =>
  a.length === b.length && a.every((f) => { const g = b.find((x) => x.id === f.id); return !!g && Math.abs(g.x - f.x) < 1e-3 && Math.abs(g.y - f.y) < 1e-3 && Math.abs(g.rotation - f.rotation) < 1e-3; });

/**
 * The layout that furnishes the room: the best final one by score (the report's final score when there is one),
 * fewest failed checks as the tie-break, earlier in the list after that. `avoid` is the room as it stands:
 * a layout identical to it is skipped when another exists ("another layout"). Null when nothing is final.
 */
export function pickAuto<C extends Cand & { checks?: Array<{ result: string }> }>(
  candidates: C[], reports: Array<{ candidateId: string; finalScore?: number }> = [], avoid?: Array<{ id: string; x: number; y: number; rotation: number }>,
): C | null {
  const ok = candidates.filter((c) => !isPartial(c) && c.furniture.length > 0);
  if (!ok.length) return null;
  const fresh = avoid?.length ? ok.filter((c) => !sameRoom(c.furniture, avoid)) : ok;
  const pool = fresh.length ? fresh : ok;
  const score = (c: C) => reports.find((r) => r.candidateId === c.id)?.finalScore ?? c.metrics.score;
  const fails = (c: C) => (c.checks ?? []).filter((k) => k.result === 'fail').length;
  return pool.reduce((best, c) => (score(c) > score(best) || (score(c) === score(best) && fails(c) < fails(best)) ? c : best));
}

const GENERIC_NAME = /^(layout|plan|draft|candidate|assembling)\b/i;
/** A name the design brought itself ("Gerard's room"), as opposed to an id or a placeholder. */
export const realName = (name: string | undefined, id?: string): string | null => {
  const n = (name ?? '').trim();
  return n.length > 2 && n !== id && /\p{L}/u.test(n) && !GENERIC_NAME.test(n) ? n : null;
};

/** Title shown on a card: a themed design's own name, else the idea name from caseFor; never a bare placeholder. */
export function titleFor(c: { id: string; name?: string; generator?: string }, ideaTitle: string): string {
  if (c.generator === 'theme') return realName(c.name, c.id) ?? ideaTitle;
  return ideaTitle;
}

/** Price text, or null when the cost is unknown (zero or missing). */
export const priceLabel = (costSek: number | undefined): string | null => (costSek && costSek > 0 ? fmtSek(costSek) : null);

/** The ring only appears when checks actually ran. */
export const checksRan = (total: number): boolean => total > 0;

/** One or two words for why nothing is shown. */
export function failReason(o: { offline?: boolean; infeasible?: boolean; error?: unknown }): 'Offline' | 'Busy' | 'No fit' {
  if (o.infeasible) return 'No fit';
  if (o.offline) return 'Offline';
  return 'Busy';
}

/** Follow-ups that act on the whole design rather than edit a piece. */
export function wholeRoomAsk(text: string): 'again' | 'reset' | null {
  const t = text.toLowerCase().replace(/[.!?]+$/g, '').replace(/\s+/g, ' ').trim().replace(/^(please |can you |could you |let's |lets )/, '');
  if (/^(start over|start again|clear( the)?( room| it| everything)?|empty( the)? room|reset|begin again|remove everything)$/.test(t)) return 'reset';
  if (/^(another|a different|different|new|next|one more)( layout| one| option| arrangement| version)?$|^(try|show) (another|a different)( layout| one| option)?$|^(re-?run|again|shuffle|redo)( it| the layout)?$/.test(t)) return 'again';
  return null;
}
