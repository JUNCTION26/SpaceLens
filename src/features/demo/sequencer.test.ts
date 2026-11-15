import { describe, expect, it } from 'vitest';
import { crossFade, runLoop, runSequence, type SeqStep } from './sequencer';

const mk = (id: string, log: string[], run?: SeqStep['run'], extra: Partial<SeqStep> = {}): SeqStep =>
  ({ id, ms: 0, run: run ?? (async () => { log.push(id); }), ...extra });

describe('runSequence', () => {
  it('runs steps in order', async () => {
    const log: string[] = [];
    const r = await runSequence([mk('a', log), mk('b', log), mk('c', log)], new AbortController().signal);
    expect(log).toEqual(['a', 'b', 'c']);
    expect(r.map((x) => x.outcome)).toEqual(['done', 'done', 'done']);
  });
  it('skips a step that throws and carries on', async () => {
    const log: string[] = [];
    const r = await runSequence([mk('a', log), mk('b', log, async () => { throw new Error('x'); }), mk('c', log)], new AbortController().signal);
    expect(log).toEqual(['a', 'c']);
    expect(r.map((x) => x.outcome)).toEqual(['done', 'skipped', 'done']);
  });
  it('skips a step that hangs past its timeout', async () => {
    const log: string[] = [];
    const r = await runSequence([mk('a', log, () => new Promise<void>(() => {}), { timeoutMs: 20 }), mk('b', log)], new AbortController().signal);
    expect(r.map((x) => x.outcome)).toEqual(['skipped', 'done']);
    expect(log).toEqual(['b']);
  });
  it('stops when aborted mid-step and runs nothing after', async () => {
    const log: string[] = [];
    const ac = new AbortController();
    const p = runSequence([mk('a', log, (c) => c.wait(5000)), mk('b', log)], ac.signal);
    setTimeout(() => ac.abort(), 20);
    const r = await p;
    expect(r).toEqual([{ id: 'a', outcome: 'stopped' }]);
    expect(log).toEqual([]);
  });
  it('does not start when already aborted, and reports each step start', async () => {
    const ac = new AbortController(); ac.abort();
    const seen: number[] = [];
    const r = await runSequence([mk('a', [])], ac.signal, { onStep: (i) => seen.push(i) });
    expect(r[0].outcome).toBe('stopped');
    expect(seen).toEqual([]);
  });
});

describe('cuts', () => {
  it('fades to black, runs setup under the black, then fades back before the step plays', async () => {
    const log: string[] = [];
    const t0 = Date.now();
    let blackAt = 0, clearAt = 0;
    const fade = (b: boolean) => { log.push(b ? 'black' : 'clear'); if (b) blackAt = Date.now() - t0; else clearAt = Date.now() - t0; };
    const step = mk('a', log, async () => { log.push('run'); }, { cut: true, setup: () => { log.push('setup'); } });
    await runSequence([step], new AbortController().signal, { fade, fadeMs: 30 });
    expect(log).toEqual(['black', 'setup', 'clear', 'run']);
    expect(clearAt - blackAt).toBeGreaterThanOrEqual(25);
  });
  it('a failing setup skips the step but still clears the screen', async () => {
    const log: string[] = [];
    const fade = (b: boolean) => log.push(b ? 'black' : 'clear');
    const bad = mk('a', log, async () => { log.push('run'); }, { cut: true, setup: () => { throw new Error('x'); } });
    const r = await runSequence([bad, mk('b', log)], new AbortController().signal, { fade, fadeMs: 5 });
    expect(r.map((x) => x.outcome)).toEqual(['skipped', 'done']);
    expect(log).toEqual(['black', 'clear', 'b']);
  });
  it('crossFade clears the screen when the swap throws', async () => {
    const seen: boolean[] = [];
    await expect(crossFade((b) => seen.push(b), () => { throw new Error('x'); }, async () => {}, 0)).rejects.toThrow('x');
    expect(seen).toEqual([true, false]);
  });
});

describe('runLoop', () => {
  it('plays once when not looping', async () => {
    const log: string[] = [];
    const n = await runLoop(() => [mk('a', log)], new AbortController().signal, { loop: false });
    expect(n).toBe(1);
    expect(log).toEqual(['a']);
  });
  it('loops with a reset between rounds until stopped', async () => {
    const log: string[] = [];
    const ac = new AbortController();
    const rounds: number[] = [];
    const n = await runLoop(() => [mk('a', log, async () => { log.push('a'); if (log.filter((x) => x === 'a').length === 3) ac.abort(); })], ac.signal, {
      loop: true, gapMs: 1, onRound: (r) => rounds.push(r), reset: () => { log.push('reset'); },
    });
    expect(n).toBe(3);
    expect(rounds).toEqual([0, 1, 2]);
    expect(log).toEqual(['a', 'reset', 'a', 'reset', 'a']);
  });
  it('keeps looping when a reset fails and when every step is skipped', async () => {
    const ac = new AbortController();
    let rounds = 0;
    await runLoop(() => [mk('a', [], async () => { throw new Error('x'); })], ac.signal, {
      loop: true, gapMs: 1, onRound: () => { if (++rounds === 3) setTimeout(() => ac.abort(), 0); }, reset: () => { throw new Error('r'); },
    });
    expect(rounds).toBeGreaterThanOrEqual(3);
  });
});
