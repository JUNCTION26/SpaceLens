/** Route handlers. Each gets a context built by the app: request, response, services and an abort signal. */
import { once } from 'node:events';
import { HttpError, envelope, readJson, retryAfterOf, sendJson } from './http.mjs';
import { validateGenerate } from './schema.mjs';
import { publicChunk, SseReader, upstreamErrorFrom, mapUpstreamError } from './gemini.mjs';

export const HEARTBEAT_MS = 15_000;

export function healthz({ res }) {
  sendJson(res, 200, { status: 'ok' });
}

/**
 * The allowlist, narrowed to what the key can actually call. The upstream list is cached;
 * if it cannot be read the allowlist is returned unchecked and retried a minute later.
 */
export function createModelsHandler({ config, gemini, now = Date.now }) {
  let cache = null;
  return async function models({ res }) {
    if (!cache || now() > cache.until) {
      try {
        const offered = new Set(await gemini.listModels({ signal: AbortSignal.timeout(5000) }));
        const models = config.modelAllowlist.filter((m) => offered.has(m));
        cache = { body: { models, checked: true }, until: now() + config.modelsCacheMs };
      } catch {
        cache = { body: { models: config.modelAllowlist, checked: false }, until: now() + 60_000 };
      }
    }
    sendJson(res, 200, cache.body);
  };
}

/** Validates, spends one unit of the daily budget, and returns what to forward. */
async function prepare(ctx) {
  const { model, body } = validateGenerate(await readJson(ctx.req, ctx.config.maxBodyBytes), ctx.config.modelAllowlist);
  ctx.meta.model = model;
  const spend = ctx.budget.take();
  if (!spend.ok) throw new HttpError(429, 'budget_exhausted', 'The shared daily AI allowance is used up. Try again tomorrow.', { 'Retry-After': String(spend.retryAfterS) });
  return { model, body };
}

/** Upstream call bounded by the request timeout and cancelled when the client goes away. */
function upstreamSignal(ctx) {
  const timeout = AbortSignal.timeout(ctx.config.upstreamTimeoutMs);
  return { signal: AbortSignal.any([ctx.signal, timeout]), timedOut: () => timeout.aborted };
}

function networkError(ctx, timedOut) {
  if (timedOut()) return new HttpError(504, 'upstream_timeout', 'The AI service took too long to answer.');
  if (ctx.signal.aborted) return new HttpError(499, 'client_closed', 'The request was cancelled.');
  return new HttpError(502, 'upstream_unreachable', 'Could not reach the AI service.');
}

export async function generate(ctx) {
  const { model, body } = await prepare(ctx);
  const { signal, timedOut } = upstreamSignal(ctx);
  let upstream;
  let json;
  try {
    upstream = await ctx.gemini.generate({ model, body, stream: false, signal });
    ctx.meta.upstreamStatus = upstream.status;
    if (!upstream.ok) throw await upstreamErrorFrom(upstream, body);
    json = await upstream.json();
  } catch (e) {
    throw e instanceof HttpError ? e : networkError(ctx, timedOut);
  }
  sendJson(ctx.res, 200, publicChunk(json));
}

/**
 * Server-sent events, chunk by chunk as Google sends them. Each event is re-encoded with only
 * the public fields. A failure after the stream has started is sent as a final error event.
 */
export async function generateStream(ctx) {
  const { model, body } = await prepare(ctx);
  const { signal, timedOut } = upstreamSignal(ctx);
  const { res } = ctx;
  let upstream;
  try {
    upstream = await ctx.gemini.generate({ model, body, stream: true, signal });
    ctx.meta.upstreamStatus = upstream.status;
    if (!upstream.ok || !upstream.body) throw await upstreamErrorFrom(upstream, body);
  } catch (e) {
    throw e instanceof HttpError ? e : networkError(ctx, timedOut);
  }

  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  // Comment lines keep idle proxies from closing the connection while a model thinks.
  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
  heartbeat.unref();
  const send = async (obj) => {
    if (!res.write(`data: ${JSON.stringify(obj)}\n\n`)) await once(res, 'drain', { signal: ctx.signal });
  };

  let events = 0;
  try {
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    const sse = new SseReader();
    const handle = async (data) => {
      let payload;
      try { payload = JSON.parse(data); } catch { return false; }
      if (payload?.error) {
        const err = mapUpstreamError(Number(payload.error.code) || 500, payload.error.message, body);
        ctx.meta.streamError = err.code;
        await send(envelope(err.code, err.message, retryAfterOf(err)));
        return true;
      }
      events += 1;
      await send(publicChunk(payload));
      return false;
    };
    let stop = false;
    while (!stop) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const d of sse.push(decoder.decode(value, { stream: true }))) if ((stop = await handle(d))) break;
    }
    if (!stop) for (const d of [...sse.push(decoder.decode()), ...sse.flush()]) if (await handle(d)) break;
    if (stop) reader.cancel().catch(() => {});
  } catch {
    if (!ctx.signal.aborted) {
      const err = networkError(ctx, timedOut);
      ctx.meta.streamError = err.code;
      res.write(`data: ${JSON.stringify(envelope(err.code, err.message))}\n\n`);
    }
  } finally {
    clearInterval(heartbeat);
    ctx.meta.events = events;
    res.end();
  }
}
