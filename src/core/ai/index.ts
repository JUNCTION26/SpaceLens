import { usage, type GeminiPart } from '../gemini';
import { getState } from '../store';
import { AiError, type StreamOutcome } from './engine';
import { candidatesFor, type AiTask, type ThinkingLevel } from './models';
import {
  ensureAwake, hashKey, isExhausted, isProbing, loadServerModels, maybeReprobe, onProbeUpdate, probeFresh, probeResults, routeFor, runProbe, runRouted, TIMING, waitForRoute, warmUpWhenIdle,
  type ModelStatus,
} from './router';
import { pickTransport, transportId, type Transport } from './transport';
import { cacheGet, cacheSet, emitActivity, recordTask, recordUsage } from './telemetry';
import { runScheduled, schedulerFor, type AiPriority } from './scheduler';

export type { AiTask, ThinkingLevel } from './models';
export type { ModelStatus } from './router';
export type { AiActivity, ModelUsage } from './telemetry';
export { partialJson } from './partialJson';
export { aiStats, aiTaskStats, estimateCostUsd, onAiActivity, clearAiCache, aiQueue, onAiQueue, type AiQueueState } from './telemetry';
export type { AiPriority } from './scheduler';
export { shortModel, candidatesFor } from './models';
export { AiError } from './engine';
export { classify, problemFor, OFFLINE_NOTE, type AiReason, type AiProblem, type AiAction } from './errors';
export { TASKS, getOverrides, setOverride } from './models';
export { onProbeUpdate };
export { warmUp, ensureAwake, isExhausted } from './router';
export { apiBase, pickTransport, type Transport } from './transport';

export interface AiCall {
  task: AiTask;
  system?: string;
  parts: GeminiPart[];
  /** Gemini responseSchema (JSON). When set, the result is parsed JSON. */
  schema?: object;
  /** Parse the reply as JSON even without a schema. */
  json?: boolean;
  /** Called with the accumulated raw text as it streams in. Pair with partialJson() for schema calls. */
  onPartial?: (text: string) => void;
  signal?: AbortSignal;
  /** Time to the first token before the next-fastest model is started in parallel (first to answer wins). Default 4000 for 'fast', 8000 otherwise. */
  budgetMs?: number;
  /** Identical calls with the same key return the cached result. */
  cacheKey?: string;
  /** Skip the automatic 10 minute cache (reads and writes). Calls that stream with onPartial are never auto-cached. */
  noCache?: boolean;
  temperature?: number;
  /** Gemini tools such as [{ google_search: {} }]. */
  tools?: object[];
  /** Thinking level where the model accepts it. Defaults to 'minimal' for 'fast' and 'low' otherwise
   *  (measured: 3.5-flash answers in ~3 s on 'low' versus ~11 s on its default). */
  thinking?: ThinkingLevel;
  /** Server path only: order in the shared queue. 'high' for what the person is waiting to read
   *  (a brief), 'normal' (default) for object specs, 'low' for critic passes and background work. */
  priority?: AiPriority;
}

export interface AiResult<T> { data: T; model: string; ms: number; inputTokens: number; outputTokens: number; cached: boolean }

/** How calls go right now: a key in Settings (or the dev env) goes direct, else the server, else none. */
export const currentTransport = (): Transport | null => pickTransport(getState().settings.geminiKey);

/** True when Gemini can be called: with a personal key, or through the SpaceLens server. */
export const aiReady = () => currentTransport() !== null;
let callSeq = 1;

/** Life of an automatic cache entry. */
export const CACHE_TTL_MS = 10 * 60_000;

/** Key from task, model family, prompt hash and schema hash. */
function autoCacheKey(t: Transport, call: AiCall): string {
  const family = (routeFor(t, call.task)[0] ?? '').replace(/^gemini-/, '').replace(/^\d+(\.\d+)?-?/, '') || 'any';
  const prompt = hashKey(JSON.stringify([call.system ?? '', call.parts, call.temperature ?? null, call.thinking ?? null, call.json ?? false]));
  const schema = hashKey(JSON.stringify(call.schema ?? null));
  return [call.task, family, prompt, schema].join('.');
}

// Wake the server / warm each ladder head once the app is idle after load.
warmUpWhenIdle(currentTransport);

/**
 * Runs one Gemini call on the fastest healthy model for the task, streaming, with
 * fall-through on errors/timeouts and hedging on 'fast'. Throws AiError if every model fails,
 * so callers can fall back to local logic.
 */
export async function ai<T = unknown>(call: AiCall): Promise<AiResult<T>> {
  const id = callSeq++;
  const t0 = performance.now();
  const since = () => Math.round(performance.now() - t0);

  if (call.cacheKey && !call.noCache) {
    const hit = cacheGet<AiResult<T>>(call.cacheKey);
    if (hit) {
      emitActivity({ id, task: call.task, phase: 'cached', model: hit.model, ms: 0 });
      call.onPartial?.(typeof hit.data === 'string' ? hit.data : JSON.stringify(hit.data));
      return { ...hit, cached: true };
    }
  }

  const t = currentTransport();
  if (!t) throw new AiError('No Gemini key set', 'http', 0, 'no_key');
  const autoKey = !call.noCache && !call.cacheKey && !call.onPartial && !call.tools?.length ? 'auto.' + autoCacheKey(t, call) : null;
  if (autoKey) {
    const hit = cacheGet<{ at: number; result: AiResult<T> }>(autoKey);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      emitActivity({ id, task: call.task, phase: 'cached', model: hit.result.model, ms: 0 });
      return { ...hit.result, cached: true };
    }
  }
  const sched = t.kind === 'server' ? schedulerFor(t) : null;
  emitActivity({ id, task: call.task, phase: 'start', ms: 0 });

  if (t.kind === 'server') {
    // The server shares one key among everyone: no speed probe, just its model list (loaded once).
    await ensureAwake(t, call.task);
    await loadServerModels(t);
  } else {
    // First call with this key: probe in the background and route as soon as one model answers.
    if (!probeFresh(t)) {
      if (!isProbing(t)) void runProbe(t);
      await waitForRoute(t, call.task, 3000);
    }
    maybeReprobe(t, 'age');
  }
  let data: T | undefined;
  let out: StreamOutcome;
  // Routed again on each attempt: a call that waited in the queue sees what was learned meanwhile.
  const routed = (): Promise<StreamOutcome> => {
    const order = routeFor(t, call.task);
    if (!order.length && candidatesFor(call.task).some((m) => isExhausted(m))) return Promise.reject(new AiError('Daily quota used on every model', 'http', 429, 'quota'));
    return runRouted(t, order, {
      system: call.system,
      parts: call.parts,
      schema: call.schema,
      json: call.json,
      temperature: call.temperature,
      tools: call.tools,
      thinking: call.thinking ?? (call.task === 'fast' ? 'minimal' : 'low'),
    }, { ...TIMING[call.task], hedgeMs: call.budgetMs ?? TIMING[call.task].hedgeMs }, call.signal, {
      onStart: (model) => emitActivity({ id, task: call.task, phase: 'model', model, ms: since() }),
      onCommit: (model) => emitActivity({ id, task: call.task, phase: 'streaming', model, ms: since() }),
      onText: call.onPartial,
      onModelError: (model) => recordUsage(model, { errors: 1 }),
      accept: (o) => { data = parseOutput<T>(o, Boolean(call.schema || call.json)); },
      // Through the server a parallel hedge only runs when no other call is waiting for a slot.
      canHedge: sched ? () => sched.tryExtra() : undefined,
    });
  };
  try {
    // A call that has to wait announces it again, with how many are ahead and the rough wait.
    const onWait = ({ ahead, waitS }: { ahead: number; waitS: number }) => emitActivity({ id, task: call.task, phase: 'start', ms: since(), queued: ahead, waitS });
    out = await (sched ? runScheduled(sched, routed, call.priority ?? 'normal', call.signal, onWait) : routed());
  } catch (e) {
    const err = e instanceof AiError ? e : new AiError(String(e), 'http');
    emitActivity({ id, task: call.task, phase: 'error', ms: since(), error: err.message, reason: err.reason });
    throw err;
  }

  const ms = since();
  recordUsage(out.model, { calls: 1, inputTokens: out.inputTokens, outputTokens: out.outputTokens, ms });
  if (t.kind === 'direct' && ms > 2 * (call.budgetMs ?? TIMING[call.task].hedgeMs)) maybeReprobe(t, 'slow');
  recordTask(call.task, ms, out.inputTokens, out.outputTokens);
  usage.calls += 1;
  usage.inputTokens += out.inputTokens;
  usage.outputTokens += out.outputTokens;
  emitActivity({ id, task: call.task, phase: 'done', model: out.model, ms });
  const result: AiResult<T> = { data: data as T, model: out.model, ms, inputTokens: out.inputTokens, outputTokens: out.outputTokens, cached: false };
  if (call.cacheKey && !call.noCache) cacheSet(call.cacheKey, result);
  if (autoKey) cacheSet(autoKey, { at: Date.now(), result });
  return result;
}

function parseOutput<T>(out: StreamOutcome, json: boolean): T {
  if (!json) return out.text as T;
  const text = out.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AiError(`${out.model}: invalid JSON${out.finishReason === 'MAX_TOKENS' ? ' (cut off)' : ''}`, 'parse');
  }
}

/**
 * Measures every candidate model with a tiny streaming request (8 s cap each, in parallel).
 * Results are kept for 30 minutes per key or server; pass force to re-measure.
 */
export async function probeModels(opts: { force?: boolean; onUpdate?: (s: ModelStatus[]) => void } = {}): Promise<ModelStatus[]> {
  const t = currentTransport();
  if (!t) return [];
  return runProbe(t, opts);
}

/** The ordered models a task would try right now (first = the one it will use). */
export function aiRoute(task: AiTask): string[] {
  const t = currentTransport();
  return t ? routeFor(t, task) : [];
}

/** Last probe results for the current key or server, possibly partial while a probe is running. */
export function aiProbeResults(): ModelStatus[] {
  const t = currentTransport();
  return t ? Object.values(probeResults(t)) : [];
}

/** Fingerprint of the current key or server (for debugging which one a probe belongs to). */
export const aiKeyFingerprint = () => {
  const t = currentTransport();
  return hashKey(t ? transportId(t) : '');
};
