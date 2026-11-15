import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Pure geometry for every catalogue category. Each item is built once per (category, id, size),
 * merged into one geometry per material role, then fitted exactly to its footprint and height.
 */
export type Role = 'main' | 'dark' | 'soft' | 'white' | 'metal' | 'green' | 'pot' | 'glow' | 'glass' | 'ceramic'
  | 'book0' | 'book1' | 'book2' | 'book3' | 'book4';
export type Parts = Map<Role, THREE.BufferGeometry>;
type V3 = [number, number, number];

class Acc {
  list = new Map<Role, THREE.BufferGeometry[]>();
  add(role: Role, g: THREE.BufferGeometry, p: V3, rot?: V3) {
    let n = g.index ? g.toNonIndexed() : g;
    for (const k of Object.keys(n.attributes)) if (!['position', 'normal', 'uv'].includes(k)) n.deleteAttribute(k);
    if (rot) n.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...rot)));
    n.translate(...p);
    (this.list.get(role) ?? this.list.set(role, []).get(role)!).push(n);
  }
  /** Box; r > 0 rounds the edges. */
  box(role: Role, s: V3, p: V3, r = 0, rot?: V3) {
    const rr = Math.min(r, s[0] / 2.01, s[1] / 2.01, s[2] / 2.01);
    this.add(role, rr > 0.004 ? new RoundedBoxGeometry(s[0], s[1], s[2], 1, rr) : new THREE.BoxGeometry(...s), p, rot);
  }
  /** Cylinder or cone frustum standing on y; axis 'x' lays it along x. */
  cyl(role: Role, rTop: number, rBot: number, h: number, p: V3, seg = 12, axis: 'y' | 'x' | 'z' = 'y', open = false) {
    this.add(role, new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, open), p, axis === 'x' ? [0, 0, Math.PI / 2] : axis === 'z' ? [Math.PI / 2, 0, 0] : undefined);
  }
  ell(role: Role, r: V3, p: V3, rot?: V3, seg = 8) {
    const g = new THREE.SphereGeometry(1, seg, Math.max(3, seg - 3)); g.scale(...r);
    this.add(role, g, p, rot);
  }
  /** Four tapered legs set in from the corners. */
  legs(role: Role, w: number, d: number, h: number, t: number, inset: number, y0 = 0) {
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) this.cyl(role, t * 0.35, t * 0.55, h, [sx * (w / 2 - inset - t / 2), y0 + h / 2, sz * (d / 2 - inset - t / 2)], 8);
  }
  done(): Parts {
    const out: Parts = new Map();
    this.list.forEach((gs, role) => { const m = mergeGeometries(gs); if (m) out.set(role, m); gs.forEach((g) => g.dispose()); });
    return out;
  }
}

const bookRoles: Role[] = ['book0', 'book1', 'book2', 'book3', 'book4'];

function bed(a: Acc, w: number, d: number, h: number) {
  const fr = 0.28, mh = 0.2;
  a.box('main', [w, fr - 0.1, d], [0, 0.1 + (fr - 0.1) / 2, 0], 0.02);
  a.legs('dark', w, d, 0.1, 0.07, 0.02);
  a.box('white', [w - 0.04, mh, d - 0.08], [0, fr + mh / 2, 0.02], 0.06);
  const dl = d * 0.62;
  a.box('soft', [w - 0.03, 0.05, dl], [0, fr + mh + 0.02, d / 2 - dl / 2 - 0.02], 0.025);
  a.cyl('soft', 0.035, 0.035, w - 0.05, [0, fr + mh + 0.05, d / 2 - dl - 0.0], 10, 'x');
  a.box('soft', [w - 0.03, 0.03, 0.12], [0, fr + mh + 0.035, d / 2 - 0.1], 0.015);
  a.box('dark', [w, h, 0.07], [0, h / 2, -d / 2 + 0.035], 0.03);
  const pw = Math.min(0.6, w * 0.42);
  for (const x of w > 1.1 ? [-w / 4, w / 4] : [0]) a.box('white', [pw, 0.13, 0.38], [x, fr + mh + 0.07, -d / 2 + 0.3], 0.06);
}

function crib(a: Acc, w: number, d: number, h: number) {
  a.box('main', [w - 0.04, 0.05, d - 0.04], [0, 0.3, 0], 0.01);
  a.box('white', [w - 0.08, 0.12, d - 0.08], [0, 0.39, 0], 0.04);
  a.legs('main', w, d, h, 0.05, 0);
  const bars = Math.max(6, Math.round(d / 0.08));
  for (const sx of [-1, 1]) {
    a.box('main', [0.03, 0.03, d], [sx * (w / 2 - 0.025), h - 0.02, 0], 0.01);
    for (let i = 0; i < bars; i++) a.cyl('main', 0.009, 0.009, h - 0.37, [sx * (w / 2 - 0.025), 0.33 + (h - 0.37) / 2, -d / 2 + (i + 0.5) * d / bars], 5);
  }
  for (const sz of [-1, 1]) a.box('main', [w, h - 0.3, 0.03], [0, 0.3 + (h - 0.3) / 2, sz * (d / 2 - 0.015)], 0.01);
}

function sofa(a: Acc, w: number, d: number, h: number) {
  const armW = Math.min(0.16, w * 0.2), seatH = Math.min(0.44, h * 0.55), backD = Math.min(0.22, d * 0.26);
  const inner = w - 2 * armW, n = inner > 1.5 ? 3 : inner > 0.9 ? 2 : 1, cw = inner / n;
  a.box('main', [w, 0.2, d], [0, 0.08 + 0.1, 0], 0.03);
  a.legs('dark', w, d, 0.08, 0.06, 0.04);
  for (let i = 0; i < n; i++) a.box('soft', [cw - 0.015, seatH - 0.28, d - backD - 0.02], [-inner / 2 + cw * (i + 0.5), 0.28 + (seatH - 0.28) / 2, backD / 2], 0.05);
  a.box('main', [inner, h - 0.28, backD], [0, 0.28 + (h - 0.28) / 2, -d / 2 + backD / 2], 0.06);
  for (let i = 0; i < n; i++) a.box('soft', [cw - 0.03, (h - seatH) * 0.85, 0.15], [-inner / 2 + cw * (i + 0.5), seatH + (h - seatH) * 0.45, -d / 2 + backD + 0.05], 0.06, [-0.18, 0, 0]);
  for (const sx of [-1, 1]) a.box('main', [armW, h * 0.72 - 0.08, d], [sx * (w / 2 - armW / 2), 0.08 + (h * 0.72 - 0.08) / 2, 0], 0.06);
}

function table(a: Acc, w: number, d: number, h: number, round: boolean) {
  const top = 0.035;
  if (round) {
    a.cyl('main', Math.min(w, d) / 2, Math.min(w, d) / 2, top, [0, h - top / 2, 0], 28);
    a.cyl('metal', 0.03, 0.03, h - top - 0.02, [0, 0.02 + (h - top - 0.02) / 2, 0], 10);
    a.cyl('metal', Math.min(w, d) * 0.3, Math.min(w, d) * 0.32, 0.02, [0, 0.01, 0], 20);
    return;
  }
  a.box('main', [w, top, d], [0, h - top / 2, 0], 0.012);
  const ins = Math.min(0.06, w * 0.1, d * 0.2), ah = Math.min(0.09, h * 0.2), t = Math.min(0.055, w * 0.12, d * 0.12);
  a.box('dark', [w - 2 * ins - t, ah, 0.02], [0, h - top - ah / 2, d / 2 - ins - t / 2], 0.004);
  a.box('dark', [w - 2 * ins - t, ah, 0.02], [0, h - top - ah / 2, -d / 2 + ins + t / 2], 0.004);
  a.box('dark', [0.02, ah, d - 2 * ins - t], [w / 2 - ins - t / 2, h - top - ah / 2, 0], 0.004);
  a.box('dark', [0.02, ah, d - 2 * ins - t], [-w / 2 + ins - -t / 2, h - top - ah / 2, 0], 0.004);
  a.legs('dark', w, d, h - top, t, ins);
}

function desk(a: Acc, w: number, d: number, h: number, standing: boolean, drawers: boolean) {
  const top = 0.03;
  a.box('main', [w, top, d], [0, h - top / 2, 0], 0.012);
  if (standing) {
    for (const sx of [-1, 1]) {
      a.box('metal', [0.07, h - top - 0.04, 0.07], [sx * (w / 2 - 0.15), 0.04 + (h - top - 0.04) / 2, 0], 0.01);
      a.box('metal', [0.07, 0.04, d * 0.85], [sx * (w / 2 - 0.15), 0.02, 0], 0.015);
    }
    a.box('dark', [w - 0.3, 0.08, 0.02], [0, h - top - 0.06, -d / 2 + 0.08], 0.004);
    return;
  }
  a.box('dark', [w - 0.2, 0.07, 0.02], [0, h - top - 0.035, -d / 2 + 0.07], 0.004);
  a.legs('metal', w, d, h - top, 0.05, 0.035);
  if (drawers) a.box('soft', [0.4, 0.14, d - 0.2], [w / 2 - 0.3, h - top - 0.1, 0], 0.01);
}

function chair(a: Acc, w: number, d: number, h: number) {
  const seatH = Math.min(0.46, h * 0.56), t = 0.035;
  a.box('main', [w, 0.045, d * 0.92], [0, seatH, d * 0.04], 0.018);
  a.legs('dark', w, d * 0.92, seatH - 0.02, 0.04, 0.015, 0);
  for (const sx of [-1, 1]) a.box('dark', [t * 0.8, h - seatH - 0.03, t * 0.8], [sx * (w / 2 - 0.03), seatH + (h - seatH) / 2, -d / 2 + 0.05], 0.008);
  const bh = (h - seatH) * 0.6;
  a.box('main', [w - 0.1, bh, 0.03], [0, h - bh / 2 - 0.02, -d / 2 + 0.05], 0.012, [-0.08, 0, 0]);
}

function officeChair(a: Acc, w: number, d: number, h: number) {
  const seatH = 0.46;
  a.box('soft', [w * 0.8, 0.09, d * 0.76], [0, seatH, 0.04], 0.04);
  a.box('soft', [w * 0.72, h - seatH - 0.14, 0.07], [0, seatH + 0.08 + (h - seatH - 0.14) / 2 + 0.04, -d * 0.34], 0.04, [-0.1, 0, 0]);
  a.cyl('metal', 0.03, 0.025, seatH - 0.12, [0, 0.06 + (seatH - 0.12) / 2, 0], 10);
  a.cyl('dark', 0.045, 0.045, 0.1, [0, 0.4, 0], 10);
  for (let i = 0; i < 5; i++) {
    const ang = (i / 5) * Math.PI * 2, rr = w * 0.45;
    const g = new THREE.BoxGeometry(rr, 0.035, 0.05); g.translate(rr / 2, 0, 0); g.rotateY(-ang);
    a.add('metal', g, [0, 0.07, 0]);
    a.ell('dark', [0.03, 0.025, 0.03], [Math.cos(ang) * rr, 0.03, -Math.sin(ang) * rr], undefined, 6);
  }
  for (const sx of [-1, 1]) {
    a.box('dark', [0.04, 0.2, 0.04], [sx * w * 0.38, seatH + 0.1, 0], 0.01);
    a.box('dark', [0.06, 0.03, d * 0.35], [sx * w * 0.38, seatH + 0.21, 0], 0.012);
  }
}

function shelf(a: Acc, w: number, d: number, h: number) {
  const t = 0.022, n = Math.max(2, Math.round(h / 0.38)), step = (h - t) / n;
  for (const sx of [-1, 1]) a.box('main', [t, h, d], [sx * (w / 2 - t / 2), h / 2, 0]);
  a.box('dark', [w - 2 * t, h, 0.008], [0, h / 2, -d / 2 + 0.004]);
  for (let i = 0; i <= n; i++) a.box('main', [w - 2 * t, t, d - 0.01], [0, t / 2 + i * step, 0.004]);
  for (let i = 0; i < n; i++) {
    let x = -w / 2 + t + 0.03;
    const cnt = 4 + (i % 3), startShift = (i % 2) * w * 0.3;
    x += startShift;
    for (let j = 0; j < cnt; j++) {
      const bh = step * (0.55 + ((i * 7 + j * 3) % 5) * 0.08), bw = 0.025 + ((i + j * 2) % 3) * 0.012;
      if (x + bw > w / 2 - t - 0.02) break;
      a.box(bookRoles[(i * 2 + j) % 5], [bw, bh, d * (0.62 + ((j + i) % 3) * 0.08)], [x + bw / 2, t + i * step + bh / 2, 0.01], 0.004);
      x += bw + 0.004;
    }
  }
}

function cabinetBody(a: Acc, w: number, d: number, bodyY: number, body: number, doors: number, drawers: number, hasLegs: boolean) {
  const lg = bodyY;
  if (hasLegs) a.legs('dark', w, d, lg, 0.04, 0.03);
  else if (lg > 0) a.box('dark', [w - 0.04, lg, d - 0.04], [0, lg / 2, -0.01]);
  a.box('main', [w, body, d - 0.015], [0, lg + body / 2, -0.0075], 0.01);
  const fz = d / 2 - 0.007;
  if (drawers) {
    const dh = body / drawers;
    for (let i = 0; i < drawers; i++) {
      const y = lg + dh * (i + 0.5);
      a.box('soft', [w - 0.025, dh - 0.012, 0.018], [0, y, fz], 0.006);
      a.box('metal', [Math.min(0.16, w * 0.3), 0.014, 0.018], [0, y + dh * 0.22, fz + 0.022], 0.005);
    }
  } else {
    for (let i = 0; i < doors; i++) {
      const dw = w / doors, x = -w / 2 + dw * (i + 0.5);
      a.box('soft', [dw - 0.008, body - 0.02, 0.018], [x, lg + body / 2, fz], 0.005);
      const hx = x + (doors === 1 ? dw * 0.38 : (i === 0 ? 1 : -1) * dw * 0.4);
      a.cyl('metal', 0.007, 0.007, Math.min(0.3, body * 0.25), [hx, lg + body * 0.5, fz + 0.03], 6);
    }
  }
}

function cabinet(a: Acc, w: number, d: number, h: number, o: { drawers?: number; legs?: number }) {
  const lg = o.legs ?? 0.05;
  cabinetBody(a, w, d, lg, h - lg, o.drawers ? 0 : w > 0.7 ? 2 : 1, o.drawers ?? 0, lg >= 0.08);
}

function fixture(a: Acc, id: string, w: number, d: number, h: number) {
  if (id === 'toilet') {
    a.box('ceramic', [w * 0.75, h * 0.5, d * 0.28], [0, h * 0.75, -d / 2 + d * 0.14], 0.04); // cistern
    a.cyl('metal', 0.02, 0.02, 0.012, [0, h * 0.5 + 0.01, -d / 2 + d * 0.14 + 0.1], 8);
    a.ell('ceramic', [w * 0.46, h * 0.22, d * 0.38], [0, h * 0.42, d * 0.1], undefined, 12);
    a.ell('white', [w * 0.38, 0.02, d * 0.31], [0, h * 0.62, d * 0.1], undefined, 12);
    a.cyl('ceramic', w * 0.2, w * 0.28, h * 0.22, [0, h * 0.11, -0.02], 10);
    return;
  }
  if (id === 'washbasin') {
    const bh = h * 0.55;
    a.box('main', [w, bh, d], [0, bh / 2 + 0.02, 0], 0.012);
    a.box('dark', [w - 0.04, 0.02, d - 0.04], [0, 0.01, 0]);
    a.box('ceramic', [w, 0.05, d], [0, bh + 0.045, 0], 0.02);
    a.ell('white', [w * 0.32, 0.03, d * 0.3], [0, bh + 0.065, 0.02], undefined, 12);
    a.cyl('metal', 0.014, 0.014, 0.16, [0, bh + 0.15, -d / 2 + 0.07], 8);
    a.cyl('metal', 0.008, 0.008, 0.08, [0, bh + 0.2, -d / 2 + 0.1], 6, 'z');
    a.box('ceramic', [w, h - bh - 0.07, 0.02], [0, bh + 0.07 + (h - bh - 0.07) / 2, -d / 2 + 0.01], 0.006);
    return;
  }
  if (id === 'shower') {
    a.box('ceramic', [w, 0.08, d], [0, 0.04, 0], 0.02);
    for (const [px, pz] of [[-1, 1], [1, 1], [-1, -1], [1, -1]] as const) a.box('metal', [0.025, h - 0.1, 0.025], [px * (w / 2 - 0.0125), 0.08 + (h - 0.1) / 2, pz * (d / 2 - 0.0125)]);
    a.box('glass', [w - 0.02, h - 0.12, 0.008], [0, 0.08 + (h - 0.12) / 2, d / 2 - 0.004]);
    a.box('glass', [0.008, h - 0.12, d - 0.02], [w / 2 - 0.004, 0.08 + (h - 0.12) / 2, 0]);
    a.cyl('metal', 0.012, 0.012, 0.5, [-w / 2 + 0.06, h - 0.35, -d / 2 + 0.04], 6);
    a.cyl('metal', 0.09, 0.09, 0.015, [-w / 2 + 0.06, h - 0.1, -d / 2 + 0.12], 14);
    return;
  }
  if (id === 'bathtub') {
    a.box('ceramic', [w, h, d], [0, h / 2, 0], 0.08);
    a.ell('dark', [w * 0.43, 0.01, d * 0.38], [0, h - 0.015, 0.0], undefined, 14);
    a.cyl('metal', 0.014, 0.014, 0.16, [w / 2 - 0.15, h + 0.0, -d / 2 + 0.05], 8);
    return;
  }
  if (id === 'washing-machine') {
    a.box('ceramic', [w, h, d], [0, h / 2, 0], 0.02);
    a.cyl('dark', w * 0.3, w * 0.3, 0.04, [0, h * 0.45, d / 2 - 0.01], 20, 'z');
    a.cyl('glass', w * 0.24, w * 0.24, 0.045, [0, h * 0.45, d / 2 - 0.005], 20, 'z');
    a.box('dark', [w - 0.1, 0.06, 0.012], [0, h - 0.08, d / 2 + 0.002], 0.004);
    return;
  }
  cabinet(a, w, d, h, {});
}

function plant(a: Acc, w: number, h: number) {
  const potH = Math.min(0.32, h * 0.26), r = w / 2;
  a.cyl('pot', r * 0.85, r * 0.62, potH, [0, potH / 2, 0], 16);
  a.cyl('pot', r * 0.9, r * 0.88, 0.025, [0, potH - 0.0125, 0], 16);
  a.cyl('dark', r * 0.78, r * 0.78, 0.01, [0, potH - 0.015, 0], 14);
  const stems = 5, top = h - 0.03;
  for (let i = 0; i < stems; i++) {
    const ang = (i / stems) * Math.PI * 2 + 0.5, lean = 0.25 + (i % 3) * 0.1, sh = (top - potH) * (0.7 + (i % 3) * 0.15);
    a.cyl('green', 0.008, 0.012, sh, [Math.sin(ang) * sh * lean * 0.5, potH + sh / 2, Math.cos(ang) * sh * lean * 0.5], 5, 'y');
  }
  const leaves = 16;
  for (let i = 0; i < leaves; i++) {
    const t = i / leaves, ang = i * 2.4, rad = r * (0.25 + 0.55 * ((i * 5) % leaves) / leaves);
    const y = potH + (top - potH) * (0.35 + 0.6 * t), len = r * 0.55;
    a.ell('green', [len, 0.012, len * 0.45], [Math.sin(ang) * rad, y, Math.cos(ang) * rad], [0.0, ang + Math.PI / 2, 0.35], 6);
  }
}

function lamp(a: Acc, w: number, h: number) {
  const sh = Math.min(0.32, h * 0.22);
  a.cyl('metal', w * 0.38, w * 0.4, 0.025, [0, 0.0125, 0], 20);
  a.cyl('metal', 0.012, 0.012, h - sh - 0.02, [0, 0.025 + (h - sh - 0.02) / 2, 0], 8);
  a.cyl('glow', w / 2, w * 0.32, sh, [0, h - sh / 2, 0], 20, 'y', true);
  a.cyl('metal', 0.02, 0.02, 0.02, [0, h - sh, 0], 8);
}

function rug(a: Acc, w: number, d: number, h: number) {
  const t = Math.max(0.008, h), b = Math.min(0.07, w * 0.06);
  a.box('main', [w, t * 0.8, d], [0, t * 0.4, 0], 0.003);
  a.box('dark', [w, t, b], [0, t / 2, d / 2 - b / 2]);
  a.box('dark', [w, t, b], [0, t / 2, -d / 2 + b / 2]);
  a.box('dark', [b, t, d - 2 * b], [w / 2 - b / 2, t / 2, 0]);
  a.box('dark', [b, t, d - 2 * b], [-w / 2 + b / 2, t / 2, 0]);
}

function counter(a: Acc, w: number, d: number, h: number) {
  const top = 0.04, pl = 0.08, body = h - top - pl, doors = Math.max(2, Math.round(w / 0.6));
  a.box('dark', [w - 0.06, pl, d - 0.12], [0, pl / 2, -0.03]);
  a.box('main', [w, body, d - 0.07], [0, pl + body / 2, -0.035], 0.008);
  for (let i = 0; i < doors; i++) {
    const dw = w / doors, x = -w / 2 + dw * (i + 0.5);
    a.box('soft', [dw - 0.01, body - 0.03, 0.016], [x, pl + body / 2, d / 2 - 0.078], 0.005);
    a.cyl('metal', 0.006, 0.006, 0.14, [x + dw * 0.35, pl + body * 0.78, d / 2 - 0.05], 6);
  }
  a.box('dark', [w + 0.02, top, d], [0, h - top / 2, 0], 0.012);
}

function treatmentBed(a: Acc, w: number, d: number, h: number) {
  a.box('white', [w, 0.1, d * 0.72], [0, h - 0.05, d * 0.14], 0.045);
  a.box('white', [w, 0.1, d * 0.28], [0, h - 0.02, -d / 2 + d * 0.14], 0.045, [0.3, 0, 0]);
  a.box('metal', [0.12, h - 0.2, 0.12], [0, (h - 0.2) / 2 + 0.06, 0], 0.02);
  a.box('metal', [w * 0.9, 0.05, d * 0.8], [0, 0.025, 0], 0.02);
}

function stool(a: Acc, w: number, h: number, bar: boolean) {
  a.cyl('main', w / 2, w / 2 * 0.95, 0.06, [0, h - 0.03, 0], 20);
  if (bar) {
    for (let i = 0; i < 4; i++) { const ang = (i / 4) * Math.PI * 2 + 0.78, rr = w * 0.36;
      a.cyl('metal', 0.012, 0.016, h - 0.06, [Math.cos(ang) * rr, (h - 0.06) / 2, Math.sin(ang) * rr], 6); }
    a.cyl('metal', w * 0.36, w * 0.36, 0.015, [0, h * 0.3, 0], 16, 'y', true);
    return;
  }
  a.cyl('metal', 0.025, 0.025, h - 0.12, [0, 0.07 + (h - 0.12) / 2, 0], 8);
  for (let i = 0; i < 5; i++) {
    const ang = (i / 5) * Math.PI * 2, rr = w * 0.42, g = new THREE.BoxGeometry(rr, 0.025, 0.035); g.translate(rr / 2, 0, 0); g.rotateY(-ang);
    a.add('metal', g, [0, 0.05, 0]);
  }
}

function bunk(a: Acc, w: number, d: number, h: number) {
  const post = 0.06;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) a.box('main', [post, h, post], [sx * (w / 2 - post / 2), h / 2, sz * (d / 2 - post / 2)], 0.012);
  for (const y of [0.25, h * 0.62]) {
    a.box('main', [w - 0.04, 0.05, d - 0.04], [0, y, 0], 0.01);
    a.box('white', [w - 0.08, 0.15, d - 0.1], [0, y + 0.1, 0], 0.05);
    a.box('white', [Math.min(0.6, w * 0.6), 0.1, 0.35], [0, y + 0.22, -d / 2 + 0.28], 0.05);
  }
  for (const sz of [-1, 1]) a.box('main', [w, 0.12, 0.03], [0, h - 0.1, sz * (d / 2 - 0.02)], 0.01);
  for (let i = 0; i < 4; i++) a.cyl('dark', 0.013, 0.013, w - 0.1, [0, 0.35 + i * (h * 0.62 - 0.1) / 4, d / 2 - 0.02], 6, 'x');
}

function pod(a: Acc, w: number, d: number, h: number) {
  a.box('dark', [w, 0.08, d], [0, 0.04, 0], 0.02);
  a.box('dark', [w, 0.1, d], [0, h - 0.05, 0], 0.02);
  a.box('main', [w, h - 0.18, 0.06], [0, h / 2, -d / 2 + 0.03], 0.01);
  for (const sx of [-1, 1]) a.box('main', [0.06, h - 0.18, d], [sx * (w / 2 - 0.03), h / 2, 0], 0.01);
  a.box('glass', [w - 0.12, h - 0.2, 0.012], [0, h / 2, d / 2 - 0.02]);
  a.box('white', [w * 0.7, 0.03, 0.4], [0, 0.74, -d / 2 + 0.26], 0.01);
  a.box('soft', [0.4, 0.45, 0.4], [0, 0.31, 0.05], 0.08);
  a.cyl('metal', 0.02, 0.02, 0.45, [0.0, 0.3, -0.12], 6);
}

function reception(a: Acc, w: number, d: number, h: number) {
  a.box('main', [w, h, 0.06], [0, h / 2, d / 2 - 0.03], 0.02);
  a.box('dark', [w + 0.04, 0.035, 0.3], [0, h + 0.0, d / 2 - 0.15], 0.012);
  a.box('white', [w - 0.1, 0.03, d - 0.1], [0, 0.74, -0.03], 0.01);
  for (const sx of [-1, 1]) a.box('main', [0.04, 0.74, d - 0.06], [sx * (w / 2 - 0.02), 0.37, -0.03], 0.01);
}

function divider(a: Acc, w: number, d: number, h: number) {
  const n = Math.max(2, Math.round(w / 0.45)), pw = w / n, pd = Math.max(0.02, d * 0.5);
  for (let i = 0; i < n; i++) {
    const x = -w / 2 + pw * (i + 0.5), z = (i % 2 ? 1 : -1) * Math.max(0, d / 2 - pd / 2 - 0.002);
    a.box('main', [pw - 0.02, h - 0.06, pd], [x, 0.06 + (h - 0.06) / 2, z], 0.008);
    a.box('dark', [0.04, 0.06, Math.max(0.03, pd)], [x, 0.03, z], 0.004);
  }
}

function tvUnit(a: Acc, w: number, d: number, h: number) {
  cabinetBody(a, w, d, 0.1, h - 0.1, 3, 0, true);
}

function build(category: string, id: string, w: number, d: number, h: number): Acc {
  const a = new Acc();
  switch (category) {
    case 'bed': bed(a, w, d, h); break;
    case 'crib': crib(a, w, d, h); break;
    case 'sofa': case 'sofa-bed': case 'armchair': sofa(a, w, d, h); break;
    case 'desk': desk(a, w, d, h, id === 'desk-standing', id === 'desk-140' || id === 'desk-160'); break;
    case 'table': case 'coffee-table': case 'bench': table(a, w, d, h, false); break;
    case 'cafe-table': table(a, w, d, h, true); break;
    case 'chair': chair(a, w, d, h); break;
    case 'office-chair': officeChair(a, w, d, h); break;
    case 'bookshelf': shelf(a, w, d, h); break;
    case 'wardrobe': case 'storage-cabinet': fixture(a, id, w, d, h); break;
    case 'dresser': cabinet(a, w, d, h, { drawers: id === 'sideboard' ? 2 : 4, legs: 0.06 }); break;
    case 'nightstand': cabinet(a, w, d, h, { drawers: 2, legs: 0.1 }); break;
    case 'filing-cabinet': cabinet(a, w, d, h, { drawers: 3, legs: 0.02 }); break;
    case 'toy-storage': cabinet(a, w, d, h, { drawers: 2, legs: 0.03 }); break;
    case 'tv-unit': tvUnit(a, w, d, h); break;
    case 'counter': counter(a, w, d, h); break;
    case 'bunk-bed': bunk(a, w, d, h); break;
    case 'office-pod': pod(a, w, d, h); break;
    case 'reception-desk': reception(a, w, d, h); break;
    case 'room-divider': divider(a, w, d, h); break;
    case 'treatment-bed': treatmentBed(a, w, d, h); break;
    case 'stool': stool(a, w, h, /bar/.test(id)); break;
    case 'plant': plant(a, w, h); break;
    case 'lamp': lamp(a, w, h); break;
    case 'rug': rug(a, w, d, h); break;
    default: a.box('main', [w, h, d], [0, h / 2, 0], 0.02);
  }
  return a;
}

const cache = new Map<string, Parts>();

/** Parts for an item, cached per category, catalogue id and size, fitted exactly to w x d x h. */
export function buildParts(category: string, catalogId: string, w: number, d: number, h: number): Parts {
  const key = `${category}|${catalogId}|${w.toFixed(3)}|${d.toFixed(3)}|${h.toFixed(3)}`;
  const hit = cache.get(key); if (hit) return hit;
  const parts = build(category, catalogId, w, d, h).done();
  const box = new THREE.Box3();
  parts.forEach((g) => { g.computeBoundingBox(); box.union(g.boundingBox!); });
  if (!box.isEmpty()) {
    const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    const m = new THREE.Matrix4()
      .makeScale(w / (size.x || 1), h / (size.y || 1), d / (size.z || 1))
      .multiply(new THREE.Matrix4().makeTranslation(-c.x, -box.min.y, -c.z));
    parts.forEach((g) => { g.applyMatrix4(m); g.computeBoundingBox(); g.computeBoundingSphere(); });
  }
  if (cache.size > 300) cache.clear();
  cache.set(key, parts);
  return parts;
}

export function triangleCount(parts: Parts): number {
  let n = 0; parts.forEach((g) => { n += (g.index ? g.index.count : g.attributes.position.count) / 3; });
  return n;
}
