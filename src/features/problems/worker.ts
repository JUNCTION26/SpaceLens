// Runs the checks and the fix search off the main thread so dragging and typing stay smooth.
import { runProblems, type RunInput } from './engine';

let latest = 0;
const scope = self as unknown as { onmessage: ((e: MessageEvent<RunInput>) => void) | null; postMessage: (m: unknown) => void };
scope.onmessage = (e) => {
  const input = e.data;
  latest = input.gen;
  runProblems(input, (m) => scope.postMessage(m), () => input.gen !== latest)
    .catch((err: unknown) => scope.postMessage({ type: 'done', gen: input.gen, error: String((err as Error)?.stack ?? err) }));
};
