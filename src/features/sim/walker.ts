// Walk feel as pure functions: eye height, smooth acceleration, fixed-rate sub-stepping, head bob.
import type { Vec2 } from '../../core/types';
import { approach, wishVelocity } from '../scene3d/walkMath';
import { BODY, moveSliding, type Obstacle } from './collide';

export const EYE = { stand: 1.6, seated: 1.2 } as const;

export interface WalkerOpts { seated: boolean; bob: boolean; speed?: number }
export interface Walker { pos: Vec2; vel: Vec2; yaw: number; pitch: number; phase: number; blockedAt: Vec2 | null }
export interface WalkInput { forward: number; strafe: number; sprint?: boolean }
export interface World { obstacles: Obstacle[]; canStand?: (p: Vec2) => boolean }

export const radiusFor = (o: Pick<WalkerOpts, 'seated'>) => (o.seated ? BODY.wheelchair : BODY.stand);
export const newWalker = (pos: Vec2, yaw = 0): Walker => ({ pos, vel: { x: 0, y: 0 }, yaw, pitch: 0, phase: 0, blockedAt: null });

const ACCEL = 9;   // 1 / s while input is held
const BRAKE = 12;  // 1 / s when released
const MAX_DT = 0.05;
const FIXED = 1 / 120;

/** Advance by dt seconds in fixed sub-steps, so the path does not depend on the frame rate. */
export function stepWalker(w: Walker, input: WalkInput, dtIn: number, o: WalkerOpts, world: World): Walker {
  let dt = Math.min(Math.max(dtIn, 0), MAX_DT);
  const r = radiusFor(o);
  const top = (o.speed ?? 1.4) * (input.sprint ? 1.6 : 1) * (o.seated ? 0.85 : 1);
  let s: Walker = { ...w, blockedAt: null };
  while (dt > 1e-9) {
    const h = Math.min(dt, FIXED);
    dt -= h;
    const wish = wishVelocity(input.forward, input.strafe, s.yaw, top);
    const held = Math.hypot(wish.x, wish.y) > 1e-6;
    const k = held ? ACCEL : BRAKE;
    const vel = { x: approach(s.vel.x, wish.x, k, h), y: approach(s.vel.y, wish.y, k, h) };
    const m = moveSliding(s.pos, { x: vel.x * h, y: vel.y * h }, r, world.obstacles, world.canStand);
    const moved = Math.hypot(m.pos.x - s.pos.x, m.pos.y - s.pos.y);
    // the speed actually achieved: a wall takes away the part of the velocity that pushes into it
    const sp = Math.hypot(vel.x, vel.y);
    const kk = sp > 1e-9 ? Math.min(1, moved / h / sp) : 1;
    s = { ...s, pos: m.pos, vel: { x: vel.x * kk, y: vel.y * kk }, phase: s.phase + moved * 0.7, blockedAt: m.blocked && held ? m.pos : s.blockedAt };
  }
  if (Math.hypot(s.vel.x, s.vel.y) < 0.01 && !input.forward && !input.strafe) s.vel = { x: 0, y: 0 };
  return s;
}

/** Eye height in metres: 1.6 standing, 1.2 seated, plus a bob of a few millimetres while moving. */
export function eyeHeight(w: Walker, o: Pick<WalkerOpts, 'seated' | 'bob'>): number {
  const base = o.seated ? EYE.seated : EYE.stand;
  if (!o.bob) return base;
  const v = Math.hypot(w.vel.x, w.vel.y);
  return base + Math.sin(w.phase * Math.PI * 2) * 0.004 * Math.min(1, v / 1.4);
}
