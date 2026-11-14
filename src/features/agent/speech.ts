// Voice in and out. `speak()` goes through a swappable engine so a neural TTS can replace the
// browser's voice later without touching the agent; recognition wraps SpeechRecognition.

// ---------- pure helpers ----------

/**
 * Split streaming text into sentences that are safe to speak now. Returns the finished sentences
 * after `from` and the index up to which text has been consumed. With `final`, the rest counts too.
 */
export function takeSentences(text: string, from: number, final = false): { sentences: string[]; next: number } {
  const sentences: string[] = [];
  let i = from;
  const re = /[.!?…](?=["')\]]?\s)|[.!?…]["')\]]?$|\n/g;
  re.lastIndex = from;
  for (let m: RegExpExecArray | null; (m = re.exec(text)); ) {
    const endAt = m.index + m[0].length;
    // A trailing terminator at the very end may still grow ("3." -> "3.5"), unless final.
    if (endAt >= text.length && !final) break;
    // Skip decimals and short abbreviations: "1.5 m", "e.g. ".
    const before = text.slice(Math.max(from, m.index - 3), m.index);
    if (m[0] === '.' && (/\d$/.test(before) && /^\d/.test(text.slice(endAt).trimStart()) || /\b(e\.g|i\.e|ca|approx|st)$/i.test(text.slice(Math.max(0, m.index - 6), m.index)))) continue;
    const s = text.slice(i, endAt).trim();
    if (s) sentences.push(s);
    i = endAt;
  }
  if (final) { const rest = text.slice(i).trim(); if (rest) sentences.push(rest); i = text.length; }
  return { sentences, next: i };
}

const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);

/**
 * True when what the mic heard is most likely the agent's own voice coming back through the
 * speakers (hands-free mode without headphones), so it must not count as barge-in.
 */
export function isEcho(heard: string, spoken: string): boolean {
  const h = words(heard);
  if (!h.length) return true;
  const s = new Set(words(spoken));
  if (!s.size) return false;
  const hit = h.filter((w) => s.has(w)).length;
  return hit / h.length >= 0.6;
}

/** Score a voice for a locale: same language first, then neural/natural voices. */
export function voiceScore(v: { name: string; lang: string; localService?: boolean }, locale: string): number {
  const lang = locale.toLowerCase(), vl = v.lang.toLowerCase().replace('_', '-');
  let s = 0;
  if (vl === lang) s += 100; else if (vl.split('-')[0] === lang.split('-')[0]) s += 60; else return -1;
  if (/natural|neural|online|premium|enhanced|wavenet/i.test(v.name)) s += 30;
  if (/google/i.test(v.name)) s += 15;
  if (/siri|samantha|daniel|karen|aria|jenny|guy|sonia|libby/i.test(v.name)) s += 10;
  if (/compact|espeak|robot/i.test(v.name)) s -= 40;
  return s;
}

// ---------- speech output ----------

export interface SpeechEngine {
  /** Queue one short sentence; resolves when it has been spoken (or skipped). */
  say(text: string, opts: { lang: string }): Promise<void>;
  cancel(): void;
  readonly available: boolean;
}

type Listener = (speaking: boolean, text: string) => void;

class BrowserSpeech implements SpeechEngine {
  private voice: SpeechSynthesisVoice | null = null;
  private voiceLang = '';
  get available() { return typeof window !== 'undefined' && 'speechSynthesis' in window; }

  private pick(lang: string) {
    if (this.voice && this.voiceLang === lang) return this.voice;
    const list = window.speechSynthesis.getVoices();
    let best: SpeechSynthesisVoice | null = null, bestS = -1;
    for (const v of list) { const s = voiceScore(v, lang); if (s > bestS) { best = v; bestS = s; } }
    if (best) { this.voice = best; this.voiceLang = lang; }
    return best;
  }

  say(text: string, { lang }: { lang: string }) {
    return new Promise<void>((resolve) => {
      if (!this.available) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      const v = this.pick(lang);
      if (v) u.voice = v;
      u.lang = v?.lang ?? lang;
      u.rate = 1.04;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      window.speechSynthesis.speak(u);
    });
  }

  cancel() { if (this.available) window.speechSynthesis.cancel(); }
}

let engine: SpeechEngine = new BrowserSpeech();
let muted = false;
let pending = 0;
let current = '';
const listeners = new Set<Listener>();
const emit = () => listeners.forEach((l) => l(pending > 0, current));
let generation = 0;

/** Replace the voice (e.g. a neural TTS). */
export function setSpeechEngine(e: SpeechEngine) { engine.cancel(); engine = e; }
export function setMuted(on: boolean) { muted = on; if (on) stopSpeaking(); }
export const isSpeaking = () => pending > 0;
/** What is being said right now (for echo filtering and captions). */
export const currentSpeech = () => current;
export function onSpeech(l: Listener) { listeners.add(l); return () => { listeners.delete(l); }; }

export const speechLang = () => (typeof navigator !== 'undefined' && navigator.language) || 'en-US';

/** Speak one sentence (queued after anything already speaking). */
export async function speak(text: string): Promise<void> {
  const t = text.trim();
  if (!t || muted || !engine.available) return;
  const gen = generation;
  pending++; current = current ? `${current} ${t}` : t; emit();
  try { await engine.say(t, { lang: speechLang() }); } finally {
    if (gen === generation) { pending = Math.max(0, pending - 1); if (!pending) current = ''; emit(); }
  }
}

/** Stop talking now (barge-in, mute, new turn). */
export function stopSpeaking() {
  generation++;
  engine.cancel();
  if (pending || current) { pending = 0; current = ''; emit(); }
}

// Some browsers load voices late; touching the list early makes the first sentence use a good one.
if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  try { window.speechSynthesis.getVoices(); window.speechSynthesis.addEventListener?.('voiceschanged', () => window.speechSynthesis.getVoices()); } catch { /* ignore */ }
}

// ---------- speech input ----------

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Rec {
  lang: string; interimResults: boolean; continuous: boolean;
  start(): void; stop(): void; abort(): void;
  onresult: ((e: any) => void) | null; onend: (() => void) | null; onerror: ((e: any) => void) | null;
}
const RecCtor = (): (new () => Rec) | undefined =>
  typeof window === 'undefined' ? undefined : ((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition);

export const recognitionSupported = () => Boolean(RecCtor());

export interface ListenHandlers {
  /** Live text of the utterance in progress. */
  onInterim: (text: string) => void;
  /** A finished utterance. */
  onFinal: (text: string) => void;
  onState: (listening: boolean) => void;
  onError: (message: string) => void;
}

/**
 * One microphone session. `continuous` keeps listening across pauses (hands-free) and restarts
 * when the browser ends the session on its own; otherwise it stops after the first utterance.
 */
export class Ear {
  private rec: Rec | null = null;
  private keep = false;
  private sentFinal = '';
  constructor(private h: ListenHandlers) {}

  get active() { return this.rec !== null; }

  start(continuous: boolean) {
    const C = RecCtor();
    if (!C) { this.h.onError('Voice input is not supported in this browser'); return; }
    if (this.rec) return;
    this.keep = continuous;
    const r = new C();
    r.lang = speechLang(); r.interimResults = true; r.continuous = continuous;
    let pttText = '';
    r.onresult = (e: any) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const t: string = res[0].transcript;
        if (res.isFinal) {
          if (continuous) { const f = t.trim(); if (f && f !== this.sentFinal) { this.sentFinal = f; this.h.onFinal(f); } }
          else pttText += t;
        } else interim += t;
      }
      this.h.onInterim(continuous ? interim : (pttText + interim));
    };
    r.onerror = (e: any) => {
      const code = e?.error as string | undefined;
      if (code === 'not-allowed' || code === 'service-not-allowed') { this.keep = false; this.h.onError('Microphone access was blocked'); }
      else if (code === 'network') { this.keep = false; this.h.onError('Voice input needs a network connection'); }
    };
    r.onend = () => {
      this.rec = null;
      if (!continuous && pttText.trim()) this.h.onFinal(pttText.trim());
      if (this.keep) { this.start(true); return; }
      this.h.onInterim('');
      this.h.onState(false);
    };
    this.rec = r;
    try { r.start(); this.h.onState(true); } catch { this.rec = null; this.h.onState(false); }
  }

  /** Stop and deliver what was heard. */
  stop() { this.keep = false; this.rec?.stop(); }
  /** Stop and drop it. */
  abort() { this.keep = false; this.rec?.abort(); this.rec = null; this.h.onState(false); }
}
