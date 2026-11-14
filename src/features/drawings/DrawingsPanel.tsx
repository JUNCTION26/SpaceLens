import { Icon } from '../../ui/icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../core/store';
import { gemini, hasGemini, usage, dataUrlToInlineData } from '../../core/gemini';
import { emptyModel } from '../../core/sample';
import { signedArea, uid } from '../../core/geometry';
import type { Evidence, Measurement, Space, Vec2, WallMeta } from '../../core/types';
import { cropRegion, downscale, indexStats, loadImage, loadPdf, saveSummary, type DrawingDoc, type TextItem } from './drawingIndex';
import { answerFromIndex, type Answer, type Region } from './answer';
import { drawingToBuilding, type BuildReport } from './toBuilding';
import { answerFromGeometry } from './geoAnswer';
import { buildFromProposals, cleanProposals, PROPOSAL_PROMPT, PROPOSAL_SCHEMA, scaleFromAreas, type RoomProposal } from './rasterRooms';
import type { SpaceModel } from '../../core/types';
import './drawings.css';

type Tool = 'pan' | 'calibrate' | 'trace';
interface Pt { x: number; y: number } // normalised page coords

const docCache = new Map<string, DrawingDoc>();
type QA = Answer & { tokens?: number; cached?: boolean; check?: { index: number; model: number; ok: boolean } };
const answerCache = new Map<string, QA>();
const OVERLAY_KINDS = ['room', 'area', 'dimension', 'scale', 'tag'] as const;
let lastDoc: DrawingDoc | null = null;

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    answer: { type: 'STRING' },
    value: { type: 'NUMBER' },
    unit: { type: 'STRING' },
    kind: { type: 'STRING', enum: ['printed', 'calculated', 'inferred'] },
    regions: { type: 'ARRAY', items: { type: 'OBJECT', properties: { x: { type: 'NUMBER' }, y: { type: 'NUMBER' }, w: { type: 'NUMBER' }, h: { type: 'NUMBER' } }, required: ['x', 'y', 'w', 'h'] } },
  },
  required: ['answer', 'kind', 'regions'],
};

export function DrawingsPanel() {
  const dispatch = useStore((s) => s.dispatch);
  const setMode = useStore((s) => s.setMode);
  const toast = useStore((s) => s.toast);
  const [doc, setDoc] = useState<DrawingDoc | null>(lastDoc);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState<string | null>(null);
  const [samples, setSamples] = useState<Array<{ name: string; url: string }>>([]);
  const [tool, setTool] = useState<Tool>('pan');
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [answers, setAnswers] = useState<QA[]>([]);
  const [crops, setCrops] = useState<Record<string, string[]>>({});
  const [focus, setFocus] = useState<Region[] | null>(null);
  const [q, setQ] = useState('');
  const [asking, setAsking] = useState(false);
  const [stats, setStats] = useState({ asked: 0, free: 0 });
  const [calPts, setCalPts] = useState<Pt[]>([]);
  const [calDist, setCalDist] = useState('');
  const [mPerPx, setMPerPx] = useState<Record<number, number>>({});
  const [trace, setTrace] = useState<Pt[]>([]);
  const [roomName, setRoomName] = useState('Traced room');
  const [overlay, setOverlay] = useState(false);
  const [hover, setHover] = useState<Region | null>(null);
  const [anim, setAnim] = useState(false);
  const [stageSize, setStageSize] = useState({ w: 1, h: 1 });
  const [buildBench, setBuildBench] = useState<{ plans: number; convertedPct: number; within2PctPct: number; medianMsPerPlan: number } | null>(null);
  const [bench, setBench] = useState<{ accuracyOnAnswered: number; coverage: number; questions: number; files: number; dataset: string } | null>(null);
  const [built, setBuilt] = useState<{ page: number; model: SpaceModel; report: BuildReport } | null>(null);
  const [building, setBuilding] = useState(false);
  const [pickRoom, setPickRoom] = useState<string | null>(null);
  const [proposals, setProposals] = useState<RoomProposal[] | null>(null);
  const setView = useStore((s) => s.setView);
  const stageRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  const pg = doc?.pages[page];
  const scaleItems = useMemo(() => (doc?.items ?? []).filter((i) => i.kind === 'scale' && i.page === page), [doc, page]);
  const dims = useMemo(() => (doc?.items ?? []).filter((i) => i.kind === 'dimension' && i.page === page), [doc, page]);
  const mpp = mPerPx[page];
  const pageItems = useMemo(() => (doc?.items ?? []).filter((i) => i.page === page && (OVERLAY_KINDS as readonly string[]).includes(i.kind)), [doc, page]);
  const roomList = useMemo(() => {
    const areas = pageItems.filter((i) => i.kind === 'area');
    return pageItems.filter((i) => i.kind === 'room').map((r) => {
      const a = areas.map((x) => ({ x, d: Math.hypot(x.x - r.x, x.y - r.y) })).filter((z) => z.d < 0.08).sort((m, n) => m.d - n.d)[0]?.x;
      return { r, area: a?.value };
    });
  }, [pageItems]);

  useEffect(() => {
    const el = stageRef.current; if (!el) return;
    const ro = new ResizeObserver(() => setStageSize({ w: el.clientWidth || 1, h: el.clientHeight || 1 }));
    ro.observe(el); return () => ro.disconnect();
  }, [doc]);

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}samples/stoa/index.json`).then((r) => (r.ok ? r.json() : null)).then((j) => {
      if (!j) return;
      const list = Array.isArray(j) ? j : j.files ?? j.samples ?? [];
      setSamples(list.map((e: string | { name?: string; url?: string; file?: string; path?: string }) => {
        const url = typeof e === 'string' ? e : e.url ?? e.file ?? e.path ?? '';
        const name = typeof e === 'string' ? e.split('/').pop()! : e.name ?? url.split('/').pop()!;
        return { name, url: /^(https?:|\/)/.test(url) ? url : `${import.meta.env.BASE_URL}samples/stoa/${url}` };
      }).filter((s: { url: string }) => s.url));
    }).catch(() => { /* no samples yet */ });
  }, []);

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}samples/stoa/eval-results.json`).then((r) => (r.ok ? r.json() : null)).then((j) => setBench(j?.summary ?? null)).catch(() => { /* not generated yet */ });
    fetch(`${import.meta.env.BASE_URL}samples/stoa/build-results.json`).then((r) => (r.ok ? r.json() : null)).then((j) => setBuildBench(j?.summary ?? null)).catch(() => { /* not generated yet */ });
  }, []);

  const benchCard = bench && (
    <details className="drawings-bench">
      <summary>Accuracy</summary>
      <div className="row drawings-stats">
        <div className="stat"><b>{bench.accuracyOnAnswered}%</b><span className="muted">accuracy when answered</span></div>
        <div className="stat"><b>{bench.coverage}%</b><span className="muted">answered</span></div>
        <div className="stat"><b>{bench.questions}</b><span className="muted">questions</span></div>
        <div className="stat"><b>0</b><span className="muted">model calls</span></div>
      </div>
      <p className="muted">{bench.dataset} · {bench.files} plans</p>
      {buildBench && (
        <div className="row drawings-stats">
          <div className="stat"><b>{buildBench.convertedPct}%</b><span className="muted">plans built in 3D</span></div>
          <div className="stat"><b>{buildBench.within2PctPct}%</b><span className="muted">areas within 2%</span></div>
          <div className="stat"><b>{buildBench.medianMsPerPlan} ms</b><span className="muted">per plan</span></div>
        </div>
      )}
    </details>
  );

  function openDoc(d: DrawingDoc) {
    docCache.set(d.name, d); lastDoc = d; saveSummary(d);
    setDoc(d); setPage(0); setZoom(1); setPan({ x: 0, y: 0 }); setAnswers([]); setFocus(null); setTrace([]); setCalPts([]); setMPerPx({});
    setBuilt(null); setPickRoom(null); setProposals(null);
  }

  async function buildPlan() {
    if (!doc || !pg) return;
    setBuilding(true); setLoading('Reading walls, doors and rooms');
    await new Promise((r) => setTimeout(r, 30)); // let the progress line paint
    try {
      // An object URL keeps the saved model small: every wall's evidence points at the same page image.
      let imageUrl = pg.dataUrl;
      try { imageUrl = URL.createObjectURL(await (await fetch(pg.dataUrl)).blob()); } catch { /* keep the data URL */ }
      const out = drawingToBuilding(doc, page, { imageUrl });
      setBuilt({ page, model: out.model, report: out.report });
      setPickRoom(null); setOverlay(false); setTool('pan');
      // frame the detected building on the sheet
      const pts = out.report.rooms.flatMap((r) => r.outline);
      if (pts.length) {
        const xs = pts.map((q) => q.x), ys = pts.map((q) => q.y);
        flyTo([{ page, x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }]);
      } else { setZoom(1); setPan({ x: 0, y: 0 }); }
    } catch (e) {
      toast(`Could not read the plan: ${(e as Error).message}`, 'error');
    } finally { setBuilding(false); setLoading(null); }
  }

  async function proposeRooms() {
    if (!doc || !pg) return;
    setBuilding(true); setLoading('Gemini is looking at the plan');
    try {
      const img = await downscale(pg.dataUrl, 1400);
      const raw = await gemini<{ rooms?: Array<{ name?: string; areaM2?: number; polygon?: Vec2[] }> }>(
        [dataUrlToInlineData(img), { text: PROPOSAL_PROMPT }],
        { json: true, schema: PROPOSAL_SCHEMA, system: 'You read architectural floor plans precisely. Never invent rooms or numbers.' },
      );
      const ps = cleanProposals(raw);
      setProposals(ps);
      if (!ps.length) toast('No rooms found. Trace a room by hand.', 'warn');
    } catch (e) {
      toast(`${(e as Error).message} Trace a room by hand instead.`, 'error');
    } finally { setBuilding(false); setLoading(null); }
  }

  function open3d() {
    if (!built?.report.ok) return;
    dispatch({ type: 'REPLACE_MODEL', model: built.model });
    setView('3d');
    setMode('design');
    toast(`${built.report.rooms.length} rooms built from the drawing`, 'ok');
  }

  async function openBlob(blob: Blob, name: string) {
    const cached = docCache.get(name);
    if (cached) return openDoc(cached);
    setLoading('Opening');
    try {
      const isPdf = blob.type === 'application/pdf' || /\.pdf$/i.test(name);
      const d = isPdf ? await loadPdf(await blob.arrayBuffer(), name, setLoading) : await loadImage(blob, name);
      openDoc(d);
    } catch (e) {
      toast(`Could not open ${name}: ${(e as Error).message}`, 'error');
    } finally { setLoading(null); }
  }

  async function openSample(s: { name: string; url: string }) {
    try {
      const r = await fetch(s.url);
      if (!r.ok) throw new Error(String(r.status));
      await openBlob(await r.blob(), s.name);
    } catch (e) { toast(`Sample failed: ${(e as Error).message}`, 'error'); }
  }

  async function addCrops(a: Answer) {
    if (!doc) return;
    const out: string[] = [];
    for (const r of a.regions.slice(0, 4)) { const p = doc.pages[r.page]; if (p) out.push(await cropRegion(p.dataUrl, r)); }
    setCrops((c) => ({ ...c, [a.id]: out }));
  }

  // Sheet box (unscaled) inside the stage, matching the CSS fit.
  function sheetBox() {
    if (!pg) return { w: 1, h: 1 };
    const ar = pg.pxW / pg.pxH;
    return stageSize.w / stageSize.h > ar ? { w: stageSize.h * ar, h: stageSize.h } : { w: stageSize.w, h: stageSize.w / ar };
  }
  function flyTo(rs: Region[]) {
    if (!rs.length) return;
    const x0 = Math.min(...rs.map((r) => r.x)), y0 = Math.min(...rs.map((r) => r.y));
    const x1 = Math.max(...rs.map((r) => r.x + r.w)), y1 = Math.max(...rs.map((r) => r.y + r.h));
    const sb = sheetBox();
    // fit the regions into the stage with a margin, whatever its shape
    const fit = 0.85 * Math.min(stageSize.w / (sb.w * Math.max(x1 - x0, 0.02)), stageSize.h / (sb.h * Math.max(y1 - y0, 0.02)));
    const z = Math.min(6, Math.max(1, Math.min(fit, 0.5 / Math.max(x1 - x0, y1 - y0, 0.02) * 2)));
    setAnim(true); setZoom(z);
    setPan({ x: -((x0 + x1) / 2 - 0.5) * sb.w * z, y: -((y0 + y1) / 2 - 0.5) * sb.h * z });
    window.setTimeout(() => setAnim(false), 600);
  }
  function focusAnswer(a: Answer) {
    if (!a.regions.length) return;
    setFocus(a.regions); setPage(a.regions[0].page); flyTo(a.regions);
  }

  function show(a: QA) {
    setAnswers((list) => [a, ...list]);
    focusAnswer(a);
    void addCrops(a);
  }

  async function ask(question = q) {
    if (!doc || !question.trim()) return;
    setAsking(true);
    const geo = built?.report.ok ? answerFromGeometry(built.report, built.model, question) : null;
    const local = geo ?? answerFromIndex(doc, question, page);
    if (local) { setStats((s) => ({ asked: s.asked + 1, free: s.free + 1 })); show(local); setAsking(false); setQ(''); return; }
    setStats((s) => ({ ...s, asked: s.asked + 1 }));
    if (!hasGemini()) {
      show({ id: uid('a'), question, answer: 'Not found in the drawing text. Add a Gemini key in Settings to ask the model.', kind: 'inferred', method: 'none', regions: [] });
      setAsking(false); return;
    }
    const key = `${doc.name}|${page}|${question.trim().toLowerCase()}`;
    const hit = answerCache.get(key);
    if (hit) { show({ ...hit, id: uid('a'), cached: true, tokens: 0 }); setAsking(false); setQ(''); return; }
    try {
      // Cheaper: if the question names an indexed room, send only a crop around it.
      const words = question.toLowerCase().split(/[^a-z\u00c0-\u024f0-9]+/).filter((w) => w.length >= 3);
      const room = roomList.find(({ r }) => words.some((w) => r.str.toLowerCase().includes(w)));
      let box = { x: 0, y: 0, w: 1, h: 1 };
      let img: string;
      if (room) {
        const pad = 0.12;
        const x = Math.max(0, room.r.x - pad), y = Math.max(0, room.r.y - pad);
        box = { x, y, w: Math.min(1 - x, room.r.w + pad * 2), h: Math.min(1 - y, room.r.h + pad * 2) };
        img = await cropRegion(doc.pages[page].dataUrl, box, 0, 450);
      } else img = await downscale(doc.pages[page].dataUrl, 1200);
      const before = usage.inputTokens + usage.outputTokens;
      const res = await gemini<{ answer: string; value?: number; unit?: string; kind: Answer['kind']; regions: Array<{ x: number; y: number; w: number; h: number }> }>(
        [dataUrlToInlineData(img), { text: `Question about this technical drawing: ${question}\nAnswer briefly. kind: "printed" if read directly from text on the drawing, "calculated" if computed from printed values, "inferred" otherwise. regions: boxes (normalised 0..1, x,y = top-left) around the exact spots on the drawing that support the answer.` }],
        { json: true, schema: SCHEMA, system: 'You read architectural and technical drawings precisely. Never invent values that are not on the drawing; say so if unsure.' },
      );
      const clamp = (v: number) => Math.min(1, Math.max(0, Number(v) || 0));
      const a: QA = { id: uid('a'), question, answer: res.answer, value: res.value, unit: res.unit, kind: res.kind ?? 'inferred', method: 'gemini',
        tokens: usage.inputTokens + usage.outputTokens - before,
        regions: (res.regions ?? []).map((r) => ({ page, x: box.x + clamp(r.x) * box.w, y: box.y + clamp(r.y) * box.h, w: clamp(r.w) * box.w, h: clamp(r.h) * box.h })).filter((r) => r.w > 0 && r.h > 0) };
      if (room?.area && typeof res.value === 'number' && /m/.test(res.unit ?? 'm2')) {
        a.check = { index: room.area, model: res.value, ok: Math.abs(res.value - room.area) <= Math.max(0.5, room.area * 0.03) };
      }
      answerCache.set(key, a);
      show(a);
      setQ('');
    } catch (e) {
      toast(`Model call failed: ${(e as Error).message}`, 'error');
    } finally { setAsking(false); }
  }

  // ---- pointer handling on the page ----
  function toNorm(e: React.PointerEvent): Pt | null {
    const img = stageRef.current?.querySelector('img');
    if (!img) return null;
    const r = img.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  }
  function onDown(e: React.PointerEvent) {
    if (tool === 'pan') { drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y }; (e.target as Element).setPointerCapture?.(e.pointerId); return; }
    const p = toNorm(e); if (!p) return;
    if (tool === 'calibrate') setCalPts((c) => (c.length >= 2 ? [p] : [...c, p]));
    if (tool === 'trace') setTrace((t) => [...t, p]);
  }
  function onMove(e: React.PointerEvent) {
    if (!drag.current) return;
    setPan({ x: drag.current.px + e.clientX - drag.current.x, y: drag.current.py + e.clientY - drag.current.y });
  }
  function onWheel(e: React.WheelEvent) {
    setZoom((z) => Math.min(8, Math.max(0.3, z * (e.deltaY < 0 ? 1.15 : 1 / 1.15))));
  }

  const pxDist = (a: Pt, b: Pt) => (pg ? Math.hypot((a.x - b.x) * pg.pxW, (a.y - b.y) * pg.pxH) : 0);

  function applyCalibration() {
    const d = Number(calDist.replace(',', '.'));
    if (calPts.length !== 2 || !(d > 0)) return toast('Click 2 points, type metres', 'warn');
    setMPerPx((m) => ({ ...m, [page]: d / pxDist(calPts[0], calPts[1]) }));
    toast('Scale set from your two points', 'ok');
  }
  function applyScale(n: number) {
    if (!pg?.ptW) return;
    const paperMPerPx = (pg.ptW * 0.0003528) / pg.pxW;
    setMPerPx((m) => ({ ...m, [page]: paperMPerPx * n }));
    toast(`Scale set from 1:${n}`, 'ok');
  }

  // Traced walls with lengths and any matching printed dimension.
  const walls = useMemo(() => {
    if (trace.length < 2 || !mpp) return [];
    return trace.map((a, i) => {
      const b = trace[(i + 1) % trace.length];
      const len = pxDist(a, b) * mpp;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const near = dims.filter((d) => d.value && Math.hypot(d.x + d.w / 2 - mid.x, d.y + d.h / 2 - mid.y) < 0.15)
        .map((d) => ({ d, err: Math.abs(d.value! - len) / d.value! })).sort((x, y) => x.err - y.err);
      const match = near.find((n) => n.err <= 0.02)?.d ?? null;
      const conflict = !match && near[0] && near[0].err < 0.25 ? near[0].d : null;
      return { a, b, len, match, conflict, closing: i === trace.length - 1 };
    }).filter((w) => trace.length >= 3 || !w.closing);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trace, mpp, dims, pg]);

  function explore3d() {
    if (!doc || !pg || !mpp || trace.length < 3) return toast('Set scale, click 3 corners', 'warn');
    let poly: Vec2[] = trace.map((p) => ({ x: p.x * pg.pxW * mpp, y: p.y * pg.pxH * mpp }));
    const minX = Math.min(...poly.map((p) => p.x)), minY = Math.min(...poly.map((p) => p.y));
    poly = poly.map((p) => ({ x: p.x - minX, y: p.y - minY }));
    let ws = walls;
    if (signedArea(poly) < 0) { poly = [...poly].reverse(); ws = [...walls].reverse().map((w) => w); }
    // After reversal wall i runs poly[i] -> poly[i+1]; recompute matches by length to stay aligned.
    const now = Date.now();
    const evidence: Evidence[] = [];
    const measurements: Measurement[] = [];
    const spaceId = uid('space');
    const metas: WallMeta[] = poly.map((a, i) => {
      const b = poly[(i + 1) % poly.length];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const w = ws.find((x) => Math.abs(x.len - len) < 1e-6) ?? ws[i];
      const xs = [w.a.x, w.b.x], ys = [w.a.y, w.b.y];
      const ev: Evidence = { id: uid('ev'), kind: 'pdf', label: `${doc.name} p${page + 1}, wall ${i + 1}`, imageUrl: pg.dataUrl, page,
        bbox: [Math.min(...xs), Math.min(...ys), Math.max(0.005, Math.abs(xs[0] - xs[1])), Math.max(0.005, Math.abs(ys[0] - ys[1]))], createdAt: now };
      evidence.push(ev);
      if (w.match) {
        const dev: Evidence = { id: uid('ev'), kind: 'pdf', label: `Printed "${w.match.str}"`, imageUrl: pg.dataUrl, page, bbox: [w.match.x, w.match.y, w.match.w, w.match.h], createdAt: now };
        evidence.push(dev);
        const m: Measurement = { id: uid('ms'), label: `Wall ${i + 1}`, valueM: w.match.value!, sourceKind: 'pdf-annotation', status: 'verified', toleranceM: 0.01, evidenceIds: [dev.id, ev.id], targetId: `${spaceId}:${i}` };
        measurements.push(m);
        return { thicknessM: 0.12, sourceKind: 'pdf-annotation', status: 'verified', measurementId: m.id };
      }
      return { thicknessM: 0.12, sourceKind: 'pdf-annotation', status: w.conflict ? 'conflicting' : 'estimated' };
    });
    const space: Space = { id: spaceId, name: roomName || 'Traced room', polygon: poly, walls: metas };
    const base = emptyModel(roomName || doc.name);
    dispatch({ type: 'REPLACE_MODEL', model: { ...base, sourceLabel: `Drawing: ${doc.name}`, spaces: [space], openings: [], measurements, evidence } });
    toast('Room built from the drawing', 'ok');
    setMode('design');
  }

  const st = doc ? indexStats(doc) : null;
  const pageFocus = (focus ?? []).filter((r) => r.page === page);
  const named = [...new Set(roomList.filter((x) => x.area).map((x) => x.r.str))].slice(0, 2);
  const geoReady = !!built?.report.ok && built.page === page;
  const suggestions = [
    ...(geoReady ? ['Which room is largest?', 'How many rooms have a window?', 'Entrance to bathroom distance?'] : []),
    ...named.slice(0, geoReady ? 1 : 2).map((n) => `Area of ${n}?`),
    ...(roomList.length && !geoReady ? ['How many rooms?'] : []),
    ...(scaleItems.length ? ['What scale?'] : []),
    ...(dims.length ? ['Which dimensions are on this sheet?'] : []),
  ];
  if (!suggestions.length) suggestions.push('What scale?', 'List rooms', 'What is the area of the kitchen?');

  const rep = built && built.page === page ? built.report : null;
  const picked = rep?.rooms.find((r) => r.spaceId === pickRoom) ?? null;
  const flyToRoom = (id: string) => {
    const r = rep?.rooms.find((x) => x.spaceId === id); if (!r) return;
    setPickRoom(id);
    const xs = r.outline.map((p) => p.x), ys = r.outline.map((p) => p.y);
    flyTo([{ page, x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }]);
  };
  const proposalScale = proposals && pg ? (scaleFromAreas(proposals, pg.pxW, pg.pxH) ?? mpp ?? null) : null;
  function openProposals() {
    if (!doc || !pg || !proposals?.length || !proposalScale) return;
    const out = buildFromProposals(proposals, { pxW: pg.pxW, pxH: pg.pxH, mPerPx: proposalScale, imageUrl: pg.dataUrl, name: doc.name, page });
    dispatch({ type: 'REPLACE_MODEL', model: out.model });
    setView('split'); setMode('design');
    toast(`${out.rooms.length} rooms built from the picture`, 'ok');
  }
  const fmtPct = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
  const hasLines = !!doc?.vectors?.[page];
  const buildCard = doc && (
    <section className="card drawings-build">
      {!rep && (
        <>
          {hasLines ? (
            <>
              <button className="btn btn-primary drawings-big" onClick={() => void buildPlan()} disabled={building}>
                {building ? 'Reading…' : 'Build 3D from this plan'}
              </button>
            </>
          ) : proposals ? (
            <>
              <p className="muted drawings-bnote">{proposals.length} rooms found. Remove any that are wrong.</p>
              <div className="drawings-rooms">
                {proposals.map((r, i) => (
                  <div key={i} className="drawings-room">
                    <span>{r.name}{r.areaM2 ? ` · ${r.areaM2} m²` : ''}</span>
                    <button className="btn btn-ghost btn-sm" aria-label={`Remove ${r.name}`} onClick={() => setProposals((ps) => ps!.filter((_, j) => j !== i))}><Icon name="minus" size={12} /></button>
                  </div>
                ))}
              </div>
              {!proposalScale && <p className="muted drawings-bnote">No areas. Set scale.</p>}
              <button className="btn btn-primary drawings-big" disabled={!proposals.length || !proposalScale} onClick={openProposals}>Open in 3D</button>
              {!proposalScale && <button className="btn btn-sm" onClick={() => setTool('calibrate')}>Set scale</button>}
            </>
          ) : (
            <>
              <p className="muted">No lines in a picture</p>
              {hasGemini() && <button className="btn btn-primary drawings-big" disabled={building} onClick={() => void proposeRooms()}>{building ? 'Finding rooms…' : 'Find rooms with Gemini'}</button>}
              <button className="btn drawings-big" onClick={() => setTool(mpp ? 'trace' : 'calibrate')}>Trace a room</button>
            </>
          )}
        </>
      )}
      {rep && !rep.ok && (
        <>
          <h4>Could not build 3D</h4>
          <p>{rep.reason}</p>
          <button className="btn drawings-big" onClick={() => { setBuilt(null); setTool(mpp ? 'trace' : 'calibrate'); }}>Trace a room</button>
        </>
      )}
      {rep && rep.ok && (
        <>
          <div className="row drawings-stats">
            <div className="stat"><b>{rep.rooms.length}</b><span className="muted">rooms</span></div>
            <div className="stat"><b>{rep.doors}</b><span className="muted">doors</span></div>
            <div className="stat"><b>{rep.windows}</b><span className="muted">windows</span></div>
          </div>
          {rep.withPrintedArea > 0 && (
            <p className="muted drawings-bnote">
              {rep.verified} of {rep.withPrintedArea} areas within 2% of printed
            </p>
          )}
          {picked ? (
            <div className={`drawings-bpick st-${picked.printedArea == null ? 'none' : picked.status}`}>
              <b>{picked.name}</b>
              {picked.printedArea != null
                ? <span>Printed {picked.printedArea.toFixed(2)} m² · Computed {picked.computedArea.toFixed(2)} m²</span>
                : <span>{picked.computedArea.toFixed(2)} m² · no printed area</span>}
              <span className="muted">{picked.doors} door{picked.doors === 1 ? '' : 's'} · {picked.windows} window{picked.windows === 1 ? '' : 's'}</span>
            </div>
          ) : null}
          <div className="drawings-rooms">
            {rep.rooms.map((r) => (
              <button key={r.spaceId} className={`drawings-room${pickRoom === r.spaceId ? ' is-on' : ''}`} onClick={() => flyToRoom(r.spaceId)}>
                <span>{r.name}</span>
                <span className={r.printedArea == null ? 'muted' : r.status === 'verified' ? 'drawings-ok' : 'drawings-bad'}>
                  {r.computedArea.toFixed(1)} m²{r.errorPct != null ? ` ${fmtPct(r.errorPct)}` : ''}
                </span>
              </button>
            ))}
          </div>
          {rep.failed.length > 0 && (
            <details className="drawings-bfailed">
              <summary>{rep.failed.length} room{rep.failed.length > 1 ? 's' : ''} not built</summary>
              <ul>{rep.failed.map((f, i) => <li key={i}>{[f.label, f.no].filter(Boolean).join(' ') || 'Room'}: {f.reason}</li>)}</ul>
            </details>
          )}
          {rep.warnings.filter((w) => !/could not be closed/.test(w)).map((w) => <p key={w} className="muted drawings-bnote">{w}</p>)}
          <button className="btn btn-primary drawings-big" onClick={open3d}>Open in 3D</button>
          <button className="btn btn-ghost btn-sm" onClick={() => { setBuilt(null); setPickRoom(null); }}>Clear</button>
        </>
      )}
    </section>
  );

  return (
    <div className="drawings">
      {doc && (
        <div className="drawings-bar row" role="toolbar" aria-label="Drawing tools">
          {(['pan', 'calibrate', 'trace'] as Tool[]).map((t) => (
            <button key={t} className={`btn btn-sm ${tool === t ? 'btn-primary' : 'btn-ghost'}`} aria-pressed={tool === t} onClick={() => setTool(t)}>
              {t === 'pan' ? 'Move' : t === 'calibrate' ? 'Set scale' : 'Trace room'}
            </button>
          ))}
          <span className="drawings-sep" />
          <button className="btn btn-ghost btn-sm" onClick={() => setZoom((z) => Math.min(8, z * 1.25))} aria-label="Zoom in"><Icon name="plus" size={14} /></button>
          <button className="btn btn-ghost btn-sm" onClick={() => setZoom((z) => Math.max(0.3, z / 1.25))} aria-label="Zoom out"><Icon name="minus" size={14} /></button>
          <button className="btn btn-ghost btn-sm" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}>Fit</button>
          <button className={`btn btn-sm ${overlay ? 'btn-primary' : 'btn-ghost'}`} aria-pressed={overlay} onClick={() => setOverlay((o) => !o)}>Overlay</button>
          {loading && <span className="muted">{loading}…</span>}
          <label className="btn btn-ghost btn-sm drawings-open">
            <Icon name="file" size={14} /> Open
            <input type="file" accept="application/pdf,image/png,image/jpeg" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void openBlob(f, f.name); e.target.value = ''; }} />
          </label>
        </div>
      )}

      {!doc ? (
        <div className="drawings-empty">
          <label className="drawings-drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) void openBlob(f, f.name); }}>
            <Icon name="file" size={20} />
            <b>Drop a plan</b>
            <input type="file" accept="application/pdf,image/png,image/jpeg" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void openBlob(f, f.name); e.target.value = ''; }} />
          </label>
          {loading && <p className="muted">{loading}…</p>}
          {samples.length > 0 && (
            <div className="drawings-samples">
              <h4>Sample drawings</h4>
              {samples.map((s) => (
                <button key={s.url} className="drawings-sample" onClick={() => void openSample(s)}>
                  <span>{s.name}</span><Icon name="chevronRight" size={14} />
                </button>
              ))}
            </div>
          )}
          {benchCard}
        </div>
      ) : (
        <div className="drawings-main">
          {doc.pages.length > 1 && (
            <div className="drawings-thumbs">
              {doc.pages.map((p) => (
                <button key={p.index} className={`drawings-thumb ${p.index === page ? 'is-on' : ''}`} onClick={() => { setPage(p.index); setTrace([]); setCalPts([]); }}>
                  <img src={p.dataUrl} alt={`Page ${p.index + 1}`} /><span>{p.index + 1}</span>
                </button>
              ))}
            </div>
          )}

          <div className={`drawings-stage tool-${tool}`} ref={stageRef} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={() => { drag.current = null; }} onWheel={onWheel}>
            {pg && (
              <div className={`drawings-sheet ${anim ? 'is-anim' : ''}`} style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, aspectRatio: `${pg.pxW} / ${pg.pxH}` }}>
                <img src={pg.dataUrl} alt={`${doc.name} page ${page + 1}`} draggable={false} />
                <svg viewBox="0 0 1 1" preserveAspectRatio="none">
                  {overlay && pageItems.map((i) => <rect key={`o${i.id}`} className={`drawings-ov ov-${i.kind}`} x={i.x} y={i.y} width={i.w} height={i.h}><title>{`${i.kind}: ${i.str}`}</title></rect>)}
                  {hover && hover.page === page && <rect className="drawings-hover" x={hover.x - 0.005} y={hover.y - 0.005} width={hover.w + 0.01} height={hover.h + 0.01} />}
                  {built && built.page === page && built.report.ok && (
                    <g>
                      {built.report.wallsNorm.map((w, i) => <polygon key={`w${i}`} className="drawings-bwall" points={w.map((p) => `${p.x},${p.y}`).join(' ')} />)}
                      {built.report.rooms.map((r) => (
                        <polygon key={r.spaceId} className={`drawings-broom st-${r.printedArea == null ? 'none' : r.status}${pickRoom === r.spaceId ? ' is-on' : ''}`}
                          points={r.outline.map((p) => `${p.x},${p.y}`).join(' ')} onClick={() => setPickRoom(r.spaceId)}>
                          <title>{r.name}</title>
                        </polygon>
                      ))}
                    </g>
                  )}
                  {proposals?.map((r, i) => <polygon key={`p${i}`} className="drawings-broom st-none" points={r.polygon.map((p) => `${p.x},${p.y}`).join(' ')}><title>{`${r.name} (proposed)`}</title></polygon>)}
                  {built && built.page === page && built.report.failed.map((f, i) => <rect key={`f${i}`} className="drawings-bfail" x={f.box[0] - 0.004} y={f.box[1] - 0.004} width={f.box[2] + 0.008} height={f.box[3] + 0.008}><title>{f.reason}</title></rect>)}
                  {pageFocus.map((r, i) => <rect key={i} className="drawings-hit" x={r.x} y={r.y} width={r.w} height={r.h} />)}
                  {calPts.length === 2 && <line className="drawings-cal" x1={calPts[0].x} y1={calPts[0].y} x2={calPts[1].x} y2={calPts[1].y} />}
                  {calPts.map((p, i) => <circle key={i} className="drawings-cal-pt" cx={p.x} cy={p.y} r={0.004} />)}
                  {walls.map((w, i) => <line key={i} className={`drawings-wall ${w.match ? 'ok' : w.conflict ? 'bad' : ''}`} x1={w.a.x} y1={w.a.y} x2={w.b.x} y2={w.b.y} />)}
                  {trace.length === 1 || (!mpp && trace.length > 1) ? <polyline className="drawings-wall" points={trace.map((p) => `${p.x},${p.y}`).join(' ')} /> : null}
                  {trace.map((p, i) => <circle key={i} className="drawings-pt" cx={p.x} cy={p.y} r={0.004} />)}
                </svg>
              </div>
            )}
            {pg && zoom > 1.05 && (() => {
              const sb = sheetBox(); const vw = Math.min(1, stageSize.w / (sb.w * zoom)), vh = Math.min(1, stageSize.h / (sb.h * zoom));
              const cxn = 0.5 - pan.x / (sb.w * zoom), cyn = 0.5 - pan.y / (sb.h * zoom);
              return (
                <div className="drawings-mini" style={{ aspectRatio: `${pg.pxW} / ${pg.pxH}` }} onPointerDown={(e) => {
                  e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect();
                  setPan({ x: -((e.clientX - r.left) / r.width - 0.5) * sb.w * zoom, y: -((e.clientY - r.top) / r.height - 0.5) * sb.h * zoom });
                }}>
                  <img src={pg.dataUrl} alt="" draggable={false} />
                  <div className="drawings-mini-view" style={{ left: `${(cxn - vw / 2) * 100}%`, top: `${(cyn - vh / 2) * 100}%`, width: `${vw * 100}%`, height: `${vh * 100}%` }} />
                </div>
              );
            })()}
            {overlay && <div className="drawings-legend">{OVERLAY_KINDS.map((k) => <span key={k} className={`lg-${k}`}>{k}</span>)}</div>}
          </div>

          <aside className="drawings-side">
            {buildCard}
            <section className="card drawings-ask">
              <form className="row" onSubmit={(e) => { e.preventDefault(); void ask(); }}>
                <input className="field drawings-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask about this drawing" />
                <button className="btn btn-primary btn-sm" disabled={asking || !q.trim()}>{asking ? '…' : 'Ask'}</button>
              </form>
              <div className="row drawings-sugg">
                {suggestions.map((s) => <button key={s} className="chip" onClick={() => void ask(s)}>{s}</button>)}
              </div>
              <p className="muted drawings-cost">
                {stats.free} of {stats.asked} answered free · {st!.rooms} rooms · {st!.dimensions} dimensions
              </p>
              {st!.text === 0 && <p className="muted">No text layer</p>}
              <div className="list">
                {answers.map((a) => (
                  <div key={a.id} className="drawings-answer" onClick={() => focusAnswer(a)}>
                    <div className="muted drawings-aq">{a.question}</div>
                    <div className="drawings-at">{a.answer}</div>
                    <div className="row drawings-meta">
                      <span className={`chip ${a.kind === 'printed' ? 'chip-ok' : a.kind === 'calculated' ? 'chip-warn' : 'chip-bad'}`}>{a.kind}</span>
                      <span className="chip">{a.method === 'index' ? 'Free' : a.method === 'gemini' ? 'Gemini' : 'No answer'}</span>
                    </div>
                    {a.check && (
                      <div className={`drawings-check ${a.check.ok ? 'ok' : 'bad'}`}>
                        Index {a.check.index} m² · Model {a.check.model} m² · {a.check.ok ? 'agree' : 'disagree, check the sheet'}
                      </div>
                    )}
                    {(crops[a.id] ?? []).length > 0 && (
                      <div className="drawings-crops">{crops[a.id].map((c, i) => <img key={i} src={c} alt="Source on drawing" />)}</div>
                    )}
                  </div>
                ))}
              </div>
            </section>

            {roomList.length > 0 && (
              <section className="card">
                <h4>Rooms on this page</h4>
                <div className="drawings-rooms" onMouseLeave={() => setHover(null)}>
                  {roomList.map(({ r, area }) => (
                    <button key={r.id} className="drawings-room" onMouseEnter={() => setHover(r)} onFocus={() => setHover(r)} onClick={() => flyTo([r])}>
                      <span>{r.str}</span>{area != null && <span className="muted">{area} m²</span>}
                    </button>
                  ))}
                </div>
              </section>
            )}
            {(tool === 'calibrate' || mpp) && <section className="card">
              <h4>Scale</h4>
              {mpp ? <p><span className="chip chip-ok">Set</span> {(mpp * 1000).toFixed(1)} mm per pixel</p> : <p className="muted">Not set.</p>}
              {mpp && tool !== 'trace' && (
                <button className="btn btn-primary drawings-big" onClick={() => { setTool('trace'); setTrace([]); }}>Trace a room into 3D</button>
              )}
              {scaleItems.length > 0 && pg?.ptW && (
                <div className="row">{[...new Set(scaleItems.map((s) => s.value!))].map((n) => <button key={n} className="btn btn-ghost btn-sm" onClick={() => applyScale(n)}>Use 1:{n}</button>)}</div>
              )}
              {tool === 'calibrate' && (
                <div className="row">
                  <span className="muted">{calPts.length}/2 points</span>
                  <input className="field drawings-num" value={calDist} onChange={(e) => setCalDist(e.target.value)} placeholder="metres" inputMode="decimal" />
                  <button className="btn btn-sm btn-primary" onClick={applyCalibration}>Apply</button>
                </div>
              )}
            </section>}

            {tool === 'trace' && <section className="card">
              <h4>Trace room</h4>
              <ol className="drawings-steps">
                <li className={mpp ? 'done' : 'now'}>Set the scale</li>
                <li className={trace.length >= 3 ? 'done' : mpp ? 'now' : ''}>Click room corners</li>
                <li className={trace.length >= 3 && mpp ? 'now' : ''}>Explore in 3D</li>
              </ol>
              {tool !== 'trace' ? null : (
                <>
                  <input className="field" value={roomName} onChange={(e) => setRoomName(e.target.value)} aria-label="Room name" />
                  <div className="list">
                    {walls.map((w, i) => (
                      <div key={i} className="row drawings-wrow">
                        <span>Wall {i + 1}: {w.len.toFixed(2)} m</span>
                        {w.match && <span className="chip chip-ok">matches {w.match.str}</span>}
                        {w.conflict && <span className="chip chip-bad">conflict: printed {w.conflict.str}</span>}
                      </div>
                    ))}
                  </div>
                  <div className="row">
                    <button className="btn btn-ghost btn-sm" onClick={() => setTrace((t) => t.slice(0, -1))} disabled={!trace.length}>Undo</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => setTrace([])} disabled={!trace.length}>Clear</button>
                    <button className="btn btn-primary btn-sm" onClick={explore3d} disabled={trace.length < 3 || !mpp}>Explore in 3D</button>
                  </div>
                </>
              )}
            </section>}
          </aside>
        </div>
      )}
    </div>
  );
}

export type { TextItem };
