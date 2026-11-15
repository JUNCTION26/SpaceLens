import { useRef, useState } from 'react';
import { Icon } from '../../ui/icons';
import { getState, useStore } from '../../core/store';
import { fileToInlineData } from '../../core/gemini';
import type { FurnitureItem } from '../../core/types';
import { paletteFromFile, type Swatch } from './palette';
import { STYLE_PROMPT, STYLE_SCHEMA, cleanReading, planInspiration, styleFromPalette, type Plan, type StyleReading } from './style';

interface Inspiration { id: string; thumb: string; swatches: Swatch[]; reading: StyleReading | null }

const LS = 'spacelens.inspirations.v1';
const loadSaved = (): Inspiration[] => { try { return JSON.parse(localStorage.getItem(LS) ?? '[]'); } catch { return []; } };
const persist = (l: Inspiration[]) => { try { localStorage.setItem(LS, JSON.stringify(l.slice(0, 8))); } catch { /* storage full or blocked */ } };

async function readStyle(file: File): Promise<StyleReading | null> {
  try {
    const { ai, aiReady } = await import('../../core/ai');
    if (!aiReady()) return null;
    const img = await fileToInlineData(file);
    const r = await ai<Partial<StyleReading>>({ task: 'vision', parts: [img, { text: STYLE_PROMPT }], schema: STYLE_SCHEMA, json: true });
    return cleanReading(r.data);
  } catch { return null; }
}

function showFurniture(items: FurnitureItem[]) {
  const m = getState().model;
  useStore.setState({ model: { ...m, furniture: items, version: m.version + 1 } });
}

export function InspireTool() {
  const [saved, setSaved] = useState<Inspiration[]>(loadSaved);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [strength, setStrength] = useState(0.6);
  const [busy, setBusy] = useState(false);
  // The room before the first apply, and the history depth right after it. While the history is unchanged,
  // later strength or picture changes replace the result in place, so the whole thing stays one undo step.
  const applied = useRef<{ base: FurnitureItem[]; pastLen: number; plan: Plan | null } | null>(null);
  const active = saved.find((x) => x.id === activeId) ?? null;

  const apply = (insp: Inspiration, st: number) => {
    const s = getState();
    const live = applied.current && s.past.length === applied.current.pastLen ? applied.current : null;
    const baseModel = live ? { ...s.model, furniture: live.base } : s.model;
    const plan = planInspiration(baseModel, insp.swatches, insp.reading ?? styleFromPalette(insp.swatches), st);
    if (live) { showFurniture(plan.items); live.plan = plan; return; }
    if (!plan.ops.length) return;
    const base = s.model.furniture;
    s.dispatch(plan.ops[0]);
    applied.current = { base, pastLen: getState().past.length, plan };
  };

  const add = async (file: File) => {
    setBusy(true);
    try {
      const { swatches, thumb } = await paletteFromFile(file);
      const insp: Inspiration = { id: `i${Date.now().toString(36)}`, thumb, swatches, reading: null };
      const next = [insp, ...saved].slice(0, 8);
      setSaved(next); setActiveId(insp.id); persist(next); apply(insp, strength);
      const reading = await readStyle(file);
      if (reading) {
        const full = { ...insp, reading };
        const upd = (l: Inspiration[]) => l.map((x) => (x.id === insp.id ? full : x));
        setSaved((l) => { const n = upd(l); persist(n); return n; });
        apply(full, strength);
      }
    } catch { getState().toast('Image failed', 'error'); }
    setBusy(false);
  };

  const pick = (insp: Inspiration) => { setActiveId(insp.id); apply(insp, strength); };
  const remove = (id: string) => { const n = saved.filter((x) => x.id !== id); setSaved(n); persist(n); if (activeId === id) setActiveId(null); };

  const hold = useRef<FurnitureItem[] | null>(null);
  const down = () => { const a = applied.current; if (!a) return; hold.current = getState().model.furniture; showFurniture(a.base); };
  const up = () => { if (hold.current) { showFurniture(hold.current); hold.current = null; } };

  const name = active ? (active.reading ?? styleFromPalette(active.swatches)).style : '';
  return (
    <div className="vision-body inspire">
      <label className="btn" aria-label="Choose inspiration picture">
        <Icon name="palette" size={14} /> {busy ? '...' : 'Picture'}
        <input type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void add(f); e.target.value = ''; }} />
      </label>
      {active && (
        <div className="inspire-card">
          <img src={active.thumb} alt="Inspiration" className="inspire-thumb" />
          <div className="inspire-side">
            <div className="inspire-swatches">{active.swatches.map((s) => <span key={s.hex} title={`${s.role} ${s.hex}`} aria-label={`${s.role} ${s.hex}`} style={{ background: s.hex }} />)}</div>
            <span className="inspire-chip on">{name}</span>
          </div>
        </div>
      )}
      {active && (
        <>
          <label className="inspire-strength" aria-label="Strength">
            <span aria-hidden="true">Subtle</span>
            <input type="range" min={0} max={1} step={0.05} value={strength} onChange={(e) => { const v = Number(e.target.value); setStrength(v); apply(active, v); }} />
            <span aria-hidden="true">Full</span>
          </label>
          <button className="btn" aria-label="Hold to compare with before"
            onPointerDown={down} onPointerUp={up} onPointerLeave={up} onPointerCancel={up}
            onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') down(); }} onKeyUp={(e) => { if (e.key === ' ' || e.key === 'Enter') up(); }}>
            <Icon name="eye" size={14} /> Before
          </button>
        </>
      )}
      {saved.length > 0 && (
        <div className="inspire-chips">
          {saved.map((x) => (
            <span key={x.id} className={`inspire-chip${x.id === activeId ? ' on' : ''}`}>
              <button className="inspire-pick" aria-label={`Apply ${(x.reading ?? styleFromPalette(x.swatches)).style}`} onClick={() => pick(x)}>
                <img src={x.thumb} alt="" />
                {(x.reading ?? styleFromPalette(x.swatches)).style}
              </button>
              <button className="inspire-x" aria-label="Remove" onClick={() => remove(x.id)}>x</button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
