// Lays out one room off the main thread, so furnishing a whole floor never stalls the page.
import { runSolveJob, type SolveJob } from './solveJob';

const scope = self as unknown as { onmessage: ((e: MessageEvent<SolveJob>) => void) | null; postMessage: (m: unknown) => void };
scope.onmessage = async (e) => {
  try { scope.postMessage({ id: e.data.id, furniture: await runSolveJob(e.data) }); }
  catch (err) { scope.postMessage({ id: e.data.id, error: (err as Error).message }); }
};
