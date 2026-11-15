// A small step sequencer for the hands-free film: runs steps in order, gives each one a
// time limit, skips a step that fails or times out, cross-fades between scenes, can loop
// for a stand, and stops cleanly when asked.

export interface SeqCtx {
  signal: AbortSignal;
  /** Resolves after ms, or rejects with 'stopped' if the run is stopped. */
  wait: (ms: number) => Promise<void>;
}
export interface SeqStep {
  id: string;
  /** Planned length on the progress bar, in ms. The step is padded to this length. */
  ms: number;
  /** Hard limit for the work itself, in ms (default: the planned length plus 15 s). */
  timeoutMs?: number;
  /** Open with a cut: fade to black, run `setup` under the black, fade back in. */
  cut?: boolean;
  /** Scene change done while the screen is black (only with `cut`). A failure skips the step. */
  setup?: (c: SeqCtx) => Promise<void> | void;
  run: (c: SeqCtx) => Promise<void>;
}
export type StepOutcome = 'done' | 'skipped' | 'stopped';
export interface SeqResult { id: string; outcome: StepOutcome }
export interface SeqHooks {
  onStep?: (index: number, step: SeqStep) => void;
  onEnd?: (results: SeqResult[]) => void;
  /** Show (true) or clear (false) the black cut overlay. */
  fade?: (black: boolean) => void;
  /** Length of each half of a cut, in ms (default 250). */
  fadeMs?: number;
}

export const FADE_MS = 250;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((res, rej) => {
    if (signal.aborted) return rej(new Error('stopped'));
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); res(); }, ms);
    const onAbort = () => { clearTimeout(t); rej(new Error('stopped')); };
    signal.addEventListener('abort', onAbort, { once: true });
  });

/** Fade to black, swap the scene underneath, fade back. The screen always comes back, even if the swap fails. */
export async function crossFade(fade: (black: boolean) => void, swap: () => Promise<void> | void, wait: (ms: number) => Promise<void>, ms = FADE_MS): Promise<void> {
  fade(true);
  try {
    await wait(ms);
    await swap();
  } finally { fade(false); }
  await wait(ms);
}

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
    const work = async () => {
      if (s.cut && hooks.fade) await crossFade(hooks.fade, () => s.setup?.(ctx), ctx.wait, hooks.fadeMs ?? FADE_MS);
      else await s.setup?.(ctx);
      await s.run(ctx);
    };
    try {
      await Promise.race([
        work(),
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

export interface LoopOpts {
  /** Keep playing until stopped. False plays once. */
  loop: boolean;
  /** Called before each round with its number (0 first). */
  onRound?: (round: number) => void;
  /** Puts the app back to a clean state between rounds. A failure here does not end the loop. */
  reset?: () => Promise<void> | void;
  /** Pause between rounds, in ms (default 1500). Keeps a round of skipped steps from spinning. */
  gapMs?: number;
  hooks?: SeqHooks;
}

/** Play the steps once, or round after round until the signal stops it. Returns how many rounds started. */
export async function runLoop(make: () => SeqStep[], signal: AbortSignal, opts: LoopOpts): Promise<number> {
  let round = 0;
  while (!signal.aborted) {
    if (round > 0) {
      try { await opts.reset?.(); } catch { /* the next round sets its own scenes */ }
      try { await sleep(opts.gapMs ?? 1500, signal); } catch { break; }
    }
    opts.onRound?.(round);
    round++;
    const res = await runSequence(make(), signal, opts.hooks);
    if (!opts.loop || res.some((r) => r.outcome === 'stopped')) break;
  }
  return round;
}
