import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { chunk, jsonResponse, ORIGIN, readEvents, sseResponse, startServer, TEST_KEY, validBody, waitForLog } from './support/harness.mjs';

const assertError = async (res, status, code) => {
  assert.equal(res.status, status);
  const body = await res.json();
  assert.equal(body.error.code, code);
  assert.equal(typeof body.error.message, 'string');
  assert.deepEqual(Object.keys(body), ['error']);
  return body;
};

describe('basics', () => {
  let s;
  before(async () => { s = await startServer({ upstream: () => sseResponse([chunk('OK')]) }); });
  after(() => s.close());

  test('healthz answers with security headers and a request id', async () => {
    const res = await s.request('/healthz', { origin: null });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok' });
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(res.headers.get('strict-transport-security'), /max-age=\d+/);
    assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.match(res.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
  });

  test('a well-formed incoming request id is kept, a bad one replaced', async () => {
    const a = await s.request('/healthz', { headers: { 'X-Request-Id': 'trace-12345678' } });
    assert.equal(a.headers.get('x-request-id'), 'trace-12345678');
    const b = await s.request('/healthz', { headers: { 'X-Request-Id': 'bad id <script>' } });
    assert.notEqual(b.headers.get('x-request-id'), 'bad id <script>');
  });

  test('unknown paths and wrong methods use the error envelope', async () => {
    await assertError(await s.request('/nope'), 404, 'not_found');
    const res = await s.request('/v1/generate');
    await assertError(res, 405, 'method_not_allowed');
    assert.match(res.headers.get('allow'), /POST/);
  });
});

describe('CORS', () => {
  let s;
  before(async () => { s = await startServer({ env: { ALLOWED_ORIGINS: `${ORIGIN},http://localhost:*` }, upstream: () => sseResponse([chunk('OK')]) }); });
  after(() => s.close());

  test('allowed origins are echoed with Vary and exposed headers', async () => {
    for (const origin of [ORIGIN, 'http://localhost:5180']) {
      const res = await s.request('/healthz', { origin });
      assert.equal(res.headers.get('access-control-allow-origin'), origin);
      assert.match(res.headers.get('vary'), /Origin/);
      assert.match(res.headers.get('access-control-expose-headers'), /Retry-After/);
    }
  });

  test('other origins are refused without CORS headers', async () => {
    const res = await s.request('/healthz', { origin: 'https://evil.example' });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    await assertError(res, 403, 'origin_not_allowed');
  });

  test('preflight allows the API methods and headers only', async () => {
    const ok = await s.request('/v1/generate/stream', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Content-Type' } });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);
    assert.match(ok.headers.get('access-control-allow-methods'), /POST/);
    assert.match(ok.headers.get('access-control-allow-headers'), /content-type/);
    assert.equal(ok.headers.get('access-control-max-age'), '600');

    const hdr = await s.request('/v1/generate', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type, x-goog-api-key' } });
    await assertError(hdr, 403, 'preflight_rejected');
    const meth = await s.request('/v1/generate', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'DELETE' } });
    await assertError(meth, 403, 'preflight_rejected');
    const evil = await s.request('/v1/generate', { method: 'OPTIONS', origin: 'https://evil.example', headers: { 'Access-Control-Request-Method': 'POST' } });
    await assertError(evil, 403, 'origin_not_allowed');
  });

  test('generate calls need an Origin by default', async () => {
    await assertError(await s.request('/v1/generate', { json: validBody(), origin: null }), 403, 'origin_required');
  });
});

describe('request limits', () => {
  let s;
  before(async () => { s = await startServer({ env: { MAX_BODY_BYTES: '2048' }, upstream: () => sseResponse([chunk('OK')]) }); });
  after(() => s.close());

  test('bodies over the cap are refused by declared length', async () => {
    await assertError(await s.request('/v1/generate', { json: validBody({ contents: [{ parts: [{ text: 'x'.repeat(5000) }] }] }) }), 413, 'payload_too_large');
    assert.equal(s.calls.length, 0);
  });

  test('bodies over the cap are cut off while streaming without a length', async () => {
    const status = await new Promise((resolve, reject) => {
      const req = httpRequest(`${s.base}/v1/generate`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      req.write('{"model":"gemini-3.5-flash-lite","contents":[{"parts":[{"text":"');
      for (let i = 0; i < 4; i++) req.write('y'.repeat(1000));
      req.end('"}]}]}');
    });
    assert.equal(status, 413);
    assert.equal(s.calls.length, 0);
  });

  test('wrong content type, bad JSON and invalid fields', async () => {
    await assertError(await s.request('/v1/generate', { method: 'POST', body: 'x', headers: { 'Content-Type': 'text/plain' } }), 415, 'unsupported_media_type');
    await assertError(await s.request('/v1/generate', { method: 'POST', body: '{bad', headers: { 'Content-Type': 'application/json' } }), 400, 'invalid_json');
    const b = await assertError(await s.request('/v1/generate', { json: { ...validBody(), apiKey: 'mine' } }), 400, 'invalid_request');
    assert.match(b.error.message, /body\.apiKey/);
    await assertError(await s.request('/v1/generate', { json: validBody({ model: 'gemini-9-ultra' }) }), 400, 'model_not_allowed');
    assert.equal(s.calls.length, 0);
  });
});

describe('rate limits', () => {
  test('per-client token bucket answers 429 with Retry-After', async () => {
    const s = await startServer({ env: { RATE_LIMIT_BURST: '2', RATE_LIMIT_PER_MINUTE: '1' }, upstream: () => sseResponse([chunk('OK')]) });
    try {
      for (let i = 0; i < 2; i++) assert.equal((await s.request('/v1/generate/stream', { json: validBody() })).status, 200);
      const res = await s.request('/v1/generate/stream', { json: validBody() });
      const body = await assertError(res, 429, 'rate_limited');
      assert.equal(res.headers.get('retry-after'), '60');
      assert.equal(body.error.retryAfterS, 60, 'the wait is also in the body, in seconds');
      assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN, 'the browser can read the 429');
      assert.equal((await s.request('/healthz')).status, 200, 'health checks are not limited');
    } finally { await s.close(); }
  });

  test('one visitor designing a themed room in a burst stays under the default limits', async () => {
    const s = await startServer({ upstream: () => sseResponse([chunk('OK')]) });
    try {
      // brief + 12 objects + critic, then the same again with repairs and duplicates: 60 calls at once.
      const all = await Promise.all(Array.from({ length: 60 }, () => s.request('/v1/generate/stream', { json: validBody() })));
      assert.deepEqual(all.map((r) => r.status), Array(60).fill(200));
      await Promise.all(all.map((r) => r.text()));
      assert.equal(s.app.budget.remaining(), 20_000 - 60);
    } finally { await s.close(); }
  });

  test('defaults: burst 90, 240 per minute, 20000 per day; each is configurable', async () => {
    const { loadConfig } = await import('../config.mjs');
    const base = { GEMINI_API_KEY: TEST_KEY };
    assert.deepEqual({ ...loadConfig(base).rateLimit }, { burst: 90, perMinute: 240, dailyBudget: 20_000 });
    assert.deepEqual({ ...loadConfig({ ...base, RATE_LIMIT_BURST: '5', RATE_LIMIT_PER_MINUTE: '7', RATE_LIMIT_DAILY: '9' }).rateLimit }, { burst: 5, perMinute: 7, dailyBudget: 9 });
    const media = loadConfig(base).media;
    assert.deepEqual([media.burst, media.perMinute, media.dailyBudget], [3, 4, 300], 'media limits unchanged');
  });

  test('our own limit and the model quota have different codes, both with a wait in seconds', async () => {
    const s = await startServer({
      env: { RATE_LIMIT_BURST: '1', RATE_LIMIT_PER_MINUTE: '30' },
      upstream: () => jsonResponse(429, { error: { code: 429, message: 'quota' } }, { 'Retry-After': '17' }),
    });
    try {
      const upstream = await s.request('/v1/generate/stream', { json: validBody() });
      const a = await assertError(upstream, 429, 'upstream_quota');
      assert.equal(a.error.retryAfterS, 17);
      assert.equal(upstream.headers.get('retry-after'), '17');
      const ours = await s.request('/v1/generate/stream', { json: validBody() });
      const b = await assertError(ours, 429, 'rate_limited');
      assert.equal(b.error.retryAfterS, 2);
      assert.equal(ours.headers.get('retry-after'), '2');
    } finally { await s.close(); }
  });

  test('global daily budget answers 429 until UTC midnight, and only valid calls spend it', async () => {
    const s = await startServer({ env: { RATE_LIMIT_DAILY: '1' }, upstream: () => sseResponse([chunk('OK')]) });
    try {
      assert.equal((await s.request('/v1/generate/stream', { json: { model: 'x' } })).status, 400);
      assert.equal((await s.request('/v1/generate/stream', { json: validBody() })).status, 200);
      const res = await s.request('/v1/generate/stream', { json: validBody() });
      await assertError(res, 429, 'budget_exhausted');
      assert.ok(Number(res.headers.get('retry-after')) > 0);
    } finally { await s.close(); }
  });
});

describe('models', () => {
  test('lists the allowlist narrowed to what the key offers, cached', async () => {
    const s = await startServer({
      env: { MODEL_ALLOWLIST: 'gemini-3.5-flash-lite,gemini-gone' },
      upstream: () => jsonResponse(200, { models: [{ name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] }, { name: 'models/other', supportedGenerationMethods: ['generateContent'] }] }),
    });
    try {
      assert.deepEqual(await (await s.request('/v1/models')).json(), { models: ['gemini-3.5-flash-lite'], checked: true });
      await s.request('/v1/models');
      assert.equal(s.calls.length, 1, 'second call served from cache');
      assert.equal(s.calls[0].init.headers['x-goog-api-key'], TEST_KEY);
    } finally { await s.close(); }
  });

  test('falls back to the allowlist when the upstream list fails', async () => {
    const s = await startServer({ env: { MODEL_ALLOWLIST: 'gemini-a,gemini-b' }, upstream: () => jsonResponse(500, {}) });
    try {
      assert.deepEqual(await (await s.request('/v1/models')).json(), { models: ['gemini-a', 'gemini-b'], checked: false });
    } finally { await s.close(); }
  });
});

describe('generate', () => {
  test('streams Gemini chunks through, with only public fields, and the key only upstream', async () => {
    const s = await startServer({ upstream: () => sseResponse([chunk('Hel'), ': upstream comment\n\n', chunk('lo', { candidates: [{ content: { parts: [{ text: 'lo' }] }, finishReason: 'STOP' }] })], { delayMs: 5 }) });
    try {
      const res = await s.request('/v1/generate/stream', { json: validBody() });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /^text\/event-stream/);
      const events = await readEvents(res);
      assert.deepEqual(events.map((e) => e.candidates[0].content.parts[0].text), ['Hel', 'lo']);
      assert.equal(events[1].candidates[0].finishReason, 'STOP');
      assert.ok(events.every((e) => e.responseId === undefined));

      const call = s.calls[0];
      assert.equal(call.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:streamGenerateContent?alt=sse');
      assert.equal(call.init.headers['x-goog-api-key'], TEST_KEY);
      const forwarded = JSON.parse(call.init.body);
      assert.equal(forwarded.model, undefined);
      assert.deepEqual(forwarded.contents, validBody().contents);
    } finally { await s.close(); }
  });

  test('non-streaming generate returns the filtered JSON', async () => {
    const s = await startServer({ upstream: () => jsonResponse(200, chunk('OK')) });
    try {
      const res = await s.request('/v1/generate', { json: validBody() });
      const body = await res.json();
      assert.equal(body.candidates[0].content.parts[0].text, 'OK');
      assert.equal(body.responseId, undefined);
      assert.match(s.calls[0].url, /:generateContent$/);
    } finally { await s.close(); }
  });

  test('upstream errors are mapped, never passed through', async () => {
    const leak = 'Quota exceeded for metric generativelanguage.googleapis.com/x project 99999';
    const cases = [
      [jsonResponse(429, { error: { code: 429, message: leak } }, { 'Retry-After': '12' }), 429, 'upstream_quota'],
      [jsonResponse(400, { error: { code: 400, message: 'Thinking level LOW is not supported for this model.' } }), 400, 'thinking_unsupported'],
      [jsonResponse(404, { error: { message: leak } }), 404, 'model_unavailable'],
      [jsonResponse(503, { error: { message: leak } }), 503, 'upstream_unavailable'],
      [jsonResponse(403, { error: { message: `API key ${TEST_KEY} invalid` } }), 502, 'upstream_auth'],
      [new Response('<html>gateway</html>', { status: 502 }), 503, 'upstream_unavailable'],
    ];
    for (const [upstream, status, code] of cases) {
      const s = await startServer({ upstream: () => upstream });
      try {
        const res = await s.request('/v1/generate/stream', { json: validBody() });
        const raw = await res.clone().text();
        await assertError(res, status, code);
        assert.ok(!raw.includes('project 99999') && !raw.includes(TEST_KEY));
        if (code === 'upstream_quota') assert.equal(res.headers.get('retry-after'), '12');
        if (code === 'thinking_unsupported') assert.match(raw, /Thinking level LOW is not supported/);
      } finally { await s.close(); }
    }
  });

  test('an error inside the stream becomes a final error event', async () => {
    const s = await startServer({ upstream: () => sseResponse([chunk('a'), { error: { code: 429, message: 'secret quota detail' } }, chunk('never')]) });
    try {
      const res = await s.request('/v1/generate/stream', { json: validBody() });
      const events = await readEvents(res);
      assert.equal(events.length, 2);
      assert.deepEqual(events[1].error.code, 'upstream_quota');
      assert.ok(!JSON.stringify(events).includes('secret quota detail'));
    } finally { await s.close(); }
  });

  test('network failure and timeout map to 502 and 504', async () => {
    const down = await startServer({ upstream: () => { throw new TypeError('fetch failed: getaddrinfo ENOTFOUND'); } });
    try { await assertError(await down.request('/v1/generate/stream', { json: validBody() }), 502, 'upstream_unreachable'); } finally { await down.close(); }

    const slow = await startServer({
      env: { UPSTREAM_TIMEOUT_MS: '1000' },
      upstream: (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
    });
    try { await assertError(await slow.request('/v1/generate/stream', { json: validBody() }), 504, 'upstream_timeout'); } finally { await slow.close(); }
  });

  test('the upstream call is aborted when the client disconnects', async () => {
    let upstreamSignal;
    const s = await startServer({
      upstream: (url, init) => { upstreamSignal = init.signal; return sseResponse(Array.from({ length: 200 }, (_, i) => chunk(String(i))), { delayMs: 20, signal: init.signal }); },
    });
    try {
      const ctrl = new AbortController();
      const res = await s.request('/v1/generate/stream', { json: validBody(), signal: ctrl.signal });
      const reader = res.body.getReader();
      await reader.read();
      ctrl.abort();
      const line = await waitForLog(s.lines, (l) => l.msg === 'request' && l.route === 'POST /v1/generate/stream');
      assert.equal(line.aborted, true);
      assert.equal(upstreamSignal.aborted, true);
    } finally { await s.close(); }
  });
});

describe('logs', () => {
  test('one structured line per request, no body, no key, no address', async () => {
    const s = await startServer({ upstream: () => sseResponse([chunk('private answer text')]) });
    try {
      const secretPrompt = 'my private floor plan at 12 Secret Street';
      await (await s.request('/v1/generate/stream', { json: validBody({ contents: [{ parts: [{ text: secretPrompt }] }] }), headers: { 'X-Request-Id': 'req-abcdef12' } })).text();
      await (await s.request('/v1/generate', { json: { ...validBody(), extra: TEST_KEY } })).text();
      const line = await waitForLog(s.lines, (l) => l.id === 'req-abcdef12');
      assert.equal(line.route, 'POST /v1/generate/stream');
      assert.equal(line.status, 200);
      assert.equal(line.model, 'gemini-3.5-flash-lite');
      assert.equal(typeof line.ms, 'number');
      await waitForLog(s.lines, (l) => l.error === 'invalid_request');
      const all = s.lines.join('');
      for (const bad of [TEST_KEY, secretPrompt, 'private answer text', '127.0.0.1']) assert.ok(!all.includes(bad), `log contains ${bad}`);
    } finally { await s.close(); }
  });
});
