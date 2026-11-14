// Run the floor-plan search in a Web Worker (falls back to the main thread after a paint when
// workers are unavailable), so typing and scrolling never freeze while options are searched.
import type { Vec2 } from '../../core/types';
import { planBuilding, type BuildingPlan, type PlanOptions, type ShellEntrance, type ShellWindow } from './partition';
import type { RoomProgramme } from './programme';
import type { PlanJob } from './plan.worker';

let worker: Worker | null = null;
let failed = false;
let next = 0;
const waiting = new Map<number, { resolve: (p: BuildingPlan[]) => void; reject: (e: Error) => void }>();

function getWorker(): Worker | null {
  if (worker || failed || typeof Worker === 'undefined') return worker;
  try {
    worker = new Worker(new URL('./plan.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number; plans?: BuildingPlan[]; error?: string }>) => {
      const w = waiting.get(e.data.id);
      if (!w) return;
      waiting.delete(e.data.id);
      if (e.data.error) w.reject(new Error(e.data.error)); else w.resolve(e.data.plans ?? []);
    };
    worker.onerror = () => {
      // a worker that cannot start: finish what is waiting on the main thread
      worker?.terminate(); worker = null; failed = true;
      for (const [, w] of waiting) w.reject(new Error('worker-failed'));
      waiting.clear();
    };
  } catch { worker = null; failed = true; }
  return worker;
}

const onMain = (shell: Vec2[], entrances: ShellEntrance[], windows: ShellWindow[], programme: RoomProgramme, opts: PlanOptions) =>
  new Promise<BuildingPlan[]>((resolve, reject) => setTimeout(() => {
    try { resolve(planBuilding(shell, entrances, windows, programme, opts)); } catch (e) { reject(e as Error); }
  }, 30));

export async function planBuildingAsync(shell: Vec2[], entrances: ShellEntrance[], windows: ShellWindow[], programme: RoomProgramme, opts: PlanOptions = {}): Promise<BuildingPlan[]> {
  const w = getWorker();
  if (!w) return onMain(shell, entrances, windows, programme, opts);
  const id = ++next;
  const job: PlanJob = { id, shell, entrances, windows, programme, opts };
  try {
    return await new Promise<BuildingPlan[]>((resolve, reject) => { waiting.set(id, { resolve, reject }); w.postMessage(job); });
  } catch (e) {
    if ((e as Error).message === 'worker-failed') return onMain(shell, entrances, windows, programme, opts);
    throw e;
  }
}
