/**
 * How a model call leaves the browser. With a key set in Settings (or the dev env) it goes
 * straight to Google; otherwise it goes to the SpaceLens server at VITE_API_BASE, which holds
 * the key. With neither, AI features fall back to offline rules.
 */
export type Transport =
  | { kind: 'direct'; key: string }
  | { kind: 'server'; base: string };

export const GOOGLE_API = 'https://generativelanguage.googleapis.com/v1beta';

/** VITE_API_BASE without trailing slashes, or '' when it is not set. */
export function apiBase(): string {
  const raw = (import.meta.env?.VITE_API_BASE as string | undefined) ?? '';
  return raw.trim().replace(/\/+$/, '');
}

/** A personal key wins; otherwise the server when one is configured; otherwise none. */
export function pickTransport(key: string | undefined, base: string = apiBase()): Transport | null {
  if (key) return { kind: 'direct', key };
  if (base) return { kind: 'server', base };
  return null;
}

/** Identity for per-transport caches such as probe results. Callers hash it before storing. */
export const transportId = (t: Transport) => (t.kind === 'direct' ? t.key : `server:${t.base}`);

interface HttpRequest { url: string; init: RequestInit }

/** The streaming generate request for one model. The server form carries no key at all. */
export function streamRequest(t: Transport, model: string, body: object, signal?: AbortSignal): HttpRequest {
  if (t.kind === 'direct') {
    return {
      url: `${GOOGLE_API}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
      init: { method: 'POST', signal, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': t.key }, body: JSON.stringify(body) },
    };
  }
  return {
    url: `${t.base}/v1/generate/stream`,
    init: { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, ...body }) },
  };
}

/** The model list: everything the key offers (direct), or the server's allowlist. */
export function modelsRequest(t: Transport, signal?: AbortSignal): HttpRequest {
  return t.kind === 'direct'
    ? { url: `${GOOGLE_API}/models?pageSize=200`, init: { headers: { 'x-goog-api-key': t.key }, signal } }
    : { url: `${t.base}/v1/models`, init: { signal } };
}

/** Server error codes that fail every model the same way, so trying the next model is pointless. */
export const STOP_ALL_CODES = new Set(['rate_limited', 'budget_exhausted', 'origin_not_allowed', 'origin_required', 'upstream_auth']);

/** HTTP status for a server error code that arrives inside a stream. */
export const CODE_STATUS: Record<string, number> = {
  rate_limited: 429, budget_exhausted: 429, upstream_quota: 429,
  upstream_unavailable: 503, upstream_timeout: 504, upstream_unreachable: 502,
  model_unavailable: 404, model_not_allowed: 400, thinking_unsupported: 400, modality_unsupported: 400,
  upstream_rejected: 400, invalid_request: 400,
};

// ---------------------------------------------------------------- image and speech

/** What an image or speech call returns on either path: base64 data and its mime type. */
export interface MediaResult { model: string; mimeType: string; data: string }

export class MediaError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}

interface InlinePart { inlineData?: { mimeType?: string; data?: string }; inline_data?: { mime_type?: string; mimeType?: string; data?: string } }

/** First part of a Gemini reply whose data matches `kind` (image or audio). */
function firstMedia(json: unknown, kind: 'image' | 'audio', model: string): MediaResult | null {
  const parts = (json as { candidates?: { content?: { parts?: InlinePart[] } }[] })?.candidates?.[0]?.content?.parts ?? [];
  for (const p of parts) {
    const d = p.inlineData ?? p.inline_data;
    const mime = (d as { mimeType?: string })?.mimeType ?? (d as { mime_type?: string })?.mime_type ?? (kind === 'image' ? 'image/png' : '');
    if (d?.data && mime.startsWith(`${kind}/`)) return { model, mimeType: mime, data: d.data };
  }
  return null;
}

async function mediaFetch(url: string, init: RequestInit, kind: 'image' | 'audio', model: string, direct: boolean): Promise<MediaResult> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let code = direct ? `http_${res.status}` : 'error';
    if (!direct) { try { code = (await res.json())?.error?.code ?? code; } catch { /* keep status code */ } }
    throw new MediaError(`${kind} ${res.status}`, res.status, code);
  }
  const json = await res.json();
  const out = direct ? firstMedia(json, kind, model) : (json as MediaResult);
  if (!out?.data || !out.mimeType) throw new MediaError(`no ${kind}`, 502, 'no_media');
  return { model: out.model ?? model, mimeType: out.mimeType, data: out.data };
}

/** One image-model call. Direct goes to Google with the key; server sends the small request to /v1/image. */
export function requestImage(t: Transport, model: string, prompt: string, image: { mimeType: string; data: string } | null, signal?: AbortSignal): Promise<MediaResult> {
  if (t.kind === 'direct') {
    const parts: object[] = image ? [{ inlineData: image }] : [];
    parts.push({ text: prompt });
    return mediaFetch(`${GOOGLE_API}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', signal, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': t.key },
      body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } }),
    }, 'image', model, true);
  }
  return mediaFetch(`${t.base}/v1/image`, {
    method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, ...(image ? { image } : {}) }),
  }, 'image', model, false);
}

/** One speech call returning the whole clip as base64 PCM (or whatever mime the model uses). */
export function requestSpeech(t: Transport, model: string, text: string, voice = 'Kore', signal?: AbortSignal): Promise<MediaResult> {
  if (t.kind === 'direct') {
    return mediaFetch(`${GOOGLE_API}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', signal, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': t.key },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
      }),
    }, 'audio', model, true);
  }
  return mediaFetch(`${t.base}/v1/speech`, {
    method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, text, voice }),
  }, 'audio', model, false);
}

/** Server error codes for media calls that make every other model fail too. */
export const MEDIA_STOP_CODES = new Set([...STOP_ALL_CODES]);
