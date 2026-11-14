import { create } from 'zustand';
import type { SketchMark } from '../../core/types';

/**
 * A mark plus how it should appear. Renderers that know nothing about animation can treat it as a
 * plain SketchMark; SketchLayer draws strokes on over `drawMs`, starting `delayMs` after createdAt.
 */
export type AgentMark = SketchMark & {
  /** Draw-on duration in ms (0 = appear at once). */
  drawMs?: number;
  /** Wait before drawing starts, ms after createdAt. */
  delayMs?: number;
  /** Turn that produced the mark; a newer turn supersedes it. */
  turnId?: string;
};

interface SketchState {
  marks: AgentMark[];
  /** When on, drags on the plan draw strokes instead of moving things. */
  drawing: boolean;
  add: (m: AgentMark) => void;
  remove: (id: string) => void;
  clear: (by?: SketchMark['by']) => void;
  setDrawing: (on: boolean) => void;
  /** Add several marks at once. */
  addMany: (ms: AgentMark[]) => void;
  /** Drop agent marks from earlier turns; the person's marks stay. */
  supersede: (turnId: string) => void;
}

export const useSketch = create<SketchState>((set, get) => ({
  marks: [],
  drawing: false,
  add: (m) => set({ marks: [...get().marks.slice(-199), m] }),
  remove: (id) => set({ marks: get().marks.filter((m) => m.id !== id) }),
  clear: (by) => set({ marks: by ? get().marks.filter((m) => m.by !== by) : [] }),
  setDrawing: (drawing) => set({ drawing }),
  addMany: (ms) => set({ marks: [...get().marks, ...ms].slice(-200) }),
  supersede: (turnId) => set({ marks: get().marks.filter((m) => m.by !== 'agent' || m.turnId === turnId) }),
}));

/** The newest mark drawn by `by`, or undefined. */
export const latestMark = (marks: SketchMark[], by: SketchMark['by'] = 'you'): SketchMark | undefined => {
  for (let i = marks.length - 1; i >= 0; i--) if (marks[i].by === by) return marks[i];
  return undefined;
};

/** 0..1 draw-on progress of a mark at time `now` (1 when it has no animation). */
export function drawProgress(m: AgentMark, now = Date.now()): number {
  const dur = m.drawMs ?? 0;
  const t = now - m.createdAt - (m.delayMs ?? 0);
  if (dur <= 0) return t >= 0 ? 1 : 0;
  return Math.max(0, Math.min(1, t / dur));
}
