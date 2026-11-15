import { rankByTaste } from '../taste/apply';
import { activeProfile } from '../taste/state';
import { useStore } from '../../core/store';
import { useReports } from '../design/reportStore';
import type { DesignResult } from '../design/pipeline';

/** Puts a phase of layouts on screen at once, keeping the previewed card if it is still there. */
export function showLayouts(res: Pick<DesignResult, 'candidates' | 'reports' | 'infeasibility'>) {
  const st = useStore.getState();
  const keep = st.activeCandidateId;
  useReports.getState().setReports(res.reports);
  const taste = activeProfile();
  st.setCandidates(taste ? rankByTaste(res.candidates, taste, st.model) : res.candidates, res.infeasibility ?? null);
  if (keep && res.candidates.some((c) => c.id === keep)) st.previewCandidate(keep);
}
