import { describe, expect, it } from 'vitest';
import { runSequence, type SeqStep } from './sequencer';

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
