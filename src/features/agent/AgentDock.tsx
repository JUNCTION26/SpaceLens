// The design partner's dock: talk (hold or tap the mic, or go hands-free), type, draw on the plan,
// and read what the agent said. Sits at the bottom centre of the canvas.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../../ui/icons';
import { phaseOf, useAgent, type Phase } from './agentStore';
import { NoKeyPrompt } from '../../core/ai/AiStatus';
import { useStore } from '../../core/store';
import { interrupt, runTurn } from './brain';
import { applyVoicePreference, neuralVoiceWanted } from './neuralVoice';
import { preloadMods } from './mods';
import { SketchOverlay } from './SketchLayer';
import { Conversation, type ConvState } from '../voice/converse';
import { useSketch } from './sketchStore';
import { currentSpeech, Ear, isEcho, isSpeaking, onSpeech, recognitionSupported, setMuted, stopSpeaking } from './speech';
import { apiBase } from '../../core/ai/transport';
import './agent.css';

const GLYPH: Record<string, string> = {
  pencil: 'M4 20l1-4L16 5l3 3L8 19zM14 7l3 3',
  speaker: 'M4 9h4l5-4v14l-5-4H4zM16.5 9a4 4 0 0 1 0 6M19 6.5a7.5 7.5 0 0 1 0 11',
  speakerOff: 'M4 9h4l5-4v14l-5-4H4zM17 10l4 4M21 10l-4 4',
  eraser: 'M8 20h12M5 15l8-8 5 5-6 6H8z',
  micOff: 'M3 3l18 18M9 9v-3a3 3 0 0 1 5.1-2.1M15 11v1a3 3 0 0 1-.5 1.7M5 11a7 7 0 0 0 11.5 5.4M19 11a7 7 0 0 1-.6 2.8M12 18v3',
};
const Glyph = ({ d }: { d: string }) => (
  <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);

const PHASE_LABEL: Record<Phase, string> = { idle: '', listening: '', thinking: 'Thinking', speaking: '' };

/** Five bars: live mic level while listening, a soft pulse while speaking or thinking. */
function Wave({ phase, meter }: { phase: Phase; meter: boolean }) {
  const bars = useRef<Array<HTMLSpanElement | null>>([]);
  useEffect(() => {
    if (!meter || !navigator.mediaDevices?.getUserMedia) return;
    let stream: MediaStream | null = null, ctx: AudioContext | null = null, raf = 0, stopped = false;
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }).then((s) => {
      if (stopped) { s.getTracks().forEach((t) => t.stop()); return; }
      stream = s;
      ctx = new AudioContext();
      const an = ctx.createAnalyser(); an.fftSize = 256;
      ctx.createMediaStreamSource(s).connect(an);
      const buf = new Uint8Array(an.frequencyBinCount);
      const tick = () => {
        an.getByteFrequencyData(buf);
        bars.current.forEach((el, i) => {
          if (!el) return;
          const band = buf.slice(2 + i * 6, 8 + i * 6);
          const v = band.reduce((a, b) => a + b, 0) / (band.length * 255);
          el.style.transform = `scaleY(${Math.max(0.15, Math.min(1, v * 1.8))})`;
        });
        raf = requestAnimationFrame(tick);
      };
      tick();
    }).catch(() => { /* no level meter; the CSS pulse still shows */ });
    return () => {
      stopped = true; cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop()); void ctx?.close();
      bars.current.forEach((el) => { if (el) el.style.transform = ''; });
    };
  }, [meter]);
  return (
    <span className={`ad-wave ad-wave-${phase}${meter ? ' metered' : ''}`} aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => <span key={i} ref={(el) => { bars.current[i] = el; }} style={{ animationDelay: `${i * 90}ms` }} />)}
    </span>
  );
}

/** Writes the microphone level (0..1) to `--lvl` on the dock while a conversation is listening. */
function useMicLevel(active: boolean, el: React.RefObject<HTMLElement>) {
  useEffect(() => {
    const node = el.current;
    if (!active || !node || !navigator.mediaDevices?.getUserMedia) return;
    let stream: MediaStream | null = null, ctx: AudioContext | null = null, raf = 0, stopped = false, lvl = 0;
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }).then((st) => {
      if (stopped) { st.getTracks().forEach((t) => t.stop()); return; }
      stream = st; ctx = new AudioContext();
      const an = ctx.createAnalyser(); an.fftSize = 256;
      ctx.createMediaStreamSource(st).connect(an);
      const buf = new Uint8Array(an.frequencyBinCount);
      const tick = () => {
        an.getByteFrequencyData(buf);
        let sum = 0; for (let i = 2; i < 40; i++) sum += buf[i];
        const v = Math.min(1, (sum / 38 / 255) * 2.2);
        lvl += (v - lvl) * 0.35;
        node.style.setProperty('--lvl', lvl.toFixed(3));
        raf = requestAnimationFrame(tick);
      };
      tick();
    }).catch(() => { /* the breathing ring still shows */ });
    return () => { stopped = true; cancelAnimationFrame(raf); stream?.getTracks().forEach((t) => t.stop()); void ctx?.close(); node.style.removeProperty('--lvl'); };
  }, [active, el]);
}

/** The last few words, for the one-line caption. */
const lastWords = (t: string, n = 7) => { const w = t.trim().split(/\s+/).filter(Boolean); return (w.length > n ? '… ' : '') + w.slice(-n).join(' '); };

function Transcript() {
  const turns = useAgent((s) => s.turns);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [turns.length]);
  if (!turns.length) return null;
  return (
    <div className="ad-transcript" role="log" aria-label="Conversation">
      {turns.map((t) => (
        <div key={t.id} className={`ad-turn ad-${t.who}`}>
          <p>{t.text || (t.who === 'agent' ? '…' : '')}</p>
          {t.done && <ul className="ad-done">{t.done.map((d, i) => <li key={i}><Icon name="check" size={12} aria-hidden="true" />{d}</li>)}</ul>}
          {t.products && (
            <ul className="ad-products">
              {t.products.map((p, i) => (
                <li key={i}>
                  <a href={p.url} target="_blank" rel="noreferrer noopener">{p.title}</a>
                  <span>{p.store}{p.price != null ? ` · ${Math.round(p.price).toLocaleString()} ${p.currency}` : ''}</span>
                </li>
              ))}
            </ul>
          )}
          {t.meta && <details className="ad-meta"><summary>Details</summary>{t.meta}</details>}
        </div>
      ))}
      <NoKeyPrompt compact />
      <div ref={end} />
    </div>
  );
}

export function AgentDock({ overlay = true }: { overlay?: boolean } = {}) {
  const s = useAgent();
  const geminiKey = useStore((x) => x.settings.geminiKey);
  // The Gemini voice is optional and measured: it only replaces the browser voice when it starts fast.
  useEffect(() => { if ((geminiKey || apiBase()) && neuralVoiceWanted()) void applyVoicePreference(true); }, [geminiKey]);
  const drawing = useSketch((x) => x.drawing);
  const hasMarks = useSketch((x) => x.marks.length > 0);
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  // The dock rests as a small pill (mic + Ask) and opens into the full bar on demand.
  const [expanded, setExpanded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const ear = useRef<Ear | null>(null);
  const pressAt = useRef(0);
  const [micBlocked, setMicBlocked] = useState(false);
  const supported = recognitionSupported() && !micBlocked;
  const phase = phaseOf(s);
  const [conv, setConv] = useState<ConvState>('off');
  const [heard, setHeard] = useState('');
  const [capVisible, setCapVisible] = useState(false);
  const dockRef = useRef<HTMLDivElement>(null);
  useMicLevel(conv === 'listening', dockRef);

  useEffect(() => { preloadMods(); }, []);
  useEffect(() => setMuted(s.muted), [s.muted]);
  const talk = useRef<Conversation | null>(null);
  useEffect(() => onSpeech((speaking, t) => { useAgent.getState().set({ speaking }); talk.current?.setSpeaking(speaking, t); }), []);

  const send = useCallback((t: string) => { const v = t.trim(); if (v) void runTurn(v); }, []);

  if (!ear.current) {
    ear.current = new Ear({
      onInterim: (t) => {
        if (talk.current?.on) { talk.current.hearInterim(t); return; }
        // Barge-in: the person talking over the agent stops its voice, unless it is the agent's own echo.
        if (t.trim() && isSpeaking() && !isEcho(t, currentSpeech())) stopSpeaking();
        useAgent.getState().set({ interim: t });
      },
      onFinal: (t) => {
        if (talk.current?.on) { talk.current.hearFinal(t); return; }
        if (isSpeaking() && isEcho(t, currentSpeech())) return;
        useAgent.getState().set({ interim: '' });
        send(t);
      },
      onState: (listening) => useAgent.getState().set({ listening, ...(listening ? {} : { interim: '' }) }),
      onError: (error) => {
        talk.current?.end();
        if (/blocked/i.test(error)) setMicBlocked(true);
        useAgent.getState().set({ error, handsFree: false });
      },
    });
  }
  if (!talk.current) {
    talk.current = new Conversation({
      ear: { start: () => ear.current!.start(true), stop: () => ear.current!.stop(), abort: () => ear.current!.abort() },
      runTurn: (t) => runTurn(t),
      stopSpeaking,
      isEcho,
      beforeTurn: () => useSketch.getState().clear('agent'),
      onState: (c) => { setConv(c); useAgent.getState().set({ handsFree: c !== 'off', ...(c === 'off' ? { interim: '' } : {}) }); },
      onCaption: (t) => { setHeard(t); useAgent.getState().set({ interim: t }); },
    });
  }

  const startPtt = useCallback(() => {
    if (useAgent.getState().handsFree) return;
    interrupt();
    useAgent.getState().set({ error: null });
    ear.current!.start(false);
  }, []);
  const stopPtt = useCallback(() => { if (!useAgent.getState().handsFree) ear.current!.stop(); }, []);

  const toggleHandsFree = useCallback(() => {
    const c = talk.current!;
    ear.current!.abort();
    if (c.on) { c.end(); return; }
    useAgent.getState().set({ error: null });
    interrupt();
    c.start();
  }, []);

  // Mic button: hold to talk, or tap to talk until a pause. In hands-free it turns listening off.
  const micDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (s.handsFree) { toggleHandsFree(); return; }
    pressAt.current = Date.now(); startPtt();
  };
  // A short tap starts the conversation; holding talks once and sends on release.
  const micUp = () => {
    if (!pressAt.current) return;
    const held = Date.now() - pressAt.current;
    pressAt.current = 0;
    if (held > 400) stopPtt(); else { ear.current!.abort(); toggleHandsFree(); }
  };

  // V: hold to talk or tap; Esc: stop the agent talking, or leave drawing.
  useEffect(() => {
    const typing = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
    };
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (talk.current?.on) { talk.current.end(); return; }
        if (isSpeaking() || useAgent.getState().thinking) interrupt();
        else if (useSketch.getState().drawing) useSketch.getState().setDrawing(false);
        return;
      }
      const space = e.key === ' ' && !(e.target as HTMLElement | null)?.closest?.('button, a, summary, [role=button]');
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || (e.key.toLowerCase() !== 'v' && !space) || typing(e)) return;
      e.preventDefault();
      if (talk.current?.on) { if (space) stopSpeaking(); return; }
      if (ear.current!.active) { pressAt.current = 0; stopPtt(); } else { pressAt.current = Date.now(); startPtt(); }
    };
    const up = (e: KeyboardEvent) => { if ((e.key.toLowerCase() === 'v' || e.key === ' ') && !typing(e) && pressAt.current && Date.now() - pressAt.current > 400) stopPtt(); };
    const ext = (e: Event) => { const d = (e as CustomEvent<string>).detail; if (typeof d === 'string' && d) send(d); else startPtt(); };
    const vis = () => talk.current?.setPaused(document.hidden);
    window.addEventListener('keydown', down); window.addEventListener('keyup', up);
    window.addEventListener('spacelens:agent', ext); document.addEventListener('visibilitychange', vis);
    return () => { document.removeEventListener('visibilitychange', vis); window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('spacelens:agent', ext); };
  }, [startPtt, stopPtt, send]);

  useEffect(() => () => { talk.current?.end(); ear.current?.abort(); stopSpeaking(); }, []);

  const caption = s.interim || s.caption;
  const inConv = conv !== 'off';
  const line = lastWords(inConv ? (heard || s.caption) : caption);
  // In a conversation the caption is one small line that fades a few seconds after the last words.
  useEffect(() => {
    if (conv === 'off') return;
    setCapVisible(true);
    const t = setTimeout(() => setCapVisible(false), 4000);
    return () => clearTimeout(t);
  }, [conv, heard, s.caption]);
  const submit = (e: React.FormEvent) => { e.preventDefault(); send(text); setText(''); };

  return (
    <>
      {overlay && <SketchOverlay />}
      <div ref={dockRef} className={`agent-dock${open ? ' open' : ''}${expanded || drawing || s.handsFree || !supported ? '' : ' is-pill'}${inConv ? ` in-conv conv-${conv}` : ''}`}>
        {open && <Transcript />}
        {inConv && <div className={`ad-live${capVisible && line ? ' show' : ''}`} aria-live="polite">{line}</div>}
        {(!inConv || s.error) && (caption || s.status || s.error || phase !== 'idle') && (
          <div className="ad-caption">
            <Wave phase={phase} meter={s.listening} />
            <div className="ad-caption-text" aria-live="polite">
              <span className={s.interim ? 'ad-interim' : undefined}>{caption}</span>
              {s.error && !s.status && <small className="ad-error">{s.error}</small>}
            </div>
          </div>
        )}
        <form className="ad-bar" onSubmit={submit}
          onBlur={(e) => {
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
            if (!text.trim() && !open && !drawing && !s.handsFree) setExpanded(false);
          }}>
          <button
            type="button" className={`ad-mic${s.listening ? ' on' : ''}${s.handsFree ? ' free' : ''}`}
            aria-label={s.handsFree ? 'Turn hands-free off' : s.listening ? 'Stop listening' : 'Talk (hold, or press V)'}
            aria-pressed={s.listening}
            title={supported ? 'Hold or tap · V' : 'No voice input in this browser'}
            disabled={!supported}
            onPointerDown={micDown} onPointerUp={micUp} onPointerLeave={micUp}
            onClick={(e) => { if (e.detail === 0) toggleHandsFree(); }}
          >
            {supported
              ? <Icon name="mic" size={20} aria-hidden="true" />
              : <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={GLYPH.micOff} /></svg>}
            {inConv && <span className="ad-orb" aria-hidden="true"><i /><i /><i /></span>}
          </button>
          {!(expanded || drawing || s.handsFree || !supported) && (
            <button type="button" className="ad-ask" onClick={() => { setExpanded(true); setTimeout(() => inputRef.current?.focus(), 0); }}>Ask</button>
          )}
          {(expanded || drawing || s.handsFree || !supported) && <>
          <input
            ref={inputRef}
            className="ad-input" value={text} onChange={(e) => setText(e.target.value)}
            placeholder={drawing ? 'Say what goes here' : 'Type a change'}
            aria-label="Message the design partner"
          />
          {text.trim() && <button type="submit" className="ad-icon" aria-label="Send"><Icon name="send" size={16} aria-hidden="true" /></button>}
          <span className="ad-sep" aria-hidden="true" />
          <button type="button" className={`ad-icon${drawing ? ' on' : ''}`} aria-pressed={drawing} aria-label="Draw on the plan" title="Draw on the plan"
            onClick={() => useSketch.getState().setDrawing(!drawing)}><Glyph d={GLYPH.pencil} /></button>
          {hasMarks && (
            <button type="button" className="ad-icon" aria-label="Clear sketches" title="Clear sketches" onClick={() => useSketch.getState().clear()}>
              <Glyph d={GLYPH.eraser} />
            </button>
          )}
          <button type="button" className={`ad-icon${s.muted ? ' on' : ''}`} aria-pressed={s.muted} aria-label={s.muted ? 'Unmute voice' : 'Mute voice'} title={s.muted ? 'Unmute voice' : 'Mute voice'}
            onClick={() => s.set({ muted: !s.muted })}><Glyph d={s.muted ? GLYPH.speakerOff : GLYPH.speaker} /></button>
          <button type="button" className={`ad-pill${s.handsFree ? ' on' : ''}`} aria-pressed={s.handsFree} disabled={!supported} onClick={toggleHandsFree}
          >Hands-free</button>
          <button type="button" className="ad-icon" aria-expanded={open} aria-label={open ? 'Hide conversation' : 'Show conversation'} onClick={() => setOpen(!open)}>
            <Icon name="chevronDown" size={16} aria-hidden="true" style={{ transform: open ? undefined : 'rotate(180deg)' }} />
          </button>
          </>}
        </form>
      </div>
    </>
  );
}
