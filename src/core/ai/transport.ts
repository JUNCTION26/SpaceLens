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
