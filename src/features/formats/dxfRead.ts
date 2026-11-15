/**
 * ASCII DXF reader: group-code pairs to flattened geometry (lines, polylines with bulges, arcs,
 * circles, block inserts with transforms, text), then to a SpaceModel. Coordinates come out in
 * metres with y down (plan frame). Everything read from a file is treated as untrusted data.
 */
import type { Evidence, FurnitureItem, Opening, Space, SpaceModel, Vec2 } from '../../core/types';
import type { PagePaths, VPath } from '../drawings/pdfPaths';
import type { TextItem } from '../drawings/textCore';
import { classify } from '../drawings/textCore';
import { buildFromPaths } from '../drawings/toBuilding';
import { purposeOf } from '../drawings/purpose';

export type Pt = Vec2;
export interface DxfLine { layer: string; pts: Pt[]; closed: boolean; kind: 'line' | 'poly' | 'arc' | 'circle' }
export interface DxfText { layer: string; str: string; at: Pt; h: number }
export interface DxfDoc {
  /** Metres per drawing unit; null when the file does not say. */
  unitM: number | null;
  insUnits: number;
  lines: DxfLine[];
  texts: DxfText[];
  layers: string[];
  warnings: string[];
}

type Pair = [number, string];
const UNIT_M: Record<number, number> = { 1: 0.0254, 2: 0.3048, 4: 0.001, 5: 0.01, 6: 1, 3: 1609.344, 7: 1000, 10: 0.9144 };
const MAX_ENTITIES = 400000;

function pairs(text: string): Pair[] {
  const L = text.split(/\r?\n/);
  const out: Pair[] = [];
  for (let i = 0; i + 1 < L.length; i += 2) {
    const c = parseInt(L[i].trim(), 10);
    if (Number.isNaN(c)) { i -= 1; continue; }
    out.push([c, L[i + 1]]);
  }
  return out;
}

interface Ent { type: string; layer: string; g: Pair[] }
const num = (e: Ent, code: number, d = 0) => { const p = e.g.find((x) => x[0] === code); const v = p ? parseFloat(p[1]) : NaN; return Number.isFinite(v) ? v : d; };
const str = (e: Ent, code: number) => e.g.find((x) => x[0] === code)?.[1] ?? '';

function splitEntities(ps: Pair[], from: number, to: number): Ent[] {
  const out: Ent[] = [];
  let cur: Ent | null = null;
  for (let i = from; i < to; i++) {
    const [c, v] = ps[i];
    if (c === 0) { cur = { type: v.trim().toUpperCase(), layer: '0', g: [] }; out.push(cur); }
    else if (cur) { if (c === 8) cur.layer = v.trim(); cur.g.push([c, v]); }
  }
  return out;
}

function sections(ps: Pair[]): Map<string, [number, number]> {
  const m = new Map<string, [number, number]>();
  for (let i = 0; i < ps.length; i++) {
    if (ps[i][0] === 0 && ps[i][1].trim() === 'SECTION' && ps[i + 1]?.[0] === 2) {
      const name = ps[i + 1][1].trim();
      let j = i + 2;
      while (j < ps.length && !(ps[j][0] === 0 && ps[j][1].trim() === 'ENDSEC')) j++;
      m.set(name, [i + 2, j]);
      i = j;
    }
  }
  return m;
}

type Tf = (p: Pt) => Pt;
const ident: Tf = (p) => p;

function arcPts(c: Pt, r: number, a0: number, a1: number): Pt[] {
  let sweep = a1 - a0; while (sweep <= 0) sweep += Math.PI * 2;
  const n = Math.max(4, Math.ceil(sweep / (Math.PI / 24)));
  return Array.from({ length: n + 1 }, (_, i) => ({ x: c.x + r * Math.cos(a0 + (sweep * i) / n), y: c.y + r * Math.sin(a0 + (sweep * i) / n) }));
}

function bulgeSeg(a: Pt, b: Pt, bulge: number): Pt[] {
  if (!bulge) return [b];
  const d = Math.hypot(b.x - a.x, b.y - a.y); if (d < 1e-12) return [b];
  const th = 4 * Math.atan(bulge);
  const r = d / (2 * Math.sin(Math.abs(th) / 2));
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const h = r * Math.cos(th / 2);
  const nx = -(b.y - a.y) / d, ny = (b.x - a.x) / d;
  const c = { x: mx + nx * h, y: my + ny * h };
  const a0 = Math.atan2(a.y - c.y, a.x - c.x);
  const n = Math.max(2, Math.ceil(Math.abs(th) / (Math.PI / 24)));
  return Array.from({ length: n }, (_, i) => { const t = a0 + (th * (i + 1)) / n; return { x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t) }; });
}

function polyOut(pts: Pt[], bul: number[], closed: boolean): Pt[] {
  const out: Pt[] = pts.length ? [pts[0]] : [];
  const n = closed ? pts.length : pts.length - 1;
  for (let k = 0; k < n; k++) out.push(...bulgeSeg(pts[k], pts[(k + 1) % pts.length], bul[k]));
  if (closed && out.length > 1) out.pop();
  return out.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
}

/** Parses DXF text. Never throws on odd input; problems become warnings. */
export function parseDxf(text: string): DxfDoc {
  const ps = pairs(text);
  const sec = sections(ps);
  const warnings: string[] = [];
  let insUnits = 0;
  const hs = sec.get('HEADER');
  if (hs) for (let i = hs[0]; i < hs[1]; i++) if (ps[i][0] === 9 && ps[i][1].trim() === '$INSUNITS' && ps[i + 1]) insUnits = parseInt(ps[i + 1][1], 10) || 0;

  const blocks = new Map<string, { base: Pt; ents: Ent[] }>();
  const bs = sec.get('BLOCKS');
  if (bs) {
    let cur: { base: Pt; ents: Ent[] } | null = null;
    for (const e of splitEntities(ps, bs[0], bs[1])) {
      if (e.type === 'BLOCK') { cur = { base: { x: num(e, 10), y: num(e, 20) }, ents: [] }; blocks.set(str(e, 2), cur); }
      else if (e.type === 'ENDBLK') cur = null;
      else if (cur) cur.ents.push(e);
    }
  }
  const lines: DxfLine[] = [];
  const texts: DxfText[] = [];
  const layers = new Set<string>();
  let budget = MAX_ENTITIES;

  const emit = (ents: Ent[], tf: Tf, inherit: string | null, depth: number, scale: number) => {
    for (let i = 0; i < ents.length && budget > 0; i++) {
      const e = ents[i];
      const layer = e.layer === '0' && inherit ? inherit : e.layer;
      const add = (pts: Pt[], closed: boolean, kind: DxfLine['kind']) => { if (pts.length >= 2) { budget--; layers.add(layer); lines.push({ layer, pts: pts.map(tf), closed, kind }); } };
      switch (e.type) {
        case 'LINE': add([{ x: num(e, 10), y: num(e, 20) }, { x: num(e, 11), y: num(e, 21) }], false, 'line'); break;
        case 'LWPOLYLINE': {
          const pts: Pt[] = []; const bul: number[] = [];
          for (const [c, v] of e.g) {
            if (c === 10) { pts.push({ x: parseFloat(v), y: 0 }); bul.push(0); }
            else if (c === 20 && pts.length) pts[pts.length - 1].y = parseFloat(v);
            else if (c === 42 && bul.length) bul[bul.length - 1] = parseFloat(v);
          }
          const closed = (num(e, 70) & 1) === 1;
          add(polyOut(pts, bul, closed), closed, 'poly');
          break;
        }
        case 'POLYLINE': {
          const pts: Pt[] = []; const bul: number[] = [];
          let j = i + 1;
          for (; j < ents.length && ents[j].type !== 'SEQEND'; j++) {
            if (ents[j].type === 'VERTEX' && (num(ents[j], 70) & 16) === 0) { pts.push({ x: num(ents[j], 10), y: num(ents[j], 20) }); bul.push(num(ents[j], 42)); }
          }
          i = j;
          const closed = (num(e, 70) & 1) === 1;
          add(polyOut(pts, bul, closed), closed, 'poly');
          break;
        }
        case 'ARC': add(arcPts({ x: num(e, 10), y: num(e, 20) }, num(e, 40), (num(e, 50) * Math.PI) / 180, (num(e, 51) * Math.PI) / 180), false, 'arc'); break;
        case 'CIRCLE': { const p = arcPts({ x: num(e, 10), y: num(e, 20) }, num(e, 40), 0, Math.PI * 2 - 1e-6); p.pop(); add(p, true, 'circle'); break; }
        case 'TEXT': case 'MTEXT': {
          let s = e.type === 'MTEXT' ? e.g.filter((x) => x[0] === 3).map((x) => x[1]).join('') + str(e, 1) : str(e, 1);
          s = s.replace(/\\[Pp]/g, ' ').replace(/\\[A-Za-z][^;]*;/g, '').replace(/[{}]/g, '').replace(/%%[cC]/g, 'dia ').replace(/\s+/g, ' ').trim();
          if (s) { budget--; layers.add(layer); texts.push({ layer, str: s, at: tf({ x: num(e, 10), y: num(e, 20) }), h: num(e, 40) * scale }); }
          break;
        }
        case 'INSERT': {
          const b = blocks.get(str(e, 2));
          if (!b || depth >= 4) break;
          const sx = num(e, 41, 1) || 1, sy = num(e, 42, 1) || 1, rot = (num(e, 50) * Math.PI) / 180;
          const ox = num(e, 10), oy = num(e, 20);
          const cs = Math.cos(rot), sn = Math.sin(rot);
          const inner: Tf = (p) => {
            const x = (p.x - b.base.x) * sx, y = (p.y - b.base.y) * sy;
            return tf({ x: ox + x * cs - y * sn, y: oy + x * sn + y * cs });
          };
          emit(b.ents, inner, layer, depth + 1, scale * Math.abs(sx));
          break;
        }
      }
    }
  };
  const es = sec.get('ENTITIES');
  if (!es) warnings.push('No ENTITIES section: this does not look like an ASCII DXF.');
  else emit(splitEntities(ps, es[0], es[1]), ident, null, 0, 1);
  if (budget <= 0) warnings.push('Very large drawing: only the first part was read.');
  return { unitM: UNIT_M[insUnits] ?? null, insUnits, lines, texts, layers: [...layers], warnings };
}

const WALL_RE = /wall|mur|wand|wände|vägg|vagg|seina|muro/i;
const DOOR_RE = /door|porte|tür|tuer|dörr|dorr|ovi|porta/i;
const WINDOW_RE = /window|fenster|fönster|fonster|fenêtre|fenetre|ikkuna|finestra|a-glaz/i;
const ROOM_RE = /room|raum|space|zone|piece|pièce|rum\b|huone|stanza|a-area/i;
const NOT_ROOM_RE = /unit|apart|building|site|plot|boundary|level|storey|floor_outline|text|label|name|number/i;

export interface DxfReport {
  method: 'room-outlines' | 'walls-fill' | 'none';
  rooms: number;
  doors: number;
  windows: number;
  unitM: number | null;
  scaleAssumed: boolean;
  layers: string[];
  warnings: string[];
}

const shoelace = (p: Pt[]) => p.reduce((s, a, i) => { const b = p[(i + 1) % p.length]; return s + (a.x * b.y - b.x * a.y); }, 0) / 2;
const inRing = (p: Pt, ring: Pt[]) => { let ins = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const a = ring[i], b = ring[j]; if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) ins = !ins; } return ins; };
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const centroid = (p: Pt[]): Pt => ({ x: p.reduce((s, q) => s + q.x, 0) / p.length, y: p.reduce((s, q) => s + q.y, 0) / p.length });

function dedupe(poly: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of poly) { const q = out[out.length - 1]; if (!q || Math.hypot(p.x - q.x, p.y - q.y) > 1e-4) out.push(p); }
  if (out.length > 1 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) < 1e-4) out.pop();
  return out.filter((p, i) => { const a = out[(i + out.length - 1) % out.length], b = out[(i + 1) % out.length]; return Math.abs((p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x)) > 1e-6 * (Math.hypot(b.x - a.x, b.y - a.y) || 1); });
}

interface Box { x0: number; y0: number; x1: number; y1: number; arcs: number }

/** Clusters entities on a layer by touching bounding boxes; returns one box per cluster. */
function clusters(ls: DxfLine[], margin: number): Box[] {
  const boxes = ls.slice(0, 3000).map((l) => ({ x0: Math.min(...l.pts.map((p) => p.x)), y0: Math.min(...l.pts.map((p) => p.y)), x1: Math.max(...l.pts.map((p) => p.x)), y1: Math.max(...l.pts.map((p) => p.y)) }));
  const par = boxes.map((_, i) => i);
  const f = (i: number): number => (par[i] === i ? i : (par[i] = f(par[i])));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    if (a.x0 - margin <= b.x1 && b.x0 - margin <= a.x1 && a.y0 - margin <= b.y1 && b.y0 - margin <= a.y1) par[f(i)] = f(j);
  }
  const m = new Map<number, Box>();
  boxes.forEach((b, i) => {
    const r = f(i); const c = m.get(r);
    const arc = ls[i].kind === 'arc' ? 1 : 0;
    if (!c) m.set(r, { ...b, arcs: arc }); else { c.x0 = Math.min(c.x0, b.x0); c.y0 = Math.min(c.y0, b.y0); c.x1 = Math.max(c.x1, b.x1); c.y1 = Math.max(c.y1, b.y1); c.arcs += arc; }
  });
  return [...m.values()];
}

function placeOpenings(kind: 'door' | 'window', cl: Box[], spaces: Space[]): Opening[] {
  const out: Opening[] = [];
  for (const c of cl) {
    const w = Math.max(c.x1 - c.x0, c.y1 - c.y0), cx = (c.x0 + c.x1) / 2, cy = (c.y0 + c.y1) / 2;
    if (w < 0.4 || w > (kind === 'door' ? 2.6 : 5)) continue;
    let best: { s: Space; i: number; d: number; t: number } | null = null;
    for (const s of spaces) for (let i = 0; i < s.polygon.length; i++) {
      const a = s.polygon[i], b = s.polygon[(i + 1) % s.polygon.length];
      const L = Math.hypot(b.x - a.x, b.y - a.y); if (L < 0.2) continue;
      const t = Math.max(0, Math.min(L, ((cx - a.x) * (b.x - a.x) + (cy - a.y) * (b.y - a.y)) / L));
      const d = Math.hypot(a.x + ((b.x - a.x) * t) / L - cx, a.y + ((b.y - a.y) * t) / L - cy);
      if (!best || d < best.d) best = { s, i, d, t };
    }
    if (!best || best.d > 0.6) continue;
    out.push({
      id: `${kind}-${out.length + 1}`, kind, spaceId: best.s.id, wallIndex: best.i, offsetM: r3(best.t), widthM: r3(Math.min(w, kind === 'door' ? 1.2 : 3)),
      heightM: kind === 'door' ? 2.05 : 1.2, sillM: kind === 'door' ? 0 : 0.9, swing: kind === 'door' && c.arcs ? 'in' : 'none', hinge: 'start',
      sourceKind: 'pdf-annotation', status: 'estimated',
    });
  }
  return out;
}

export interface DxfResult { model: SpaceModel; report: DxfReport }

/** Builds a SpaceModel from DXF text. Everything it finds is marked estimated. */
export function dxfToModel(textIn: string, name = 'drawing.dxf', opts: { now?: number; unitM?: number } = {}): DxfResult {
  const doc = parseDxf(textIn);
  const now = opts.now ?? Date.now();
  const warnings = [...doc.warnings];
  let unitM = opts.unitM ?? doc.unitM;
  let scaleAssumed = false;
  const base = name.replace(/\.dxf$/i, '');
  const all0 = doc.lines.flatMap((l) => l.pts);
  const empty = (m: string): DxfResult => ({
    model: { id: `dxf-${now}`, name: base, version: 1, units: 'm', ceilingM: 2.6, sourceLabel: `DXF: ${name}`, spaces: [], openings: [], furniture: [], measurements: [], evidence: [] },
    report: { method: 'none', rooms: 0, doors: 0, windows: 0, unitM, scaleAssumed, layers: doc.layers, warnings: [...warnings, m] },
  });
  if (!all0.length) return empty('No drawing lines found.');
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of all0) { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; }
  if (!unitM) {
    const ext = Math.max(maxX - minX, maxY - minY);
    unitM = ext > 2000 ? 0.001 : ext > 200 ? 0.01 : 1;
    scaleAssumed = true;
    warnings.push(`The file does not state its units; assumed ${unitM === 0.001 ? 'millimetres' : unitM === 0.01 ? 'centimetres' : 'metres'}.`);
  }
  const u = unitM;
  const M = (p: Pt): Pt => ({ x: (p.x - minX) * u, y: (maxY - p.y) * u });
  const lines = doc.lines.map((l) => ({ ...l, pts: l.pts.map(M) }));
  const texts = doc.texts.map((t) => ({ ...t, at: M(t.at), h: t.h * u }));

  const wallLines = lines.filter((l) => WALL_RE.test(l.layer));
  const roomLines = lines.filter((l) => l.closed && ROOM_RE.test(l.layer) && !NOT_ROOM_RE.test(l.layer) && l.pts.length >= 3);
  const doorLines = lines.filter((l) => DOOR_RE.test(l.layer));
  const winLines = lines.filter((l) => WINDOW_RE.test(l.layer));
  const roomTexts = texts.filter((t) => !/dim|hatch|grid|axis|title/i.test(t.layer));

  const evidence: Evidence[] = [{ id: 'ev-dxf', kind: 'manual', label: `DXF file ${name}`, note: `Read from a CAD drawing; units ${doc.insUnits ? `code ${doc.insUnits}` : 'not stated'}.`, createdAt: now }];

  const nameFor = (poly: Pt[]): string | undefined => {
    for (const t of roomTexts) {
      if (!inRing(t.at, poly)) continue;
      if (classify(t.str).kind === 'area') continue;
      if (/[a-zA-ZÀ-ÿ]{2}/.test(t.str) && t.str.length <= 40) return t.str;
    }
    return undefined;
  };

  const mkSpace = (poly0: Pt[], i: number): Space | null => {
    let poly = dedupe(poly0);
    if (poly.length < 3) return null;
    if (shoelace(poly) < 0) poly = [...poly].reverse();
    if (Math.abs(shoelace(poly)) < 0.8) return null;
    const nm = nameFor(poly) ?? `Room ${i + 1}`;
    const p = purposeOf(nm);
    return { id: `room-${i + 1}`, name: nm, purpose: p?.purpose, polygon: poly.map((q) => ({ x: r3(q.x), y: r3(q.y) })), walls: poly.map(() => ({ thicknessM: 0.15, sourceKind: 'pdf-annotation' as const, status: 'estimated' as const })) };
  };

  let spaces: Space[] = [];
  let method: DxfReport['method'] = 'none';
  if (roomLines.length) {
    const sorted = roomLines.map((l) => ({ l, a: Math.abs(shoelace(l.pts)) })).filter((x) => x.a > 0.8).sort((a, b) => a.a - b.a);
    const kept: typeof sorted = [];
    for (const c of sorted) {
      const dup = kept.some((k) => Math.abs(k.a - c.a) < 0.01 && inRing(centroid(k.l.pts), c.l.pts));
      if (!dup) kept.push(c);
    }
    // a shape that holds two or more smaller shapes is a floor or zone, not a room
    const inner = kept.filter((c) => kept.filter((o) => o !== c && o.a < c.a && inRing(o.l.pts[0], c.l.pts)).length < 2);
    inner.sort((a, b) => { const ca = centroid(a.l.pts), cb = centroid(b.l.pts); return Math.abs(ca.y - cb.y) > 1 ? ca.y - cb.y : ca.x - cb.x; });
    spaces = inner.map((c, i) => mkSpace(c.l.pts, i)).filter((s): s is Space => !!s);
    if (spaces.length) method = 'room-outlines';
  }

  let built: SpaceModel | null = null;
  if (!spaces.length) {
    // Fall back to the drawing-sheet pipeline: lines become strokes (walls thick) and it finds the rooms.
    try {
      const W = maxX * 0 + (maxX - minX) * u + 1, H = (maxY - minY) * u + 1;
      const useWalls = wallLines.length > 0;
      const keep = useWalls ? lines.filter((l) => WALL_RE.test(l.layer) || DOOR_RE.test(l.layer) || WINDOW_RE.test(l.layer)) : lines;
      const paths: VPath[] = keep.map((l) => {
        const arc = l.kind === 'arc';
        return { paint: 'stroke', lw: useWalls && WALL_RE.test(l.layer) ? 0.1 : 0.02, stroke: [0, 0, 0], fill: [0, 0, 0], dashed: false, subs: [l.pts], closed: [l.closed], curves: arc ? l.pts.length - 1 : 0, arcs: arc ? [l.pts] : [] };
      });
      const items: TextItem[] = texts.map((t, id) => {
        const h = Math.max(t.h, 0.1), w = h * 0.6 * t.str.length; const k = classify(t.str);
        return { id, page: 1, str: t.str, x: t.at.x / W, y: (t.at.y - h) / H, w: w / W, h: h / H, kind: k.kind, value: k.value };
      });
      const pp: PagePaths = { w: W, h: H, paths };
      const r = buildFromPaths(pp, items, 1, { mPerPt: 1, name, now, cellM: 0.05 });
      if (r.model.spaces.length) { built = r.model; spaces = r.model.spaces; method = 'walls-fill'; }
      else warnings.push('No closed rooms found from the wall lines.');
    } catch (e) { warnings.push(`Room finder failed: ${(e as Error).message}`); }
  }

  const openings: Opening[] = built ? built.openings : [
    ...placeOpenings('door', clusters(doorLines, 0.05), spaces),
    ...placeOpenings('window', clusters(winLines, 0.05), spaces).map((o, i) => ({ ...o, id: `window-${i + 1}` })),
  ];
  const furniture: FurnitureItem[] = [];
  const model: SpaceModel = {
    id: `dxf-${now}`, name: base, version: 1, units: 'm', ceilingM: 2.6,
    sourceLabel: `DXF: ${name}, rooms ${method === 'room-outlines' ? 'from room outlines' : 'found between walls'}; all estimated`,
    spaces, openings, furniture, measurements: built ? built.measurements : [], evidence: built ? [...evidence, ...built.evidence] : evidence,
  };
  return {
    model,
    report: { method, rooms: spaces.length, doors: openings.filter((o) => o.kind === 'door').length, windows: openings.filter((o) => o.kind === 'window').length, unitM, scaleAssumed, layers: doc.layers, warnings },
  };
}
