import { create } from 'zustand';
import type { FullReport, Stage } from './pipeline';

/** Decision trails for the current candidates, keyed by candidate id, plus the live run stages. */
export interface ReportState {
  reports: Record<string, FullReport>;
  stages: Stage[];
  running: boolean;
  setReports: (list: FullReport[]) => void;
  setStages: (stages: Stage[], running?: boolean) => void;
  clear: () => void;
}

export const useReports = create<ReportState>((set) => ({
  reports: {},
  stages: [],
  running: false,
  setReports: (list) => set({ reports: Object.fromEntries(list.map((r) => [r.candidateId, r])) }),
  setStages: (stages, running) => set((s) => ({ stages, running: running ?? s.running })),
  clear: () => set({ reports: {}, stages: [], running: false }),
}));

export const reportFor = (id: string | null | undefined) => (id ? useReports.getState().reports[id] : undefined);
