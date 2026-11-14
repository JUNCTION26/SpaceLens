import { create } from 'zustand';
import type { SketchMark } from '../../core/types';

interface SketchState {
  marks: SketchMark[];
  /** When on, drags on the plan draw strokes instead of moving things. */
  drawing: boolean;
  add: (m: SketchMark) => void;
  remove: (id: string) => void;
  clear: (by?: SketchMark['by']) => void;
  setDrawing: (on: boolean) => void;
}

export const useSketch = create<SketchState>((set, get) => ({
  marks: [],
  drawing: false,
  add: (m) => set({ marks: [...get().marks.slice(-199), m] }),
  remove: (id) => set({ marks: get().marks.filter((m) => m.id !== id) }),
  clear: (by) => set({ marks: by ? get().marks.filter((m) => m.by !== by) : [] }),
  setDrawing: (drawing) => set({ drawing }),
}));
