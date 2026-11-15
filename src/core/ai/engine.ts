import type { GeminiPart } from '../gemini';
import { acceptsThinking, clampLevel, isLevelRejection, markNoImages, markNoThinking, markThinkingFloor, nextLevel, type ThinkingLevel } from './models';
import { reasonFromStatus, type AiReason } from './errors';
import { SseParser } from './sse';
import { CODE_STATUS, STOP_ALL_CODES, streamRequest, type Transport } from './transport';

export interface ModelRequest {
  system?: string;
  parts: GeminiPart[];
  schema?: object;
  /** JSON out without a schema. */
  json?: boolean;
  temperature?: number;
  thinking?: ThinkingLevel;
  maxOutputTokens?: number;
  /** Gemini tools, e.g. [{ google_search: {} }] for grounding. Not combined with a schema. */
  tools?: object[];
}

export interface StreamOptions {
  /** Straight to Google with a key, or through the SpaceLens server. */
  transport: Transport;
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
  /** Plain category for the UI (the message is for logs only). */
  readonly reason: AiReason;
  /** Every model would fail the same way (e.g. the server's rate limit): stop trying others. */
  stopAll = false;
  /** The SpaceLens server's error code, e.g. 'rate_limited' (its own limit) or 'upstream_quota' (Gemini's). */
  code?: string;
  /** Seconds the server asked us to wait before trying again. */
  retryAfterS?: number;
  constructor(message: string, readonly kind: 'http' | 'timeout' | 'abort' | 'blocked' | 'parse', readonly status = 0, reason?: AiReason) {
    super(message);
    this.name = 'AiError';
    this.reason = reason ?? (kind === 'timeout' ? 'timeout' : kind === 'blocked' ? 'blocked' : kind === 'http' ? reasonFromStatus(status, message) : 'other');
  }
}

export function buildBody(req: ModelRequest, withThinking: boolean): object {
  const generationConfig: Record<string, unknown> = { temperature: req.temperature ?? 0.2 };
  if (req.schema || req.json) generationConfig.responseMimeType = 'application/json';
  if (req.schema) generationConfig.responseSchema = req.schema;
  if (req.maxOutputTokens) generationConfig.maxOutputTokens = req.maxOutputTokens;
  if (withThinking && req.thinking) generationConfig.thinkingConfig = { thinkingLevel: req.thinking };
  return {
    ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
    contents: [{ role: 'user', parts: req.parts }],
    ...(req.tools?.length ? { tools: req.tools } : {}),
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
    const { url, init } = streamRequest(opts.transport, model, buildBody(req, withThinking), ctrl.signal);
    const res = await fetch(url, init);
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '');
      const msg = body.match(/"message":\s*"([^"]*)"/)?.[1] ?? body.slice(0, 160);
      const code = body.match(/"code":\s*"([a-z_]+)"/)?.[1];
      const wait = Number(body.match(/"retryAfterS":\s*(\d+)/)?.[1] ?? res.headers?.get?.('retry-after'));
      throw httpError(model, res.status, msg, code, wait);
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
      if (payload.error) {
        const code = payload.error.code;
        // Google sends a numeric code; the server sends one of its own string codes.
        if (typeof code === 'string') throw httpError(model, CODE_STATUS[code] ?? 502, payload.error.message ?? 'stream error', code, Number(payload.error.retryAfterS));
        throw new AiError(`${model}: ${payload.error.message ?? 'stream error'}`, 'http', code ?? 0);
      }
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

/** An HTTP failure as an AiError. `code` is set only for answers from the SpaceLens server. */
function httpError(model: string, status: number, message: string, code?: string, retryAfterS?: number): AiError {
  // A model the server does not offer behaves like one Google does not know: skip it for a long while.
  const st = code === 'model_not_allowed' ? 404 : status;
  // The server's own per-address limit clears in seconds: the service is busy, not out of quota.
  const reason: AiReason | undefined = code === 'rate_limited' ? 'overloaded'
    : code === 'budget_exhausted' ? 'quota'
    : code === 'upstream_auth' || code?.startsWith('origin_') ? 'other' : undefined;
  const err = new AiError(`${model} ${st}: ${message}`, 'http', st, reason);
  err.stopAll = Boolean(code && STOP_ALL_CODES.has(code));
  if (code) err.code = code;
  if (retryAfterS !== undefined && Number.isFinite(retryAfterS) && retryAfterS > 0) err.retryAfterS = retryAfterS;
  return err;
}

/**
 * streamModel plus learning: a model that rejects thinkingConfig with a 400 is retried
 * without it once, and remembered so later calls skip it from the start.
 */
export async function callModel(model: string, req: ModelRequest, opts: StreamOptions): Promise<StreamOutcome> {
  let level = req.thinking ? clampLevel(model, req.thinking) : undefined;
  const withThinking = Boolean(level) && acceptsThinking(model);
  for (;;) {
    try {
      const out = await streamModel(model, { ...req, thinking: level }, opts, withThinking);
      if (level && req.thinking && level !== req.thinking) markThinkingFloor(model, level);
      return out;
    } catch (e) {
      if (!(e instanceof AiError) || e.status !== 400) throw e;
      if (withThinking && level) {
        // "Thinking level MINIMAL is not supported": go up one level, otherwise drop thinking settings.
        const up = isLevelRejection(e.message) ? nextLevel(level) : null;
        if (up) { level = up; continue; }
        const out = await streamModel(model, req, opts, false);
        markNoThinking(model);
        return out;
      }
      const hasImage = req.parts.some((p) => p.inlineData);
      if (hasImage && /image|modality|mime/i.test(e.message)) markNoImages(model);
      throw e;
    }
  }
}
