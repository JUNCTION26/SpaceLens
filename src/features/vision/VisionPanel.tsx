import { useState, type ReactNode } from 'react';
import { Icon } from '../../ui/icons';
import './vision.css';
import { useStore, getState } from '../../core/store';
import { gemini, fileToInlineData, hasGemini, usage, type GeminiPart } from '../../core/gemini';
import { CATALOG, CATEGORIES, makeItem, findByKeyword } from '../../features/furniture/catalog';
import { findFreeSpot } from '../../features/objects/placement';
import { InspireTool } from './InspireTool';

interface CallInfo { model: string; ms: number; tokens: number }

async function timed<T>(parts: GeminiPart[], opts: Parameters<typeof gemini>[1]): Promise<{ data: T; info: CallInfo }> {
  const t0 = performance.now();
  const before = usage.inputTokens + usage.outputTokens;
  const data = await gemini<T>(parts, opts);
  return { data, info: { model: getState().settings.geminiModel, ms: Math.round(performance.now() - t0), tokens: usage.inputTokens + usage.outputTokens - before } };
}

function PhotoInput({ onFile, label, busy }: { onFile: (f: File) => void; label: string; busy?: boolean }) {
  return (
    <label className="btn" aria-busy={busy} style={busy ? { opacity: 0.5, pointerEvents: 'none' } : undefined}>
      {label}
      <input type="file" accept="image/*" capture="environment" disabled={busy} hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
    </label>
  );
}

// ---------- 1. Furniture from a photo ----------
interface ItemEstimate { category: string; name: string; widthCm: number; depthCm: number; heightCm: number; confidence: number; reasoning: string }

const ITEM_SCHEMA = {
  type: 'OBJECT',
  properties: {
    category: { type: 'STRING', enum: CATEGORIES }, name: { type: 'STRING' },
    widthCm: { type: 'NUMBER' }, depthCm: { type: 'NUMBER' }, heightCm: { type: 'NUMBER' },
    confidence: { type: 'NUMBER' }, reasoning: { type: 'STRING' },
  },
  required: ['category', 'name', 'widthCm', 'depthCm', 'heightCm', 'confidence', 'reasoning'],
};

function FurnitureFromPhoto() {
  const [known, setKnown] = useState('');
  const [est, setEst] = useState<ItemEstimate | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const run = async (file: File) => {
    setBusy(true); setErr(''); setEst(null);
    try {
      const img = await fileToInlineData(file);
      const r = await timed<ItemEstimate>([img, { text: `Identify the main furniture item and estimate its size in cm. If an A4 sheet (21 x 29.7 cm) is visible, use it as scale. ${known ? `Known size from the user: ${known}.` : ''} Confidence is 0 to 1. Keep reasoning to one or two sentences.` }], { json: true, schema: ITEM_SCHEMA });
      setEst(r.data);
    } catch (e) { setErr(String((e as Error).message)); }
    setBusy(false);
  };

  const add = () => {
    if (!est) return;
    const s = getState();
    const entry = CATALOG.find((c) => c.category === est.category) ?? findByKeyword(est.name) ?? findByKeyword(est.category) ?? CATALOG[0];
    const item = { ...makeItem(entry.id), name: est.name, w: est.widthCm / 100, d: est.depthCm / 100, h: est.heightCm / 100, owned: true, priceSek: 0, priceStatus: 'owned' as const, sourceKind: 'photo-inferred' as const };
    const spot = findFreeSpot(s.model, item);
    s.dispatch({ type: 'PLACE_OBJECT', item: { ...item, ...spot } });
    setEst(null);
  };

  const num = (k: 'widthCm' | 'depthCm' | 'heightCm', label: string) => (
    <label>{label} <input type="number" min={1} value={est ? Math.round(est[k]) : 0} onChange={(e) => est && setEst({ ...est, [k]: Number(e.target.value) || 1 })} style={{ width: 70 }} /></label>
  );

  return (
    <div className="vision-body">
      <input aria-label="Known size" placeholder="cm" value={known} onChange={(e) => setKnown(e.target.value)} />
      <PhotoInput label="Photo" busy={busy} onFile={run} />
      {err && <p className="error small">{err}</p>}
      {est && (
        <div className="vision-result">
          <label>Name <input value={est.name} onChange={(e) => setEst({ ...est, name: e.target.value })} /></label>
          <label>Type <select value={est.category} onChange={(e) => setEst({ ...est, category: e.target.value })}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></label>
          {num('widthCm', 'W')} {num('depthCm', 'D')} {num('heightCm', 'H')} <span className="muted">cm</span>
          <details className="small"><summary>More</summary><p className="muted">{est.reasoning}</p></details>
          <button className="btn btn-primary" onClick={add}>Add</button>
        </div>
      )}
    </div>
  );
}

// ---------- 3. Room check ----------
interface Issue { kind: string; detail: string; suggestion: string }
const CHECK_SCHEMA = {
  type: 'OBJECT',
  properties: { issues: { type: 'ARRAY', items: { type: 'OBJECT', properties: { kind: { type: 'STRING' }, detail: { type: 'STRING' }, suggestion: { type: 'STRING' } }, required: ['kind', 'detail', 'suggestion'] } } },
  required: ['issues'],
};

function modelSummary(): string {
  const m = getState().model;
  const lines = [`Ceiling ${m.ceilingM} m.`];
  m.spaces.forEach((s) => {
    const walls = s.polygon.map((p, i) => { const q = s.polygon[(i + 1) % s.polygon.length]; return `wall ${i}: ${Math.hypot(q.x - p.x, q.y - p.y).toFixed(2)} m`; });
    lines.push(`Room "${s.name}": ${walls.join(', ')}.`);
  });
  m.openings.forEach((o) => lines.push(`${o.kind} on wall ${o.wallIndex}, ${o.widthM.toFixed(2)} m wide, centre ${o.offsetM.toFixed(2)} m from wall start.`));
  m.furniture.forEach((f) => lines.push(`${f.name} ${Math.round(f.w * 100)}x${Math.round(f.d * 100)} cm.`));
  return lines.join('\n');
}

function RoomCheck() {
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const run = async (file: File) => {
    setBusy(true); setErr(''); setIssues(null);
    try {
      const img = await fileToInlineData(file);
      const r = await timed<{ issues: Issue[] }>([img, { text: `Compare this room photo with the model below. List clear differences only: missing or extra doors and windows, openings in the wrong place, walls that look wrong, big furniture missing. Kind is a short label.\n\nModel:\n${modelSummary()}` }], { json: true, schema: CHECK_SCHEMA });
      setIssues(r.data.issues);
    } catch (e) { setErr(String((e as Error).message)); }
    setBusy(false);
  };

  return (
    <div className="vision-body">
      <PhotoInput label="Photo" busy={busy} onFile={run} />
      {err && <p className="error small">{err}</p>}
      {issues && (issues.length === 0 ? <p className="small"><Icon name="check" size={16} /><span className="sr-only">No differences</span></p> : (
        <ul className="small">{issues.map((x, i) => <li key={i} title={`${x.detail} ${x.suggestion}`}><strong>{x.kind}</strong></li>)}</ul>
      ))}
    </div>
  );
}

export function VisionPanel() {
  useStore((s) => s.settings.geminiKey);
  if (!hasGemini()) {
    return (
      <div className="panel vision">
        <div className="vision-row on"><InspireTool /></div>
      </div>
    );
  }
  return <VisionTools />;
}

const TOOLS: Array<{ id: string; title: string; icon: string; body: () => ReactNode }> = [
  { id: 'style', title: 'Inspiration', icon: 'palette', body: () => <InspireTool /> },
  { id: 'furniture', title: 'Furniture', icon: 'sofa', body: () => <FurnitureFromPhoto /> },
  { id: 'check', title: 'Compare', icon: 'camera', body: () => <RoomCheck /> },
];

function VisionTools() {
  const [open, setOpen] = useState<string | null>('style');
  return (
    <div className="panel vision">
      {TOOLS.map((t) => (
        <div key={t.id} className={`vision-row${open === t.id ? ' on' : ''}`}>
          <button className="vision-head" aria-expanded={open === t.id} onClick={() => setOpen((o) => (o === t.id ? null : t.id))}>
            <Icon name={t.icon} size={16} />
            <span className="vision-title">{t.title}</span>
            <Icon name={open === t.id ? 'chevronDown' : 'chevronRight'} size={14} />
          </button>
          {open === t.id && t.body()}
        </div>
      ))}
    </div>
  );
}
