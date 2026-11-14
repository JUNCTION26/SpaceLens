/**
 * The only module that talks to Google. It adds the server key, and turns every upstream
 * failure into a stable code and a plain message so no upstream text reaches the client.
 */
import { HttpError } from './http.mjs';

export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export function createGeminiClient({ apiKey, fetch: doFetch = globalThis.fetch, base = GEMINI_BASE }) {
  const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey };
  return {
    /** Starts a generate call and returns the raw upstream Response. */
    generate({ model, body, stream, signal }) {
      const url = `${base}/models/${encodeURIComponent(model)}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;
      return doFetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    },
    /** Model ids the key can call with generateContent. */
    async listModels({ signal } = {}) {
      const res = await doFetch(`${base}/models?pageSize=200`, { headers: { 'x-goog-api-key': apiKey }, signal });
      if (!res.ok) throw new HttpError(502, 'upstream_error', 'The model list is unavailable.');
      const json = await res.json();
      return (json.models ?? [])
        .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
        .map((m) => String(m.name).replace(/^models\//, ''));
    },
  };
}

/** Keeps the fields the app reads from a response or stream chunk; drops everything else. */
export function publicChunk(payload) {
  const out = {};
  for (const k of ['candidates', 'usageMetadata', 'promptFeedback', 'modelVersion']) if (payload?.[k] !== undefined) out[k] = payload[k];
  return out;
}

/**
 * Maps an upstream failure to the client's error. The upstream message is read only to pick a
 * category; the message sent back is always one of ours.
 * @param {number} status upstream HTTP status (or the code inside a streamed error)
 * @param {string} upstreamMessage
 * @param {object} body the validated request, used to name the thinking level that was refused
 * @param {string | null} retryAfter upstream Retry-After header, if any
 */
export function mapUpstreamError(status, upstreamMessage, body, retryAfter = null) {
  const msg = String(upstreamMessage ?? '');
  if (status === 400) {
    if (/api[ _]key/i.test(msg)) return authError();
    if (/thinking/i.test(msg)) {
      const level = body?.generationConfig?.thinkingConfig?.thinkingLevel;
      return new HttpError(400, 'thinking_unsupported', level
        ? `Thinking level ${String(level).toUpperCase()} is not supported for this model.`
        : 'Thinking settings are not supported for this model.');
    }
    if (/image|modality|mime/i.test(msg)) return new HttpError(400, 'modality_unsupported', 'This model does not accept image input.');
    return new HttpError(400, 'upstream_rejected', 'The model could not accept this request.');
  }
  if (status === 401 || status === 403) return authError();
  if (status === 404) return new HttpError(404, 'model_unavailable', 'This model is not available right now.');
  if (status === 429) {
    const s = Number(retryAfter);
    return new HttpError(429, 'upstream_quota', 'The AI service is at its usage limit. Try again later.', { 'Retry-After': String(Number.isInteger(s) && s > 0 ? s : 60) });
  }
  if (status >= 500 && status <= 599) return new HttpError(503, 'upstream_unavailable', 'The AI service is busy. Try again shortly.');
  return new HttpError(502, 'upstream_error', 'The AI service returned an unexpected answer.');
}

const authError = () => new HttpError(502, 'upstream_auth', 'The AI service is not set up correctly on this server.');

/** Reads an upstream error body without trusting its shape. */
export async function upstreamErrorFrom(res, body) {
  let message = '';
  try {
    const text = await res.text();
    message = JSON.parse(text)?.error?.message ?? text;
  } catch { /* unreadable body: category from status only */ }
  return mapUpstreamError(res.status, message, body, res.headers.get('retry-after'));
}

/** Incremental text/event-stream reader: returns the data payload of every completed event. */
export class SseReader {
  #buf = '';

  push(chunk) {
    this.#buf += chunk;
    const out = [];
    for (;;) {
      const m = this.#buf.match(/\r?\n\r?\n/);
      if (!m) break;
      const event = this.#buf.slice(0, m.index);
      this.#buf = this.#buf.slice(m.index + m[0].length);
      const data = dataOf(event);
      if (data !== null) out.push(data);
    }
    return out;
  }

  flush() {
    const data = dataOf(this.#buf);
    this.#buf = '';
    return data === null ? [] : [data];
  }
}

function dataOf(event) {
  const lines = event.split(/\r?\n/).filter((l) => l.startsWith('data:'));
  if (!lines.length) return null;
  return lines.map((l) => l.slice(l.startsWith('data: ') ? 6 : 5)).join('\n');
}
