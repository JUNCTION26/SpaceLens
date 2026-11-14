import type { FurnitureItem, Opening, Requirements, Space, SpaceModel, ValidationResult } from '../../core/types';
import { distPointRect, distToBoundary, isSimplePolygon, overlapDepth, pointInPolygon, rectOutside, signedArea, type ORect, type P } from './geom';

const TOL = 0.01;
const cm = (m: number) => `${Math.round(m * 100)} cm`;
const r2 = (v: number) => Math.round(v * 1000) / 1000;
const sek = (v: number) => `${Math.round(v).toLocaleString('sv-SE')} SEK`;

function footprint(f: FurnitureItem): ORect { return { cx: f.x, cy: f.y, hw: f.w / 2, hd: f.d / 2, rot: f.rotation }; }
/** Rect in the item's local frame, given local bounds. */
function localRect(f: FurnitureItem, x0: number, x1: number, y0: number, y1: number): ORect {
  const c = Math.cos(f.rotation), s = Math.sin(f.rotation), lx = (x0 + x1) / 2, ly = (y0 + y1) / 2;
  return { cx: f.x + lx * c - ly * s, cy: f.y + lx * s + ly * c, hw: (x1 - x0) / 2, hd: (y1 - y0) / 2, rot: f.rotation };
}

interface WallFrame { a: P; t: P; n: P; length: number; rot: number }
function wallFrame(space: Space, i: number): WallFrame {
  const p = space.polygon, a = p[i], b = p[(i + 1) % p.length];
  const length = Math.hypot(b.x - a.x, b.y - a.y) || 1e-9;
  const t = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
  const sgn = signedArea(p) >= 0 ? 1 : -1;
  return { a, t, n: { x: -t.y * sgn, y: t.x * sgn }, length, rot: Math.atan2(t.y, t.x) };
}
/** Zone of the given depth on the inward side of an opening. */
function openingZone(space: Space, o: Opening, depth: number): ORect {
  const w = wallFrame(space, o.wallIndex);
  const c = { x: w.a.x + w.t.x * o.offsetM, y: w.a.y + w.t.y * o.offsetM };
  return { cx: c.x + (w.n.x * depth) / 2, cy: c.y + (w.n.y * depth) / 2, hw: o.widthM / 2, hd: depth / 2, rot: w.rot };
}
function openingPoint(space: Space, o: Opening, inward: number): P {
  const w = wallFrame(space, o.wallIndex);
  return { x: w.a.x + w.t.x * o.offsetM + w.n.x * inward, y: w.a.y + w.t.y * o.offsetM + w.n.y * inward };
}
function spaceFor(model: SpaceModel, p: P): Space | undefined {
  return model.spaces.find((s) => s.polygon.length >= 3 && pointInPolygon(p, s.polygon)) ?? model.spaces[0];
}
/** Seats may sit in the use zone of the desk or table they belong to. */
const SEATS = new Set(['chair', 'desk-chair', 'office-chair', 'stool', 'bench']);
export const isSeat = (f: FurnitureItem) => SEATS.has(f.category);
export const isSeatHost = (f: FurnitureItem) => /desk|table|counter/.test(f.category) && !/coffee|side/.test(f.category);
/** Each seat belongs to the nearest desk or table (centre to centre). Returns seat id -> host id. */
export function pairSeats(items: FurnitureItem[]): Map<string, string> {
  const hosts = items.filter(isSeatHost), out = new Map<string, string>();
  if (!hosts.length) return out;
  for (const f of items) {
    if (!isSeat(f)) continue;
    let best = hosts[0], bd = Infinity;
    for (const h of hosts) { const d = Math.hypot(h.x - f.x, h.y - f.y); if (d < bd) { bd = d; best = h; } }
    out.set(f.id, best.id);
  }
  return out;
}

const names = (fs: FurnitureItem[]) => fs.map((f) => f.name).join(', ');

/** Independent checker. Reads only the model and the furniture; never trusts a generator's claims. */
export function validateLayout(model: SpaceModel, furniture: FurnitureItem[], req?: Requirements | null): ValidationResult[] {
  const out: ValidationResult[] = [];
  const add = (r: ValidationResult) => { out.push(r); };
  const solid = furniture.filter((f) => f.category !== 'rug');

  // Room polygons
  const validSpaces = new Set<string>();
  for (const s of model.spaces) {
    const area = Math.abs(signedArea(s.polygon));
    const simple = isSimplePolygon(s.polygon);
    const ok = simple && area > 1e-6;
    if (ok) validSpaces.add(s.id);
    add({
      id: `room:${s.id}`, rule: 'Room shape', result: ok ? 'pass' : 'fail', measured: r2(area), threshold: 0, subjectIds: [s.id],
      details: ok ? `${s.name}: simple outline, area ${area.toFixed(2)} m².` : `${s.name}: ${simple ? 'area is zero' : 'outline crosses itself or has fewer than 3 corners'} (area ${area.toFixed(2)} m²).`,
    });
  }
  if (!model.spaces.length) add({ id: 'room:none', rule: 'Room shape', result: 'unknown', subjectIds: [], details: 'No room outline yet.' });

  // Openings on their walls
  const goodOpenings: Array<{ o: Opening; s: Space }> = [];
  for (const o of model.openings) {
    const s = model.spaces.find((x) => x.id === o.spaceId);
    if (!s || o.wallIndex < 0 || o.wallIndex >= s.polygon.length) {
      add({ id: `opening:${o.id}`, rule: 'Opening on wall', result: 'fail', subjectIds: [o.id], details: `${o.kind} ${o.id} refers to a wall that does not exist.` });
      continue;
    }
    const L = wallFrame(s, o.wallIndex).length, lo = o.offsetM - o.widthM / 2, hi = o.offsetM + o.widthM / 2;
    const over = Math.max(-lo, hi - L, 0);
    const ok = over <= TOL;
    if (ok && validSpaces.has(s.id)) goodOpenings.push({ o, s });
    add({
      id: `opening:${o.id}`, rule: 'Opening on wall', result: ok ? 'pass' : 'fail', measured: r2(over), threshold: TOL, subjectIds: [o.id],
      details: ok ? `${o.kind} spans ${lo.toFixed(2)}–${hi.toFixed(2)} m of a ${L.toFixed(2)} m wall.` : `${o.kind} runs ${cm(over)} past the end of its ${L.toFixed(2)} m wall (spans ${lo.toFixed(2)}–${hi.toFixed(2)} m).`,
    });
  }

  // Inside room, ceiling
  const ceilFails: FurnitureItem[] = [];
  for (const f of furniture) {
    if (f.h > model.ceilingM + 1e-9) ceilFails.push(f);
    const s = spaceFor(model, f);
    if (!s || s.polygon.length < 3) { add({ id: `inside:${f.id}`, rule: 'Inside room', result: 'unknown', subjectIds: [f.id], details: `No room outline to test ${f.name} against.` }); continue; }
    const outBy = rectOutside(footprint(f), s.polygon);
    const ok = outBy <= TOL;
    add({
      id: `inside:${f.id}`, rule: 'Inside room', result: ok ? 'pass' : 'fail', measured: r2(outBy), threshold: TOL, subjectIds: [f.id],
      details: ok ? `${f.name} fits inside ${s.name}.` : `${f.name} sticks ${cm(outBy)} outside the room.`,
    });
  }
  for (const f of ceilFails) add({ id: `ceiling:${f.id}`, rule: 'Ceiling height', result: 'fail', measured: f.h, threshold: model.ceilingM, subjectIds: [f.id], details: `${f.name} is ${cm(f.h)} tall; the ceiling is ${cm(model.ceilingM)}.` });
  if (furniture.length && !ceilFails.length) add({ id: 'ceiling:all', rule: 'Ceiling height', result: 'pass', threshold: model.ceilingM, subjectIds: [], details: `All items are under the ${cm(model.ceilingM)} ceiling.` });

  // Pairwise overlap
  let overlaps = 0;
  for (let i = 0; i < solid.length; i++) for (let j = i + 1; j < solid.length; j++) {
    const a = solid[i], b = solid[j], d = overlapDepth(footprint(a), footprint(b));
    if (d > TOL) {
      overlaps++;
      add({ id: `overlap:${a.id}:${b.id}`, rule: 'No overlap', result: 'fail', measured: r2(d), threshold: TOL, subjectIds: [a.id, b.id], details: `${a.name} and ${b.name} overlap by ${cm(d)}.` });
    }
  }
  if (solid.length > 1 && !overlaps) add({ id: 'overlap:all', rule: 'No overlap', result: 'pass', subjectIds: [], details: `${solid.length} footprints, none overlapping.` });

  // Clearance envelopes
  let clrFails = 0;
  const pairs = pairSeats(solid);
  const paired = (a: FurnitureItem, b: FurnitureItem) => pairs.get(a.id) === b.id || pairs.get(b.id) === a.id;
  for (const f of solid) {
    const host = pairs.has(f.id) ? solid.find((g) => g.id === pairs.get(f.id)) : undefined;
    const s = spaceFor(model, f), c = f.clearance, hw = f.w / 2, hd = f.d / 2;
    const sides: Array<[string, number, ORect]> = [
      ['front', c.front, localRect(f, -hw, hw, hd, hd + c.front)],
      ['back', c.back, localRect(f, -hw, hw, -hd - c.back, -hd)],
      ['left', c.left, localRect(f, -hw - c.left, -hw, -hd, hd)],
      ['right', c.right, localRect(f, hw, hw + c.right, -hd, hd)],
    ];
    for (const [side, need, rect] of sides) {
      if (need <= TOL) continue;
      let worst = 0;
      const hit: FurnitureItem[] = [];
      for (const g of solid) {
        if (g.id === f.id || paired(f, g)) continue;
        const d = overlapDepth(rect, footprint(g));
        if (d > TOL) { worst = Math.max(worst, Math.min(d, need)); hit.push(g); }
      }
      // A seat's use zone facing its desk is the knee space under the desk, not floor in front of a wall.
      const facesHost = !!host && overlapDepth(rect, footprint(host)) > TOL;
      const wallPen = !facesHost && s && s.polygon.length >= 3 ? Math.min(rectOutside(rect, s.polygon), need) : 0;
      if (wallPen > TOL) worst = Math.max(worst, wallPen);
      if (worst > 0) {
        clrFails++;
        const free = Math.max(0, need - worst);
        const by = [...hit.map((g) => g.name), ...(wallPen > TOL ? ['a wall'] : [])].join(', ');
        add({
          id: `clearance:${f.id}:${side}`, rule: 'Clearance', result: 'fail', measured: r2(free), threshold: need, subjectIds: [f.id, ...hit.map((g) => g.id)],
          details: `${f.name} ${side}: about ${cm(free)} free, needs ${cm(need)} (blocked by ${by}).`,
        });
      }
    }
  }
  if (solid.length && !clrFails) add({ id: 'clearance:all', rule: 'Clearance', result: 'pass', subjectIds: [], details: 'Every use zone is free of furniture and walls.' });

  // Doors (swing + approach) and windows
  for (const { o, s } of goodOpenings) {
    if (o.kind === 'door') {
      if (o.swing === 'in') {
        const zone = openingZone(s, o, o.widthM);
        const hits = solid.filter((f) => overlapDepth(zone, footprint(f)) > TOL);
        add({
          id: `swing:${o.id}`, rule: 'Door swing', result: hits.length ? 'fail' : 'pass', threshold: o.widthM, subjectIds: [...hits.map((f) => f.id), o.id],
          details: hits.length ? `Door swing (${cm(o.widthM)}) is blocked by ${names(hits)}.` : `Door swing (${cm(o.widthM)}) is clear.`,
        });
      }
      const zone = openingZone(s, o, 0.8);
      const hits = solid.filter((f) => overlapDepth(zone, footprint(f)) > TOL);
      add({
        id: `approach:${o.id}`, rule: 'Door approach', result: hits.length ? 'fail' : 'pass', threshold: 0.8, subjectIds: [...hits.map((f) => f.id), o.id],
        details: hits.length ? `The 80 cm zone inside the door is blocked by ${names(hits)}.` : 'The 80 cm zone inside the door is clear.',
      });
    } else if (o.kind === 'window') {
      const zone = openingZone(s, o, 0.4);
      const hits = solid.filter((f) => f.h > 1.0 && overlapDepth(zone, footprint(f)) > TOL);
      add({
        id: `window:${o.id}`, rule: 'Window access', result: hits.length ? 'fail' : 'pass', threshold: 0.4, subjectIds: [...hits.map((f) => f.id), o.id],
        details: hits.length ? `Tall items within 40 cm of the window: ${hits.map((f) => `${f.name} (${cm(f.h)})`).join(', ')}.` : 'No tall items within 40 cm of the window.',
      });
    }
  }

  // Unfolded sofa beds / extendable tables
  for (const f of solid) {
    if (!f.unfoldedD || f.unfoldedD <= f.d) continue;
    const r = localRect(f, -f.w / 2, f.w / 2, -f.d / 2, f.d / 2 + (f.unfoldedD - f.d));
    const s = spaceFor(model, f);
    const outBy = s && s.polygon.length >= 3 ? rectOutside(r, s.polygon) : 0;
    const hits = solid.filter((g) => g.id !== f.id && overlapDepth(r, footprint(g)) > TOL);
    const ok = outBy <= TOL && !hits.length;
    const why = [outBy > TOL ? `goes ${cm(outBy)} into a wall` : '', hits.length ? `hits ${names(hits)}` : ''].filter(Boolean).join(' and ');
    add({
      id: `unfold:${f.id}`, rule: 'Unfolded fits', result: ok ? 'pass' : 'fail', measured: f.unfoldedD, subjectIds: [f.id, ...hits.map((g) => g.id)],
      details: ok ? `${f.name} unfolds to ${cm(f.unfoldedD)} without hitting anything.` : `${f.name} unfolded (${cm(f.unfoldedD)}) ${why}.`,
    });
  }

  // Routes
  if (req && req.routeTargets.length) {
    const doors = goodOpenings.filter((x) => x.o.kind === 'door');
    if (!doors.length) add({ id: 'route:nodoor', rule: 'Clear route', result: 'unknown', subjectIds: [], details: 'No door to start a route from.' });
    for (const d of doors) {
      for (const tgt of req.routeTargets) {
        const targets = goodOpenings.filter((x) => x.o.kind === tgt.kind && (!tgt.id || x.o.id === tgt.id) && x.o.id !== d.o.id && x.s.id === d.s.id);
        if (!targets.length) {
          add({ id: `route:${d.o.id}:${tgt.kind}:${tgt.id ?? 'any'}`, rule: 'Clear route', result: 'unknown', subjectIds: [d.o.id], details: `No ${tgt.kind} in this room to route to.` });
          continue;
        }
        for (const t of targets) add(routeCheck(d.s, d.o, t.o, openingPoint(d.s, d.o, 0.4), openingPoint(t.s, t.o, 0.5), solid, req.minRouteWidthM));
      }
    }
  }

  // Budget
  const cost = furniture.filter((f) => !f.owned).reduce((a, f) => a + (f.priceSek || 0), 0);
  if (!req || req.budgetSek == null) {
    add({ id: 'budget', rule: 'Budget', result: 'unknown', measured: cost, subjectIds: [], details: `New items cost ${sek(cost)}; no budget set.` });
  } else {
    const over = cost > req.budgetSek;
    add({
      id: 'budget', rule: 'Budget', result: over ? 'fail' : 'pass', measured: cost, threshold: req.budgetSek,
      subjectIds: over ? furniture.filter((f) => !f.owned && f.priceSek > 0).sort((a, b) => b.priceSek - a.priceSek).map((f) => f.id) : [],
      details: `New items cost ${sek(cost)} of a ${sek(req.budgetSek)} budget${over ? ` (${sek(cost - req.budgetSek)} over)` : ''}.`,
    });
  }
  return out;
}

const CELL = 0.05;
const NB = [[1, 0], [-1, 0], [0, 1], [0, -1]];
function routeCheck(space: Space, door: Opening, target: Opening, start: P, goal: P, items: FurnitureItem[], minW: number): ValidationResult {
  const id = `route:${door.id}:${target.id}`, rule = 'Clear route', subj = [door.id, target.id];
  const poly = space.polygon, xs = poly.map((p) => p.x), ys = poly.map((p) => p.y);
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  const cols = Math.max(1, Math.ceil((Math.max(...xs) - x0) / CELL)), rows = Math.max(1, Math.ceil((Math.max(...ys) - y0) / CELL));
  const rects = items.map(footprint);
  // Clearance per cell: distance to nearest wall or footprint (-1 outside the room).
  const clr = new Float64Array(cols * rows).fill(-1);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const p = { x: x0 + (c + 0.5) * CELL, y: y0 + (r + 0.5) * CELL };
    if (!pointInPolygon(p, poly)) continue;
    // Near the endpoints the wall itself is the destination, so only furniture narrows the way.
    const nearEnd = Math.hypot(p.x - start.x, p.y - start.y) < 0.5 || Math.hypot(p.x - goal.x, p.y - goal.y) < 0.5;
    let m = nearEnd ? Infinity : distToBoundary(p, poly);
    for (const rc of rects) m = Math.min(m, distPointRect(p, rc));
    clr[r * cols + c] = m;
  }
  const cellOf = (p: P) => {
    const c = Math.min(cols - 1, Math.max(0, Math.floor((p.x - x0) / CELL))), r = Math.min(rows - 1, Math.max(0, Math.floor((p.y - y0) / CELL)));
    return r * cols + c;
  };
  const sI = cellOf(start), gI = cellOf(goal);
  if (clr[sI] < 0 || clr[gI] < 0) return { id, rule, result: 'unknown', subjectIds: subj, details: 'A route endpoint falls outside the room.' };

  // Widest-path bottleneck: add cells by descending clearance until start and goal join.
  const order = Array.from({ length: cols * rows }, (_, i) => i).filter((i) => clr[i] >= 0).sort((a, b) => clr[b] - clr[a]);
  const parent = new Int32Array(cols * rows).fill(-1);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  let neck = -1;
  for (const i of order) {
    parent[i] = i;
    const r = Math.floor(i / cols), c = i % cols;
    for (const [dr, dc] of NB) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
      const j = rr * cols + cc;
      if (parent[j] >= 0) parent[find(j)] = find(i);
    }
    if (parent[sI] >= 0 && parent[gI] >= 0 && find(sI) === find(gI)) { neck = i; break; }
  }
  const width = neck >= 0 ? 2 * clr[neck] : 0;
  const at = neck >= 0 ? { x: x0 + ((neck % cols) + 0.5) * CELL, y: y0 + (Math.floor(neck / cols) + 0.5) * CELL } : start;
  if (width + 1e-9 < minW) {
    const blockers = items.filter((f) => distPointRect(at, footprint(f)) <= width / 2 + CELL * 1.5).map((f) => f.id);
    return {
      id, rule, result: 'fail', measured: r2(width), threshold: minW, subjectIds: [...blockers, ...subj],
      details: `No ${cm(minW)} route from door to ${target.kind}: narrowest spot is ${cm(width)} at (${at.x.toFixed(2)}, ${at.y.toFixed(2)}) m.`,
    };
  }
  // BFS over cells wide enough for the route, for the path length.
  const rad = minW / 2 - 1e-9, steps = new Int32Array(cols * rows).fill(-1), q = [sI];
  steps[sI] = 0;
  for (let h = 0; h < q.length && steps[gI] < 0; h++) {
    const i = q[h], rr = Math.floor(i / cols), cc = i % cols;
    for (const [dr, dc] of NB) {
      const a = rr + dr, b = cc + dc;
      if (a < 0 || b < 0 || a >= rows || b >= cols) continue;
      const j = a * cols + b;
      if (steps[j] < 0 && clr[j] >= rad) { steps[j] = steps[i] + 1; q.push(j); }
    }
  }
  const L = steps[gI] >= 0 ? steps[gI] * CELL : null;
  return {
    id, rule, result: 'pass', measured: L == null ? undefined : r2(L), threshold: minW, subjectIds: subj,
    details: `Route door → ${target.kind}: ${L == null ? '?' : L.toFixed(2)} m long, narrowest ${cm(width)} (needs ${cm(minW)}).`,
  };
}

export function firstFailure(results: ValidationResult[]): ValidationResult | undefined {
  return results.find((r) => r.result === 'fail');
}

export function summarize(results: ValidationResult[]): { pass: number; fail: number; unknown: number } {
  const s = { pass: 0, fail: 0, unknown: 0 };
  for (const r of results) s[r.result]++;
  return s;
}
