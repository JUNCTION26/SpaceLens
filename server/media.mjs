/**
 * Image and speech generation. Both routes take a small, strict request, build the upstream
 * call themselves, and return the first media result as base64 with its mime type:
 *   { model, mimeType, data }
 * They use tighter per-client limits and their own daily allowance than text calls, because
 * every call is far more expensive.
 */
import { HttpError, readJson, sendJson } from './http.mjs';
import { upstreamErrorFrom } from './gemini.mjs';

export const MEDIA_LIMITS = Object.freeze({ promptChars: 1500, speechChars: 1000, imageBytesB64: 5_000_000 });

export const DEFAULT_IMAGE_MODELS = ['gemini-3.1-flash-image', 'gemini-3.1-flash-image-preview', 'gemini-2.5-flash-image', 'gemini-3-pro-image'];
export const DEFAULT_TTS_MODELS = ['gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts', 'gemini-3.1-flash-tts-preview'];

const INPUT_IMAGE_TYPES = /^image\/(png|jpeg|webp)$/;
const OUTPUT_IMAGE_TYPES = /^image\/(png|jpeg|webp|gif)$/;
const OUTPUT_AUDIO_TYPES = /^audio\/[a-z0-9.+-]+(;\s*[a-z]+=[a-z0-9]+)*$/i;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const VOICE = /^[A-Z][a-z]{2,19}$/;

const fail = (path, message) => { throw new HttpError(400, 'invalid_request', `${path}: ${message}`); };
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function strictObject(v, path, allowed) {
  if (!isObject(v)) fail(path, 'must be an object');
  for (const k of Object.keys(v)) if (!allowed.includes(k)) fail(`${path}.${k}`, 'is not an accepted field');
  return v;
}

function text(v, path, max) {
  if (typeof v !== 'string') fail(path, 'must be text');
  if (!v.trim() || v.length > max) fail(path, `must be 1 to ${max} characters`);
  return v;
}

function model(v, allowlist) {
  if (typeof v !== 'string' || v.length < 1 || v.length > 64) fail('model', 'must be a model id');
  if (!allowlist.includes(v)) throw new HttpError(400, 'model_not_allowed', 'This model is not available on this server.');
  return v;
}

/** @returns {{ model: string, body: object }} */
export function validateImage(input, allowlist) {
  strictObject(input, 'body', ['model', 'prompt', 'image']);
  const m = model(input.model, allowlist);
  const parts = [];
  if (input.image !== undefined) {
    const d = strictObject(input.image, 'image', ['mimeType', 'data']);
    if (typeof d.mimeType !== 'string' || !INPUT_IMAGE_TYPES.test(d.mimeType)) fail('image.mimeType', 'must be image/png, image/jpeg or image/webp');
    if (typeof d.data !== 'string' || d.data.length < 4 || d.data.length > MEDIA_LIMITS.imageBytesB64) fail('image.data', 'is missing or too large');
    if (d.data.length % 4 !== 0 || !BASE64.test(d.data)) fail('image.data', 'must be base64');
    parts.push({ inlineData: { mimeType: d.mimeType, data: d.data } });
  }
  parts.push({ text: text(input.prompt, 'prompt', MEDIA_LIMITS.promptChars) });
  return { model: m, body: { contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } } };
}

/** @returns {{ model: string, body: object }} */
export function validateSpeech(input, allowlist) {
  strictObject(input, 'body', ['model', 'text', 'voice']);
  const m = model(input.model, allowlist);
  let voice = 'Kore';
  if (input.voice !== undefined) {
    if (typeof input.voice !== 'string' || !VOICE.test(input.voice)) fail('voice', 'must be a voice name');
    voice = input.voice;
  }
  return {
    model: m,
    body: {
      contents: [{ parts: [{ text: text(input.text, 'text', MEDIA_LIMITS.speechChars) }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
    },
  };
}

const partsOf = (json) => json?.candidates?.[0]?.content?.parts ?? [];
const inline = (p) => p?.inlineData ?? p?.inline_data;

/** First image part, or null. */
export function pickImage(json) {
  for (const p of partsOf(json)) {
    const d = inline(p);
    const mime = d?.mimeType ?? d?.mime_type ?? 'image/png';
    if (typeof d?.data === 'string' && d.data && OUTPUT_IMAGE_TYPES.test(mime)) return { mimeType: mime, data: d.data };
  }
  return null;
}

/** All audio parts joined into one base64 payload, or null. */
export function pickAudio(json) {
  const bufs = [];
  let mimeType = '';
  for (const p of partsOf(json)) {
    const d = inline(p);
    const mime = d?.mimeType ?? d?.mime_type ?? '';
    if (typeof d?.data !== 'string' || !d.data || !OUTPUT_AUDIO_TYPES.test(mime)) continue;
    mimeType ||= mime;
    bufs.push(Buffer.from(d.data, 'base64'));
  }
  return bufs.length ? { mimeType, data: Buffer.concat(bufs).toString('base64') } : null;
}

function createMediaHandler({ validate, allowlistOf, pick, label }) {
  return async function media(ctx) {
    const { model: m, body } = validate(await readJson(ctx.req, ctx.config.media.maxBodyBytes), allowlistOf(ctx.config));
    ctx.meta.model = m;
    const spend = ctx.mediaBudget.take();
    if (!spend.ok) throw new HttpError(429, 'budget_exhausted', `The shared daily ${label} allowance is used up. Try again tomorrow.`, { 'Retry-After': String(spend.retryAfterS) });

    const timeout = AbortSignal.timeout(ctx.config.upstreamTimeoutMs);
    const signal = AbortSignal.any([ctx.signal, timeout]);
    let json;
    try {
      const upstream = await ctx.gemini.generate({ model: m, body, stream: false, signal });
      ctx.meta.upstreamStatus = upstream.status;
      if (!upstream.ok) throw await upstreamErrorFrom(upstream, body);
      json = await upstream.json();
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if (timeout.aborted) throw new HttpError(504, 'upstream_timeout', 'The AI service took too long to answer.');
      if (ctx.signal.aborted) throw new HttpError(499, 'client_closed', 'The request was cancelled.');
      throw new HttpError(502, 'upstream_unreachable', 'Could not reach the AI service.');
    }
    const out = pick(json);
    if (!out) throw new HttpError(502, 'no_media', `The model returned no ${label}. Try again or change the request.`);
    sendJson(ctx.res, 200, { model: m, ...out });
  };
}

export const image = createMediaHandler({ validate: validateImage, allowlistOf: (c) => c.media.imageModels, pick: pickImage, label: 'image' });
export const speech = createMediaHandler({ validate: validateSpeech, allowlistOf: (c) => c.media.ttsModels, pick: pickAudio, label: 'speech' });
