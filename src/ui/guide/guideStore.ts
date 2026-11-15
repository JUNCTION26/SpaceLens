import { create } from 'zustand';
import { moveStep } from './steps';

interface GuideState {
  on: boolean;
  step: number;
  /** Drags and scrolls on the views, counted for the orbit step. */
  viewPokes: number;
  /** Walks that started and then stopped. */
  walkStops: number;
  start: (step?: number) => void;
  stop: () => void;
  move: (dir: number) => void;
  poke: () => void;
  walkStopped: () => void;
}

export const useGuide = create<GuideState>((set, get) => ({
  on: false, step: 0, viewPokes: 0, walkStops: 0,
  start: (step = 0) => set({ on: true, step }),
  stop: () => set({ on: false }),
  move: (dir) => set({ step: moveStep(get().step, dir) }),
  poke: () => set({ viewPokes: get().viewPokes + 1 }),
  walkStopped: () => set({ walkStops: get().walkStops + 1 }),
}));
