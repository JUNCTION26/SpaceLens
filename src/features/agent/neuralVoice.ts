// Optional neural voice for the agent through Gemini's speech models. Audio streams in as 16-bit
// PCM and is scheduled on a Web Audio clock as it arrives. The engine only replaces the browser's
// voice when a measured first-audio time is under one second; otherwise the browser voice stays.

import { getState } from '../../core/store';
import { SseParser } from '../../core/ai/sse';
import { MEDIA_STOP_CODES, MediaError, pickTransport, requestSpeech, type Transport } from '../../core/ai/transport';
import { setSpeechEngine, useBrowserSpeech, type SpeechEngine } from './speech';

const API = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Best first. Measured on a real key: the lite model starts speaking in about 0.5 s. */
export const TTS_MODELS = ['gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts', 'gemini-3.1-flash-tts-preview'];
export const MAX_FIRST_AUDIO_MS = 1000;
const VOICE = 'Kore';

// ---------- pure helpers ----------

/** Sample rate from a mime type such as "audio/l16; rate=24000; channels=1". */
export function pcmRate(mime: string): number {
  return Number(mime.match(/rate=(\d+)/i)?.[1]) || 24000;
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Drops a 44-byte WAV header when the first chunk of a stream carries one. */
export function stripWavHeader(bytes: Uint8Array): Uint8Array {
  const riff = bytes.length > 44 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
  return riff ? bytes.subarray(44) : bytes;
}

/**
 * 16-bit little-endian PCM to floats. A chunk may end in the middle of a sample, so the odd byte
 * is handed back to be placed in front of the next chunk.
 */
export function pcm16ToFloat(bytes: Uint8Array, carry: number | null = null): { samples: Float32Array; carry: number | null } {
  let data = bytes;
  if (carry !== null) { data = new Uint8Array(bytes.length + 1); data[0] = carry; data.set(bytes, 1); }
  const n = data.length >> 1;
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = data[2 * i] | (data[2 * i + 1] << 8);
    samples[i] = (v >= 0x8000 ? v - 0x10000 : v) / 32768;
  }
  return { samples, carry: data.length & 1 ? data[data.length - 1] : null };
}

/** Audio parts (base64 data and mime) in one streamed JSON payload. */
export function audioParts(payload: unknown): { data: string; mime: string }[] {
  const parts = (payload as { candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] } }[] })?.candidates?.[0]?.content?.parts ?? [];
  return parts.filter((p) => p.inlineData?.data).map((p) => ({ data: p.inlineData!.data!, mime: p.inlineData!.mimeType ?? '' }));
}

// ---------- streaming request ----------

/** Streams speech for `text`; calls onAudio with each PCM chunk. Resolves with ms to the first audio. */
export async function streamSpeech(key: string, model: string, text: string, onAudio: (pcm: Float32Array, rate: number) => void, signal?: AbortSignal): Promise<number | null> {
  const t0 = performance.now();
  const res = await fetch(`${API}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ parts: [{ text }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } } },
    }),
  });
  if (!res.ok || !res.body) throw new Error(`voice ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const sse = new SseParser();
  let first: number | null = null;
  let carry: number | null = null;
  let headerChecked = false;
  const handle = (d: string) => {
    let payload: unknown;
    try { payload = JSON.parse(d); } catch { return; }
    for (const p of audioParts(payload)) {
      let bytes = b64ToBytes(p.data);
      if (!headerChecked) { bytes = stripWavHeader(bytes); headerChecked = true; }
      const { samples, carry: c } = pcm16ToFloat(bytes, carry);
      carry = c;
      if (!samples.length) continue;
      if (first === null) first = performance.now() - t0;
      onAudio(samples, pcmRate(p.mime));
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const d of sse.push(dec.decode(value, { stream: true }))) handle(d);
  }
  for (const d of sse.flush()) handle(d);
  return first;
}

/** Whole-clip speech through the server transport; decodes the base64 clip like a streamed chunk. Tries each model in order. */
export async function clipSpeech(t: Transport, text: string, onAudio: (pcm: Float32Array, rate: number) => void, signal?: AbortSignal, models: string[] = TTS_MODELS): Promise<number | null> {
  const t0 = performance.now();
  let last: unknown = new Error('voice unavailable');
  for (const model of models) {
    try {
      const r = await requestSpeech(t, model, text, VOICE, signal);
      const { samples } = pcm16ToFloat(stripWavHeader(b64ToBytes(r.data)));
      if (!samples.length) continue;
      onAudio(samples, pcmRate(r.mimeType));
      return performance.now() - t0;
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') throw e;
      last = e;
      if (e instanceof MediaError && MEDIA_STOP_CODES.has(e.code)) break;
    }
  }
  throw last;
}

/** One sentence of speech on either transport: streamed with a personal key, one clip from the server. */
export function speak(t: Transport, model: string, text: string, onAudio: (pcm: Float32Array, rate: number) => void, signal?: AbortSignal): Promise<number | null> {
  return t.kind === 'direct' ? streamSpeech(t.key, model, text, onAudio, signal) : clipSpeech(t, text, onAudio, signal);
}

// ---------- engine ----------

export class GeminiSpeech implements SpeechEngine {
  private ctx: AudioContext | null = null;
  private nextStart = 0;
  private tail: Promise<void> = Promise.resolve();
  private ctrl = new AbortController();
  private sources = new Set<AudioBufferSourceNode>();

  private transport: Transport;
  constructor(key: string | Transport, private model: string) {
    this.transport = typeof key === 'string' ? { kind: 'direct', key } : key;
  }

  get available() { return typeof window !== 'undefined' && typeof AudioContext !== 'undefined'; }

  private context(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  private play(ctx: AudioContext, pcm: Float32Array, rate: number): Promise<void> {
    const buf = ctx.createBuffer(1, pcm.length, rate);
    buf.copyToChannel(pcm, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const at = Math.max(ctx.currentTime + 0.02, this.nextStart);
    src.start(at);
    this.nextStart = at + buf.duration;
    this.sources.add(src);
    return new Promise((resolve) => { src.onended = () => { this.sources.delete(src); resolve(); }; });
  }

  async say(text: string): Promise<void> {
    const ctx = this.context();
    const signal = this.ctrl.signal;
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => { release = r; });
    // Chunks of this sentence wait until the sentence before it has been fully scheduled.
    let myTurn = false;
    const held: { pcm: Float32Array; rate: number }[] = [];
    const ended: Promise<void>[] = [];
    void prev.then(() => { myTurn = true; for (const h of held.splice(0)) ended.push(this.play(ctx, h.pcm, h.rate)); });
    try {
      await speak(this.transport, this.model, text, (pcm, rate) => {
        if (myTurn) ended.push(this.play(ctx, pcm, rate)); else held.push({ pcm, rate });
      }, signal);
      await prev;
    } catch {
      /* a failed sentence is skipped; the text is already on screen */
    } finally {
      release();
    }
    await Promise.all(ended);
  }

  cancel() {
    this.ctrl.abort();
    this.ctrl = new AbortController();
    for (const s of this.sources) { try { s.stop(); } catch { /* already stopped */ } }
    this.sources.clear();
    this.nextStart = 0;
    this.tail = Promise.resolve();
  }
}

// ---------- choosing the engine ----------

const LS_ON = 'spacelens.voice.neural';
const ls = (): Storage | null => { try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; } };
export const neuralVoiceWanted = () => ls()?.getItem(LS_ON) === '1';

export interface VoiceChoice { engine: 'gemini' | 'browser'; model?: string; firstAudioMs?: number; note: string }

/** Measures one short phrase per model, best first; returns the first that starts under one second. */
export async function pickNeuralModel(key: string, maxMs = MAX_FIRST_AUDIO_MS): Promise<{ model: string; ms: number } | { slowest: number | null }> {
  let best: number | null = null;
  for (const model of TTS_MODELS) {
    try {
      const t = await timeFirstAudio(key, model);
      if (t !== null && t <= maxMs) return { model, ms: Math.round(t) };
      if (t !== null && (best === null || t < best)) best = t;
    } catch { /* try the next model */ }
  }
  return { slowest: best === null ? null : Math.round(best) };
}

async function timeFirstAudio(key: string, model: string): Promise<number | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  let ms: number | null = null;
  const t0 = performance.now();
  try {
    await streamSpeech(key, model, 'Ready.', () => { if (ms === null) { ms = performance.now() - t0; ctrl.abort(); } }, ctrl.signal);
  } catch { /* aborted after the first chunk, or failed */ } finally { clearTimeout(timer); }
  return ms;
}

/** Turns the neural voice on or off, remembering the choice, and installs the right engine now. */
export async function applyVoicePreference(on = neuralVoiceWanted()): Promise<VoiceChoice> {
  try { ls()?.setItem(LS_ON, on ? '1' : '0'); } catch { /* storage blocked */ }
  const key = getState().settings.geminiKey;
  if (!on) { useBrowserSpeech(); return { engine: 'browser', note: 'Using the browser voice.' }; }
  const t = pickTransport(key);
  if (!t) return { engine: 'browser', note: 'Add a Gemini key to use the Gemini voice.' };
  if (t.kind === 'server') {
    // The server returns whole clips, so first-audio timing is not comparable; use it directly.
    setSpeechEngine(new GeminiSpeech(t, TTS_MODELS[0]));
    return { engine: 'gemini', model: TTS_MODELS[0], note: 'Gemini voice from the SpaceLens server.' };
  }
  const pick = await pickNeuralModel(t.key);
  if ('model' in pick) {
    setSpeechEngine(new GeminiSpeech(t, pick.model));
    return { engine: 'gemini', model: pick.model, firstAudioMs: pick.ms, note: `Gemini voice, starts in ${(pick.ms / 1000).toFixed(1)} s.` };
  }
  return { engine: 'browser', note: pick.slowest === null ? 'Gemini voice is not available on this key, using the browser voice.' : `Gemini voice took ${(pick.slowest / 1000).toFixed(1)} s to start, using the browser voice.` };
}
