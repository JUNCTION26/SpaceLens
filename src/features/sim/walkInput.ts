// Walking controls in one place. W A S D move relative to the view, the arrow keys look (left and
// right turn, up and down tilt) and never move, Shift walks faster. Dragging with the mouse looks;
// on touch screens a drag on the left half moves and a drag on the right half looks; a gamepad
// works too. Call `read(dt)` once per frame; it returns the move axes and the look change since
// the last read.
export interface Axes { forward: number; strafe: number; sprint: boolean; dYaw: number; dPitch: number }

const MOVE: Record<string, [number, number]> = { KeyW: [1, 0], KeyS: [-1, 0], KeyD: [0, 1], KeyA: [0, -1] };
const LOOK: Record<string, [number, number]> = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
const SHIFT = new Set(['ShiftLeft', 'ShiftRight']);

/** Tilt is held within about 60 degrees up or down. */
export const PITCH_LIMIT = Math.PI / 3;
/** Arrow keys turn at 90 degrees per second, easing in and out over about a tenth of a second. */
export const TURN_RATE = Math.PI / 2;
const TURN_EASE = 0.1;

export const deadzone = (v: number, dz = 0.15) => (Math.abs(v) < dz ? 0 : Math.sign(v) * ((Math.abs(v) - dz) / (1 - dz)));
export const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));
export const clampPitch = (p: number) => Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, p));

/** True for key codes the walker uses. */
export const isWalkKey = (code: string) => code in MOVE || code in LOOK || SHIFT.has(code);

/** Axes from a set of held key codes: WASD give only movement, arrows give only turn and tilt. */
export function keyAxes(down: ReadonlySet<string>): { forward: number; strafe: number; turn: number; tilt: number } {
  let forward = 0, strafe = 0, turn = 0, tilt = 0;
  for (const k of down) {
    const m = MOVE[k];
    if (m) { forward += m[0]; strafe += m[1]; }
    const l = LOOK[k];
    if (l) { turn += l[0]; tilt += l[1]; }
  }
  return { forward: clamp1(forward), strafe: clamp1(strafe), turn: clamp1(turn), tilt: clamp1(tilt) };
}

/** Eases the arrow-key turn rate toward the held direction, so turning starts and stops smoothly. */
export function easeTurn(current: number, target: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-Math.max(0, dt) / TURN_EASE));
}

/** Thumb pad: the drag from where the thumb landed, in units of the pad radius. Up is forward. */
export function padAxes(dx: number, dy: number, radiusPx = 48): { forward: number; strafe: number } {
  const l = Math.hypot(dx, dy);
  const k = l > radiusPx ? radiusPx / l : 1;
  return { forward: deadzone(clamp1((-dy * k) / radiusPx), 0.12), strafe: deadzone(clamp1((dx * k) / radiusPx), 0.12) };
}

export interface WalkInput {
  read: (dt: number) => Axes;
  /** Current thumb pad state, or null. */
  pad: () => { cx: number; cy: number; x: number; y: number } | null;
  dispose: () => void;
}

const LOOK_MOUSE = 0.004, LOOK_TOUCH = 0.0045, PAD_R = 48;

const typing = (t: EventTarget | null) => t instanceof HTMLElement && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
const onControl = (t: EventTarget | null) => t instanceof Element && !!t.closest('button,a,input,select,textarea,[role="button"],[role="toolbar"]');

/** Attach to the 3D view's element. Keys are caught first so they do not also edit the plan. */
export function attachWalkInput(el: HTMLElement, opts: { enabled?: () => boolean; onExit?: () => void } = {}): WalkInput {
  const on = () => opts.enabled?.() !== false;
  const down = new Set<string>();
  let dYaw = 0, dPitch = 0, turnV = 0, tiltV = 0;
  let padId: number | null = null, lookId: number | null = null;
  let pad: { cx: number; cy: number; x: number; y: number } | null = null;
  let lx = 0, ly = 0;

  const kd = (e: KeyboardEvent) => {
    if (!on() || typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'Escape' && !document.fullscreenElement) { opts.onExit?.(); return; }
    if (!isWalkKey(e.code)) return;
    down.add(e.code);
    e.preventDefault(); e.stopPropagation();
  };
  const ku = (e: KeyboardEvent) => { if (down.delete(e.code) && on()) e.stopPropagation(); };
  const blur = () => { down.clear(); padId = lookId = null; pad = null; turnV = tiltV = 0; };
  const pd = (e: PointerEvent) => {
    if (!on() || onControl(e.target)) return;
    if (e.pointerType === 'touch') {
      const r = el.getBoundingClientRect();
      if (e.clientX - r.left < r.width / 2) {
        if (padId === null) { padId = e.pointerId; pad = { cx: e.clientX, cy: e.clientY, x: e.clientX, y: e.clientY }; }
        return;
      }
    } else if (e.button !== 0) return;
    if (lookId === null) { lookId = e.pointerId; lx = e.clientX; ly = e.clientY; }
  };
  const pm = (e: PointerEvent) => {
    if (e.pointerId === padId && pad) { pad.x = e.clientX; pad.y = e.clientY; }
    else if (e.pointerId === lookId) {
      const k = e.pointerType === 'touch' ? LOOK_TOUCH : LOOK_MOUSE;
      dYaw -= (e.clientX - lx) * k; dPitch -= (e.clientY - ly) * k; lx = e.clientX; ly = e.clientY;
    }
  };
  const pu = (e: PointerEvent) => { if (e.pointerId === padId) { padId = null; pad = null; } if (e.pointerId === lookId) lookId = null; };

  window.addEventListener('keydown', kd, true); window.addEventListener('keyup', ku, true); window.addEventListener('blur', blur);
  el.addEventListener('pointerdown', pd); window.addEventListener('pointermove', pm);
  window.addEventListener('pointerup', pu); window.addEventListener('pointercancel', pu);

  return {
    pad: () => pad,
    read(dt) {
      if (!on()) { blur(); dYaw = dPitch = 0; return { forward: 0, strafe: 0, sprint: false, dYaw: 0, dPitch: 0 }; }
      const k = keyAxes(down);
      let forward = k.forward, strafe = k.strafe;
      let sprint = down.has('ShiftLeft') || down.has('ShiftRight');
      turnV = easeTurn(turnV, k.turn, dt); tiltV = easeTurn(tiltV, k.tilt, dt);
      if (Math.abs(turnV) < 1e-3 && !k.turn) turnV = 0;
      if (Math.abs(tiltV) < 1e-3 && !k.tilt) tiltV = 0;
      let yaw = dYaw + turnV * TURN_RATE * dt, pitch = dPitch + tiltV * TURN_RATE * 0.7 * dt;
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
      window.removeEventListener('keydown', kd, true); window.removeEventListener('keyup', ku, true); window.removeEventListener('blur', blur);
      el.removeEventListener('pointerdown', pd); window.removeEventListener('pointermove', pm);
      window.removeEventListener('pointerup', pu); window.removeEventListener('pointercancel', pu);
    },
  };
}
