/**
 * Builds the request handler: security headers, request id, CORS, routing, rate limits,
 * error envelope and one access-log line per request. Services are injected so tests can
 * run the whole stack with a stubbed upstream.
 */
import { randomUUID } from 'node:crypto';
import { HttpError, SECURITY_HEADERS, sendError, sendJson, envelope } from './http.mjs';
import { clientAddress, corsHeaders, createDailyBudget, createRateLimiter, originMatcher, preflight } from './security.mjs';
import { createRouter } from './router.mjs';
import { createGeminiClient } from './gemini.mjs';
import { createModelsHandler, generate, generateStream, healthz } from './handlers.mjs';
import { image, speech } from './media.mjs';
import { createLogger } from './log.mjs';
import { createVoteHandlers, createVoteStore } from './votes.mjs';

const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * @param {object} config from loadConfig()
 * @param {{ fetch?: typeof fetch, logger?: object, now?: () => number }} [deps]
 */
export function createApp(config, deps = {}) {
  const now = deps.now ?? Date.now;
  const log = deps.logger ?? createLogger({ level: config.logLevel });
  const gemini = createGeminiClient({ apiKey: config.apiKey, fetch: deps.fetch });
  const limiter = createRateLimiter({ burst: config.rateLimit.burst, perMinute: config.rateLimit.perMinute, now });
  const budget = createDailyBudget({ limit: config.rateLimit.dailyBudget, now });
  const mediaLimiter = createRateLimiter({ burst: config.media.burst, perMinute: config.media.perMinute, now });
  const mediaBudget = createDailyBudget({ limit: config.media.dailyBudget, now });
  const isAllowedOrigin = originMatcher(config.allowedOrigins);
  const votes = createVoteHandlers(deps.voteStore ?? createVoteStore({ now }));
  const match = createRouter([
    { method: 'GET', path: '/healthz', handler: healthz },
    { method: 'GET', path: '/v1/models', handler: createModelsHandler({ config, gemini, now }) },
    { method: 'POST', path: '/v1/generate', handler: generate, limited: true },
    { method: 'POST', path: '/v1/generate/stream', handler: generateStream, limited: true },
    { method: 'POST', path: '/v1/image', handler: image, limited: true, media: true },
    { method: 'POST', path: '/v1/speech', handler: speech, limited: true, media: true },
    { method: 'POST', path: '/v1/votes', handler: votes.create, limited: true },
    { method: 'GET', path: '/v1/votes/:id', handler: votes.read, limited: true },
    { method: 'POST', path: '/v1/votes/:id/vote', handler: votes.vote, limited: true },
  ]);

  async function handle(req, res) {
    const t0 = performance.now();
    const incoming = req.headers['x-request-id'];
    const id = typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    const meta = {};
    let path = '?';
    let routeName = 'unmatched';

    // Cancel upstream work as soon as the client disconnects before the answer is complete.
    const ctrl = new AbortController();
    res.on('close', () => { if (!res.writableFinished) ctrl.abort(); });
    res.on('close', () => {
      log.info('request', {
        id, method: req.method, route: routeName, status: res.statusCode,
        ms: Math.round(performance.now() - t0), ...meta, ...(res.writableFinished ? {} : { aborted: true }),
      });
    });

    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    res.setHeader('X-Request-Id', id);

    try {
      try { path = new URL(req.url ?? '/', 'http://local').pathname; } catch { throw new HttpError(400, 'invalid_request', 'The request path is not valid.'); }

      const origin = req.headers.origin;
      if (origin !== undefined) {
        if (!isAllowedOrigin(origin)) throw new HttpError(403, 'origin_not_allowed', 'This site is not allowed to use the API.');
        for (const [k, v] of Object.entries(corsHeaders(origin))) res.setHeader(k, v);
      }

      if (req.method === 'OPTIONS') {
        routeName = 'preflight';
        if (origin === undefined) { res.writeHead(204, { Allow: 'GET, POST, OPTIONS' }); return res.end(); }
        const extra = preflight(req);
        if (!extra) throw new HttpError(403, 'preflight_rejected', 'This method or header is not allowed.');
        res.writeHead(204, extra);
        return res.end();
      }

      const { route, allow, params } = match(req.method, path);
      if (!route) {
        if (allow) throw new HttpError(405, 'method_not_allowed', 'This method is not allowed here.', { Allow: allow.join(', ') });
        throw new HttpError(404, 'not_found', 'There is nothing at this address.');
      }
      routeName = `${route.method} ${route.path}`;

      if (route.limited) {
        if (config.requireOrigin && origin === undefined) throw new HttpError(403, 'origin_required', 'Requests must come from an allowed site.');
        const take = limiter.take(clientAddress(req, config));
        if (!take.ok) throw new HttpError(429, 'rate_limited', 'Too many requests. Wait a moment and try again.', { 'Retry-After': String(take.retryAfterS) });
        if (route.media) {
          const m = mediaLimiter.take(clientAddress(req, config));
          if (!m.ok) throw new HttpError(429, 'rate_limited', 'Too many image or voice requests. Wait a moment and try again.', { 'Retry-After': String(m.retryAfterS) });
        }
      }

      await route.handler({ req, res, config, gemini, budget, mediaBudget, meta, params, signal: ctrl.signal });
    } catch (e) {
      if (e instanceof HttpError) {
        meta.error = e.code;
        if (!res.headersSent) sendError(res, e);
        else res.end();
      } else {
        // Log the type only: messages from deep inside could carry request content.
        log.error('unhandled', { id, route: routeName, type: e?.name ?? typeof e });
        meta.error = 'internal';
        if (!res.headersSent) sendJson(res, 500, envelope('internal', 'Something went wrong on the server.'));
        else res.end();
      }
    }
  }

  return { handle, budget, limiter, mediaBudget, mediaLimiter };
}
