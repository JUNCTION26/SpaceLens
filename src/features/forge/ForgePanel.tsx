import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { shortModel } from '../../core/ai';
import { useStore } from '../../core/store';
import type { ObjectSpec } from '../../core/types';
import { Icon } from '../../ui/icons';
import { generateObject } from './generate';
import { dominantColor, FORGE_RESULT_EVENT, placeSpec, useForgeLibrary, variation } from './library';
import { semanticLine } from './rulesFallback';
import { ForgePreview } from './ForgePreview';
import './forge.css';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Rec = { lang: string; interimResults: boolean; continuous: boolean; start(): void; stop(): void; abort(): void; onresult: ((e: any) => void) | null; onend: (() => void) | null; onerror: ((e: any) => void) | null };
const RecCtor = (): (new () => Rec) | undefined =>
  typeof window === 'undefined' ? undefined : ((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition);


const cm = (m: number) => Math.round(m * 100);
const dims = (s: ObjectSpec['size']) => `${cm(s.w)} × ${cm(s.d)} × ${cm(s.h)} cm`;
const timing = (s: ObjectSpec) => `${s.model === 'rules' ? 'Templates' : `Gemini · ${shortModel(s.model)}`} · ${(s.latencyMs / 1000).toFixed(1)} s`;

export function ForgePanel() {
  const toast = useStore((s) => s.toast);
  const { items, save, rename, remove } = useForgeLibrary();
  const [prompt, setPrompt] = useState('');
  const [refine, setRefine] = useState('');
  const [spec, setSpec] = useState<ObjectSpec | null>(null);
  const [busy, setBusy] = useState<null | 'new' | 'refine'>(null);
  const [open, setOpen] = useState(false);
  const [listening, setListening] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const rec = useRef<Rec | null>(null);

  const run = useCallback(async (kind: 'new' | 'refine', text: string) => {
    const t = text.trim();
    if (!t || (kind === 'refine' && !spec)) return;
    abort.current?.abort();
    const ctl = new AbortController(); abort.current = ctl;
    setBusy(kind); setOpen(false);
    if (kind === 'new') setSpec(null);
    const onPartial = (p: ObjectSpec) => { if (!ctl.signal.aborted) setSpec(p); };
    try {
      const out = kind === 'new' ? await generateObject(t, { onPartial, signal: ctl.signal }) : await variation(spec!, t, { onPartial, signal: ctl.signal });
      if (ctl.signal.aborted) return;
      setSpec(out); save(out);
      if (kind === 'refine') setRefine('');
    } catch {
      if (!ctl.signal.aborted) toast('Could not build that object', 'error');
    } finally {
      if (abort.current === ctl) { setBusy(null); abort.current = null; }
    }
  }, [spec, save, toast]);

  useEffect(() => {
    const onResult = (e: Event) => { const s = (e as CustomEvent<ObjectSpec>).detail; if (s) { setSpec(s); setOpen(false); } };
    window.addEventListener(FORGE_RESULT_EVENT, onResult);
    return () => { window.removeEventListener(FORGE_RESULT_EVENT, onResult); abort.current?.abort(); rec.current?.abort(); };
  }, []);

  const toggleMic = () => {
    if (rec.current) { rec.current.stop(); return; }
    const C = RecCtor();
    if (!C) { toast('Voice is not supported in this browser', 'warn'); return; }
    const r = new C();
    r.lang = navigator.language || 'en-US'; r.interimResults = true; r.continuous = false;
    let said = '';
    r.onresult = (e: any) => { said = Array.from(e.results as ArrayLike<any>).map((x: any) => x[0].transcript).join(''); setPrompt(said); };
    r.onerror = (e: any) => { if (e?.error === 'not-allowed') toast('Microphone access was blocked', 'warn'); };
    r.onend = () => { rec.current = null; setListening(false); if (said.trim()) void run('new', said); };
    rec.current = r;
    try { r.start(); setListening(true); } catch { rec.current = null; }
  };

  const submit = (e: FormEvent) => { e.preventDefault(); void run('new', prompt); };
  const place = (s: ObjectSpec) => { placeSpec(s); toast(`Placed ${s.name}`, 'ok'); };
  const done = spec && !busy;

  return (
    <div className="forge">
      <form className="forge-ask" onSubmit={submit}>
        <input
          value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Describe any object"
          aria-label="Describe any object, with sizes if you know them" autoComplete="off" enterKeyHint="go"
        />
        <button type="button" className={`icon-btn forge-mic${listening ? ' on' : ''}`} onClick={toggleMic} aria-pressed={listening} aria-label={listening ? 'Stop listening' : 'Speak'}>
          <Icon name="mic" />
        </button>
        <button type="submit" className="icon-btn" disabled={!prompt.trim() || busy === 'new'} aria-label="Build">
          <Icon name="send" />
        </button>
      </form>

      <ForgePreview spec={spec} assembling={!!busy} open={open} />

      <div className="forge-meta" aria-live="polite">
        {spec ? (
          <>
            <div className="forge-title">
              <strong>{spec.name}</strong>
              {busy && <span className="forge-dims">{dims(spec.size)}</span>}
            </div>
            <div className="muted">{busy ? 'Building…' : semanticLine(spec.semantics)}</div>
          </>
        ) : busy ? <div className="muted">Building…</div> : null}
      </div>

      {done && (
        <>
          <div className="forge-actions">
            <button type="button" className="btn btn-primary" onClick={() => place(spec)}><Icon name="plus" /> Place in room</button>
            {!!spec.motions?.length && (
              <button type="button" className="btn" aria-pressed={open} onClick={() => setOpen((o) => !o)}>{open ? 'Close' : spec.motions[0].label || 'Open'}</button>
            )}
          </div>
          <form className="forge-ask" onSubmit={(e) => { e.preventDefault(); void run('refine', refine); }}>
            <input value={refine} onChange={(e) => setRefine(e.target.value)} placeholder="Refine…" aria-label="Refine this object, e.g. 20 cm wider or in walnut" autoComplete="off" />
            <button type="submit" className="icon-btn" disabled={!refine.trim()} aria-label="Apply change"><Icon name="sparkles" /></button>
          </form>
          <div className="forge-timing">{timing(spec)}</div>
        </>
      )}

      {items.length > 0 && (
        <section className="forge-lib" aria-label="My objects">
          <h3>My objects</h3>
          <ul>
            {items.map((s) => (
              <li key={s.id} className={spec?.id === s.id ? 'on' : undefined}>
                <button type="button" className="forge-tile" onClick={() => { setSpec(s); setOpen(false); }} title={s.prompt}>
                  <span className="forge-swatch" style={{ background: dominantColor(s) }} aria-hidden="true" />
                  {renaming === s.id ? null : <span className="forge-tile-name">{s.name}</span>}
                  <span className="forge-tile-dims">{dims(s.size)}</span>
                </button>
                {renaming === s.id && (
                  <input
                    className="forge-rename" defaultValue={s.name} autoFocus aria-label="Object name"
                    onBlur={(e) => { rename(s.id, e.target.value); setRenaming(null); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(null); }}
                  />
                )}
                <div className="forge-tile-actions">
                  <button type="button" className="icon-btn" onClick={() => place(s)} aria-label={`Place ${s.name}`} title="Place in room"><Icon name="plus" /></button>
                  <button type="button" className="icon-btn" onClick={() => setRenaming(s.id)} aria-label={`Rename ${s.name}`} title="Rename"><Icon name="file" /></button>
                  <button type="button" className="icon-btn" onClick={() => remove(s.id)} aria-label={`Delete ${s.name}`} title="Delete"><Icon name="trash" /></button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
