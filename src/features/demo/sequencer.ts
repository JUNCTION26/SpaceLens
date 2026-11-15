// A small step sequencer for the hands-free tour: runs steps in order, gives each one a
// time limit, skips a step that fails or times out, and stops cleanly when asked.

export interface SeqCtx {
  signal: AbortSignal;
  /** Resolves after ms, or rejects with 'stopped' if the tour is stopped. */
  wait: (ms: number) => Promise<void>;
}
export interface SeqStep {
  id: string;
  /** Planned length on the progress bar, in ms. The step is padded to this length. */
  ms: number;
  /** Hard limit for the work itself, in ms (default: the planned length plus 15 s). */
  timeoutMs?: number;
  run: (c: SeqCtx) => Promise<void>;
}
export type StepOutcome = 'done' | 'skipped' | 'stopped';
export interface SeqResult { id: string; outcome: StepOutcome }
export interface SeqHooks {
  onStep?: (index: number, step: SeqStep) => void;
  onEnd?: (results: SeqResult[]) => void;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((res, rej) => {
    if (signal.aborted) return rej(new Error('stopped'));
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); res(); }, ms);
    const onAbort = () => { clearTimeout(t); rej(new Error('stopped')); };
    signal.addEventListener('abort', onAbort, { once: true });
  });

/** Run the steps in order. Never throws; the result lists what happened to each step. */
export async function runSequence(steps: SeqStep[], signal: AbortSignal, hooks: SeqHooks = {}): Promise<SeqResult[]> {
  const results: SeqResult[] = [];
  const ctx: SeqCtx = { signal, wait: (ms) => sleep(ms, signal) };
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (signal.aborted) { results.push({ id: s.id, outcome: 'stopped' }); break; }
    hooks.onStep?.(i, s);
    const t0 = Date.now();
    let outcome: StepOutcome = 'done';
    const limit = s.timeoutMs ?? s.ms + 15000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        s.run(ctx),
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), limit); }),
        new Promise<never>((_, rej) => signal.addEventListener('abort', () => rej(new Error('stopped')), { once: true })),
      ]);
    } catch (e) {
      outcome = signal.aborted || (e as Error).message === 'stopped' ? 'stopped' : 'skipped';
    } finally { clearTimeout(timer); }
    if (outcome === 'stopped') { results.push({ id: s.id, outcome }); break; }
    // Pad a quick step to its planned length so the bar keeps its pace; a skipped one moves on at once.
    const rest = s.ms - (Date.now() - t0);
    if (outcome === 'done' && rest > 0) {
      try { await ctx.wait(rest); } catch { results.push({ id: s.id, outcome: 'stopped' }); break; }
    }
    results.push({ id: s.id, outcome });
  }
  hooks.onEnd?.(results);
  return results;
}
