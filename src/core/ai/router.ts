import { AiError, callModel, type ModelRequest, type StreamOutcome } from './engine';
import { acceptsImages, candidatesFor, getOverrides, pickNewModels, setExtraModels, type AiTask } from './models';
import { dominantReason, type AiReason } from './errors';
import { modelsRequest, transportId, type Transport } from './transport';
import { emitActivity } from './telemetry';
import { schedulerFor } from './scheduler';

export interface ModelStatus { model: string; ok: boolean; firstTokenMs: number | null; totalMs: number | null; error?: string; reason?: AiReason; code?: string }

// ---------------------------------------------------------------- health

const health = new Map<string, { until: number; reason: string }>();

/** Back-off after an overload answer. */
export const OVERLOAD_BACKOFF_MS = 60_000;

// Daily quota: a model that answered 429 is skipped until the next UTC midnight, across reloads.
const LS_EXHAUSTED = 'spacelens.ai.exhausted.v1';
let exhausted: Record<string, number> | null = null;

/** The next 00:00 UTC after `now`. */
export const nextUtcMidnight = (now = Date.now()) => Math.floor(now / 86_400_000) * 86_400_000 + 86_400_000;

function exhaustedMap(): Record<string, number> {
  if (!exhausted) {
    try { exhausted = JSON.parse(storage()?.getItem(LS_EXHAUSTED) ?? '{}') as Record<string, number>; } catch { exhausted = {}; }
  }
  return exhausted;
}
function saveExhausted() {
  try { storage()?.setItem(LS_EXHAUSTED, JSON.stringify(exhaustedMap())); } catch { /* storage blocked */ }
}
export function markExhausted(model: string, now = Date.now()) {
  exhaustedMap()[model] = nextUtcMidnight(now);
  saveExhausted();
}
export function isExhausted(model: string, now = Date.now()) {
  const until = exhaustedMap()[model];
  if (until === undefined) return false;
  if (until > now) return true;
  delete exhaustedMap()[model];
  saveExhausted();
  return false;
}
export const resetExhausted = () => { exhausted = {}; saveExhausted(); };

const isQuotaError = (err: unknown) => err instanceof AiError && err.kind === 'http' && (err.status === 429 || /RESOURCE_EXHAUSTED/i.test(err.message));

/** Server codes that say nothing about one model: our own rate limit and the shared daily allowance. */
const SERVER_SIDE_CODES = new Set(['rate_limited', 'budget_exhausted']);

/**
 * True only when Gemini itself says this model's quota is spent: a 429 straight from Google, or
 * the server's `upstream_quota`. The server's own limits never mark a model spent.
 */
export function exhaustsModel(err: { status?: number; code?: string; reason?: AiReason; message?: string } | undefined): boolean {
  if (!err) return false;
  if (err.code) return err.code === 'upstream_quota';
  return err.status === 429 || err.reason === 'quota' || /RESOURCE_EXHAUSTED/i.test(err.message ?? '');
}
const isOverloadError = (err: unknown) => err instanceof AiError && err.kind === 'http' && (err.status === 503 || err.status === 529 || /overloaded/i.test(err.message));

export function markUnhealthy(model: string, reason: string, err?: unknown) {
  const status = err instanceof AiError ? err.status : 0;
  // The server's own limits are about this address, not the model: leave its health alone.
  if (err instanceof AiError && err.code && SERVER_SIDE_CODES.has(err.code)) return;
  if (isQuotaError(err) && !(err as AiError).stopAll) { markExhausted(model); return; }
  // A rejected request (schema, thinking level) says nothing about the model's health.
  if (status === 400) return;
  // Unknown models stay out for the session; timeouts recover after a few minutes.
  const ms = status === 404 ? 6 * 3600_000 : isOverloadError(err) ? OVERLOAD_BACKOFF_MS : status === 429 ? 10 * 60_000 : 5 * 60_000;
  health.set(model, { until: Date.now() + ms, reason });
}
export const markHealthy = (model: string) => { health.delete(model); };
export function isHealthy(model: string, now = Date.now()) {
  const h = health.get(model);
  return !h || h.until <= now;
}
export const resetHealth = () => health.clear();

// ---------------------------------------------------------------- ranking

/** A model slower than this (probe total) is never first choice while a faster healthy one exists. */
export const SLOW_MS = 4000;

/**
 * Orders a task's candidates (given in ladder order) for one call:
 * - probed-ok models that answered within SLOW_MS (or the fastest, if all are slower) come first;
 *   smart / vision keep ladder order among them, fast takes pure measured speed;
 * - then the other probed-ok models by speed, then models not probed yet (ladder order), then
 *   models whose probe failed (slow before broken);
 * - models marked unhealthy at runtime go last.
 */
export function rankModels(task: AiTask, candidates: string[], probes: Record<string, ModelStatus | undefined>, healthy: (m: string) => boolean = () => true): string[] {
  const speed = (m: string) => probes[m]?.totalMs ?? probes[m]?.firstTokenMs ?? Infinity;
  const ok = candidates.filter((m) => probes[m]?.ok);
  const unknown = candidates.filter((m) => !probes[m]);
  const failed = candidates.filter((m) => probes[m] && !probes[m]!.ok);
  const bySpeed = [...ok].sort((a, b) => speed(a) - speed(b));
  let head: string[];
  if (task === 'fast' || !bySpeed.length) {
    head = bySpeed;
  } else {
    const limit = Math.max(SLOW_MS, speed(bySpeed[0]));
    const quick = ok.filter((m) => speed(m) <= limit);
    head = [...quick, ...bySpeed.filter((m) => !quick.includes(m))];
  }
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

/** Probe results are stored per transport under a fingerprint, never the key itself. */
const idOf = (t: Transport) => hashKey(transportId(t));

/** Current probe results for this transport (possibly partial while a probe runs), or {} if stale. */
export function probeResults(t: Transport): Record<string, ModelStatus> {
  const kh = idOf(t);
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

/** Re-measure in the background: every 10 minutes, and after a slow call. Old results stay in use meanwhile. */
export const REPROBE_MS = 10 * 60_000;
export function maybeReprobe(t: Transport, reason: 'age' | 'slow') {
  if (isProbing(t)) return;
  const kh = idOf(t);
  const age = probe && probe.keyHash === kh ? Date.now() - probe.at : Infinity;
  if (reason === 'age' ? age > REPROBE_MS : age > 60_000) void runProbe(t, { force: true, keep: true });
}

export const probeFresh = (t: Transport) => Object.keys(probeResults(t)).length > 0 && !(probing?.keyHash === idOf(t));
export const isProbing = (t: Transport) => probing?.keyHash === idOf(t);
export function onProbeUpdate(cb: () => void) { probeListeners.add(cb); return () => { probeListeners.delete(cb); }; }

const PROBE_REQ: ModelRequest = { parts: [{ text: 'Reply with the single word OK.' }], thinking: 'minimal', maxOutputTokens: 16, temperature: 0 };

/** Probe one model with a tiny streaming request under a hard cap. */
export async function probeOne(t: Transport, model: string, capMs = PROBE_CAP_MS): Promise<ModelStatus> {
  try {
    const call = () => callModel(model, PROBE_REQ, { transport: t, totalTimeoutMs: capMs });
    // Through the server a probe is the least urgent call there is: it waits behind real work.
    const out = t.kind === 'server' ? await schedulerFor(t).run(call, 'low') : await call();
    return { model, ok: true, firstTokenMs: round(out.firstTokenMs ?? out.totalMs), totalMs: round(out.totalMs) };
  } catch (e) {
    const err = e as AiError;
    return {
      model, ok: false, firstTokenMs: null, totalMs: null, error: err.kind === 'timeout' ? `no reply in ${capMs / 1000} s` : shortError(err), reason: err.reason,
      ...(err.code ? { code: err.code } : {}),
    };
  }
}

/**
 * Probes every candidate model in parallel and stores the results (30 min, per key).
 * Results land incrementally, so callers can route as soon as one fast model has answered.
 */
export function runProbe(t: Transport, opts: { force?: boolean; keep?: boolean; onUpdate?: (s: ModelStatus[]) => void } = {}): Promise<ModelStatus[]> {
  const kh = idOf(t);
  if (probing?.keyHash === kh) return probing.promise;
  if (!opts.force && probeFresh(t)) return Promise.resolve(allVia(t).map((m) => probe!.results[m]).filter(Boolean));
  probe = { keyHash: kh, at: Date.now(), results: opts.keep && probe?.keyHash === kh ? { ...probe.results } : {} };
  const current = probe;
  const promise = discoverModels(t).then(() => allVia(t)).then((models) => Promise.all(models.map(async (m) => {
    const s = await probeOne(t, m);
    if (probe !== current) return s;
    current.results[m] = s;
    if (s.ok) markHealthy(m);
    else if (s.code && SERVER_SIDE_CODES.has(s.code)) { /* the server was busy, not the model */ }
    else if (exhaustsModel(s)) markExhausted(m);
    else markUnhealthy(m, s.error ?? 'probe failed');
    const snapshot = models.map((x) => current.results[x]).filter(Boolean);
    opts.onUpdate?.(snapshot);
    probeListeners.forEach((cb) => cb());
    return s;
  }))).then((all) => {
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
export function waitForRoute(t: Transport, task: AiTask, maxMs: number): Promise<void> {
  const ready = () => !isProbing(t) || candidatesVia(t, task).some((m) => probeResults(t)[m]?.ok);
  if (ready()) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); off(); resolve(); };
    const t = setTimeout(done, maxMs);
    const off = onProbeUpdate(() => { if (ready()) done(); });
  });
}

export function routeFor(t: Transport, task: AiTask): string[] {
  const order = rankModels(task, candidatesVia(t, task), probeResults(t), (m) => isHealthy(m)).filter((m) => !isExhausted(m));
  // The person's own choice for this task goes first (unless its quota is spent); the rest stay as fall-through.
  const pick = getOverrides()[task];
  return pick && !isExhausted(pick) ? [pick, ...order.filter((m) => m !== pick)] : order;
}

// ---------------------------------------------------------------- models per transport

/** Models each server offers, in its order of preference. */
const serverModels = new Map<string, string[]>();
const serverLoads = new Map<string, Promise<void>>();

/**
 * The task's candidates for this transport. Through the server only the models it offers are
 * used, plus any it offers that the lists here do not name yet.
 */
export function candidatesVia(t: Transport, task: AiTask): string[] {
  const list = candidatesFor(task);
  const offered = t.kind === 'server' ? serverModels.get(t.base) : undefined;
  if (!offered) return list;
  const extra = offered.filter((m) => !list.includes(m) && (task !== 'vision' || acceptsImages(m)));
  return [...list.filter((m) => offered.includes(m)), ...extra];
}

const allVia = (t: Transport) => [...new Set([...candidatesVia(t, 'fast'), ...candidatesVia(t, 'smart')])];

/** Loads the server's model list once; after a failed load, a later call tries again a minute on. */
export function loadServerModels(t: Transport, capMs = 4000): Promise<void> {
  if (t.kind !== 'server') return Promise.resolve();
  const known = serverLoads.get(t.base);
  if (known) return known;
  const load = discoverModels(t, capMs).then(() => {
    if (!serverModels.has(t.base)) setTimeout(() => serverLoads.delete(t.base), 60_000);
  });
  serverLoads.set(t.base, load);
  return load;
}

/**
 * Direct: finds models this key offers that no list names yet, so new releases work without a
 * code change. Server: reads the models the server allows.
 */
export async function discoverModels(t: Transport, capMs = 4000): Promise<string[]> {
  try {
    const { url, init } = modelsRequest(t, AbortSignal.timeout(capMs));
    const res = await fetch(url, init);
    if (!res.ok) return [];
    if (t.kind === 'server') {
      const list = ((await res.json()) as { models?: unknown }).models;
      if (!Array.isArray(list)) return [];
      const models = list.filter((m): m is string => typeof m === 'string');
      serverModels.set(t.base, models);
      return models;
    }
    const j = await res.json() as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
    const found = pickNewModels(j.models ?? []);
    setExtraModels(found);
    return found;
  } catch { return []; }
}

// ---------------------------------------------------------------- hedged execution

export interface RouteTiming {
  /** Start the next model in parallel if no first token has arrived after this long. */
  hedgeMs: number;
  /** Give up on a model that has sent nothing after this long. */
  firstTokenTimeoutMs: number;
  totalTimeoutMs: number;
  /** Hard limit for the whole call: after this the caller gets a typed timeout error. */
  deadlineMs?: number;
}

export const TIMING: Record<AiTask, RouteTiming> = {
  fast: { hedgeMs: 1500, firstTokenTimeoutMs: 6000, totalTimeoutMs: 20_000, deadlineMs: 12_000 },
  smart: { hedgeMs: 3000, firstTokenTimeoutMs: 12_000, totalTimeoutMs: 45_000, deadlineMs: 25_000 },
  vision: { hedgeMs: 5000, firstTokenTimeoutMs: 20_000, totalTimeoutMs: 60_000, deadlineMs: 40_000 },
};

export interface RouteHooks {
  onStart?: (model: string) => void;
  onCommit?: (model: string, firstTokenMs: number) => void;
  onText?: (text: string) => void;
  onModelError?: (model: string, err: AiError) => void;
  /** Validates a finished response; throwing here falls through to the next model. */
  accept?: (out: StreamOutcome) => void;
  /** Asked before starting a parallel hedge; false postpones it by another hedge interval. */
  canHedge?: () => boolean;
}

/**
 * Runs `req` over `order`, falling through on errors and timeouts. Several models may run at
 * once while hedging; the first to stream text wins and the others are aborted.
 */
export function runRouted(t: Transport, order: string[], req: ModelRequest, timing: RouteTiming, signal: AbortSignal | undefined, hooks: RouteHooks = {}): Promise<StreamOutcome> {
  return new Promise((resolve, reject) => {
    if (!order.length) return reject(new AiError('No Gemini model available', 'http'));
    interface Attempt { model: string; ctrl: AbortController }
    const live = new Set<Attempt>();
    const errors: string[] = [];
    const reasons: AiReason[] = [];
    let next = 0;
    let committed: Attempt | null = null;
    let settled = false;
    let hedgeTimer: ReturnType<typeof setTimeout> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(hedgeTimer);
      clearTimeout(deadlineTimer);
      signal?.removeEventListener('abort', onAbort);
      for (const a of live) a.ctrl.abort();
      live.clear();
      fn();
    };
    const onAbort = () => finish(() => reject(new AiError('Aborted', 'abort')));
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort);
    if (timing.deadlineMs) deadlineTimer = setTimeout(() => finish(() => reject(new AiError('Gemini took too long to answer', 'timeout'))), timing.deadlineMs);

    const scheduleHedge = () => {
      clearTimeout(hedgeTimer);
      if (committed || next >= order.length) return;
      hedgeTimer = setTimeout(() => {
        if (committed || settled) return;
        if (hooks.canHedge && !hooks.canHedge()) return scheduleHedge();
        launch();
      }, timing.hedgeMs);
    };

    const launch = () => {
      if (settled) return;
      if (next >= order.length) {
        if (!live.size) finish(() => reject(new AiError(`All Gemini models failed: ${errors.join('; ')}`, 'http', 0, dominantReason(reasons))));
        return;
      }
      const model = order[next++];
      const att: Attempt = { model, ctrl: new AbortController() };
      live.add(att);
      hooks.onStart?.(model);
      scheduleHedge();
      callModel(model, req, {
        transport: t,
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
        reasons.push(err.reason);
        hooks.onModelError?.(model, err);
        if (committed === att) committed = null;
        if (err.kind === 'blocked') return finish(() => reject(err));
        // A rejected key fails every model the same way: stop at once.
        if (err.reason === 'invalid_key') return finish(() => reject(new AiError('Key not accepted', 'http', err.status, 'invalid_key')));
        // The server refused for everyone (rate limit, daily allowance): other models would fail the same way.
        if (err.stopAll) return finish(() => reject(err));
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

// ---------------------------------------------------------------- warm-up and waking

/** How long a server stays "awake" after it answered its health route. */
export const AWAKE_MS = 10 * 60_000;
/** A free server can need about a minute to wake. */
export const WAKE_CAP_MS = 65_000;
/** The 'waking' state only shows if the health route is still pending after this long. */
export const WAKING_SHOW_MS = 1200;

const awake = new Map<string, { until: number }>();
const waking = new Map<string, Promise<void>>();
let wakeSeq = -1;

/**
 * Server path: calls its health route so a sleeping server starts, and reports a 'waking' activity
 * (then 'awake') while that takes long. Resolves when the server answered or the cap passed; never throws.
 */
export function ensureAwake(t: Transport, task: AiTask = 'fast'): Promise<void> {
  if (t.kind !== 'server') return Promise.resolve();
  if ((awake.get(t.base)?.until ?? 0) > Date.now()) return Promise.resolve();
  const known = waking.get(t.base);
  if (known) return known;
  const id = wakeSeq--;
  const t0 = Date.now();
  let shown = false;
  const timer = setTimeout(() => { shown = true; emitActivity({ id, task, phase: 'waking', ms: Date.now() - t0 }); }, WAKING_SHOW_MS);
  const p = (async () => {
    try {
      const res = await fetch(`${t.base}/healthz`, { signal: AbortSignal.timeout(WAKE_CAP_MS) });
      if (res.ok) awake.set(t.base, { until: Date.now() + AWAKE_MS });
    } catch { /* offline or still asleep: the real call decides */ }
  })().finally(() => {
    clearTimeout(timer);
    waking.delete(t.base);
    if (shown) emitActivity({ id, task, phase: 'awake', ms: Date.now() - t0 });
  });
  waking.set(t.base, p);
  return p;
}
export const resetAwake = () => { awake.clear(); waking.clear(); };

/**
 * One tiny request to the head of each task ladder, so the first real call does not pay the cold
 * start. On the server path it only wakes the server and reads its model list: model calls there
 * share one address's rate limit with the person's real work.
 */
export async function warmUp(t: Transport): Promise<void> {
  if (t.kind === 'server') { await ensureAwake(t); await loadServerModels(t); return; }
  const heads = [...new Set((['fast', 'smart', 'vision'] as AiTask[]).map((k) => routeFor(t, k)[0]).filter(Boolean))];
  await Promise.all(heads.map((m) => probeOne(t, m, 6000).then((s) => { if (exhaustsModel(s)) markExhausted(m); })));
}

let warmed = false;
/** Schedules warmUp for when the browser is idle after load. Runs once. */
export function warmUpWhenIdle(getTransport: () => Transport | null) {
  if (warmed || typeof window === 'undefined') return;
  warmed = true;
  const run = () => { const t = getTransport(); if (t) void warmUp(t).catch(() => undefined); };
  const ric = (window as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
  const start = () => (ric ? ric(run, { timeout: 4000 }) : setTimeout(run, 1500));
  if (document.readyState === 'complete') start(); else window.addEventListener('load', start, { once: true });
}
