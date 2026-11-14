import type { GeminiPart } from '../gemini';
import { acceptsThinking, markNoImages, markNoThinking, type ThinkingLevel } from './models';
import { SseParser } from './sse';

const API = 'https://generativelanguage.googleapis.com/v1beta/models';

export interface ModelRequest {
  system?: string;
  parts: GeminiPart[];
  schema?: object;
  temperature?: number;
  thinking?: ThinkingLevel;
  maxOutputTokens?: number;
}

export interface StreamOptions {
  key: string;
  signal?: AbortSignal;
  /** Abort if no text has arrived after this long. */
  firstTokenTimeoutMs?: number;
  /** Abort if the whole response has not finished after this long. */
  totalTimeoutMs?: number;
  onFirstToken?: (ms: number) => void;
  /** Accumulated text so far. */
  onText?: (text: string) => void;
}

export interface StreamOutcome {
  model: string;
  text: string;
  firstTokenMs: number | null;
  totalMs: number;
  inputTokens: number;
  outputTokens: number;
  finishReason?: string;
}

export class AiError extends Error {
  constructor(message: string, readonly kind: 'http' | 'timeout' | 'abort' | 'blocked' | 'parse', readonly status = 0) {
    super(message);
    this.name = 'AiError';
  }
}

export function buildBody(req: ModelRequest, withThinking: boolean): object {
  const generationConfig: Record<string, unknown> = { temperature: req.temperature ?? 0.2 };
  if (req.schema) { generationConfig.responseMimeType = 'application/json'; generationConfig.responseSchema = req.schema; }
  if (req.maxOutputTokens) generationConfig.maxOutputTokens = req.maxOutputTokens;
  if (withThinking && req.thinking) generationConfig.thinkingConfig = { thinkingLevel: req.thinking };
  return {
    ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
    contents: [{ role: 'user', parts: req.parts }],
    generationConfig,
  };
}

/** Text of one streamed chunk, ignoring thought parts. */
export function chunkText(payload: unknown): string {
  const parts = (payload as { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[] })
    ?.candidates?.[0]?.content?.parts;
  return parts?.filter((p) => !p.thought).map((p) => p.text ?? '').join('') ?? '';
}

/** One streaming request to one model. Throws AiError on any failure. */
export async function streamModel(model: string, req: ModelRequest, opts: StreamOptions, withThinking = true): Promise<StreamOutcome> {
  const ctrl = new AbortController();
  let reason: 'timeout' | 'abort' | null = null;
  const stop = (why: 'timeout' | 'abort') => { if (!reason) reason = why; ctrl.abort(); };
  const onOuterAbort = () => stop('abort');
  if (opts.signal?.aborted) throw new AiError('Aborted', 'abort');
  opts.signal?.addEventListener('abort', onOuterAbort);
  const t0 = performance.now();
  let firstTokenMs: number | null = null;
  const firstTimer = opts.firstTokenTimeoutMs ? setTimeout(() => { if (firstTokenMs === null) stop('timeout'); }, opts.firstTokenTimeoutMs) : undefined;
  const totalTimer = opts.totalTimeoutMs ? setTimeout(() => stop('timeout'), opts.totalTimeoutMs) : undefined;

  try {
    const res = await fetch(`${API}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': opts.key },
      body: JSON.stringify(buildBody(req, withThinking)),
    });
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '');
      const msg = body.match(/"message":\s*"([^"]*)"/)?.[1] ?? body.slice(0, 160);
      throw new AiError(`${model} ${res.status}: ${msg}`, 'http', res.status);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const sse = new SseParser();
    let text = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason: string | undefined;
    const handle = (data: string) => {
      let payload: Record<string, any>;
      try { payload = JSON.parse(data); } catch { return; }
      if (payload.error) throw new AiError(`${model}: ${payload.error.message ?? 'stream error'}`, 'http', payload.error.code ?? 0);
      if (payload.promptFeedback?.blockReason) throw new AiError(`${model}: blocked (${payload.promptFeedback.blockReason})`, 'blocked');
      const piece = chunkText(payload);
      finishReason = payload.candidates?.[0]?.finishReason ?? finishReason;
      inputTokens = payload.usageMetadata?.promptTokenCount ?? inputTokens;
      outputTokens = payload.usageMetadata?.candidatesTokenCount ?? outputTokens;
      if (!piece) return;
      text += piece;
      if (firstTokenMs === null) {
        firstTokenMs = performance.now() - t0;
        opts.onFirstToken?.(firstTokenMs);
      }
      opts.onText?.(text);
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const d of sse.push(decoder.decode(value, { stream: true }))) handle(d);
    }
    for (const d of sse.push(decoder.decode())) handle(d);
    for (const d of sse.flush()) handle(d);
    if (finishReason === 'SAFETY' || finishReason === 'PROHIBITED_CONTENT') throw new AiError(`${model}: blocked (${finishReason})`, 'blocked');
    return { model, text, firstTokenMs, totalMs: performance.now() - t0, inputTokens, outputTokens, finishReason };
  } catch (e) {
    if (e instanceof AiError) throw e;
    if (reason === 'timeout') throw new AiError(`${model}: timed out`, 'timeout');
    if (reason === 'abort') throw new AiError('Aborted', 'abort');
    throw new AiError(`${model}: ${(e as Error)?.message ?? 'network error'}`, 'http');
  } finally {
    clearTimeout(firstTimer);
    clearTimeout(totalTimer);
    opts.signal?.removeEventListener('abort', onOuterAbort);
  }
}

/**
 * streamModel plus learning: a model that rejects thinkingConfig with a 400 is retried
 * without it once, and remembered so later calls skip it from the start.
 */
export async function callModel(model: string, req: ModelRequest, opts: StreamOptions): Promise<StreamOutcome> {
  const withThinking = Boolean(req.thinking) && acceptsThinking(model);
  try {
    return await streamModel(model, req, opts, withThinking);
  } catch (e) {
    if (!(e instanceof AiError) || e.status !== 400) throw e;
    if (withThinking) {
      const out = await streamModel(model, req, opts, false);
      markNoThinking(model);
      return out;
    }
    const hasImage = req.parts.some((p) => p.inlineData);
    if (hasImage && /image|modality|mime/i.test(e.message)) markNoImages(model);
    throw e;
  }
}
