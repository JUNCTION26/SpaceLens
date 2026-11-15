/**
 * A picture of a floor plan (photo, scan, listing image, sketch) to a SpaceModel. A vision model reads
 * rooms, openings and printed dimensions in image pixels; everything after that is plain geometry:
 * solve the scale from every hint, snap near-axis walls, merge shared walls, close small gaps.
 */
import type { Evidence, Opening, Space, SpaceModel, Vec2 } from '../../core/types';
import { purposeOf } from './purpose';

export interface RawRoom { name: string; areaM2?: number; polygon: Vec2[] }
export interface RawOpening { kind: 'door' | 'window'; at: Vec2; widthPx: number }
export interface RawDimension { text: string; valueM?: number; a: Vec2; b: Vec2 }
export interface RawPlan { width: number; height: number; rooms: RawRoom[]; openings: RawOpening[]; dimensions: RawDimension[] }

export interface ScaleHint { pxLen: number; m: number; weight: number; kind: 'dimension' | 'area' | 'door' }
export type ScaleSource = 'dimensions' | 'areas' | 'door' | 'none';
export interface ScaleSolution { mPerPx: number | null; source: ScaleSource; used: number; rejected: number; spreadPct: number }

export interface ImagePlanReport {
  ok: boolean;
  reason?: string;
  scale: { source: ScaleSource; mPerPx: number | null; used: number; rejected: number };
  /** 0..1 */
  confidence: number;
  /** True when no printed hint or door was found: the person has to give one length. */
  needsLength: boolean;
  warnings: string[];
  rooms: Array<{ spaceId: string; name: string; printedArea?: number; computedArea: number; outline: Vec2[] }>;
  doors: number;
  windows: number;
  /** Plan bounding box in metres. */
  sizeM: { w: number; h: number };
  model: string;
}

// ---------- parsing ----------

/** "3.5 m", "3,50m", "350 cm", "3500 mm", "3500" -> metres. */
export function parseLengthM(text: string): number | null {
  const t = text.toLowerCase().replace(/\s+/g, '').replace(',', '.');
  const m = t.match(/(\d+(?:\.\d+)?)(mm|cm|m)?/);
  if (!m) return null;
  const v = parseFloat(m[1]);
  if (!(v > 0)) return null;
  if (m[2] === 'mm') return v / 1000;
  if (m[2] === 'cm') return v / 100;
  if (m[2] === 'm') return v;
  return v >= 100 ? v / 1000 : v; // bare numbers: plans print millimetres, listings print metres
}

const shoelace = (p: Vec2[]) => { let s = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a.x * b.y - b.x * a.y; } return s / 2; };
export const polygonArea = (p: Vec2[]) => Math.abs(shoelace(p));

// ---------- scale ----------

export function hintsFromRaw(raw: RawPlan): ScaleHint[] {
  const out: ScaleHint[] = [];
  for (const d of raw.dimensions) {
    const m = d.valueM && d.valueM > 0 ? d.valueM : parseLengthM(d.text);
    const px = Math.hypot(d.a.x - d.b.x, d.a.y - d.b.y);
    if (m && px > 4) out.push({ pxLen: px, m, weight: 1, kind: 'dimension' });
  }
  for (const r of raw.rooms) {
    if (!r.areaM2) continue;
    const a = polygonArea(r.polygon);
    if (a > 16) out.push({ pxLen: Math.sqrt(a), m: Math.sqrt(r.areaM2), weight: 0.5, kind: 'area' });
  }
  return out;
}

function weightedMedian(vals: Array<{ v: number; w: number }>): number {
  const s = [...vals].sort((a, b) => a.v - b.v);
  const half = s.reduce((t, x) => t + x.w, 0) / 2;
  let acc = 0;
  for (const x of s) { acc += x.w; if (acc >= half) return x.v; }
  return s[s.length - 1].v;
}

/** Least squares m = k * px over all hints after dropping those more than `tol` off the weighted median ratio. */
export function solveScale(hints: ScaleHint[], tol = 0.25): ScaleSolution {
  const h = hints.filter((x) => x.pxLen > 0 && x.m > 0 && x.weight > 0);
  if (!h.length) return { mPerPx: null, source: 'none', used: 0, rejected: 0, spreadPct: 0 };
  const ref = weightedMedian(h.map((x) => ({ v: x.m / x.pxLen, w: x.weight })));
  const keep = h.filter((x) => Math.abs((x.m / x.pxLen) / ref - 1) <= tol);
  const used = keep.length ? keep : h;
  const k = used.reduce((s, x) => s + x.weight * x.pxLen * x.m, 0) / used.reduce((s, x) => s + x.weight * x.pxLen * x.pxLen, 0);
  const spread = used.length > 1 ? Math.max(...used.map((x) => Math.abs((x.m / x.pxLen) / k - 1))) * 100 : 0;
  const kinds = new Set(used.map((x) => x.kind));
  const source: ScaleSource = kinds.has('dimension') ? 'dimensions' : kinds.has('area') ? 'areas' : 'door';
  return { mPerPx: k, source, used: used.length, rejected: h.length - used.length, spreadPct: Math.round(spread * 10) / 10 };
}

/** Picks the strongest tier: printed dimensions, else printed areas, else the 0.8 m door assumption. */
export function scaleFromRaw(raw: RawPlan): ScaleSolution {
  const hints = hintsFromRaw(raw);
  const dims = hints.filter((x) => x.kind === 'dimension');
  if (dims.length) return solveScale(hints);
  const areas = hints.filter((x) => x.kind === 'area');
  if (areas.length >= 2) return solveScale(areas);
  const doors = raw.openings.filter((o) => o.kind === 'door' && o.widthPx > 4).map((o) => ({ pxLen: o.widthPx, m: STANDARD_DOOR_M, weight: 0.3, kind: 'door' as const }));
  if (areas.length === 1 && !doors.length) return solveScale(areas);
  if (doors.length) return solveScale([...areas, ...doors]);
  return solveScale(areas);
}

export const STANDARD_DOOR_M = 0.8;

// ---------- geometry clean-up (metres) ----------

const clonePolys = (p: Vec2[][]) => p.map((r) => r.map((v) => ({ x: v.x, y: v.y })));

/** Makes edges within `tolDeg` of horizontal or vertical exactly so. */
export function snapAxis(polys: Vec2[][], tolDeg = 8): Vec2[][] {
  const out = clonePolys(polys);
  const tol = Math.tan((tolDeg * Math.PI) / 180);
  for (let pass = 0; pass < 2; pass++) {
    for (const r of out) {
      for (let i = 0; i < r.length; i++) {
        const a = r[i], b = r[(i + 1) % r.length];
        const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y);
        if (dx < 1e-9 && dy < 1e-9) continue;
        if (dy <= dx * tol) { const y = (a.y + b.y) / 2; a.y = y; b.y = y; }
        else if (dx <= dy * tol) { const x = (a.x + b.x) / 2; a.x = x; b.x = x; }
      }
    }
  }
  return out;
}

interface AxisEdge { poly: number; v0: number; v1: number; lo: number; hi: number; c: number; len: number }

/** Walls of adjacent rooms that run side by side (within `tol` metres, overlapping in extent) become one line. */
export function mergeSharedWalls(polys: Vec2[][], tol = 0.3): Vec2[][] {
  const out = clonePolys(polys);
  for (const axis of ['x', 'y'] as const) {
    const other = axis === 'x' ? 'y' : 'x';
    const edges: AxisEdge[] = [];
    out.forEach((r, p) => {
      for (let i = 0; i < r.length; i++) {
        const a = r[i], b = r[(i + 1) % r.length];
        if (Math.abs(a[axis] - b[axis]) > 1e-9) continue;
        const len = Math.abs(a[other] - b[other]);
        if (len < 1e-9) continue;
        edges.push({ poly: p, v0: i, v1: (i + 1) % r.length, lo: Math.min(a[other], b[other]), hi: Math.max(a[other], b[other]), c: a[axis], len });
      }
    });
    const parent = edges.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < edges.length; i++) {
      for (let j = i + 1; j < edges.length; j++) {
        const e = edges[i], f = edges[j];
        if (Math.abs(e.c - f.c) > tol) continue;
        if (Math.min(e.hi, f.hi) - Math.max(e.lo, f.lo) < -tol) continue;
        parent[find(i)] = find(j);
      }
    }
    const groups = new Map<number, number[]>();
    edges.forEach((_, i) => { const g = find(i); groups.set(g, [...(groups.get(g) ?? []), i]); });
    for (const ids of groups.values()) {
      if (ids.length < 2) continue;
      const total = ids.reduce((s, i) => s + edges[i].len, 0);
      const c = ids.reduce((s, i) => s + edges[i].c * edges[i].len, 0) / total;
      for (const i of ids) { const e = edges[i]; out[e.poly][e.v0][axis] = c; out[e.poly][e.v1][axis] = c; }
    }
  }
  return out;
}

/** Corners of different rooms closer than `gap` metres are joined at their midpoint. */
export function closeGaps(polys: Vec2[][], gap = 0.15): Vec2[][] {
  const out = clonePolys(polys);
  const pts = out.flatMap((r, p) => r.map((v, i) => ({ p, i, v })));
  const seen = new Set<number>();
  pts.forEach((a, ai) => {
    if (seen.has(ai)) return;
    const near = [ai];
    pts.forEach((b, bi) => { if (bi !== ai && !seen.has(bi) && b.p !== a.p && Math.hypot(a.v.x - b.v.x, a.v.y - b.v.y) <= gap) near.push(bi); });
    if (near.length < 2) return;
    const cx = near.reduce((s, k) => s + pts[k].v.x, 0) / near.length;
    const cy = near.reduce((s, k) => s + pts[k].v.y, 0) / near.length;
    for (const k of near) { seen.add(k); pts[k].v.x = cx; pts[k].v.y = cy; }
  });
  return out;
}

/** Drops repeated and collinear corners that the snapping can leave behind. */
export function tidy(poly: Vec2[]): Vec2[] {
  let r = poly.filter((v, i) => { const n = poly[(i + 1) % poly.length]; return Math.hypot(v.x - n.x, v.y - n.y) > 1e-6; });
  let changed = true;
  while (changed && r.length > 3) {
    changed = false;
    for (let i = 0; i < r.length; i++) {
      const a = r[(i + r.length - 1) % r.length], b = r[i], c = r[(i + 1) % r.length];
      if (Math.abs((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)) < 1e-6) { r = r.filter((_, k) => k !== i); changed = true; break; }
    }
  }
  return r;
}

export function rescalePolys(polys: Vec2[][], k: number): Vec2[][] {
  return polys.map((r) => r.map((v) => ({ x: v.x * k, y: v.y * k })));
}

/** Multiplies every length in a model by `k` (the one-known-length correction). */
export function rescaleModel(model: SpaceModel, k: number): SpaceModel {
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  return {
    ...model,
    version: model.version + 1,
    spaces: model.spaces.map((s) => ({ ...s, polygon: s.polygon.map((v) => ({ x: r3(v.x * k), y: r3(v.y * k) })) })),
    openings: model.openings.map((o) => ({ ...o, offsetM: r3(o.offsetM * k), widthM: r3(o.widthM * k) })),
  };
}

/** Factor that makes the longest side of the plan equal `knownM`. */
export function factorForLength(sizeM: { w: number; h: number }, knownM: number): number | null {
  const cur = Math.max(sizeM.w, sizeM.h);
  return cur > 0 && knownM > 0 ? knownM / cur : null;
}

// ---------- build ----------

/** Cleans the raw reading, solves the scale and returns the model and report. Pure. */
export function buildFromRaw(raw: RawPlan, o: { name: string; imageUrl?: string; modelName?: string; now?: number; forceMPerPx?: number }): { model: SpaceModel; report: ImagePlanReport } {
  const now = o.now ?? Date.now();
  const rooms = raw.rooms.filter((r) => r.polygon.length >= 3 && polygonArea(r.polygon) > 16);
  const warnings: string[] = [];
  const emptyReport = (reason: string): ImagePlanReport => ({ ok: false, reason, scale: { source: 'none', mPerPx: null, used: 0, rejected: 0 }, confidence: 0, needsLength: false, warnings, rooms: [], doors: 0, windows: 0, sizeM: { w: 0, h: 0 }, model: o.modelName ?? '' });
  const emptyModel: SpaceModel = { id: `drawing-${now}`, name: o.name, version: 1, units: 'm', ceilingM: 2.6, sourceLabel: `Picture: ${o.name}`, spaces: [], openings: [], furniture: [], measurements: [], evidence: [] };
  if (!rooms.length) return { model: emptyModel, report: emptyReport('No rooms found') };

  const sol = o.forceMPerPx ? { mPerPx: o.forceMPerPx, source: 'dimensions' as ScaleSource, used: 1, rejected: 0, spreadPct: 0 } : scaleFromRaw({ ...raw, rooms });
  const needsLength = sol.mPerPx == null;
  // With nothing to go on, show the plan at a nominal size so the person can correct it with one length.
  const k = sol.mPerPx ?? 14 / Math.max(raw.width, raw.height, 1);
  if (sol.rejected) warnings.push(`${sol.rejected} hint${sol.rejected > 1 ? 's' : ''} ignored`);
  if (sol.source === 'door') warnings.push('Scale assumed from door width');
  if (needsLength) warnings.push('No scale found');

  let polys = rescalePolys(rooms.map((r) => r.polygon), k);
  polys = snapAxis(polys);
  polys = mergeSharedWalls(polys, 0.3);
  polys = closeGaps(polys, 0.15);
  polys = polys.map(tidy);
  polys = polys.map((p) => (shoelace(p) < 0 ? [...p].reverse() : p));
  const all = polys.flat();
  const minX = Math.min(...all.map((p) => p.x)), minY = Math.min(...all.map((p) => p.y));
  const maxX = Math.max(...all.map((p) => p.x)), maxY = Math.max(...all.map((p) => p.y));
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  polys = polys.map((p) => p.map((v) => ({ x: r3(v.x - minX), y: r3(v.y - minY) })));

  const evidence: Evidence[] = [];
  const reportRooms: ImagePlanReport['rooms'] = [];
  const spaces: Space[] = rooms.map((r, i) => {
    const poly = polys[i];
    const id = `room-${i + 1}`;
    const p = purposeOf(r.name);
    const area = polygonArea(poly);
    const xs = r.polygon.map((v) => v.x / raw.width), ys = r.polygon.map((v) => v.y / raw.height);
    evidence.push({ id: `ev-${id}`, kind: 'image', label: `${o.name}: ${r.name}`, imageUrl: o.imageUrl, page: 0, bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)], note: r.areaM2 ? `Printed ${r.areaM2} m², outline ${area.toFixed(2)} m².` : `Outline ${area.toFixed(2)} m².`, createdAt: now });
    reportRooms.push({ spaceId: id, name: r.name, printedArea: r.areaM2, computedArea: Math.round(area * 100) / 100, outline: poly.map((v) => ({ x: (v.x + minX) / (k * raw.width), y: (v.y + minY) / (k * raw.height) })) });
    return { id, name: r.name, purpose: p?.purpose, polygon: poly, walls: poly.map(() => ({ thicknessM: 0.1, sourceKind: 'photo-inferred' as const, status: 'estimated' as const })) };
  });

  // Openings sit on the wall nearest to the point the model gave.
  const openings: Opening[] = [];
  let doors = 0, windows = 0;
  for (const op of raw.openings) {
    const at = { x: op.at.x * k - minX, y: op.at.y * k - minY };
    let best: { s: number; w: number; d: number; off: number; len: number } | null = null;
    spaces.forEach((s, si) => s.polygon.forEach((a, wi) => {
      const b = s.polygon[(wi + 1) % s.polygon.length];
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
      if (len < 0.3) return;
      const t = Math.max(0, Math.min(len, ((at.x - a.x) * dx + (at.y - a.y) * dy) / len));
      const d = Math.hypot(a.x + (dx / len) * t - at.x, a.y + (dy / len) * t - at.y);
      if (!best || d < best.d) best = { s: si, w: wi, d, off: t, len };
    }));
    if (!best) continue;
    const b = best as { s: number; w: number; d: number; off: number; len: number };
    if (b.d > 0.6) continue;
    const w = Math.min(Math.max(op.widthPx * k, 0.4), op.kind === 'door' ? 1.4 : 3, b.len - 0.1);
    if (w < 0.3) continue;
    const off = Math.min(Math.max(b.off, w / 2 + 0.05), b.len - w / 2 - 0.05);
    openings.push({
      id: `op-${openings.length + 1}`, kind: op.kind, spaceId: spaces[b.s].id, wallIndex: b.w, offsetM: r3(off), widthM: r3(w),
      heightM: op.kind === 'door' ? 2.05 : 1.2, sillM: op.kind === 'door' ? 0 : 0.9, swing: op.kind === 'door' ? 'in' : 'none', hinge: 'start',
      sourceKind: 'photo-inferred', status: 'estimated',
    });
    if (op.kind === 'door') doors++; else windows++;
  }

  const base = sol.source === 'dimensions' ? 0.9 : sol.source === 'areas' ? 0.75 : sol.source === 'door' ? 0.45 : 0.1;
  const confidence = Math.max(0, Math.min(1, base - Math.min(0.3, sol.spreadPct / 100) - (sol.rejected ? 0.05 : 0)));
  const model: SpaceModel = { ...emptyModel, name: o.name.replace(/\.(png|jpe?g|webp|pdf)$/i, ''), sourceLabel: `Picture: ${o.name}, estimated`, spaces, openings, evidence };
  return {
    model,
    report: {
      ok: true, scale: { source: sol.source, mPerPx: sol.mPerPx, used: sol.used, rejected: sol.rejected }, confidence: Math.round(confidence * 100) / 100,
      needsLength, warnings, rooms: reportRooms, doors, windows, sizeM: { w: r3(maxX - minX), h: r3(maxY - minY) }, model: o.modelName ?? '',
    },
  };
}

// ---------- vision ----------

const PT = { type: 'OBJECT', properties: { x: { type: 'NUMBER' }, y: { type: 'NUMBER' } }, required: ['x', 'y'] };
export const IMAGE_PLAN_SCHEMA = {
  type: 'OBJECT',
  properties: {
    rooms: { type: 'ARRAY', items: { type: 'OBJECT', properties: { name: { type: 'STRING' }, areaM2: { type: 'NUMBER' }, polygon: { type: 'ARRAY', items: PT } }, required: ['name', 'polygon'] } },
    openings: { type: 'ARRAY', items: { type: 'OBJECT', properties: { kind: { type: 'STRING', enum: ['door', 'window'] }, at: PT, widthPx: { type: 'NUMBER' } }, required: ['kind', 'at', 'widthPx'] } },
    dimensions: { type: 'ARRAY', items: { type: 'OBJECT', properties: { text: { type: 'STRING' }, valueM: { type: 'NUMBER' }, a: PT, b: PT }, required: ['text', 'a', 'b'] } },
  },
  required: ['rooms', 'openings', 'dimensions'],
};

export const imagePlanPrompt = (w: number, h: number) => `This image (${w} x ${h} pixels, origin top-left, x right, y down) shows a floor plan: a photo, scan, listing picture or sketch. Read it exactly, in pixel coordinates of this image.
rooms: every room with its printed name (or a short generic name), its printed area in m² only if written in the picture (never estimate), and its outline along the inner wall faces as polygon corners in pixels, clockwise. Rooms that share a wall must use the same coordinates along it.
openings: every door and window: kind, the centre point on the wall in pixels, and its width in pixels along the wall.
dimensions: every printed length (text exactly as printed, valueM in metres when you can convert it) with the two pixel points it measures, a and b. A scale bar counts as a dimension.
Omit anything you cannot see. Never invent numbers.`;

function num(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }
const pt = (p: unknown): Vec2 => ({ x: num((p as Vec2)?.x), y: num((p as Vec2)?.y) });

/** Defensive read of the model's JSON. */
export function parseRaw(data: unknown, width: number, height: number): RawPlan {
  const d = (data ?? {}) as Record<string, unknown>;
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  const inside = (p: Vec2) => ({ x: Math.min(width, Math.max(0, p.x)), y: Math.min(height, Math.max(0, p.y)) });
  return {
    width, height,
    rooms: arr(d.rooms).map((r: Record<string, unknown>) => ({
      name: String(r.name ?? 'Room').slice(0, 40),
      areaM2: num(r.areaM2) > 0.5 && num(r.areaM2) < 2000 ? num(r.areaM2) : undefined,
      polygon: arr(r.polygon).map((p) => inside(pt(p))),
    })),
    openings: arr(d.openings).map((r: Record<string, unknown>) => ({ kind: r.kind === 'window' ? 'window' as const : 'door' as const, at: inside(pt(r.at)), widthPx: num(r.widthPx) })).filter((o) => o.widthPx > 0),
    dimensions: arr(d.dimensions).map((r: Record<string, unknown>) => ({ text: String(r.text ?? ''), valueM: num(r.valueM) > 0 ? num(r.valueM) : undefined, a: pt(r.a), b: pt(r.b) })),
  };
}

async function toJpeg(blob: Blob, max: number): Promise<{ url: string; w: number; h: number }> {
  const src = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return { url: c.toDataURL('image/jpeg', 0.88), w: c.width, h: c.height };
  } finally { URL.revokeObjectURL(src); }
}

/** Sends the image to Gemini vision (strongest model first) and returns the raw reading. Needs a browser canvas. */
export async function readImagePlan(file: Blob, opts: { signal?: AbortSignal } = {}): Promise<{ raw: RawPlan; model: string }> {
  const [{ strongCall }, { dataUrlToInlineData }] = await Promise.all([import('../photoroom/strong'), import('../../core/gemini')]);
  const img = await toJpeg(file, 1600);
  return readImageUrl(img.url, img.w, img.h, strongCall, dataUrlToInlineData, opts.signal);
}

async function readImageUrl(url: string, w: number, h: number, strongCall: typeof import('../photoroom/strong').strongCall, inline: (u: string) => import('../../core/gemini').GeminiPart, signal?: AbortSignal) {
  const r = await strongCall<unknown>({
    system: 'You read architectural floor plans precisely. Never invent rooms or numbers.',
    parts: [inline(url), { text: imagePlanPrompt(w, h) }], schema: IMAGE_PLAN_SCHEMA, thinking: 'low', temperature: 0.1,
  }, { signal });
  return { raw: parseRaw(r.data, w, h), model: r.model };
}

/** Same as imageToPlan for a picture already rendered to a data URL (a scanned PDF page). */
export async function dataUrlToPlan(url: string, w: number, h: number, o: { name: string; imageUrl?: string; signal?: AbortSignal }): Promise<{ model: SpaceModel; report: ImagePlanReport }> {
  const [{ strongCall }, { dataUrlToInlineData }] = await Promise.all([import('../photoroom/strong'), import('../../core/gemini')]);
  const { raw, model } = await readImageUrl(url, w, h, strongCall, dataUrlToInlineData, o.signal);
  return buildFromRaw(raw, { name: o.name, imageUrl: o.imageUrl, modelName: model });
}

/** The whole flow: image file in, estimated SpaceModel and report out. */
export async function imageToPlan(file: Blob, o: { name?: string; imageUrl?: string; signal?: AbortSignal } = {}): Promise<{ model: SpaceModel; report: ImagePlanReport }> {
  const name = o.name ?? (file as File).name ?? 'plan.png';
  const { raw, model } = await readImagePlan(file, { signal: o.signal });
  return buildFromRaw(raw, { name, imageUrl: o.imageUrl, modelName: model });
}
