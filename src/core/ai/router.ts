import { AiError, callModel, type ModelRequest, type StreamOutcome } from './engine';
import { allCandidates, candidatesFor, type AiTask } from './models';

export interface ModelStatus { model: string; ok: boolean; firstTokenMs: number | null; totalMs: number | null; error?: string }

// ---------------------------------------------------------------- health

const health = new Map<string, { until: number; reason: string }>();

export function markUnhealthy(model: string, reason: string, err?: unknown) {
  const status = err instanceof AiError ? err.status : 0;
  // Unknown models stay out for the session; quota and timeouts recover after a few minutes.
  const ms = status === 404 ? 6 * 3600_000 : status === 429 ? 10 * 60_000 : 5 * 60_000;
  health.set(model, { until: Date.now() + ms, reason });
}
export const markHealthy = (model: string) => { health.delete(model); };
export function isHealthy(model: string, now = Date.now()) {
  const h = health.get(model);
  return !h || h.until <= now;
}
export const resetHealth = () => health.clear();

// ---------------------------------------------------------------- ranking

/** Probe total under this counts as responsive enough for 'smart' to prefer quality order. */
export const SMART_RESPONSIVE_MS = 4000;

/**
 * Orders a task's candidates for one call:
 * - fast: probed-ok models by measured latency;
 * - smart / vision: probed-ok models that respond quickly, in quality order, then slower ok ones by latency;
 * then models not probed yet (in quality order), then models whose probe failed.
 * Models marked unhealthy at runtime go last.
 */
export function rankModels(task: AiTask, candidates: string[], probes: Record<string, ModelStatus | undefined>, healthy: (m: string) => boolean = () => true): string[] {
  const speed = (m: string) => probes[m]?.totalMs ?? probes[m]?.firstTokenMs ?? Infinity;
  const ok = candidates.filter((m) => probes[m]?.ok);
  const unknown = candidates.filter((m) => !probes[m]);
  const failed = candidates.filter((m) => probes[m] && !probes[m]!.ok);
  let head: string[];
  if (task === 'fast') {
    head = [...ok].sort((a, b) => speed(a) - speed(b));
  } else {
    const quick = ok.filter((m) => speed(m) <= SMART_RESPONSIVE_MS);
    const slow = ok.filter((m) => speed(m) > SMART_RESPONSIVE_MS).sort((a, b) => speed(a) - speed(b));
    head = [...quick, ...slow];
  }
  // Failed probes that still produced a first token were slow, not broken: try them before hard failures.
  failed.sort((a, b) => speed(a) - speed(b));
  const order = [...head, ...unknown, ...failed];
  return [...order.filter(healthy), ...order.filter((m) => !healthy(m))];
}

// ---------------------------------------------------------------- probing

const LS_PROBE = 'spacelens.ai.probe.v1';
export const PROBE_TTL_MS = 30 * 60_000;
export const PROBE_CAP_MS = 8000;

interface ProbeStore { keyHash: string; at: number; results: Record<string, ModelStatus> }

/** FNV-1a fingerprint, so stored probe results follow the key without storing it. */
export function hashKey(key: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}

function storage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

let probe: ProbeStore | null = null;
let probing: { keyHash: string; promise: Promise<ModelStatus[]> } | null = null;
const probeListeners = new Set<() => void>();

/** Current probe results for this key (possibly partial while a probe runs), or {} if stale. */
export function probeResults(key: string): Record<string, ModelStatus> {
  const kh = hashKey(key);
  if (!probe || probe.keyHash !== kh) {
    try {
      const stored = JSON.parse(storage()?.getItem(LS_PROBE) ?? 'null') as ProbeStore | null;
      if (stored?.keyHash === kh) probe = stored;
    } catch { /* ignore */ }
  }
  if (!probe || probe.keyHash !== kh) return {};
  if (Date.now() - probe.at > PROBE_TTL_MS && !(probing?.keyHash === kh)) return {};
  return probe.results;
}

export const probeFresh = (key: string) => Object.keys(probeResults(key)).length > 0 && !(probing?.keyHash === hashKey(key));
export const isProbing = (key: string) => probing?.keyHash === hashKey(key);
export function onProbeUpdate(cb: () => void) { probeListeners.add(cb); return () => { probeListeners.delete(cb); }; }

const PROBE_REQ: ModelRequest = { parts: [{ text: 'Reply with the single word OK.' }], thinking: 'minimal', maxOutputTokens: 16, temperature: 0 };

/** Probe one model with a tiny streaming request under a hard cap. */
export async function probeOne(key: string, model: string, capMs = PROBE_CAP_MS): Promise<ModelStatus> {
  try {
    const out = await callModel(model, PROBE_REQ, { key, totalTimeoutMs: capMs });
    return { model, ok: true, firstTokenMs: round(out.firstTokenMs ?? out.totalMs), totalMs: round(out.totalMs) };
  } catch (e) {
    const err = e as AiError;
    return { model, ok: false, firstTokenMs: null, totalMs: null, error: err.kind === 'timeout' ? `no reply in ${capMs / 1000} s` : shortError(err) };
  }
}

/**
 * Probes every candidate model in parallel and stores the results (30 min, per key).
 * Results land incrementally, so callers can route as soon as one fast model has answered.
 */
export function runProbe(key: string, opts: { force?: boolean; onUpdate?: (s: ModelStatus[]) => void } = {}): Promise<ModelStatus[]> {
  const kh = hashKey(key);
  if (probing?.keyHash === kh) return probing.promise;
  const models = allCandidates();
  if (!opts.force && probeFresh(key)) return Promise.resolve(models.map((m) => probe!.results[m]).filter(Boolean));
  probe = { keyHash: kh, at: Date.now(), results: {} };
  const current = probe;
  const promise = Promise.all(models.map(async (m) => {
    const s = await probeOne(key, m);
    if (probe !== current) return s;
    current.results[m] = s;
    if (s.ok) markHealthy(m); else markUnhealthy(m, s.error ?? 'probe failed');
    const snapshot = models.map((x) => current.results[x]).filter(Boolean);
    opts.onUpdate?.(snapshot);
    probeListeners.forEach((cb) => cb());
    return s;
  })).then((all) => {
    current.at = Date.now();
    try { storage()?.setItem(LS_PROBE, JSON.stringify(current)); } catch { /* storage blocked */ }
    return all;
  }).finally(() => {
    if (probing?.promise === promise) probing = null;
    probeListeners.forEach((cb) => cb());
  });
  probing = { keyHash: kh, promise };
  return promise;
}

/** Waits until the task has a probed-ok model, the probe ends, or `maxMs` passes. */
export function waitForRoute(key: string, task: AiTask, maxMs: number): Promise<void> {
  const ready = () => !isProbing(key) || candidatesFor(task).some((m) => probeResults(key)[m]?.ok);
  if (ready()) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); off(); resolve(); };
    const t = setTimeout(done, maxMs);
    const off = onProbeUpdate(() => { if (ready()) done(); });
  });
}

export function routeFor(key: string, task: AiTask): string[] {
  return rankModels(task, candidatesFor(task), probeResults(key), (m) => isHealthy(m));
}

// ---------------------------------------------------------------- hedged execution

export interface RouteTiming {
  /** Start the next model in parallel if no first token has arrived after this long. */
  hedgeMs: number;
  /** Give up on a model that has sent nothing after this long. */
  firstTokenTimeoutMs: number;
  totalTimeoutMs: number;
}

export const TIMING: Record<AiTask, RouteTiming> = {
  fast: { hedgeMs: 2500, firstTokenTimeoutMs: 10_000, totalTimeoutMs: 60_000 },
  smart: { hedgeMs: 12_000, firstTokenTimeoutMs: 30_000, totalTimeoutMs: 120_000 },
  vision: { hedgeMs: 12_000, firstTokenTimeoutMs: 30_000, totalTimeoutMs: 120_000 },
};

export interface RouteHooks {
  onStart?: (model: string) => void;
  onCommit?: (model: string, firstTokenMs: number) => void;
  onText?: (text: string) => void;
  onModelError?: (model: string, err: AiError) => void;
  /** Validates a finished response; throwing here falls through to the next model. */
  accept?: (out: StreamOutcome) => void;
}

/**
 * Runs `req` over `order`, falling through on errors and timeouts. Several models may run at
 * once while hedging; the first to stream text wins and the others are aborted.
 */
export function runRouted(key: string, order: string[], req: ModelRequest, timing: RouteTiming, signal: AbortSignal | undefined, hooks: RouteHooks = {}): Promise<StreamOutcome> {
  return new Promise((resolve, reject) => {
    if (!order.length) return reject(new AiError('No Gemini model available', 'http'));
    interface Attempt { model: string; ctrl: AbortController }
    const live = new Set<Attempt>();
    const errors: string[] = [];
    let next = 0;
    let committed: Attempt | null = null;
    let settled = false;
    let hedgeTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(hedgeTimer);
      signal?.removeEventListener('abort', onAbort);
      for (const a of live) a.ctrl.abort();
      live.clear();
      fn();
    };
    const onAbort = () => finish(() => reject(new AiError('Aborted', 'abort')));
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort);

    const scheduleHedge = () => {
      clearTimeout(hedgeTimer);
      if (committed || next >= order.length) return;
      hedgeTimer = setTimeout(() => { if (!committed && !settled) launch(); }, timing.hedgeMs);
    };

    const launch = () => {
      if (settled) return;
      if (next >= order.length) {
        if (!live.size) finish(() => reject(new AiError(`All Gemini models failed: ${errors.join('; ')}`, 'http')));
        return;
      }
      const model = order[next++];
      const att: Attempt = { model, ctrl: new AbortController() };
      live.add(att);
      hooks.onStart?.(model);
      scheduleHedge();
      callModel(model, req, {
        key,
        signal: att.ctrl.signal,
        firstTokenTimeoutMs: timing.firstTokenTimeoutMs,
        totalTimeoutMs: timing.totalTimeoutMs,
        onFirstToken: (ms) => {
          if (committed || settled) return;
          committed = att;
          clearTimeout(hedgeTimer);
          for (const a of live) if (a !== att) { a.ctrl.abort(); live.delete(a); }
          hooks.onCommit?.(model, ms);
        },
        onText: (t) => { if (committed === att && !settled) hooks.onText?.(t); },
      }).then((out) => {
        if (settled || (committed && committed !== att)) return;
        hooks.accept?.(out);
        markHealthy(model);
        finish(() => resolve(out));
      }).catch((e: unknown) => {
        live.delete(att);
        if (settled) return;
        const err = e instanceof AiError ? e : new AiError(`${model}: ${(e as Error)?.message ?? e}`, 'parse');
        if (err.kind === 'abort' && att.ctrl.signal.aborted) return; // a loser we aborted ourselves
        if (err.kind !== 'parse' && err.kind !== 'blocked') markUnhealthy(model, err.message, err);
        errors.push(shortError(err));
        hooks.onModelError?.(model, err);
        if (committed === att) committed = null;
        if (err.kind === 'blocked') return finish(() => reject(err));
        if (!committed) launch();
      });
    };
    launch();
  });
}

const round = (ms: number) => Math.round(ms);

function shortError(err: AiError): string {
  if (err.status === 429) return 'quota exceeded';
  if (err.status === 404) return 'not available';
  if (err.kind === 'timeout') return 'timed out';
  return err.message.replace(/^[^:]+:\s*/, '').slice(0, 80);
}
