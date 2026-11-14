import { useState } from 'react';
import { useStore, getState } from '../../core/store';
import { gemini, fileToInlineData, hasGemini, usage, type GeminiPart } from '../../core/gemini';
import type { Requirements } from '../../core/types';
import { CATALOG, CATEGORIES, makeItem, findByKeyword } from '../../features/furniture/catalog';
import { findFreeSpot } from '../../features/objects/placement';

interface CallInfo { model: string; ms: number; tokens: number }

async function timed<T>(parts: GeminiPart[], opts: Parameters<typeof gemini>[1]): Promise<{ data: T; info: CallInfo }> {
  const t0 = performance.now();
  const before = usage.inputTokens + usage.outputTokens;
  const data = await gemini<T>(parts, opts);
  return { data, info: { model: getState().settings.geminiModel, ms: Math.round(performance.now() - t0), tokens: usage.inputTokens + usage.outputTokens - before } };
}

function PhotoInput({ onFile, label }: { onFile: (f: File) => void; label: string }) {
  return (
    <label className="btn">
      {label}
      <input type="file" accept="image/*" capture="environment" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
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
    s.toast(`Added ${est.name}`, 'ok');
    setEst(null);
  };

  const num = (k: 'widthCm' | 'depthCm' | 'heightCm', label: string) => (
    <label>{label} <input type="number" min={1} value={est ? Math.round(est[k]) : 0} onChange={(e) => est && setEst({ ...est, [k]: Number(e.target.value) || 1 })} style={{ width: 70 }} /> cm</label>
  );

  return (
    <section className="card">
      <h3>Furniture from photo</h3>
      <p className="muted small">Put an A4 sheet next to it for scale, or type a size you know.</p>
      <input placeholder="Known size, e.g. 200 cm wide" value={known} onChange={(e) => setKnown(e.target.value)} />
      <PhotoInput label={busy ? 'Looking...' : 'Choose photo'} onFile={run} />
      {err && <p className="error small">{err}</p>}
      {est && (
        <div className="card">
          <p className="small"><strong>Estimate, check with a tape</strong> · {Math.round(est.confidence * 100)}% sure</p>
          <label>Name <input value={est.name} onChange={(e) => setEst({ ...est, name: e.target.value })} /></label>
          <label>Type <select value={est.category} onChange={(e) => setEst({ ...est, category: e.target.value })}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></label>
          {num('widthCm', 'W')} {num('depthCm', 'D')} {num('heightCm', 'H')}
          <p className="muted small">{est.reasoning}</p>
          <button className="btn primary" onClick={add}>Add as owned</button>
        </div>
      )}
    </section>
  );
}

// ---------- 2. Style from inspiration ----------
interface StyleResult { style: string; palette: string[]; materials: string[]; suggestedItems: Array<{ catalogId: string; why: string }> }

const STYLE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    style: { type: 'STRING' }, palette: { type: 'ARRAY', items: { type: 'STRING' } }, materials: { type: 'ARRAY', items: { type: 'STRING' } },
    suggestedItems: { type: 'ARRAY', items: { type: 'OBJECT', properties: { catalogId: { type: 'STRING', enum: CATALOG.map((c) => c.id) }, why: { type: 'STRING' } }, required: ['catalogId', 'why'] } },
  },
  required: ['style', 'palette', 'materials', 'suggestedItems'],
};

function blankRequirements(style: string): Requirements {
  return { purpose: '', people: 1, budgetSek: null, items: [], routeTargets: [], minRouteWidthM: 0.8, style, lockedIds: [], notes: [], questions: [], compiledBy: 'gemini' } as Requirements;
}

function StyleMatch() {
  const [res, setRes] = useState<StyleResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const run = async (file: File) => {
    setBusy(true); setErr(''); setRes(null);
    try {
      const img = await fileToInlineData(file);
      const r = await timed<StyleResult>([img, { text: 'Describe the interior style in a few words, a palette of 4 to 6 hex colours (#rrggbb), main materials, and up to 5 catalog items that fit, each with a short reason.' }], { json: true, schema: STYLE_SCHEMA });
      r.data.palette = r.data.palette.filter((h) => /^#[0-9a-f]{6}$/i.test(h));
      setRes(r.data);
    } catch (e) { setErr(String((e as Error).message)); }
    setBusy(false);
  };

  const use = () => {
    if (!res) return;
    const s = getState();
    s.setRequirements(s.requirements ? { ...s.requirements, style: res.style } : blankRequirements(res.style));
    if (res.palette.length) s.model.furniture.forEach((f, i) => s.dispatch({ type: 'UPDATE_OBJECT', id: f.id, patch: { color: res.palette[i % res.palette.length] } }));
    s.toast(`Style set to ${res.style}`, 'ok');
  };

  return (
    <section className="card">
      <h3>Style from photo</h3>
      <PhotoInput label={busy ? 'Looking...' : 'Choose inspiration photo'} onFile={run} />
      {err && <p className="error small">{err}</p>}
      {res && (
        <div>
          <p><strong>{res.style}</strong></p>
          <div style={{ display: 'flex', gap: 4 }}>{res.palette.map((h) => <span key={h} title={h} aria-label={h} style={{ width: 28, height: 28, borderRadius: 4, background: h, border: '1px solid #0003' }} />)}</div>
          {res.materials.length > 0 && <p className="muted small">{res.materials.join(', ')}</p>}
          <ul className="small">{res.suggestedItems.map((s, i) => <li key={i}><strong>{CATALOG.find((c) => c.id === s.catalogId)?.name ?? s.catalogId}</strong>: {s.why}</li>)}</ul>
          <button className="btn primary" onClick={use}>Use this style</button>
        </div>
      )}
    </section>
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
    <section className="card">
      <h3>Compare with photo</h3>
      <PhotoInput label={busy ? 'Comparing...' : 'Choose room photo'} onFile={run} />
      {err && <p className="error small">{err}</p>}
      {issues && (issues.length === 0 ? <p className="small">No clear differences found.</p> : (
        <ul className="small">{issues.map((x, i) => <li key={i}><strong>{x.kind}</strong>: {x.detail} <span className="muted">{x.suggestion}</span></li>)}</ul>
      ))}
    </section>
  );
}

export function VisionPanel() {
  useStore((s) => s.settings.geminiKey);
  if (!hasGemini()) {
    return (
      <div className="panel">
        <h3>Inspire needs a Gemini key</h3>
        <p className="muted">Add a Gemini key in Settings to use these.</p>
      </div>
    );
  }
  return (
    <div className="panel">
      <FurnitureFromPhoto />
      <StyleMatch />
      <RoomCheck />
    </div>
  );
}
