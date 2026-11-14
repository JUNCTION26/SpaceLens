// Evacuation estimate: each person walks the shortest safe route to the nearest exit and queues at
// doors that let a limited number of people through per second (flow per metre of clear width).
import type { HeatGrid, Vec2 } from '../../core/types';
import { centre, type DoorInfo, type Field, type SafetyGrid } from './field';

export interface DoorFlow { doorId: string; label: string; people: number; clearWidthM: number; capacityPerS: number; maxWaitS: number; lastOutS: number }

export interface EvacAgent {
  /** Walked polyline from the start to the exit. */
  pts: Vec2[];
  /** Cumulative distance along `pts`. */
  cum: number[];
  /** Time/distance keyframes: walking segments and waiting at doors. */
  keys: Array<[number, number]>;
  clearS: number;
}

export interface EvacResult {
  occupants: number;
  unreachable: number;
  speedMS: number;
  timeToClearS: number;
  /** Time for the slowest walker if nobody had to queue. */
  walkOnlyS: number;
  bottleneck: DoorFlow | null;
  doors: DoorFlow[];
  agents: EvacAgent[];
  bounds: { x: number; y: number; w: number; h: number };
}

export function clearWidth(d: DoorInfo, leafM: number): number {
  return Math.max(0.3, d.widthM - (d.opening.kind === 'door' && d.opening.swing !== 'none' ? leafM : 0));
}

class Q {
  a: Array<[number, number, number]> = [];
  push(x: [number, number, number]) { this.a.push(x); let i = this.a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (this.a[p][0] <= x[0]) break; this.a[i] = this.a[p]; i = p; } this.a[i] = x; }
  pop() { const top = this.a[0], last = this.a.pop()!; if (this.a.length) { let i = 0; const n = this.a.length; for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && this.a[c + 1][0] < this.a[c][0]) c++; if (this.a[c][0] >= last[0]) break; this.a[i] = this.a[c]; i = c; } this.a[i] = last; } return top; }
  get size() { return this.a.length; }
}

/** Nearest cell to p that has a route out, within ~1.2 m. */
export function snapReachable(g: SafetyGrid, f: Field, p: Vec2, ok: (i: number) => boolean): number {
  const c0 = Math.floor((p.x - g.ox) / g.cell), r0 = Math.floor((p.y - g.oy) / g.cell), R = Math.ceil(1.2 / g.cell);
  let best = -1, bd = Infinity;
  for (let dr = -R; dr <= R; dr++) for (let dc = -R; dc <= R; dc++) {
    const r = r0 + dr, c = c0 + dc; if (r < 0 || c < 0 || r >= g.rows || c >= g.cols) continue;
    const i = r * g.cols + c; if (!ok(i) || !Number.isFinite(f.len[i])) continue;
    const d = dr * dr + dc * dc; if (d < bd) { bd = d; best = i; }
  }
  return best;
}

export function simulateEvacuation(g: SafetyGrid, f: Field, starts: Vec2[], ok: (i: number) => boolean, opts: { speedMS: number; flowPerMS: number; leafM: number }): EvacResult {
  const v = Math.max(0.1, opts.speedMS);
  const cap = g.doors.map((d) => opts.flowPerMS * clearWidth(d, opts.leafM));
  const nextFree = g.doors.map(() => 0);
  const flows: DoorFlow[] = g.doors.map((d, k) => ({ doorId: d.id, label: d.label, people: 0, clearWidthM: clearWidth(d, opts.leafM), capacityPerS: cap[k], maxWaitS: 0, lastOutS: 0 }));
  const agents: EvacAgent[] = [];
  const crossings: Array<Array<{ door: number; d: number }>> = [];
  let unreachable = 0;
  for (const p of starts) {
    const s = snapReachable(g, f, p, ok);
    if (s < 0) { unreachable++; continue; }
    const cells: number[] = [];
    for (let k = s, guard = 0; k >= 0 && guard < 1e6; k = f.parent[k], guard++) cells.push(k);
    const total = f.len[s];
    const cr: Array<{ door: number; d: number }> = [];
    let last = -1;
    for (const c of cells) {
      const k = g.door[c];
      if (k >= 0 && k !== last) cr.push({ door: k, d: total - f.len[c] });
      last = k;
    }
    const exitDoor = g.door[cells[cells.length - 1]];
    if (exitDoor >= 0 && (!cr.length || cr[cr.length - 1].door !== exitDoor)) cr.push({ door: exitDoor, d: total });
    // keep a light polyline: every 4th cell plus the end
    const pts: Vec2[] = [], cum: number[] = [];
    cells.forEach((c, i) => { if (i % 4 === 0 || i === cells.length - 1) { pts.push(centre(g, c)); cum.push(total - f.len[c]); } });
    agents.push({ pts, cum, keys: [[0, 0]], clearS: total / v });
    crossings.push(cr);
  }
  const q = new Q();
  agents.forEach((a, i) => { const cr = crossings[i]; if (cr.length) q.push([cr[0].d / v, i, 0]); });
  while (q.size) {
    const [t, ai, ci] = q.pop();
    const a = agents[ai], cr = crossings[ai], c = cr[ci];
    const depart = Math.max(t, nextFree[c.door]);
    nextFree[c.door] = depart + 1 / Math.max(0.05, cap[c.door]);
    const fl = flows[c.door];
    fl.people++; fl.maxWaitS = Math.max(fl.maxWaitS, depart - t); fl.lastOutS = Math.max(fl.lastOutS, depart);
    a.keys.push([t, c.d], [depart, c.d]);
    if (ci + 1 < cr.length) q.push([depart + (cr[ci + 1].d - c.d) / v, ai, ci + 1]);
    else a.clearS = depart;
  }
  let walkOnly = 0, clear = 0;
  agents.forEach((a, i) => { walkOnly = Math.max(walkOnly, (a.cum[a.cum.length - 1] ?? 0) / v); clear = Math.max(clear, a.clearS); if (!crossings[i].length) a.keys.push([a.clearS, a.cum[a.cum.length - 1] ?? 0]); });
  const used = flows.filter((x) => x.people > 0);
  const bottleneck = used.length ? used.reduce((m, x) => (x.maxWaitS > m.maxWaitS ? x : m), used[0]) : null;
  return {
    occupants: starts.length, unreachable, speedMS: v, timeToClearS: clear, walkOnlyS: walkOnly,
    bottleneck: bottleneck && bottleneck.maxWaitS > 0.5 ? bottleneck : (used.sort((p, r) => r.lastOutS - p.lastOutS)[0] ?? null),
    doors: flows.filter((x) => x.people > 0), agents,
    bounds: { x: g.ox, y: g.oy, w: g.cols * g.cell, h: g.rows * g.cell },
  };
}

/** Where everyone is `t` seconds after the alarm. People already out are left off. */
export function positionsAt(ev: EvacResult, t: number): Vec2[] {
  const out: Vec2[] = [];
  for (const a of ev.agents) {
    if (t >= a.clearS) continue;
    let d = 0;
    const k = a.keys;
    let j = 0; while (j + 1 < k.length && k[j + 1][0] <= t) j++;
    if (j + 1 < k.length) { const [t1, d1] = k[j], [t2, d2] = k[j + 1]; d = t2 > t1 ? d1 + ((d2 - d1) * (t - t1)) / (t2 - t1) : d2; }
    else d = Math.min(a.cum[a.cum.length - 1] ?? 0, k[j][1] + (t - k[j][0]) * ev.speedMS);
    let i = 0; while (i + 1 < a.cum.length && a.cum[i + 1] < d) i++;
    const p = a.pts[i], q = a.pts[Math.min(i + 1, a.pts.length - 1)];
    const span = (a.cum[i + 1] ?? a.cum[i]) - a.cum[i];
    const u = span > 1e-9 ? Math.min(1, Math.max(0, (d - a.cum[i]) / span)) : 0;
    out.push({ x: p.x + (q.x - p.x) * u, y: p.y + (q.y - p.y) * u });
  }
  return out;
}

/** Crowd density at time t as a heat grid the plan view can draw. */
export function evacHeat(ev: EvacResult, t: number, cellM = 0.4): HeatGrid {
  const { x, y, w, h } = ev.bounds;
  const cols = Math.max(1, Math.ceil(w / cellM)), rows = Math.max(1, Math.ceil(h / cellM));
  const values = new Array<number>(cols * rows).fill(0);
  for (const p of positionsAt(ev, t)) {
    const c = Math.floor((p.x - x) / cellM), r = Math.floor((p.y - y) / cellM);
    if (c >= 0 && r >= 0 && c < cols && r < rows) values[r * cols + c] += 1;
  }
  return { origin: { x, y }, cellM, cols, rows, values };
}
