import { AiError } from './engine';
import { setQueueState } from './telemetry';
import type { Transport } from './transport';

/**
 * Pacing for calls that go through the SpaceLens server. The server limits each address with a
 * token bucket, and one themed room asks for a brief, a dozen object specs and a critic pass at
 * almost the same moment. Sent all at once they would trip that limit; here they wait their turn:
 * a few in flight, starts paced under the server's rate, the part the person is looking at first.
 */

/** 'high': what the person is waiting to read (a brief). 'normal': object specs. 'low': critic passes, probes. */
export type AiPriority = 'high' | 'normal' | 'low';
const RANK: Record<AiPriority, number> = { high: 0, normal: 1, low: 2 };

export interface SchedulerConfig {
  /** Calls running at once. */
  maxInFlight: number;
  /** Starts allowed back to back before pacing kicks in. */
  burst: number;
  /** Sustained starts per second. */
  perSecond: number;
}

/**
 * Below the server defaults (burst 90, 240 a minute = 4 a second) with room for a second tab
 * or a retry from the same address.
 */
export const SERVER_SCHEDULE: SchedulerConfig = { maxInFlight: 6, burst: 30, perSecond: 3 };

/** Retries of one call after the server's own rate limit, each after its Retry-After. */
export const RATE_LIMIT_RETRIES = 2;
/** Wait used when a rate-limit answer names none. */
export const DEFAULT_RETRY_AFTER_S = 2;

export interface QueueStats {
  inFlight: number;
  queued: number;
  /** Rough seconds until the last queued call can start. */
  waitS: number;
}

interface Entry { order: number; rank: number; resolve: (release: () => void) => void; reject: (e: unknown) => void; signal?: AbortSignal; onAbort?: () => void }

export class RequestScheduler {
  private queue: Entry[] = [];
  private running = 0;
  private tokens: number;
  private at: number;
  private pausedUntil = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private seq = 0;
  /** Running average of how long a call holds its slot; starts at a typical object spec. */
  private avgHoldMs = 3000;
  private listeners = new Set<(s: QueueStats) => void>();

  constructor(readonly config: SchedulerConfig = SERVER_SCHEDULE, private now: () => number = () => Date.now()) {
    this.tokens = config.burst;
    this.at = now();
  }

  /**
   * Waits for a slot and a start token. Resolves with a release function to call when the
   * call has finished (success or not). `front` puts a retried call ahead of its priority peers.
   */
  acquire(priority: AiPriority = 'normal', signal?: AbortSignal, front = false, onWait?: (w: { ahead: number; waitS: number }) => void): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new AiError('Aborted', 'abort'));
    return new Promise((resolve, reject) => {
      const seq = this.seq++;
      const entry: Entry = { order: front ? seq - 1e9 : seq, rank: RANK[priority] ?? 1, resolve, reject, signal };
      if (signal) {
        entry.onAbort = () => {
          const i = this.queue.indexOf(entry);
          if (i < 0) return;
          this.queue.splice(i, 1);
          reject(new AiError('Aborted', 'abort'));
          this.changed();
          this.pump();
        };
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      const i = this.queue.findIndex((e) => e.rank > entry.rank || (e.rank === entry.rank && e.order > entry.order));
      if (i < 0) this.queue.push(entry); else this.queue.splice(i, 0, entry);
      this.pump();
      this.changed();
      const ahead = this.queue.indexOf(entry);
      if (ahead >= 0 && onWait) { try { onWait({ ahead, waitS: Math.max(0.1, this.stats().waitS) }); } catch { /* ignore */ } }
    });
  }

  /** Runs `fn` in a slot and releases the slot when it settles. */
  async run<T>(fn: () => Promise<T>, priority: AiPriority = 'normal', signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(priority, signal);
    try { return await fn(); } finally { release(); }
  }

  /** The server said "wait": no new starts for `seconds`, and the burst allowance is spent. */
  pause(seconds: number) {
    const s = Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_RETRY_AFTER_S;
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + s * 1000);
    this.tokens = 0;
    this.at = this.now();
    this.changed();
    this.pump();
  }

  /**
   * A second, parallel attempt (a hedge) is allowed only when nothing is waiting, a slot is free
   * and a start token is available; it then spends the token. It never takes a slot from queued work.
   */
  tryExtra(): boolean {
    this.refill();
    if (this.queue.length || this.running >= this.config.maxInFlight || this.now() < this.pausedUntil || this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  stats(): QueueStats {
    this.refill();
    const t = this.now();
    const paused = Math.max(0, this.pausedUntil - t) / 1000;
    const n = this.queue.length;
    // Waiting for start tokens, or for running calls to free their slots: whichever is longer.
    const pacing = Math.max(0, n - Math.floor(this.tokens)) / this.config.perSecond;
    const slots = this.running + n > this.config.maxInFlight ? Math.ceil((this.running + n - this.config.maxInFlight) / this.config.maxInFlight) * this.avgHoldMs / 1000 : 0;
    return { inFlight: this.running, queued: n, waitS: Math.round((n ? paused + Math.max(pacing, slots) : 0) * 10) / 10 };
  }

  onChange(cb: (s: QueueStats) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  private changed() {
    if (!this.listeners.size) return;
    const s = this.stats();
    this.listeners.forEach((cb) => { try { cb(s); } catch { /* a listener must not break scheduling */ } });
  }

  private refill() {
    const t = this.now();
    if (t < this.pausedUntil) { this.at = t; return; }
    const from = Math.max(this.at, this.pausedUntil);
    this.tokens = Math.min(this.config.burst, this.tokens + Math.max(0, t - from) * this.config.perSecond / 1000);
    this.at = t;
  }

  private pump() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.refill();
    let started = false;
    while (this.queue.length && this.running < this.config.maxInFlight && this.now() >= this.pausedUntil && this.tokens >= 1) {
      const e = this.queue.shift()!;
      if (e.signal && e.onAbort) e.signal.removeEventListener('abort', e.onAbort);
      this.tokens -= 1;
      this.running += 1;
      started = true;
      let released = false;
      const startedAt = this.now();
      e.resolve(() => {
        if (released) return;
        released = true;
        this.avgHoldMs = this.avgHoldMs * 0.8 + Math.max(0, this.now() - startedAt) * 0.2;
        this.running -= 1;
        this.changed();
        this.pump();
      });
    }
    if (started) this.changed();
    // Blocked by the clock (pause or pacing), not by slots: wake when that clears.
    if (this.queue.length && this.running < this.config.maxInFlight) {
      const t = this.now();
      const wait = t < this.pausedUntil ? this.pausedUntil - t : Math.ceil((1 - this.tokens) * 1000 / this.config.perSecond);
      this.timer = setTimeout(() => this.pump(), Math.max(1, wait));
    }
  }
}

/** True for the server's own per-address limit, which waiting fixes; never a sign the model is spent. */
export const isRateLimited = (e: unknown) => e instanceof AiError && e.code === 'rate_limited';

/**
 * Runs `fn` through the scheduler. A `rate_limited` answer pauses the whole queue for its
 * Retry-After and sends the same call again, ahead of its peers, up to RATE_LIMIT_RETRIES times.
 */
export async function runScheduled<T>(sched: RequestScheduler, fn: () => Promise<T>, priority: AiPriority = 'normal', signal?: AbortSignal, onWait?: (w: { ahead: number; waitS: number }) => void): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const release = await sched.acquire(priority, signal, attempt > 0, onWait);
    try {
      return await fn();
    } catch (e) {
      if (!isRateLimited(e) || attempt >= RATE_LIMIT_RETRIES || signal?.aborted) throw e;
      sched.pause((e as AiError).retryAfterS ?? DEFAULT_RETRY_AFTER_S);
    } finally {
      release();
    }
  }
}

// ---------------------------------------------------------------- one scheduler per server

const schedulers = new Map<string, RequestScheduler>();

/** The shared scheduler for a server transport (created on first use). */
export function schedulerFor(t: Extract<Transport, { kind: 'server' }>): RequestScheduler {
  let s = schedulers.get(t.base);
  if (!s) {
    s = new RequestScheduler(SERVER_SCHEDULE);
    s.onChange(setQueueState);
    schedulers.set(t.base, s);
  }
  return s;
}

export const resetSchedulers = () => { schedulers.clear(); setQueueState({ inFlight: 0, queued: 0, waitS: 0 }); };
