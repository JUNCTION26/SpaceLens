import { hasGemini, usage, type GeminiPart } from '../gemini';
import { getState } from '../store';
import { AiError, type StreamOutcome } from './engine';
import { type AiTask, type ThinkingLevel } from './models';
import {
  hashKey, isProbing, onProbeUpdate, probeFresh, probeResults, routeFor, runProbe, runRouted, TIMING, waitForRoute,
  type ModelStatus,
} from './router';
import { cacheGet, cacheSet, emitActivity, recordUsage } from './telemetry';

export type { AiTask, ThinkingLevel } from './models';
export type { ModelStatus } from './router';
export type { AiActivity, ModelUsage } from './telemetry';
export { partialJson } from './partialJson';
export { aiStats, onAiActivity, clearAiCache } from './telemetry';
export { shortModel, candidatesFor } from './models';
export { AiError } from './engine';
export { onProbeUpdate };

export interface AiCall {
  task: AiTask;
  system?: string;
  parts: GeminiPart[];
  /** Gemini responseSchema (JSON). When set, the result is parsed JSON. */
  schema?: object;
  /** Called with the accumulated raw text as it streams in. Pair with partialJson() for schema calls. */
  onPartial?: (text: string) => void;
  signal?: AbortSignal;
  /** Identical calls with the same key return the cached result. */
  cacheKey?: string;
  temperature?: number;
  /** Thinking level where the model accepts it. Defaults to 'minimal' for 'fast' and 'low' otherwise
   *  (measured: 3.5-flash answers in ~3 s on 'low' versus ~11 s on its default). */
  thinking?: ThinkingLevel;
}

export interface AiResult<T> { data: T; model: string; ms: number; inputTokens: number; outputTokens: number; cached: boolean }

export const aiReady = () => hasGemini();

const keyOf = () => getState().settings.geminiKey;
let callSeq = 1;

/**
 * Runs one Gemini call on the fastest healthy model for the task, streaming, with
 * fall-through on errors/timeouts and hedging on 'fast'. Throws AiError if every model fails,
 * so callers can fall back to local logic.
 */
export async function ai<T = unknown>(call: AiCall): Promise<AiResult<T>> {
  const id = callSeq++;
  const t0 = performance.now();
  const since = () => Math.round(performance.now() - t0);

  if (call.cacheKey) {
    const hit = cacheGet<AiResult<T>>(call.cacheKey);
    if (hit) {
      emitActivity({ id, task: call.task, phase: 'cached', model: hit.model, ms: 0 });
      call.onPartial?.(typeof hit.data === 'string' ? hit.data : JSON.stringify(hit.data));
      return { ...hit, cached: true };
    }
  }

  const key = keyOf();
  if (!key) throw new AiError('No Gemini key set', 'http');
  emitActivity({ id, task: call.task, phase: 'start', ms: 0 });

  // First call with this key: probe in the background and route as soon as one model answers.
  if (!probeFresh(key)) {
    if (!isProbing(key)) void runProbe(key);
    await waitForRoute(key, call.task, 3000);
  }

  const order = routeFor(key, call.task);
  let data: T | undefined;
  let out: StreamOutcome;
  try {
    out = await runRouted(key, order, {
      system: call.system,
      parts: call.parts,
      schema: call.schema,
      temperature: call.temperature,
      thinking: call.thinking ?? (call.task === 'fast' ? 'minimal' : 'low'),
    }, TIMING[call.task], call.signal, {
      onStart: (model) => emitActivity({ id, task: call.task, phase: 'model', model, ms: since() }),
      onCommit: (model) => emitActivity({ id, task: call.task, phase: 'streaming', model, ms: since() }),
      onText: call.onPartial,
      onModelError: (model) => recordUsage(model, { errors: 1 }),
      accept: (o) => { data = parseOutput<T>(o, Boolean(call.schema)); },
    });
  } catch (e) {
    const err = e instanceof AiError ? e : new AiError(String(e), 'http');
    emitActivity({ id, task: call.task, phase: 'error', ms: since(), error: err.message });
    throw err;
  }

  const ms = since();
  recordUsage(out.model, { calls: 1, inputTokens: out.inputTokens, outputTokens: out.outputTokens, ms });
  usage.calls += 1;
  usage.inputTokens += out.inputTokens;
  usage.outputTokens += out.outputTokens;
  emitActivity({ id, task: call.task, phase: 'done', model: out.model, ms });
  const result: AiResult<T> = { data: data as T, model: out.model, ms, inputTokens: out.inputTokens, outputTokens: out.outputTokens, cached: false };
  if (call.cacheKey) cacheSet(call.cacheKey, result);
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
 * Results are kept for 30 minutes per key; pass force to re-measure.
 */
export async function probeModels(opts: { force?: boolean; onUpdate?: (s: ModelStatus[]) => void } = {}): Promise<ModelStatus[]> {
  const key = keyOf();
  if (!key) return [];
  return runProbe(key, opts);
}

/** The ordered models a task would try right now (first = the one it will use). */
export function aiRoute(task: AiTask): string[] {
  const key = keyOf();
  return key ? routeFor(key, task) : [];
}

/** Last probe results for the current key, possibly partial while a probe is running. */
export function aiProbeResults(): ModelStatus[] {
  const key = keyOf();
  return key ? Object.values(probeResults(key)) : [];
}

/** Fingerprint of the current key (for debugging which key a probe belongs to). */
export const aiKeyFingerprint = () => hashKey(keyOf() ?? '');
