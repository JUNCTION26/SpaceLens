import type { Vec2 } from '../../core/types';

/** Frame-rate independent ease of `v` toward `target`; `rate` is roughly 1 / time constant in seconds. */
export function approach(v: number, target: number, rate: number, dt: number): number {
  return v + (target - v) * (1 - Math.exp(-rate * dt));
}

const ANGLES = [0.35, -0.35, 0.8, -0.8, 1.2, -1.2];

/**
 * Move by `d` unless that ends inside something; then slide: try the same step turned a little
 * either way (shortened by the cosine, so pushing straight into a wall barely moves you), then
 * each axis alone. Returns the new position, or the old one when every option is blocked.
 */
export function slideMove(pos: Vec2, d: Vec2, blocked: (p: Vec2) => boolean): Vec2 {
  const len = Math.hypot(d.x, d.y);
  if (len < 1e-9) return pos;
  const full = { x: pos.x + d.x, y: pos.y + d.y };
  if (!blocked(full)) return full;
  for (const a of ANGLES) {
    const c = Math.cos(a), s = Math.sin(a);
    const k = c; // shorter the further we turn away from the wish
    const p = { x: pos.x + (d.x * c - d.y * s) * k, y: pos.y + (d.x * s + d.y * c) * k };
    if (!blocked(p)) return p;
  }
  const px = { x: pos.x + d.x, y: pos.y };
  if (Math.abs(d.x) > 1e-9 && !blocked(px)) return px;
  const py = { x: pos.x, y: pos.y + d.y };
  if (Math.abs(d.y) > 1e-9 && !blocked(py)) return py;
  return pos;
}

/** Plan direction the walker faces for a camera yaw (three.js: yaw 0 looks toward -z, which is plan -y). */
export const facing = (yaw: number): Vec2 => ({ x: -Math.sin(yaw), y: -Math.cos(yaw) });

/** Plan velocity wanted from forward/strafe input in [-1, 1], normalised so diagonals are not faster. */
export function wishVelocity(forward: number, strafe: number, yaw: number, speed: number): Vec2 {
  const l = Math.hypot(forward, strafe);
  if (l < 1e-6) return { x: 0, y: 0 };
  const k = Math.min(1, l) / l;
  const f = facing(yaw);
  return { x: (f.x * forward - f.y * strafe) * k * speed, y: (f.y * forward + f.x * strafe) * k * speed };
}

/** Where the centre of the view meets the floor, or null when looking level or up, or too far away. */
export function floorUnderReticle(pos: Vec2, eye: number, yaw: number, pitch: number, maxDist = 12): Vec2 | null {
  if (pitch > -0.03) return null;
  const run = eye / Math.tan(-pitch);
  if (run > maxDist) return null;
  const f = facing(yaw);
  return { x: pos.x + f.x * run, y: pos.y + f.y * run };
}

/** Keep the orbit target over the building and between floor and ceiling. */
export function clampTarget(t: { x: number; y: number; z: number }, box: { minX: number; minY: number; maxX: number; maxY: number }, ceil: number, margin = 1) {
  return {
    x: Math.min(box.maxX + margin, Math.max(box.minX - margin, t.x)),
    y: Math.min(ceil, Math.max(0, t.y)),
    z: Math.min(box.maxY + margin, Math.max(box.minY - margin, t.z)),
  };
}

/** Phone orientation to look angles: turning the phone turns the view; tilting it up looks up. */
export function orientationLook(alpha: number, beta: number, alpha0: number, yaw0: number): { yaw: number; pitch: number } {
  const rad = Math.PI / 180;
  return { yaw: yaw0 + (alpha - alpha0) * rad, pitch: Math.max(-1.2, Math.min(1.2, (beta - 90) * rad)) };
}
