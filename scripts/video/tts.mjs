// Narration through Gemini speech models, saved as 24 kHz mono WAV files (cached by text).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const API = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODELS = ['gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts', 'gemini-3.1-flash-tts-preview'];
const VOICE = 'Kore';

export function readKey(root) {
  if (process.env.GEMINI_KEY) return process.env.GEMINI_KEY;
  for (const f of ['.env.local', '.env']) {
    const p = join(root, f);
    if (!existsSync(p)) continue;
    const m = readFileSync(p, 'utf8').match(/^\s*VITE_GEMINI_KEY\s*=\s*"?([^"\r\n]+)"?/m);
    if (m) return m[1].trim();
  }
  return null;
}

function wav(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

async function speak(key, model, text) {
  const res = await fetch(`${API}/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ parts: [{ text }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } } },
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`${model}: HTTP ${res.status}`);
  const j = await res.json();
  const parts = j?.candidates?.[0]?.content?.parts ?? [];
  const bufs = parts.filter((p) => p.inlineData?.data).map((p) => Buffer.from(p.inlineData.data, 'base64'));
  if (!bufs.length) throw new Error(`${model}: no audio`);
  const mime = parts.find((p) => p.inlineData)?.inlineData?.mimeType ?? '';
  const rate = Number(mime.match(/rate=(\d+)/)?.[1]) || 24000;
  let pcm = Buffer.concat(bufs);
  if (pcm.subarray(0, 4).toString() === 'RIFF') pcm = pcm.subarray(44);
  return { pcm, rate };
}

/** Seconds of audio in a 16-bit mono WAV written by this module. */
export function wavSeconds(file) {
  const b = readFileSync(file);
  return (b.length - 44) / (b.readUInt32LE(28) || 48000);
}

/** Returns { file, seconds } per line, or null for a line that could not be voiced. */
export async function narrate(lines, dir, key) {
  mkdirSync(dir, { recursive: true });
  const out = {};
  for (const [id, text] of Object.entries(lines)) {
    if (!text) { out[id] = null; continue; }
    const hash = createHash('sha1').update(`${VOICE}|${text}`).digest('hex').slice(0, 10);
    const file = join(dir, `${id}-${hash}.wav`);
    if (!existsSync(file)) {
      if (!key) { out[id] = null; continue; }
      let done = false;
      for (const model of MODELS) {
        try {
          const { pcm, rate } = await speak(key, model, text);
          writeFileSync(file, wav(pcm, rate));
          done = true;
          break;
        } catch (e) { console.log(`   voice: ${e.message}`); }
      }
      if (!done) { out[id] = null; continue; }
    }
    out[id] = { file, seconds: wavSeconds(file) };
  }
  return out;
}
