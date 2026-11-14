/** Origin checks, client addressing and rate limits. Pure logic with an injectable clock, so it is easy to test. */

// ---------------------------------------------------------------- CORS

export const ALLOWED_METHODS = ['GET', 'POST', 'OPTIONS'];
export const ALLOWED_HEADERS = ['content-type', 'x-request-id'];
export const EXPOSED_HEADERS = ['Retry-After', 'X-Request-Id'];
export const PREFLIGHT_MAX_AGE_S = 600;

/** Builds a matcher from exact origins and "http://localhost:*" style patterns. */
export function originMatcher(patterns) {
  const exact = new Set();
  const anyPort = [];
  for (const p of patterns) {
    if (p.endsWith(':*')) anyPort.push(p.slice(0, -2));
    else exact.add(p);
  }
  return (origin) => {
    if (typeof origin !== 'string' || !origin) return false;
    if (exact.has(origin)) return true;
    return anyPort.some((base) => origin.startsWith(`${base}:`) && /^\d{1,5}$/.test(origin.slice(base.length + 1)));
  };
}

/** Headers for an allowed origin on any response. */
export function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Expose-Headers': EXPOSED_HEADERS.join(', '),
    Vary: 'Origin',
  };
}

/** Checks a preflight request. Returns the extra headers to send, or null when it asks for too much. */
export function preflight(req) {
  const method = String(req.headers['access-control-request-method'] ?? '').toUpperCase();
  if (!ALLOWED_METHODS.includes(method)) return null;
  const asked = String(req.headers['access-control-request-headers'] ?? '')
    .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (asked.some((h) => !ALLOWED_HEADERS.includes(h))) return null;
  return {
    'Access-Control-Allow-Methods': ALLOWED_METHODS.join(', '),
    'Access-Control-Allow-Headers': ALLOWED_HEADERS.join(', '),
    'Access-Control-Max-Age': String(PREFLIGHT_MAX_AGE_S),
    Vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
  };
}

// ---------------------------------------------------------------- client address

/**
 * The address used for rate limiting. Forwarded headers are trusted only when configured,
 * because anyone can send them: with X-Forwarded-For the entry added by the platform proxy
 * (counted from the right) is used, never the client-controlled left end.
 */
export function clientAddress(req, { clientIpHeader, trustedProxyHops }) {
  const socketIp = req.socket?.remoteAddress ?? 'unknown';
  if (!clientIpHeader) return socketIp;
  const raw = req.headers[clientIpHeader];
  const value = Array.isArray(raw) ? raw.join(',') : raw;
  if (!value) return socketIp;
  if (clientIpHeader !== 'x-forwarded-for') return value.trim() || socketIp;
  const hops = value.split(',').map((s) => s.trim()).filter(Boolean);
  return hops[Math.max(0, hops.length - trustedProxyHops)] ?? socketIp;
}

// ---------------------------------------------------------------- rate limits

/**
 * Per-client token buckets: `burst` requests at once, refilled at `perMinute`.
 * Idle full buckets are dropped so memory stays bounded however many clients appear.
 */
export function createRateLimiter({ burst, perMinute, maxClients = 10_000, now = Date.now }) {
  const perMs = perMinute / 60_000;
  const buckets = new Map();

  function refill(b, t) {
    b.tokens = Math.min(burst, b.tokens + (t - b.at) * perMs);
    b.at = t;
  }

  function prune(t) {
    for (const [k, b] of buckets) {
      refill(b, t);
      if (b.tokens >= burst) buckets.delete(k);
    }
    // Still too many: drop the oldest entries (Map keeps insertion order).
    for (const k of buckets.keys()) {
      if (buckets.size <= maxClients) break;
      buckets.delete(k);
    }
  }

  return {
    /** Takes one token. Returns { ok: true } or { ok: false, retryAfterS }. */
    take(key) {
      const t = now();
      let b = buckets.get(key);
      if (!b) {
        if (buckets.size >= maxClients) prune(t);
        b = { tokens: burst, at: t };
        buckets.set(key, b);
      } else {
        refill(b, t);
      }
      if (b.tokens >= 1) {
        b.tokens -= 1;
        return { ok: true };
      }
      return { ok: false, retryAfterS: Math.max(1, Math.ceil((1 - b.tokens) / perMs / 1000)) };
    },
    size: () => buckets.size,
  };
}

/** One shared allowance of upstream calls per UTC day, so a busy or abusive day has a hard cost ceiling. */
export function createDailyBudget({ limit, now = Date.now }) {
  let day = -1;
  let used = 0;
  const DAY = 86_400_000;
  const roll = (t) => {
    const d = Math.floor(t / DAY);
    if (d !== day) { day = d; used = 0; }
  };
  return {
    take() {
      const t = now();
      roll(t);
      if (used >= limit) return { ok: false, retryAfterS: Math.max(1, Math.ceil(((day + 1) * DAY - t) / 1000)) };
      used += 1;
      return { ok: true };
    },
    remaining() {
      roll(now());
      return Math.max(0, limit - used);
    },
  };
}
