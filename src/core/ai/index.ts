import { gemini, hasGemini, type GeminiPart } from '../gemini';
import { getState } from '../store';

/** 'fast' = lowest latency for decisions; 'smart' = best reasoning; 'vision' = image input. */
export type AiTask = 'fast' | 'smart' | 'vision';

export interface AiCall {
  task: AiTask;
  system?: string;
  parts: GeminiPart[];
  /** Gemini responseSchema (JSON). When set, the result is parsed JSON. */
  schema?: object;
  /** Called with the accumulated raw text as it streams in. */
  onPartial?: (text: string) => void;
  signal?: AbortSignal;
  /** Identical calls with the same key return the cached result. */
  cacheKey?: string;
  temperature?: number;
}

export interface AiResult<T> { data: T; model: string; ms: number; inputTokens: number; outputTokens: number; cached: boolean }

export interface ModelStatus { model: string; ok: boolean; firstTokenMs: number | null; totalMs: number | null; error?: string }

export const aiReady = () => hasGemini();

/** Placeholder routing: replaced by the router that probes models and streams. */
export async function ai<T = unknown>(call: AiCall): Promise<AiResult<T>> {
  const t0 = performance.now();
  const data = await gemini<T>(call.parts, { json: Boolean(call.schema), schema: call.schema, system: call.system });
  return { data, model: getState().settings.geminiModel, ms: performance.now() - t0, inputTokens: 0, outputTokens: 0, cached: false };
}

export async function probeModels(): Promise<ModelStatus[]> { return []; }
