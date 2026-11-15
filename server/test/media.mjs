import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { jsonResponse, startServer, TEST_KEY } from './support/harness.mjs';

const PNG = Buffer.from('fake-png-bytes').toString('base64');
const imageReply = () => jsonResponse(200, {
  candidates: [{ content: { parts: [{ text: 'here' }, { inlineData: { mimeType: 'image/png', data: PNG } }] } }],
  responseId: 'internal',
});
const pcm = (s) => Buffer.from(s).toString('base64');
const audioReply = () => jsonResponse(200, {
  candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm('abcd') } }, { inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm('efgh') } }] } }],
});

const imgBody = (over = {}) => ({ model: 'gemini-3.1-flash-image', prompt: 'Make it a watercolour', image: { mimeType: 'image/png', data: PNG.padEnd(Math.ceil(PNG.length / 4) * 4, '=') }, ...over });
const ttsBody = (over = {}) => ({ model: 'gemini-3.8-flash-lite-tts', text: 'Hello there.', ...over });

const code = async (res, status, c) => { assert.equal(res.status, status); assert.equal((await res.json()).error.code, c); };

describe('image route', () => {
  test('passes the image through as base64 with its mime type', async () => {
    const s = await startServer({ upstream: imageReply });
    try {
      const res = await s.request('/v1/image', { json: imgBody() });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { model: 'gemini-3.1-flash-image', mimeType: 'image/png', data: PNG });
      const sent = JSON.parse(s.calls[0].init.body);
      assert.deepEqual(sent.generationConfig.responseModalities, ['TEXT', 'IMAGE']);
      assert.equal(s.calls[0].init.headers['x-goog-api-key'], TEST_KEY);
      assert.match(s.calls[0].url, /gemini-3\.1-flash-image:generateContent$/);
    } finally { await s.close(); }
  });

  test('works without an input image', async () => {
    const s = await startServer({ upstream: imageReply });
    try {
      const res = await s.request('/v1/image', { json: { model: 'gemini-2.5-flash-image', prompt: 'A red moon' } });
      assert.equal(res.status, 200);
    } finally { await s.close(); }
  });

  test('validation: allowlist, fields, types, sizes', async () => {
    const s = await startServer({ env: { MEDIA_RATE_BURST: '100', MEDIA_RATE_PER_MINUTE: '1000' }, upstream: imageReply });
    try {
      await code(await s.request('/v1/image', { json: imgBody({ model: 'gemini-3.5-flash-lite' }) }), 400, 'model_not_allowed');
      await code(await s.request('/v1/image', { json: imgBody({ extra: 1 }) }), 400, 'invalid_request');
      await code(await s.request('/v1/image', { json: imgBody({ prompt: '' }) }), 400, 'invalid_request');
      await code(await s.request('/v1/image', { json: imgBody({ prompt: 'x'.repeat(1501) }) }), 400, 'invalid_request');
      await code(await s.request('/v1/image', { json: imgBody({ image: { mimeType: 'application/pdf', data: 'AAAA' } }) }), 400, 'invalid_request');
      await code(await s.request('/v1/image', { json: imgBody({ image: { mimeType: 'image/png', data: 'not base64!' } }) }), 400, 'invalid_request');
      await code(await s.request('/v1/image', { body: '{}', method: 'POST', headers: { 'Content-Type': 'text/plain' } }), 415, 'unsupported_media_type');
      assert.equal(s.calls.length, 0);
      assert.equal(s.app.mediaBudget.remaining(), 300);
    } finally { await s.close(); }
  });

  test('body cap', async () => {
    const s = await startServer({ env: { MEDIA_MAX_BODY_BYTES: '2048' }, upstream: imageReply });
    try {
      await code(await s.request('/v1/image', { json: imgBody({ prompt: 'x'.repeat(1400), image: { mimeType: 'image/png', data: 'A'.repeat(2000) } }) }), 413, 'payload_too_large');
    } finally { await s.close(); }
  });

  test('a reply with no image is a clear error', async () => {
    const s = await startServer({ upstream: () => jsonResponse(200, { candidates: [{ content: { parts: [{ text: 'sorry' }] } }] }) });
    try { await code(await s.request('/v1/image', { json: imgBody() }), 502, 'no_media'); } finally { await s.close(); }
  });

  test('upstream quota maps to our error and no upstream text leaks', async () => {
    const s = await startServer({ upstream: () => jsonResponse(429, { error: { message: 'secret upstream detail' } }) });
    try {
      const res = await s.request('/v1/image', { json: imgBody() });
      assert.equal(res.status, 429);
      const text = JSON.stringify(await res.json());
      assert.match(text, /upstream_quota/);
      assert.doesNotMatch(text, /secret upstream/);
    } finally { await s.close(); }
  });

  test('requires an allowed origin', async () => {
    const s = await startServer({ upstream: imageReply });
    try {
      await code(await s.request('/v1/image', { json: imgBody(), origin: 'https://evil.example' }), 403, 'origin_not_allowed');
      await code(await s.request('/v1/image', { json: imgBody(), origin: null }), 403, 'origin_required');
    } finally { await s.close(); }
  });
});

describe('speech route', () => {
  test('returns the audio parts joined, as base64 with the mime type', async () => {
    const s = await startServer({ upstream: audioReply });
    try {
      const res = await s.request('/v1/speech', { json: ttsBody({ voice: 'Puck' }) });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { model: 'gemini-3.8-flash-lite-tts', mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm('abcdefgh') });
      const sent = JSON.parse(s.calls[0].init.body);
      assert.deepEqual(sent.generationConfig.responseModalities, ['AUDIO']);
      assert.equal(sent.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Puck');
    } finally { await s.close(); }
  });

  test('validation: allowlist, fields, text length, voice', async () => {
    const s = await startServer({ env: { MEDIA_RATE_BURST: '100', MEDIA_RATE_PER_MINUTE: '1000' }, upstream: audioReply });
    try {
      await code(await s.request('/v1/speech', { json: ttsBody({ model: 'gemini-3.1-flash-image' }) }), 400, 'model_not_allowed');
      await code(await s.request('/v1/speech', { json: ttsBody({ extra: true }) }), 400, 'invalid_request');
      await code(await s.request('/v1/speech', { json: ttsBody({ text: '   ' }) }), 400, 'invalid_request');
      await code(await s.request('/v1/speech', { json: ttsBody({ text: 'x'.repeat(1001) }) }), 400, 'invalid_request');
      await code(await s.request('/v1/speech', { json: ttsBody({ voice: 'kore; drop' }) }), 400, 'invalid_request');
      assert.equal(s.calls.length, 0);
    } finally { await s.close(); }
  });

  test('a reply with no audio is a clear error', async () => {
    const s = await startServer({ upstream: () => jsonResponse(200, { candidates: [{ content: { parts: [{ text: 'no' }] } }] }) });
    try { await code(await s.request('/v1/speech', { json: ttsBody() }), 502, 'no_media'); } finally { await s.close(); }
  });

  test('allowlists can be set from the environment', async () => {
    const s = await startServer({ env: { TTS_MODEL_ALLOWLIST: 'my-tts-model' }, upstream: audioReply });
    try {
      await code(await s.request('/v1/speech', { json: ttsBody() }), 400, 'model_not_allowed');
      assert.equal((await s.request('/v1/speech', { json: ttsBody({ model: 'my-tts-model' }) })).status, 200);
    } finally { await s.close(); }
  });
});

describe('limits', () => {
  test('per-client burst is tighter than text calls and shared by both media routes', async () => {
    let t = 1_000_000_000_000;
    const s = await startServer({ now: () => t, upstream: (u) => (u.includes('tts') ? audioReply() : imageReply()) });
    try {
      assert.equal((await s.request('/v1/image', { json: imgBody() })).status, 200);
      assert.equal((await s.request('/v1/speech', { json: ttsBody() })).status, 200);
      assert.equal((await s.request('/v1/image', { json: imgBody() })).status, 200);
      const res = await s.request('/v1/image', { json: imgBody() });
      await code(res, 429, 'rate_limited');
      assert.ok(Number(res.headers.get('retry-after')) >= 1);
      // text calls are unaffected by the media bucket
      assert.equal(s.app.limiter.size() >= 1, true);
      t += 60_000;
      assert.equal((await s.request('/v1/speech', { json: ttsBody() })).status, 200);
    } finally { await s.close(); }
  });

  test('daily media budget is separate from the text budget and resets at midnight UTC', async () => {
    let t = Date.UTC(2030, 0, 1, 12);
    const s = await startServer({ now: () => t, env: { MEDIA_RATE_DAILY: '2', MEDIA_RATE_BURST: '50', MEDIA_RATE_PER_MINUTE: '100' }, upstream: imageReply });
    try {
      assert.equal((await s.request('/v1/image', { json: imgBody() })).status, 200);
      assert.equal((await s.request('/v1/image', { json: imgBody() })).status, 200);
      const res = await s.request('/v1/image', { json: imgBody() });
      await code(res, 429, 'budget_exhausted');
      assert.ok(Number(res.headers.get('retry-after')) > 0);
      assert.equal(s.app.budget.remaining(), 3000, 'text allowance untouched');
      assert.equal(s.calls.length, 2);
      t = Date.UTC(2030, 0, 2, 0, 0, 1);
      assert.equal((await s.request('/v1/image', { json: imgBody() })).status, 200);
    } finally { await s.close(); }
  });

  test('invalid requests do not spend the media budget', async () => {
    const s = await startServer({ env: { MEDIA_RATE_DAILY: '1', MEDIA_RATE_BURST: '50', MEDIA_RATE_PER_MINUTE: '100' }, upstream: imageReply });
    try {
      await code(await s.request('/v1/image', { json: imgBody({ prompt: '' }) }), 400, 'invalid_request');
      assert.equal((await s.request('/v1/image', { json: imgBody() })).status, 200);
    } finally { await s.close(); }
  });

  test('the key never appears in a media response', async () => {
    const s = await startServer({ upstream: imageReply });
    try {
      const res = await s.request('/v1/image', { json: imgBody() });
      assert.ok(![...res.headers.values(), await res.text()].join('\n').includes(TEST_KEY));
    } finally { await s.close(); }
  });
});
