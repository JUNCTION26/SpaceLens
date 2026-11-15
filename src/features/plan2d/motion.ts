/** Pure helpers for the plan's touch, motion and snapping behaviour. */

export type Box = { x: number; y: number; w: number; h: number };
export type Pt = { x: number; y: number };
export type Pose = { x: number; y: number; rotation: number };

const TAU = Math.PI * 2;

/** Signed shortest turn from one angle to another, in (-PI, PI]. */
export function shortestAngle(from: number, to: number): number {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d <= -Math.PI) d += TAU;
  return d;
}

/**
 * One step of a critically damped spring toward `target`. Returns the new value and velocity.
 * `halfLifeMs` is roughly how long the gap takes to halve; about 45 ms settles in ~180 ms.
 */
export function damp(value: number, velocity: number, target: number, dtMs: number, settleMs = 180): { value: number; velocity: number } {
  const omega = 6.5 / Math.max(settleMs, 1) * 1000 / 1; // rad/s: ~99% settled after settleMs
  const dt = Math.min(dtMs, 64) / 1000;
  const x = value - target;
  const e = Math.exp(-omega * dt);
  const t = (velocity + omega * x) * dt;
  return { value: target + (x + t) * e, velocity: (velocity - omega * t) * e };
}

/** Damp every field of a view box together. */
export function dampBox(box: Box, vel: Box, target: Box, dtMs: number, settleMs = 180): { box: Box; vel: Box; done: boolean } {
  const keys: (keyof Box)[] = ['x', 'y', 'w', 'h'];
  const out = { ...box }, v = { ...vel };
  let done = true;
  for (const k of keys) {
    const r = damp(box[k], vel[k], target[k], dtMs, settleMs);
    out[k] = r.value; v[k] = r.velocity;
    const eps = Math.max(target.w, 1e-6) * 0.0005;
    if (Math.abs(r.value - target[k]) > eps || Math.abs(r.velocity) > eps * 4) done = false;
  }
  return done ? { box: { ...target }, vel: { x: 0, y: 0, w: 0, h: 0 }, done: true } : { box: out, vel: v, done: false };
}

/** Pinch: scale the starting view by the finger-distance ratio, keeping the plan point under the start centre under the current centre. */
export function pinchView(start: Box, startDist: number, startCentre: Pt, dist: number, centre: Pt, rect: { left: number; top: number }, pxW: number, minW = 0.4, maxW = 400): Box {
  const mpp0 = start.w / pxW;
  let k = startDist / Math.max(dist, 1);
  k = Math.min(maxW / start.w, Math.max(minW / start.w, k));
  const mpp = mpp0 * k;
  const ax = start.x + (startCentre.x - rect.left) * mpp0, ay = start.y + (startCentre.y - rect.top) * mpp0;
  return { x: ax - (centre.x - rect.left) * mpp, y: ay - (centre.y - rect.top) * mpp, w: start.w * k, h: start.h * k };
}

/** Zoom by factor k (>1 zooms out) keeping the plan point under (fx, fy) (fractions 0..1 of the view) fixed. */
export function zoomAround(box: Box, fx: number, fy: number, k: number, minW = 0.4, maxW = 400): Box {
  const kk = Math.min(maxW / box.w, Math.max(minW / box.w, k));
  const w = box.w * kk, h = box.h * kk;
  return { x: box.x + (box.w - w) * fx, y: box.y + (box.h - h) * fy, w, h };
}

const easeOutCubic = (k: number) => 1 - Math.pow(1 - k, 3);

/** Pose between two poses at progress k (0..1) after an optional per-item delay; rotation takes the short way round. */
export function lerpPose(a: Pose, b: Pose, elapsedMs: number, durMs = 350, delayMs = 0): Pose {
  const k = Math.min(1, Math.max(0, (elapsedMs - delayMs) / durMs));
  const e = easeOutCubic(k);
  return { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e, rotation: a.rotation + shortestAngle(a.rotation, b.rotation) * e };
}

/** Small delay per item so a layout settles in a ripple, capped so the whole thing stays brisk. */
export function staggerDelay(index: number, count: number, stepMs = 18, capMs = 140): number {
  return count <= 1 ? 0 : Math.min(capMs, index * stepMs);
}

/** Scale for an item that has just appeared (0.85 to 1) or is leaving (1 to 0.85). */
export function appearScale(elapsedMs: number, durMs = 220): number {
  return 0.85 + 0.15 * easeOutCubic(Math.min(1, Math.max(0, elapsedMs / durMs)));
}

export type SnapLine = { axis: 'x' | 'y'; value: number; kind: 'wall' | 'centre' | 'edge' };

/** Best candidate within tolerance for a set of moving values (edges/centre) against target lines. Returns the shift to apply and the line hit. */
export function snapAxis(moving: number[], targets: { value: number; kind: SnapLine['kind'] }[], tol: number): { shift: number; target: { value: number; kind: SnapLine['kind'] } } | null {
  let best: { shift: number; target: { value: number; kind: SnapLine['kind'] } } | null = null;
  for (const m of moving) for (const t of targets) {
    const d = t.value - m;
    if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.shift))) best = { shift: d, target: t };
  }
  return best;
}

/** Magnet feel: pull strongly inside the inner zone, release smoothly towards the tolerance edge. */
export function magnet(shift: number, tol: number): number {
  const a = Math.abs(shift);
  if (a >= tol) return 0;
  const inner = tol * 0.5;
  if (a <= inner) return shift;
  return shift * (1 - (a - inner) / (tol - inner));
}

/** Scale-bar length (metres) and label that fit near `targetM` of view width: 1, 2 or 5 times a power of ten. */
export function niceScale(targetM: number): { m: number; label: string } {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(targetM, 1e-6))));
  const f = targetM / p;
  const m = (f >= 5 ? 5 : f >= 2 ? 2 : 1) * p;
  return { m, label: m >= 1 ? `${+m.toFixed(2)} m` : `${Math.round(m * 100)} cm` };
}
