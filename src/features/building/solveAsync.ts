// Run room layouts in a Web Worker (one shared worker, jobs queued). Falls back to the main thread
// where workers are missing, such as in tests.
import type { FurnitureItem } from '../../core/types';
import { runSolveJob, type SolveJob } from './solveJob';

type Job = Omit<Extract<SolveJob, { kind: 'layout' }>, 'id'> | Omit<Extract<SolveJob, { kind: 'program' }>, 'id'>;

let worker: Worker | null = null;
let failed = false;
let next = 0;
const waiting = new Map<number, { job: SolveJob; resolve: (f: FurnitureItem[] | null) => void; reject: (e: Error) => void }>();

function getWorker(): Worker | null {
  if (worker || failed || typeof Worker === 'undefined' || typeof window === 'undefined') return worker;
  try {
    worker = new Worker(new URL('./furnish.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number; furniture?: FurnitureItem[] | null; error?: string }>) => {
      const w = waiting.get(e.data.id);
      if (!w) return;
      waiting.delete(e.data.id);
      if (e.data.error) w.reject(new Error(e.data.error)); else w.resolve(e.data.furniture ?? null);
    };
    worker.onerror = () => {
      // the worker could not start: finish the queued rooms here instead
      worker?.terminate(); worker = null; failed = true;
      const pending = [...waiting.values()];
      waiting.clear();
      for (const w of pending) runSolveJob(w.job).then(w.resolve, w.reject);
    };
  } catch { worker = null; failed = true; }
  return worker;
}

export function solveRoomAsync(job: Job): Promise<FurnitureItem[] | null> {
  const full = { ...job, id: ++next } as SolveJob;
  const w = getWorker();
  if (!w) return runSolveJob(full);
  return new Promise((resolve, reject) => { waiting.set(full.id, { job: full, resolve, reject }); w.postMessage(full); });
}
