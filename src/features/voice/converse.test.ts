import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Conversation, SILENCE_MS, TAIL_MS, type ConvDeps } from './converse';
import { sketchFor, sketchForAll, type SketchWorld } from './sketchFor';
import { isEcho } from '../agent/speech';

function setup(turn: () => Promise<void> = () => Promise.resolve()) {
  const log: string[] = [];
  const deps: ConvDeps = {
    ear: { start: () => log.push('ear:start'), stop: () => log.push('ear:stop'), abort: () => log.push('ear:abort') },
    runTurn: vi.fn((t: string) => { log.push(`turn:${t}`); return turn(); }),
    stopSpeaking: vi.fn(() => log.push('hush')),
    isEcho,
    beforeTurn: () => log.push('clear'),
    now: () => Date.now(),
  };
  return { c: new Conversation(deps), deps, log };
}

describe('conversation turns', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10_000); });
  afterEach(() => vi.useRealTimers());

  it('listens after start and ends the utterance after the silence window', async () => {
    const { c, deps } = setup();
    c.start();
    expect(c.state).toBe('listening');
    c.hearInterim('move the sofa');
    vi.advanceTimersByTime(SILENCE_MS - 10);
    expect(deps.runTurn).not.toHaveBeenCalled();
    c.hearInterim('move the sofa to the window');
    vi.advanceTimersByTime(SILENCE_MS - 10);
    expect(deps.runTurn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20);
    expect(deps.runTurn).toHaveBeenCalledWith('move the sofa to the window');
    expect(c.state).toBe('thinking');
    await vi.advanceTimersByTimeAsync(0);
    expect(c.state).toBe('listening');
  });

  it('joins finals heard in one burst and clears sketches before the turn', () => {
    const { c, log } = setup();
    c.start();
    c.hearFinal('put a desk');
    vi.advanceTimersByTime(500);
    c.hearFinal('by the window');
    vi.advanceTimersByTime(SILENCE_MS);
    expect(log.slice(-2)).toEqual(['clear', 'turn:put a desk by the window']);
  });

  it('thinking then speaking then listening again', async () => {
    let done!: () => void;
    const { c } = setup(() => new Promise<void>((r) => { done = r; }));
    c.start();
    c.hearFinal('hello there');
    vi.advanceTimersByTime(SILENCE_MS);
    expect(c.state).toBe('thinking');
    c.setSpeaking(true, 'Hi, what shall we change');
    expect(c.state).toBe('speaking');
    done(); await vi.advanceTimersByTimeAsync(0);
    expect(c.state).toBe('speaking');
    c.setSpeaking(false);
    expect(c.state).toBe('listening');
  });

  it('barge-in stops the voice at once and the new words run as the next turn', () => {
    const { c, deps } = setup();
    c.start();
    c.setSpeaking(true, 'The sofa fits against the north wall with room to walk');
    c.hearInterim('no put it by the door');
    expect(deps.stopSpeaking).toHaveBeenCalledTimes(1);
    c.setSpeaking(false);
    vi.advanceTimersByTime(SILENCE_MS);
    expect(deps.runTurn).toHaveBeenCalledWith('no put it by the door');
  });

  it('ignores its own voice while speaking and just after', () => {
    const { c, deps } = setup();
    c.start();
    c.setSpeaking(true, 'The sofa fits against the north wall');
    c.hearInterim('the sofa fits against the north');
    c.hearFinal('the sofa fits against the north wall');
    expect(deps.stopSpeaking).not.toHaveBeenCalled();
    c.setSpeaking(false);
    vi.advanceTimersByTime(TAIL_MS - 100);
    c.hearFinal('fits against the north wall');
    vi.advanceTimersByTime(SILENCE_MS * 2);
    expect(deps.runTurn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    c.hearFinal('fits against the north wall');
    vi.advanceTimersByTime(SILENCE_MS);
    expect(deps.runTurn).toHaveBeenCalledTimes(1);
  });

  it('end stops everything and drops a half heard sentence', () => {
    const { c, deps, log } = setup();
    c.start();
    c.hearInterim('add a lamp');
    c.end();
    expect(c.state).toBe('off');
    expect(log).toContain('ear:abort');
    expect(deps.stopSpeaking).toHaveBeenCalled();
    vi.advanceTimersByTime(SILENCE_MS * 2);
    expect(deps.runTurn).not.toHaveBeenCalled();
    c.hearFinal('hello');
    expect(c.state).toBe('off');
  });

  it('pauses listening while the tab is hidden and resumes after', () => {
    const { c, log, deps } = setup();
    c.start();
    c.hearInterim('add a');
    c.setPaused(true);
    c.hearFinal('lamp');
    vi.advanceTimersByTime(SILENCE_MS * 2);
    expect(deps.runTurn).not.toHaveBeenCalled();
    expect(log.filter((l) => l === 'ear:abort')).toHaveLength(1);
    c.setPaused(false);
    expect(log.filter((l) => l === 'ear:start')).toHaveLength(2);
    expect(c.state).toBe('listening');
  });
});

describe('sketchFor', () => {
  const sofa = { x: 1, y: 2, w: 2, d: 1, rotation: 0, name: 'Sofa' };
  const world: SketchWorld = {
    item: (r) => (r === 'i1' ? sofa : undefined),
    place: (s) => (s === 'window' ? { x: 4, y: 0 } : undefined),
  };
  const opts = { turnId: 't1', now: 5 };

  it('move: circle the item, arrow old to new, dashed outline at the new spot, drawn in order', () => {
    const ms = sketchFor({ type: 'move', id: 'i1', place: 'window' }, world, opts);
    expect(ms.map((m) => m.kind)).toEqual(['circle', 'arrow', 'ghost']);
    expect(ms[1].points).toEqual([{ x: 1, y: 2 }, { x: 4, y: 0 }]);
    expect(ms[2].points[0]).toEqual({ x: 4, y: 0 });
    expect(ms.map((m) => m.delayMs)).toEqual([0, 320, 640]);
    expect(ms.every((m) => m.by === 'agent' && m.turnId === 't1')).toBe(true);
  });

  it('rotate previews the turned footprint; remove only circles', () => {
    const r = sketchFor({ type: 'rotate', id: 'i1', angle: 90 }, world, opts);
    expect(r.map((m) => m.kind)).toEqual(['circle', 'ghost']);
    expect(r[1].rotation).toBeCloseTo(Math.PI / 2);
    expect(sketchFor({ type: 'remove', id: 'i1' }, world, opts).map((m) => m.kind)).toEqual(['circle']);
  });

  it('unknown items or places give nothing, and ids stay unique across actions', () => {
    expect(sketchFor({ type: 'move', id: 'zz', place: 'window' }, world, opts)).toEqual([]);
    expect(sketchFor({ type: 'undo' }, world, opts)).toEqual([]);
    const all = sketchForAll([{ type: 'remove', id: 'i1' }, { type: 'explain', id: 'i1' }], world, opts);
    expect(new Set(all.map((m) => m.id)).size).toBe(2);
    expect(all[1].delayMs).toBe(320);
  });
});
