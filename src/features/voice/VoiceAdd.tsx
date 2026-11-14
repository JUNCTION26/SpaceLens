import { useCallback, useEffect, useRef, useState } from 'react';
import { add, dist, mul, wallInwardNormal, wallSegment } from '../../core/geometry';
import { gemini, hasGemini } from '../../core/gemini';
import { getState, useStore } from '../../core/store';
import type { FurnitureItem, Op, SpaceModel } from '../../core/types';
import { Icon } from '../../ui/icons';
import { catalogEntry, findByKeyword, makeItem } from '../furniture/catalog';
import { findFreeSpot, rotationFacing, snapToWall, wallCompass } from '../objects/placement';
import { colorHex, fieldCount, parseSpoken, validate, type SpokenCommand, type VoiceWall } from './parse';
import { generateObject } from '../forge/generate';
import { FORGE_RESULT_EVENT, placeSpec, useForgeLibrary } from '../forge/library';
import { hasCustomDetail, isCreateCommand, parseRequest } from '../forge/parseRequest';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Rec = { lang: string; interimResults: boolean; continuous: boolean; start(): void; stop(): void; abort(): void; onresult: ((e: any) => void) | null; onend: (() => void) | null; onerror: ((e: any) => void) | null };
const RecCtor = (): (new () => Rec) | undefined =>
  typeof window === 'undefined' ? undefined : ((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition);

const SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['add', 'resize', 'move', 'rotate', 'delete', 'undo'] },
    category: { type: 'string' }, qty: { type: 'integer' },
    w: { type: 'number' }, d: { type: 'number' }, h: { type: 'number' },
    color: { type: 'string' }, wall: { type: 'string', enum: ['north', 'south', 'east', 'west', 'window', 'door'] },
  },
  required: ['action', 'category', 'qty'],
};

async function interpret(text: string): Promise<SpokenCommand | null> {
  const rules = parseSpoken(text);
  if (!hasGemini() || rules?.action === 'undo') return rules;
  try {
    const g = await gemini<Partial<SpokenCommand>>([{ text }], {
      json: true, schema: SCHEMA, timeoutMs: 6000,
      system: 'Turn a spoken furniture command (any language) into JSON. Dimensions in metres (w width, d depth, h height). category is a single English furniture word like sofa, desk, chair, bed, rug, table. Left wall = west, right = east, back = north, front = south. qty defaults to 1.',
    });
    const gv = validate(g);
    if (gv && !gv.catalogId) gv.catalogId = findByKeyword(gv.category)?.id;
    if (gv?.catalogId && fieldCount(gv) > fieldCount(rules)) return { ...gv, category: catalogEntry(gv.catalogId)?.category ?? gv.category };
  } catch { /* fall back to rules */ }
  return rules;
}

const cm = (m: number) => Math.round(m * 100);

/** "Add/create/make ..." with custom detail (materials, features, shape) or no catalogue match goes to the forge. */
function wantsForge(text: string): boolean {
  if (!isCreateCommand(text)) return false;
  return hasCustomDetail(parseRequest(text)) || !findByKeyword(text);
}

/** Build a custom object to the spoken words and place it (quantity copies). */
async function forge(text: string, onProgress: (t: string) => void): Promise<{ text: string; steps: number }> {
  const spec = await generateObject(text, { onPartial: (p) => onProgress(`Building ${p.name} · ${p.parts.length} parts`) });
  useForgeLibrary.getState().save(spec);
  window.dispatchEvent(new CustomEvent(FORGE_RESULT_EVENT, { detail: spec }));
  const qty = Math.min(8, Math.max(1, parseRequest(text).qty));
  for (let i = 0; i < qty; i++) placeSpec(spec);
  return { text: `Built ${qty > 1 ? `${qty} × ` : ''}${spec.name} ${cm(spec.size.w)} × ${cm(spec.size.d)} cm`, steps: qty };
}

/** Pose against the requested wall (centred on it), refined with snapToWall. */
function wallPose(model: SpaceModel, item: FurnitureItem, wall: VoiceWall) {
  let target: { spaceId: string; wallIndex: number } | undefined;
  if (wall === 'window' || wall === 'door') {
    const o = model.openings.find((x) => x.kind === wall);
    if (o) target = { spaceId: o.spaceId, wallIndex: o.wallIndex };
  } else {
    let bestLen = 0;
    for (const s of model.spaces) for (let i = 0; i < s.polygon.length; i++) {
      if (wallCompass(wallInwardNormal(s, i)) !== wall) continue;
      const [a, b] = wallSegment(s, i); const L = dist(a, b);
      if (L > bestLen) { bestLen = L; target = { spaceId: s.id, wallIndex: i }; }
    }
  }
  const s = target && model.spaces.find((x) => x.id === target!.spaceId);
  if (!s || !target) return null;
  const [a, b] = wallSegment(s, target.wallIndex);
  const n = wallInwardNormal(s, target.wallIndex);
  const c = add(mul(add(a, b), 0.5), mul(n, item.d / 2 + 0.02));
  const pose = { x: c.x, y: c.y, rotation: rotationFacing(n) };
  return snapToWall(model, { ...item, ...pose }) ?? pose;
}

function findTarget(category: string): FurnitureItem | undefined {
  const { model, selection } = getState();
  const items = model.furniture.filter((f) => f.category === category || f.name.toLowerCase().includes(category));
  return items.find((f) => selection?.kind === 'furniture' && f.id === selection.id) ?? items[items.length - 1];
}

/** Apply a command; returns the confirmation text and how many undo steps it took. */
function apply(cmd: SpokenCommand): { text: string; steps: number } {
  const st = getState();
  if (cmd.action === 'undo') { st.undo(); return { text: 'Undone', steps: 0 }; }
  const run = (op: Op) => getState().dispatch(op);
  if (cmd.action === 'add') {
    const id = cmd.catalogId ?? findByKeyword(cmd.category)?.id;
    if (!id) return { text: `No ${cmd.category} in the catalog`, steps: 0 };
    let last: FurnitureItem | null = null;
    for (let i = 0; i < cmd.qty; i++) {
      const base = makeItem(id);
      const item: FurnitureItem = { ...base, w: cmd.w ?? base.w, d: cmd.d ?? base.d, h: cmd.h ?? base.h, sourceKind: 'manual' };
      const hex = cmd.color && colorHex(cmd.color); if (hex) item.color = hex;
      const model = getState().model;
      Object.assign(item, findFreeSpot(model, item));
      if (cmd.wall) { const p = wallPose(model, item, cmd.wall); if (p) Object.assign(item, p); }
      run({ type: 'PLACE_OBJECT', item }); last = item;
    }
    const name = (cmd.qty > 1 ? `${cmd.qty} × ` : '') + last!.name;
    return { text: `Added ${name} ${cm(last!.w)} × ${cm(last!.d)} cm`, steps: cmd.qty };
  }
  const t = findTarget(cmd.category);
  if (!t) return { text: `No ${cmd.category} in the room`, steps: 0 };
  if (cmd.action === 'delete') { run({ type: 'REMOVE_OBJECT', id: t.id }); return { text: `Deleted ${t.name}`, steps: 1 }; }
  if (cmd.action === 'rotate') { run({ type: 'UPDATE_OBJECT', id: t.id, patch: { rotation: t.rotation + Math.PI / 2 } }); return { text: `Rotated ${t.name}`, steps: 1 }; }
  if (cmd.action === 'move') {
    if (!cmd.wall) return { text: `Where should the ${t.name} go?`, steps: 0 };
    const p = wallPose(st.model, t, cmd.wall);
    if (!p) return { text: `No ${cmd.wall} wall found`, steps: 0 };
    run({ type: 'UPDATE_OBJECT', id: t.id, patch: p });
    return { text: `Moved ${t.name} to the ${cmd.wall} wall`, steps: 1 };
  }
  const patch: Partial<FurnitureItem> = {};
  if (cmd.w) patch.w = cmd.w; if (cmd.d) patch.d = cmd.d; if (cmd.h) patch.h = cmd.h;
  const hex = cmd.color && colorHex(cmd.color); if (hex) patch.color = hex;
  if (!Object.keys(patch).length) return { text: `What size should the ${t.name} be?`, steps: 0 };
  run({ type: 'UPDATE_OBJECT', id: t.id, patch });
  return { text: `Resized ${t.name} to ${cm(patch.w ?? t.w)} × ${cm(patch.d ?? t.d)} cm`, steps: 1 };
}

export function VoiceAdd() {
  const undo = useStore((s) => s.undo);
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [result, setResult] = useState<{ text: string; steps: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const rec = useRef<Rec | null>(null);
  const finalText = useRef('');
  const pressAt = useRef(0);
  const supported = Boolean(RecCtor());

  const handle = useCallback(async (text: string) => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      if (wantsForge(text)) { setResult(await forge(text, setTranscript)); return; }
      const cmd = await interpret(text);
      setResult(cmd ? apply(cmd) : { text: `Didn't catch that: "${text}"`, steps: 0 });
    } finally { setBusy(false); }
  }, []);

  const stop = useCallback(() => { rec.current?.stop(); }, []);
  const start = useCallback(() => {
    const C = RecCtor();
    if (!C) { setResult({ text: 'Voice not supported in this browser', steps: 0 }); return; }
    if (rec.current) return;
    const r = new C();
    r.lang = navigator.language || 'en-US'; r.interimResults = true; r.continuous = false;
    finalText.current = ''; setTranscript(''); setResult(null);
    r.onresult = (e: any) => {
      let all = '';
      for (let i = 0; i < e.results.length; i++) all += e.results[i][0].transcript;
      setTranscript(all); finalText.current = all;
    };
    r.onerror = (e: any) => { if (e?.error === 'not-allowed') setResult({ text: 'Microphone access was blocked', steps: 0 }); };
    r.onend = () => { rec.current = null; setListening(false); void handle(finalText.current); };
    rec.current = r;
    try { r.start(); setListening(true); } catch { rec.current = null; }
  }, [handle]);
  const toggle = useCallback(() => (rec.current ? stop() : start()), [start, stop]);

  // V: hold to talk, or tap to toggle. Ignored while typing in a field.
  useEffect(() => {
    const typing = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
    };
    const down = (e: KeyboardEvent) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.key.toLowerCase() !== 'v' || typing(e)) return;
      e.preventDefault(); pressAt.current = Date.now(); toggle();
    };
    const up = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'v' && !typing(e) && Date.now() - pressAt.current > 400) stop();
    };
    const ext = () => start();
    window.addEventListener('keydown', down); window.addEventListener('keyup', up);
    window.addEventListener('spacelens:voice', ext);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('spacelens:voice', ext); };
  }, [toggle, start, stop]);

  useEffect(() => () => rec.current?.abort(), []);

  const undoResult = () => { if (result) for (let i = 0; i < result.steps; i++) undo(); setResult(null); };
  const bubble = listening ? transcript || 'Listening…' : busy ? transcript || 'Working…' : result?.text;

  return (
    <div style={{ position: 'absolute', right: 16, bottom: 16, zIndex: 20, display: 'flex', alignItems: 'flex-end', gap: 8, pointerEvents: 'none' }}>
      {bubble && (
        <div role="status" aria-live="polite" style={{
          pointerEvents: 'auto', maxWidth: 300, padding: '8px 12px', borderRadius: 'var(--radius, 10px)', background: 'var(--panel)',
          color: 'var(--text)', border: '1px solid var(--line)', boxShadow: 'var(--shadow)', fontSize: 13, display: 'flex', gap: 10, alignItems: 'center',
        }}>
          <span style={{ color: listening ? 'var(--muted)' : undefined }}>{bubble}</span>
          {!listening && !busy && result && result.steps > 0 && (
            <button type="button" onClick={undoResult} style={{ background: 'none', border: 0, color: 'var(--accent)', cursor: 'pointer', font: 'inherit', fontWeight: 600, padding: 0 }}>Undo</button>
          )}
        </div>
      )}
      <button
        type="button"
        aria-label={listening ? 'Stop listening' : 'Voice command (V)'}
        aria-pressed={listening}
        title={supported ? 'Voice command — hold or tap, or press V' : 'Voice not supported in this browser'}
        onPointerDown={() => { if (rec.current) { pressAt.current = 0; stop(); } else { pressAt.current = Date.now(); start(); } }}
        onPointerUp={() => { if (pressAt.current && Date.now() - pressAt.current > 400) stop(); }}
        onClick={(e) => { if (e.detail === 0) toggle(); }}
        style={{
          pointerEvents: 'auto', width: 44, height: 44, borderRadius: '50%', border: '1px solid var(--line)', cursor: 'pointer',
          display: 'grid', placeItems: 'center', boxShadow: 'var(--shadow)',
          background: listening ? 'var(--accent)' : 'var(--panel)', color: listening ? 'var(--accent-ink)' : 'var(--text)',
          opacity: supported ? 1 : 0.6,
        }}
      >
        <Icon name="mic" size={20} aria-hidden="true" />
      </button>
    </div>
  );
}
