import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, DEFAULT_MODELS, isOriginPattern, loadConfig } from '../config.mjs';
import { validateGenerate } from '../schema.mjs';
import { clientAddress, createDailyBudget, createRateLimiter, originMatcher } from '../security.mjs';
import { mapUpstreamError, publicChunk, SseReader } from '../gemini.mjs';
import { TEST_KEY, validBody } from './support/harness.mjs';

// ---------------------------------------------------------------- config

test('config: requires a key and reports every problem at once', () => {
  assert.throws(() => loadConfig({ RATE_LIMIT_BURST: 'lots', ALLOWED_ORIGINS: 'not-a-url' }), (e) => {
    assert.ok(e instanceof ConfigError);
    assert.equal(e.problems.length, 3);
    assert.match(e.message, /GEMINI_API_KEY is required/);
    assert.match(e.message, /RATE_LIMIT_BURST/);
    assert.match(e.message, /not-a-url/);
    return true;
  });
});

test('config: defaults are sane and the result is frozen', () => {
  const c = loadConfig({ GEMINI_API_KEY: TEST_KEY });
  assert.equal(c.port, 8787);
  assert.deepEqual(c.modelAllowlist, DEFAULT_MODELS);
  assert.ok(c.allowedOrigins.includes('https://junction26.github.io'));
  assert.equal(c.requireOrigin, true);
  assert.equal(c.clientIpHeader, '');
  assert.ok(Object.isFrozen(c));
});

test('config: the error message never contains the key', () => {
  assert.throws(() => loadConfig({ GEMINI_API_KEY: TEST_KEY, MODEL_ALLOWLIST: 'Bad Model!' }), (e) => !e.message.includes(TEST_KEY));
});

test('config: origin patterns', () => {
  assert.ok(isOriginPattern('https://junction26.github.io'));
  assert.ok(isOriginPattern('http://localhost:*'));
  assert.ok(!isOriginPattern('https://junction26.github.io/SpaceLens'));
  assert.ok(!isOriginPattern('ftp://x.example'));
  assert.ok(!isOriginPattern('http://localhost:80:*'));
});

// ---------------------------------------------------------------- schema

const allow = ['gemini-3.5-flash-lite'];
const bad = (body, re) => assert.throws(() => validateGenerate(body, allow), (e) => e.status === 400 && re.test(e.message));

test('schema: accepts the request the app sends and forwards only known fields', () => {
  const body = validBody({
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: { type: 'OBJECT', properties: { a: { type: 'STRING' } } }, maxOutputTokens: 16, thinkingConfig: { thinkingLevel: 'minimal' } },
    contents: [{ role: 'user', parts: [{ text: 'hi' }, { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } }] }],
  });
  const out = validateGenerate(body, allow);
  assert.equal(out.model, 'gemini-3.5-flash-lite');
  assert.equal(out.body.model, undefined);
  assert.deepEqual(Object.keys(out.body).sort(), ['contents', 'generationConfig', 'systemInstruction', 'tools']);
});

test('schema: refuses unknown fields anywhere, naming the path', () => {
  bad({ ...validBody(), key: 'x' }, /body\.key/);
  bad(validBody({ contents: [{ role: 'user', parts: [{ text: 'a', extra: 1 }] }] }), /contents\[0\]\.parts\[0\]\.extra/);
  bad(validBody({ generationConfig: { candidateCount: 4 } }), /generationConfig\.candidateCount/);
  bad(validBody({ tools: [{ functionDeclarations: [] }] }), /tools\[0\]\.functionDeclarations/);
});

test('schema: refuses models outside the allowlist', () => {
  assert.throws(() => validateGenerate(validBody({ model: 'gemini-ultra-max' }), allow), (e) => e.code === 'model_not_allowed');
});

test('schema: checks types, ranges and sizes', () => {
  bad(validBody({ contents: [] }), /contents: must have 1/);
  bad(validBody({ contents: [{ role: 'admin', parts: [{ text: 'a' }] }] }), /role/);
  bad(validBody({ contents: [{ parts: [{ text: 'a', inlineData: { mimeType: 'image/png', data: 'AAAA' } }] }] }), /exactly one/);
  bad(validBody({ contents: [{ parts: [{ inlineData: { mimeType: 'text/html', data: 'AAAA' } }] }] }), /image or PDF/);
  bad(validBody({ contents: [{ parts: [{ inlineData: { mimeType: 'image/png', data: 'not base64!' } }] }] }), /base64/);
  bad(validBody({ generationConfig: { temperature: 9 } }), /temperature/);
  bad(validBody({ generationConfig: { maxOutputTokens: 1.5 } }), /whole number/);
  bad(validBody({ generationConfig: { thinkingConfig: { thinkingLevel: 'extreme' } } }), /thinkingLevel/);
  bad(validBody({ generationConfig: { responseMimeType: 'text/html' } }), /responseMimeType/);
  let deep = {};
  const root = deep;
  for (let i = 0; i < 20; i++) { deep.items = {}; deep = deep.items; }
  bad(validBody({ generationConfig: { responseSchema: root } }), /nested too deeply/);
  bad([], /must be an object/);
});

// ---------------------------------------------------------------- security

test('rate limiter: allows a burst, then refuses with Retry-After, then refills', () => {
  let t = 0;
  const rl = createRateLimiter({ burst: 3, perMinute: 6, now: () => t });
  for (let i = 0; i < 3; i++) assert.ok(rl.take('a').ok);
  const no = rl.take('a');
  assert.equal(no.ok, false);
  assert.equal(no.retryAfterS, 10);
  assert.ok(rl.take('b').ok, 'other clients are unaffected');
  t += 10_000;
  assert.ok(rl.take('a').ok);
  assert.equal(rl.take('a').ok, false);
});

test('rate limiter: memory stays bounded', () => {
  let t = 0;
  const rl = createRateLimiter({ burst: 2, perMinute: 60, maxClients: 100, now: () => t });
  for (let i = 0; i < 1000; i++) { rl.take(`ip${i}`); t += 1; }
  assert.ok(rl.size() <= 101);
});

test('daily budget: shared ceiling that resets at UTC midnight', () => {
  const day = 86_400_000;
  let t = 5 * day + day - 30_000;
  const b = createDailyBudget({ limit: 2, now: () => t });
  assert.ok(b.take().ok);
  assert.ok(b.take().ok);
  const no = b.take();
  assert.equal(no.ok, false);
  assert.equal(no.retryAfterS, 30);
  t += 30_000;
  assert.ok(b.take().ok);
  assert.equal(b.remaining(), 1);
});

test('origins: exact entries and any-port dev patterns', () => {
  const ok = originMatcher(['https://junction26.github.io', 'http://localhost:*']);
  assert.ok(ok('https://junction26.github.io'));
  assert.ok(ok('http://localhost:5180'));
  assert.ok(!ok('http://localhost.evil.example:5180'));
  assert.ok(!ok('http://localhost:5180.evil.example'));
  assert.ok(!ok('https://junction26.github.io.evil.example'));
  assert.ok(!ok('null'));
  assert.ok(!ok(undefined));
});

test('client address: socket by default, platform hop of X-Forwarded-For when configured', () => {
  const req = (xff) => ({ socket: { remoteAddress: '10.0.0.9' }, headers: xff ? { 'x-forwarded-for': xff } : {} });
  assert.equal(clientAddress(req('1.1.1.1'), { clientIpHeader: '', trustedProxyHops: 1 }), '10.0.0.9');
  const cfg = { clientIpHeader: 'x-forwarded-for', trustedProxyHops: 1 };
  assert.equal(clientAddress(req('spoofed, 203.0.113.7'), cfg), '203.0.113.7');
  assert.equal(clientAddress(req(''), cfg), '10.0.0.9');
  assert.equal(clientAddress(req('a, 203.0.113.7, 10.1.1.1'), { ...cfg, trustedProxyHops: 2 }), '203.0.113.7');
});

// ---------------------------------------------------------------- upstream mapping

test('upstream errors map to our codes without upstream text', () => {
  const secret = 'internal project 1234 quota metric xyz';
  const cases = [
    [429, 'upstream_quota', 429], [503, 'upstream_unavailable', 503], [500, 'upstream_unavailable', 503],
    [404, 'model_unavailable', 404], [403, 'upstream_auth', 502], [401, 'upstream_auth', 502], [418, 'upstream_error', 502],
  ];
  for (const [status, code, ours] of cases) {
    const e = mapUpstreamError(status, secret, {});
    assert.equal(e.code, code);
    assert.equal(e.status, ours);
    assert.ok(!e.message.includes(secret));
  }
  assert.equal(mapUpstreamError(429, '', {}, '17').headers['Retry-After'], '17');
  assert.equal(mapUpstreamError(400, 'API key not valid. Please pass a valid API key.', {}).code, 'upstream_auth');
  assert.equal(mapUpstreamError(400, 'Unsupported MIME type for image', {}).code, 'modality_unsupported');
  const t = mapUpstreamError(400, 'Thinking level MINIMAL is not supported for this model.', { generationConfig: { thinkingConfig: { thinkingLevel: 'minimal' } } });
  assert.equal(t.code, 'thinking_unsupported');
  assert.match(t.message, /^Thinking level MINIMAL is not supported/);
});

test('public chunk keeps only the fields the app reads', () => {
  assert.deepEqual(Object.keys(publicChunk({ candidates: [], usageMetadata: {}, responseId: 'x', debug: 1 })), ['candidates', 'usageMetadata']);
});

test('SSE reader handles split chunks, CRLF and a final event without a blank line', () => {
  const r = new SseReader();
  assert.deepEqual(r.push('data: {"a"'), []);
  assert.deepEqual(r.push(':1}\r\n\r\n: ping\n\ndata: 2'), ['{"a":1}']);
  assert.deepEqual(r.flush(), ['2']);
});
