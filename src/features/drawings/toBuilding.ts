/**
 * Turns the geometry recovered from a vector plan into the app's spatial model: one Space per
 * room, doors as Openings on the walls of both rooms they join, windows on the outer walls, and
 * Evidence on every wall and room pointing back to its spot on the sheet.
 *
 * Room polygons follow the inner wall faces, so their areas are net floor areas. Each wall is
 * drawn outward from the face: interior walls carry half their measured thickness on each side,
 * outer walls carry all of it.
 */
import type { Evidence, Measurement, Opening, Space, SpaceModel, Vec2, WallMeta } from '../../core/types';
import type { PagePaths, P } from './pdfPaths';
import type { TextItem } from './textCore';
import { extractPlan, polyArea, type ExtractOptions, type PlanGeometry } from './extract';
import { OUTDOOR_PURPOSES, purposeOf } from './purpose';
import type { DrawingDoc } from './drawingIndex';

export interface RoomReport {
  spaceId: string;
  no?: string;
  /** Name as printed, or "Room 2.04" when only a number is printed. */
  name: string;
  purpose?: string;
  printedArea?: number;
  computedArea: number;
  /** (computed - printed) / printed, percent. */
  errorPct?: number;
  status: 'verified' | 'estimated';
  windows: number;
  doors: number;
  /** Outline in normalised page coordinates (0..1), for drawing over the sheet. */
  outline: Vec2[];
  /** Room centre in model metres. */
  centre: Vec2;
}

export interface BuildReport {
  ok: boolean;
  /** Plain reason when the build failed. */
  reason?: string;
  page: number;
  rooms: RoomReport[];
  failed: Array<{ no?: string; label?: string; reason: string; box: [number, number, number, number] }>;
  /** Door swings drawn on the sheet (a swing drawn twice counts twice, as printed). */
  doorSwings: number;
  doors: number;
  windows: number;
  wallSource: PlanGeometry['wallSource'];
  scale: { source: PlanGeometry['scaleSource']; n?: number; mPerPt: number | null; areaFitDiffPct?: number };
  /** Median |error| over rooms with a printed area, percent. */
  medianAreaErrorPct: number | null;
  verified: number;
  withPrintedArea: number;
  angleDeg: number;
  ms: number;
  warnings: string[];
  /** Walls in normalised page coordinates, for the overlay. */
  wallsNorm: Vec2[][];
}

export interface BuildOptions extends ExtractOptions {
  name?: string;
  /** Rendered page image (an object URL keeps the saved model small). */
  imageUrl?: string;
  ceilingM?: number;
  now?: number;
  /** Reuse a geometry already extracted. */
  plan?: PlanGeometry;
}

const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const median = (a: number[]) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

function pointInRing(p: P, ring: P[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function buildFromPaths(pp: PagePaths, items: TextItem[], page: number, opts: BuildOptions = {}): { model: SpaceModel; report: BuildReport; plan: PlanGeometry } {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const plan = opts.plan ?? extractPlan(pp, items, page, opts);
  const now = opts.now ?? Date.now();
  const W = plan.pageW, H = plan.pageH;
  const norm = (p: P): Vec2 => ({ x: p.x / W, y: p.y / H });
  const m = plan.mPerPt ?? 0;
  const ang = plan.angle;
  const cos = Math.cos(-ang), sin = Math.sin(-ang);
  // page points -> model metres (rotated so the walls run along the axes)
  const allPts = plan.rooms.flatMap((r) => r.polygon);
  const rotP = (p: P) => ({ x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos });
  const rp = allPts.map(rotP);
  const minX = rp.length ? Math.min(...rp.map((p) => p.x)) : 0, minY = rp.length ? Math.min(...rp.map((p) => p.y)) : 0;
  const toM = (p: P): Vec2 => { const q = rotP(p); return { x: r3((q.x - minX) * m), y: r3((q.y - minY) * m) }; };

  const failedOut = plan.failed.map((f) => {
    const xs = f.items.map((i) => i.x), ys = f.items.map((i) => i.y);
    const x1 = Math.max(...f.items.map((i) => i.x + i.w)), y1 = Math.max(...f.items.map((i) => i.y + i.h));
    return { no: f.no, label: f.label, reason: f.reason, box: [Math.min(...xs), Math.min(...ys), x1 - Math.min(...xs), y1 - Math.min(...ys)] as [number, number, number, number] };
  });
  const baseReport = {
    page, failed: failedOut, doorSwings: plan.doors.length, wallSource: plan.wallSource,
    scale: { source: plan.scaleSource, n: plan.scaleN, mPerPt: plan.mPerPt, areaFitDiffPct: plan.areaFitMPerPt && plan.scaleN ? Math.round((plan.areaFitMPerPt / (plan.scaleN * 0.0254 / 72) - 1) * 1000) / 10 : undefined },
    angleDeg: Math.round((ang * 180) / Math.PI * 10) / 10, warnings: plan.warnings,
    wallsNorm: plan.walls.map((r) => r.map(norm)),
  };
  const fail = (reason: string) => ({
    model: emptyBuilt(opts.name ?? 'Drawing', now),
    report: { ...baseReport, ok: false, reason, rooms: [], doors: 0, windows: 0, medianAreaErrorPct: null, verified: 0, withPrintedArea: 0, ms: 0 } as BuildReport,
    plan,
  });
  if (plan.wallSource === 'none') return fail('No walls found: the PDF has no drawn wall lines on this page (it may be a scan).');
  if (!plan.mPerPt) return fail('No scale: the sheet prints no "1:N" scale and no room areas to calibrate from.');
  if (!plan.rooms.length) return fail('Walls were found, but no closed rooms: the outlines have gaps the reader could not close.');

  const imageUrl = opts.imageUrl;
  const label = opts.name ?? 'Drawing';
  const evidence: Evidence[] = [];
  const measurements: Measurement[] = [];
  const bboxN = (pts: P[], pad = 0): [number, number, number, number] => {
    const xs = pts.map((p) => p.x / W), ys = pts.map((p) => p.y / H);
    const x0 = Math.min(...xs) - pad, y0 = Math.min(...ys) - pad;
    return [Math.max(0, x0), Math.max(0, y0), Math.max(0.004, Math.max(...xs) - x0 + pad), Math.max(0.004, Math.max(...ys) - y0 + pad)];
  };

  // Thickness behind each room edge: walk outward through wall material until free space.
  const ringBoxes = plan.walls.map((r) => { const xs = r.map((p) => p.x), ys = r.map((p) => p.y); return { r, x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }; });
  const inWall = (p: P) => ringBoxes.some((b) => p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1 && pointInRing(p, b.r));
  const roomPolys = plan.rooms.map((r) => r.polygon);
  const step = 0.01 / m; // 1 cm
  const maxSteps = Math.ceil(0.8 / 0.01);
  function behind(a: P, b: P, self: number): { thickPt: number; neighbour: number | null } {
    const L = dist(a, b) || 1;
    // positive shoelace area in y-down coordinates: the interior lies on (-uy, ux), outward is (uy, -ux)
    const sign = polyArea(roomPolys[self]) > 0 ? 1 : -1;
    const nx = ((b.y - a.y) / L) * sign, ny = (-(b.x - a.x) / L) * sign;
    let best = { thickPt: 0, neighbour: null as number | null };
    const votes: number[] = [];
    for (const t of [0.3, 0.5, 0.7]) {
      const s = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      let k = 1, entered = false;
      for (; k <= maxSteps; k++) {
        const q = { x: s.x + nx * step * k, y: s.y + ny * step * k };
        const w = inWall(q);
        if (w) entered = true; else if (entered || k > 6) break;
      }
      if (!entered) continue;
      votes.push(k * step);
      const exit = { x: s.x + nx * step * (k + 3), y: s.y + ny * step * (k + 3) };
      const nb = roomPolys.findIndex((poly, j) => j !== self && pointInRing(exit, poly));
      if (nb >= 0) best = { thickPt: 0, neighbour: nb };
    }
    best.thickPt = median(votes) ?? 0;
    return best;
  }

  const spaces: Space[] = [];
  const reports: RoomReport[] = [];
  plan.rooms.forEach((room, idx) => {
    let poly = room.polygon;
    if (polyArea(poly) < 0) poly = [...poly].reverse(); // clockwise on screen
    plan.rooms[idx] = { ...room, polygon: poly };
    roomPolys[idx] = poly;
  });
  plan.rooms.forEach((room, idx) => {
    const id = `room-${idx + 1}`;
    const poly = room.polygon;
    const pm = poly.map(toM);
    const area = Math.abs(polyArea(pm));
    let p = purposeOf(room.label);
    // Unlabelled rooms with sanitary fixtures drawn inside (curved symbols such as a WC or basin) are bathrooms.
    const fixtures = room.label ? 0 : fixtureCount(pp, poly, 0.65 / m);
    if (!p && fixtures >= 2) p = { purpose: 'bathroom', english: 'Bathroom' };
    const name = room.label ? (room.no ? `${room.label} ${room.no}` : room.label) : p ? `${p.english} ${room.no ?? idx + 1}` : room.no ? `Room ${room.no}` : `Space ${idx + 1}`;
    const errorPct = room.printedArea ? ((area - room.printedArea) / room.printedArea) * 100 : undefined;
    const status: 'verified' | 'estimated' = errorPct != null && Math.abs(errorPct) <= 2 ? 'verified' : 'estimated';
    const areaNote = room.printedArea != null
      ? `Printed ${room.printedArea.toFixed(2)} m², computed ${area.toFixed(2)} m² (${errorPct! >= 0 ? '+' : ''}${errorPct!.toFixed(1)}%).`
      : `Computed ${area.toFixed(2)} m². No area printed for this room.`;
    const roomEv: Evidence = { id: `ev-${id}`, kind: 'pdf', label: `${label} p${page + 1}: outline of ${name}`, imageUrl, page, bbox: bboxN(poly, 0.004), note: areaNote, createdAt: now };
    evidence.push(roomEv);
    const textEv: Evidence[] = room.items.length ? [{ id: `ev-${id}-text`, kind: 'pdf', label: `Printed label "${room.items.map((i) => i.str).join(' ')}"`, imageUrl, page, bbox: bboxN(room.items.flatMap((i) => [{ x: i.x * W, y: i.y * H }, { x: (i.x + i.w) * W, y: (i.y + i.h) * H }]), 0.003), createdAt: now }] : [];
    evidence.push(...textEv);
    const walls: WallMeta[] = poly.map((a, i) => {
      const b = poly[(i + 1) % poly.length];
      const bh = behind(a, b, idx);
      const t = bh.thickPt * m;
      const thicknessM = r3(Math.min(0.6, Math.max(0.06, bh.neighbour != null ? t / 2 : t || 0.2)));
      const len = dist(pm[i], pm[(i + 1) % pm.length]);
      const ev: Evidence = { id: `ev-${id}-w${i}`, kind: 'pdf', label: `${label} p${page + 1}: wall ${i + 1} of ${name}`, imageUrl, page, bbox: bboxN([a, b], 0.006), note: `${len.toFixed(2)} m long, ${Math.round((bh.neighbour != null ? t : t) * 100)} cm thick on the drawing${bh.neighbour != null ? `, shared with ${plan.rooms[bh.neighbour].label ?? plan.rooms[bh.neighbour].no ?? 'the next room'}` : ', outer wall'}.`, createdAt: now };
      evidence.push(ev);
      const ms: Measurement = { id: `m-${id}-w${i}`, label: `${name} wall ${i + 1}`, valueM: r3(len), sourceKind: 'pdf-annotation', status, toleranceM: r3(Math.max(0.02, (plan.mPerPt ?? 0) * 0.5)), evidenceIds: [ev.id, roomEv.id, ...textEv.map((e) => e.id)], targetId: `${id}:${i}` };
      measurements.push(ms);
      return { thicknessM, sourceKind: 'pdf-annotation', status, measurementId: ms.id };
    });
    spaces.push({ id, name, purpose: p?.purpose, polygon: pm, walls });
    const c = pm.reduce((s, q) => ({ x: s.x + q.x / pm.length, y: s.y + q.y / pm.length }), { x: 0, y: 0 });
    reports.push({ spaceId: id, no: room.no, name, purpose: p?.purpose, printedArea: room.printedArea, computedArea: Math.round(area * 100) / 100, errorPct: errorPct != null ? Math.round(errorPct * 10) / 10 : undefined, status, windows: 0, doors: 0, outline: poly.map(norm), centre: c });
  });

  // Openings: place each door and window on the nearest parallel wall of every room it touches.
  const openings: Opening[] = [];
  const wallT = plan.wallThicknessPt;
  function attach(kind: Opening['kind'], centre: P, dir: P, widthPt: number, reach: number, max: number) {
    const hits: Array<{ ri: number; wi: number; off: number; d: number }> = [];
    plan.rooms.forEach((room, ri) => {
      const poly = room.polygon;
      let best: { wi: number; off: number; d: number } | null = null;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        const L = dist(a, b); if (L < widthPt * 0.5) continue;
        const ux = (b.x - a.x) / L, uy = (b.y - a.y) / L;
        if (Math.abs(ux * dir.x + uy * dir.y) < 0.95) continue; // must run along the opening
        const t = (centre.x - a.x) * ux + (centre.y - a.y) * uy;
        if (t < -widthPt * 0.2 || t > L + widthPt * 0.2) continue;
        const d = Math.abs(-(centre.x - a.x) * uy + (centre.y - a.y) * ux);
        if (d > reach) continue;
        if (!best || d < best.d) best = { wi: i, off: Math.min(L - widthPt / 2, Math.max(widthPt / 2, t)), d };
      }
      if (best) hits.push({ ri, ...best });
    });
    return hits.sort((x, y) => x.d - y.d).slice(0, max);
  }
  plan.doors.forEach((d, k) => {
    // the same swing drawn twice is one door
    if (plan.doors.slice(0, k).some((o) => dist(o.hinge, d.hinge) < d.widthPt * 0.1 && dist(o.jamb, d.jamb) < d.widthPt * 0.1)) return;
    const L = dist(d.hinge, d.jamb) || 1;
    const dir = { x: (d.jamb.x - d.hinge.x) / L, y: (d.jamb.y - d.hinge.y) / L };
    const lt = dist(d.hinge, d.tip) || 1;
    const back = { x: -(d.tip.x - d.hinge.x) / lt, y: -(d.tip.y - d.hinge.y) / lt };
    const centre = { x: (d.hinge.x + d.jamb.x) / 2 + back.x * wallT / 2, y: (d.hinge.y + d.jamb.y) / 2 + back.y * wallT / 2 };
    const hits = attach('door', centre, dir, L, Math.max(wallT * 1.5, plan.walls.length ? wallT * 2.5 : 0), 2);
    const doorId = `door-${k + 1}`;
    const ev: Evidence = { id: `ev-${doorId}`, kind: 'pdf', label: `${label} p${page + 1}: door swing`, imageUrl, page, bbox: bboxN([d.hinge, d.jamb, d.tip], 0.004), note: `${(L * m).toFixed(2)} m wide on the drawing.`, createdAt: now };
    evidence.push(ev);
    const ms: Measurement = { id: `m-${doorId}`, label: 'Door width', valueM: r3(L * m), sourceKind: 'pdf-annotation', status: 'estimated', toleranceM: 0.03, evidenceIds: [ev.id] };
    measurements.push(ms);
    for (const h of hits) {
      const room = plan.rooms[h.ri];
      // the leaf swings into the room that holds the tip
      const inside = pointInRing(d.tip, room.polygon);
      const a = room.polygon[h.wi];
      const hingeAtStart = dist(a, d.hinge) < dist(a, d.jamb);
      const sp = spaces[h.ri];
      openings.push({
        id: `${doorId}~${sp.id}`, kind: 'door', spaceId: sp.id, wallIndex: h.wi, offsetM: r3(h.off * m), widthM: r3(L * m),
        heightM: 2.05, sillM: 0, swing: inside ? 'in' : 'none', hinge: hingeAtStart ? 'start' : 'end',
        sourceKind: 'pdf-annotation', status: 'estimated', measurementId: ms.id,
      });
      reports[h.ri].doors++;
    }
  });
  plan.windows.forEach((w, k) => {
    const L = dist(w.a, w.b) || 1;
    const dir = { x: (w.b.x - w.a.x) / L, y: (w.b.y - w.a.y) / L };
    const centre = { x: (w.a.x + w.b.x) / 2, y: (w.a.y + w.b.y) / 2 };
    const hits = attach('window', centre, dir, L, Math.max(w.depthPt, wallT) * 1.2 + wallT, 1);
    const winId = `win-${k + 1}`;
    const ev: Evidence = { id: `ev-${winId}`, kind: 'pdf', label: `${label} p${page + 1}: window`, imageUrl, page, bbox: bboxN([w.a, w.b], 0.005), note: `${(L * m).toFixed(2)} m wide on the drawing. Sill and height are typical values, not on the plan.`, createdAt: now };
    evidence.push(ev);
    const ms: Measurement = { id: `m-${winId}`, label: 'Window width', valueM: r3(L * m), sourceKind: 'pdf-annotation', status: 'estimated', toleranceM: 0.03, evidenceIds: [ev.id] };
    measurements.push(ms);
    for (const h of hits) {
      const sp = spaces[h.ri];
      openings.push({ id: `${winId}~${sp.id}`, kind: 'window', spaceId: sp.id, wallIndex: h.wi, offsetM: r3(h.off * m), widthM: r3(L * m), heightM: 1.3, sillM: 0.9, swing: 'none', hinge: 'start', sourceKind: 'pdf-annotation', status: 'estimated', measurementId: ms.id });
      reports[h.ri].windows++;
    }
  });

  const withArea = reports.filter((r) => r.errorPct != null);
  const model: SpaceModel = {
    id: `drawing-${now}`,
    name: label.replace(/\.(pdf|png|jpe?g)$/i, ''),
    version: 1, units: 'm', ceilingM: opts.ceilingM ?? 2.6,
    sourceLabel: `Drawing: ${label}, page ${page + 1}`,
    spaces, openings, furniture: [], measurements, evidence,
  };
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const doorsUnique = new Set(openings.filter((o) => o.kind === 'door').map((o) => o.id.split('~')[0])).size;
  return {
    model,
    report: {
      ...baseReport, ok: true, rooms: reports, doors: doorsUnique, windows: plan.windows.length,
      medianAreaErrorPct: median(withArea.map((r) => Math.abs(r.errorPct!))),
      verified: withArea.filter((r) => r.status === 'verified').length, withPrintedArea: withArea.length,
      ms: Math.round(plan.ms + (t1 - t0)),
    },
    plan,
  };
}

/** Builds a model from one page of an opened drawing. Needs the page's vector lines (PDF only). */
export function drawingToBuilding(doc: DrawingDoc, page: number, opts: BuildOptions = {}): { model: SpaceModel; report: BuildReport; plan: PlanGeometry | null } {
  const pp = doc.vectors?.[page];
  const pg = doc.pages[page];
  if (!pp) {
    const now = opts.now ?? Date.now();
    const reason = pg && pg.ptW == null
      ? 'This is a picture, not a vector PDF, so there are no wall lines to read.'
      : 'This page has no readable drawing lines.';
    return {
      model: emptyBuilt(doc.name, now), plan: null,
      report: { ok: false, reason, page, rooms: [], failed: [], doorSwings: 0, doors: 0, windows: 0, wallSource: 'none', scale: { source: 'none', mPerPt: null }, medianAreaErrorPct: null, verified: 0, withPrintedArea: 0, angleDeg: 0, ms: 0, warnings: [], wallsNorm: [] },
    };
  }
  return buildFromPaths(pp, doc.items, page, { name: doc.name, imageUrl: opts.imageUrl ?? pg?.dataUrl, ...opts });
}

/** Small curved symbols inside a room outline (sanitary fixtures), excluding door swings. */
function fixtureCount(pp: PagePaths, poly: P[], maxSizePt: number): number {
  let n = 0;
  for (const p of pp.paths) {
    if (p.curves < 2) continue;
    const pts = p.subs.flat();
    if (!pts.length) continue;
    const xs = pts.map((q) => q.x), ys = pts.map((q) => q.y);
    const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
    if (w > maxSizePt || h > maxSizePt) continue;
    if (pointInRing({ x: (Math.max(...xs) + Math.min(...xs)) / 2, y: (Math.max(...ys) + Math.min(...ys)) / 2 }, poly)) n++;
  }
  return n;
}

function emptyBuilt(name: string, now: number): SpaceModel {
  return { id: `drawing-${now}`, name, version: 1, units: 'm', ceilingM: 2.6, sourceLabel: `Drawing: ${name}`, spaces: [], openings: [], furniture: [], measurements: [], evidence: [] };
}

/** Rooms that are outdoors (balconies, terraces), by purpose. */
export const isOutdoor = (r: Pick<RoomReport, 'purpose'>) => !!r.purpose && OUTDOOR_PURPOSES.has(r.purpose);
