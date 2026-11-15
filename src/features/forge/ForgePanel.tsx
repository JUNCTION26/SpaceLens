import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { MaterialId, ObjectSpec } from '../../core/types';
import { Icon } from '../../ui/icons';
import { editObject, generateObject } from './generate';
import { fitSpec } from './fit';
import { dominantColor, FORGE_RESULT_EVENT, placeSpec, useForgeLibrary } from './library';
import { swatchColor } from './materials';
import { ForgePreview } from './ForgePreview';
import './forge.css';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Rec = { lang: string; interimResults: boolean; continuous: boolean; start(): void; stop(): void; abort(): void; onresult: ((e: any) => void) | null; onend: (() => void) | null; onerror: ((e: any) => void) | null };
const RecCtor = (): (new () => Rec) | undefined =>
  typeof window === 'undefined' ? undefined : ((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition);

const SWATCHES: readonly MaterialId[] = ['oak', 'walnut', 'white-laminate', 'black-metal', 'steel', 'fabric', 'leather'];
const AXES = [['w', 'W'], ['d', 'D'], ['h', 'H']] as const;
const cm = (m: number) => String(Math.round(m * 100));

/** Material that covers the most volume. */
function mainMaterialId(spec: ObjectSpec): MaterialId | undefined {
  const vol = new Map<MaterialId, number>();
  for (const p of spec.parts) vol.set(p.material, (vol.get(p.material) ?? 0) + p.size[0] * p.size[1] * p.size[2]);
  return [...vol.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

export function ForgePanel() {
  const [failed, setFailed] = useState(false);
  const { items, save, rename, remove } = useForgeLibrary();
  const [prompt, setPrompt] = useState('');
  const [change, setChange] = useState('');
  const [spec, setSpec] = useState<ObjectSpec | null>(null);
  const [busy, setBusy] = useState<null | 'new' | 'change'>(null);
  const [open, setOpen] = useState(false);
  const [listening, setListening] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState({ w: '', d: '', h: '' });
  const abort = useRef<AbortController | null>(null);
  const rec = useRef<Rec | null>(null);

  const run = useCallback(async (kind: 'new' | 'change', text: string) => {
    const t = text.trim();
    if (!t || (kind === 'change' && !spec)) return;
    abort.current?.abort();
    const ctl = new AbortController(); abort.current = ctl;
    setBusy(kind); setOpen(false); setFailed(false);
    if (kind === 'new') setSpec(null);
    const onPartial = (p: ObjectSpec) => { if (!ctl.signal.aborted) setSpec(p); };
    try {
      const out = kind === 'new' ? await generateObject(t, { onPartial, signal: ctl.signal }) : await editObject(spec!, t, { onPartial, signal: ctl.signal });
      if (ctl.signal.aborted) return;
      setSpec(out); save(out);
      if (kind === 'change') setChange('');
    } catch {
      if (!ctl.signal.aborted) setFailed(true);
    } finally {
      if (abort.current === ctl) { setBusy(null); abort.current = null; }
    }
  }, [spec, save]);

  useEffect(() => {
    const onResult = (e: Event) => { const s = (e as CustomEvent<ObjectSpec>).detail; if (s) { setSpec(s); setOpen(false); } };
    window.addEventListener(FORGE_RESULT_EVENT, onResult);
    return () => { window.removeEventListener(FORGE_RESULT_EVENT, onResult); abort.current?.abort(); rec.current?.abort(); };
  }, []);

  useEffect(() => {
    if (spec) setDraft({ w: cm(spec.size.w), d: cm(spec.size.d), h: cm(spec.size.h) });
  }, [spec?.id, spec?.size.w, spec?.size.d, spec?.size.h]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleMic = () => {
    if (rec.current) { rec.current.stop(); return; }
    const C = RecCtor();
    if (!C) return;
    const r = new C();
    r.lang = navigator.language || 'en-US'; r.interimResults = true; r.continuous = false;
    let said = '';
    r.onresult = (e: any) => { said = Array.from(e.results as ArrayLike<any>).map((x: any) => x[0].transcript).join(''); setPrompt(said); };
    r.onerror = () => { setFailed(true); };
    r.onend = () => { rec.current = null; setListening(false); if (said.trim()) void run('new', said); };
    rec.current = r;
    try { r.start(); setListening(true); } catch { rec.current = null; }
  };

  const commitSize = () => {
    if (!spec) return;
    const next = { ...spec.size };
    for (const [k] of AXES) {
      const v = parseFloat(draft[k]);
      if (Number.isFinite(v) && v >= 2 && v <= 800) next[k] = v / 100;
    }
    if (AXES.every(([k]) => Math.abs(next[k] - spec.size[k]) < 0.0005)) { setDraft({ w: cm(spec.size.w), d: cm(spec.size.d), h: cm(spec.size.h) }); return; }
    const out = fitSpec(spec, next);
    setSpec(out); save(out);
  };

  const recolor = (id: MaterialId) => {
    if (!spec) return;
    const from = mainMaterialId(spec);
    if (!from || from === id) return;
    const out: ObjectSpec = { ...spec, parts: spec.parts.map((p) => (p.material === from ? { ...p, material: id, color: undefined } : p)) };
    setSpec(out); save(out);
  };

  const place = (s: ObjectSpec) => { save(s); placeSpec(s); };
  const submit = (e: FormEvent) => { e.preventDefault(); void run('new', prompt); };
  const done = spec && !busy;
  const main = spec ? mainMaterialId(spec) : undefined;

  return (
    <div className="forge">
      <form className="forge-ask" onSubmit={submit} data-guide="create">
        <input
          value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Describe"
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

      {failed && <div className="forge-fail" role="alert"><Icon name="alert" /><span className="sr-only">Failed</span></div>}

      {done && (
        <>
          <div className="forge-row">
            <div className="forge-dimsrow" role="group" aria-label="Size in centimetres">
              {AXES.map(([k, label]) => (
                <label key={k} className="forge-dim">
                  <span>{label}</span>
                  <input
                    type="number" inputMode="decimal" min={2} max={800} step={1} value={draft[k]}
                    onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
                    onBlur={commitSize}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                    aria-label={`${label === 'W' ? 'Width' : label === 'D' ? 'Depth' : 'Height'} in cm`}
                  />
                </label>
              ))}
              <span className="forge-unit">cm</span>
            </div>
          </div>
          <div className="forge-swatches" role="group" aria-label="Material">
            {SWATCHES.map((id) => (
              <button
                key={id} type="button" className={`forge-mat${main === id ? ' on' : ''}`} style={{ background: swatchColor(id) }}
                onClick={() => recolor(id)} aria-pressed={main === id} aria-label={id.replace('-', ' ')} title={id.replace('-', ' ')}
              />
            ))}
          </div>
          <div className="forge-actions">
            <button type="button" className="btn btn-primary" onClick={() => place(spec)}><Icon name="plus" /> Place</button>
            {!!spec.motions?.length && (
              <button type="button" className="btn" aria-pressed={open} onClick={() => setOpen((o) => !o)}>Open</button>
            )}
          </div>
          <form className="forge-ask" onSubmit={(e) => { e.preventDefault(); void run('change', change); }}>
            <input value={change} onChange={(e) => setChange(e.target.value)} placeholder="Change" aria-label="Change this object, e.g. 20 cm wider or in walnut" autoComplete="off" />
            <button type="submit" className="icon-btn" disabled={!change.trim()} aria-label="Apply change"><Icon name="send" /></button>
          </form>
        </>
      )}

      {items.length > 0 && (
        <>
          <details className="forge-more">
            <summary>More</summary>
            <ul>
              {items.map((s) => (
                <li key={s.id} className={spec?.id === s.id ? 'on' : undefined}>
                  <button type="button" className="forge-tile" onClick={() => { setSpec(s); setOpen(false); }} title={s.prompt}>
                    <span className="forge-swatch" style={{ background: dominantColor(s) }} aria-hidden="true" />
                    {renaming === s.id ? null : <span className="forge-tile-name">{s.name}</span>}
                  </button>
                  {renaming === s.id && (
                    <input
                      className="forge-rename" defaultValue={s.name} autoFocus aria-label="Object name"
                      onBlur={(e) => { rename(s.id, e.target.value); setRenaming(null); }}
                      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(null); }}
                    />
                  )}
                  <div className="forge-tile-actions">
                    <button type="button" className="icon-btn" onClick={() => place(s)} aria-label={`Place ${s.name}`} title="Place"><Icon name="plus" /></button>
                    <button type="button" className="icon-btn" onClick={() => setRenaming(s.id)} aria-label={`Rename ${s.name}`} title="Rename"><Icon name="file" /></button>
                    <button type="button" className="icon-btn" onClick={() => remove(s.id)} aria-label={`Delete ${s.name}`} title="Delete"><Icon name="trash" /></button>
                  </div>
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
    </div>
  );
}
