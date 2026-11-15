// Walking controls in one place: WASD and arrows, mouse look with pointer lock, a left thumb pad
// to move and right-side drag to look on touch screens, and a gamepad. Call `read(dt)` once per
// frame; it returns the move axes and the look change since the last read.
export interface Axes { forward: number; strafe: number; sprint: boolean; dYaw: number; dPitch: number }

const KEYS: Record<string, [number, number]> = {
  KeyW: [1, 0], ArrowUp: [1, 0], KeyS: [-1, 0], ArrowDown: [-1, 0],
  KeyD: [0, 1], KeyA: [0, -1],
};
const TURN = { ArrowLeft: 1, ArrowRight: -1 } as const;

export const deadzone = (v: number, dz = 0.15) => (Math.abs(v) < dz ? 0 : Math.sign(v) * ((Math.abs(v) - dz) / (1 - dz)));
export const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));

/** Axes from a set of held key codes. */
export function keyAxes(down: ReadonlySet<string>): { forward: number; strafe: number; turn: number } {
  let forward = 0, strafe = 0, turn = 0;
  for (const k of down) {
    const m = KEYS[k];
    if (m) { forward += m[0]; strafe += m[1]; }
    if (k in TURN) turn += TURN[k as keyof typeof TURN];
  }
  return { forward: clamp1(forward), strafe: clamp1(strafe), turn: clamp1(turn) };
}

/** Thumb pad: the drag from where the thumb landed, in units of the pad radius. Up is forward. */
export function padAxes(dx: number, dy: number, radiusPx = 48): { forward: number; strafe: number } {
  const l = Math.hypot(dx, dy);
  const k = l > radiusPx ? radiusPx / l : 1;
  return { forward: deadzone(clamp1((-dy * k) / radiusPx), 0.12), strafe: deadzone(clamp1((dx * k) / radiusPx), 0.12) };
}

export interface WalkInput {
  read: (dt: number) => Axes;
  /** Current thumb pad state for drawing it, or null. */
  pad: () => { cx: number; cy: number; x: number; y: number } | null;
  dispose: () => void;
}

const LOOK_MOUSE = 0.0022, LOOK_TOUCH = 0.0045, TURN_RATE = 1.8, PAD_R = 48;

/** Attach to the 3D view's element. Click locks the pointer (Esc releases); touch and gamepad work without clicks. */
export function attachWalkInput(el: HTMLElement, opts: { enabled?: () => boolean } = {}): WalkInput {
  const on = () => opts.enabled?.() !== false;
  const down = new Set<string>();
  let dYaw = 0, dPitch = 0;
  let padId: number | null = null, lookId: number | null = null;
  let pad: { cx: number; cy: number; x: number; y: number } | null = null;
  let lx = 0, ly = 0;
  let sprint = false;

  const typing = (t: EventTarget | null) => t instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
  const kd = (e: KeyboardEvent) => {
    if (!on() || typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (KEYS[e.code] || e.code in TURN || e.code === 'ShiftLeft') { down.add(e.code); sprint = e.shiftKey || down.has('ShiftLeft'); if (e.code.startsWith('Arrow')) e.preventDefault(); }
  };
  const ku = (e: KeyboardEvent) => { down.delete(e.code); if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') sprint = false; };
  const blur = () => { down.clear(); sprint = false; padId = lookId = null; pad = null; };
  const click = (e: MouseEvent) => {
    if (!on() || e.button !== 0 || (e.target instanceof HTMLElement && e.target.closest('button,a,input,select,textarea,[role="button"]'))) return;
    if (!document.pointerLockElement && 'requestPointerLock' in el && e.detail <= 1) { try { void el.requestPointerLock(); } catch { /* not allowed */ } }
  };
  const mm = (e: MouseEvent) => {
    if (document.pointerLockElement !== el || !on()) return;
    dYaw -= e.movementX * LOOK_MOUSE; dPitch -= e.movementY * LOOK_MOUSE;
  };
  const pd = (e: PointerEvent) => {
    if (e.pointerType !== 'touch' || !on()) return;
    const r = el.getBoundingClientRect();
    if (e.clientX - r.left < r.width / 2) {
      if (padId === null) { padId = e.pointerId; pad = { cx: e.clientX, cy: e.clientY, x: e.clientX, y: e.clientY }; }
    } else if (lookId === null) { lookId = e.pointerId; lx = e.clientX; ly = e.clientY; }
  };
  const pm = (e: PointerEvent) => {
    if (e.pointerId === padId && pad) { pad.x = e.clientX; pad.y = e.clientY; }
    else if (e.pointerId === lookId) { dYaw -= (e.clientX - lx) * LOOK_TOUCH; dPitch -= (e.clientY - ly) * LOOK_TOUCH; lx = e.clientX; ly = e.clientY; }
  };
  const pu = (e: PointerEvent) => { if (e.pointerId === padId) { padId = null; pad = null; } if (e.pointerId === lookId) lookId = null; };

  window.addEventListener('keydown', kd); window.addEventListener('keyup', ku); window.addEventListener('blur', blur);
  el.addEventListener('click', click); document.addEventListener('mousemove', mm);
  el.addEventListener('pointerdown', pd); window.addEventListener('pointermove', pm);
  window.addEventListener('pointerup', pu); window.addEventListener('pointercancel', pu);

  return {
    pad: () => pad,
    read(dt) {
      const k = keyAxes(down);
      let forward = k.forward, strafe = k.strafe;
      let yaw = dYaw + k.turn * TURN_RATE * dt, pitch = dPitch;
      dYaw = 0; dPitch = 0;
      if (pad) { const p = padAxes(pad.x - pad.cx, pad.y - pad.cy, PAD_R); forward += p.forward; strafe += p.strafe; }
      const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
      const gp = pads.find((p) => p && p.connected);
      if (gp) {
        strafe += deadzone(gp.axes[0] ?? 0); forward -= deadzone(gp.axes[1] ?? 0);
        yaw -= deadzone(gp.axes[2] ?? 0) * 2.4 * dt; pitch -= deadzone(gp.axes[3] ?? 0) * 1.6 * dt;
        if (gp.buttons[0]?.pressed || gp.buttons[10]?.pressed) sprint = true;
      }
      return { forward: clamp1(forward), strafe: clamp1(strafe), sprint, dYaw: yaw, dPitch: pitch };
    },
    dispose() {
      window.removeEventListener('keydown', kd); window.removeEventListener('keyup', ku); window.removeEventListener('blur', blur);
      el.removeEventListener('click', click); document.removeEventListener('mousemove', mm);
      el.removeEventListener('pointerdown', pd); window.removeEventListener('pointermove', pm);
      window.removeEventListener('pointerup', pu); window.removeEventListener('pointercancel', pu);
      if (document.pointerLockElement === el) document.exitPointerLock();
    },
  };
}
