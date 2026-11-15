import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Parts, Role } from './build';

/**
 * Geometry for wall-mounted pieces (art, curtains, shelves, mirrors, TVs). Built in the item's own
 * frame: centred on x, standing on y = 0 (the renderer lifts it to its mounting height), thickness
 * along z with the back against the wall at -d/2 and the face toward the room at +d/2.
 */
type V3 = [number, number, number];
const list = (): Map<Role, THREE.BufferGeometry[]> => new Map();

function put(m: Map<Role, THREE.BufferGeometry[]>, role: Role, s: V3, p: V3) {
  const g = new THREE.BoxGeometry(...s).toNonIndexed();
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
  g.translate(...p);
  (m.get(role) ?? m.set(role, []).get(role)!).push(g);
}
function rod(m: Map<Role, THREE.BufferGeometry[]>, role: Role, r: number, len: number, p: V3) {
  const g = new THREE.CylinderGeometry(r, r, len, 8).toNonIndexed();
  g.rotateZ(Math.PI / 2); g.translate(...p);
  (m.get(role) ?? m.set(role, []).get(role)!).push(g);
}
function finish(m: Map<Role, THREE.BufferGeometry[]>): Parts {
  const out: Parts = new Map();
  m.forEach((gs, role) => { const g = mergeGeometries(gs); if (g) out.set(role, g); gs.forEach((x) => x.dispose()); });
  return out;
}

function art(w: number, d: number, h: number): Parts {
  const m = list(), f = 0.035;
  put(m, 'dark', [w, h, d], [0, h / 2, 0]);
  put(m, 'white', [w - 2 * f - 0.04, h - 2 * f - 0.04, d * 0.4], [0, h / 2, d * 0.32]);
  // A simple abstract print: horizon bands inside the mat.
  const iw = w - 2 * f - 0.12, ih = h - 2 * f - 0.12;
  put(m, 'pot', [iw, ih * 0.45, d * 0.2], [0, h / 2 - ih * 0.2, d * 0.5]);
  put(m, 'green', [iw * 0.55, ih * 0.3, d * 0.2], [-iw * 0.2, h / 2 + ih * 0.22, d * 0.5]);
  put(m, 'book2', [iw * 0.18, iw * 0.18, d * 0.2], [iw * 0.25, h / 2 + ih * 0.25, d * 0.5]);
  return finish(m);
}

function curtain(w: number, d: number, h: number): Parts {
  const m = list(), folds = 5, fw = w / folds;
  for (let i = 0; i < folds; i++) {
    const out = i % 2 ? 0.55 : 1;
    put(m, 'soft', [fw * 0.95, h - 0.06, d * out], [-w / 2 + fw * (i + 0.5), (h - 0.06) / 2, d * (1 - out) * 0.5 - d * 0.0]);
  }
  rod(m, 'metal', 0.012, w + 0.1, [0, h - 0.03, d / 2 - 0.01]);
  return finish(m);
}

function shelf(w: number, d: number, h: number): Parts {
  const m = list();
  put(m, 'main', [w, h, d], [0, h / 2, 0]);
  const books: Role[] = ['book0', 'book1', 'book2', 'book3', 'book4'];
  for (let i = 0; i < 5; i++) put(m, books[i], [0.035, 0.18 - (i % 2) * 0.03, 0.14], [-w / 2 + 0.12 + i * 0.04, h + (0.18 - (i % 2) * 0.03) / 2, 0]);
  put(m, 'pot', [0.1, 0.1, 0.1], [w / 2 - 0.15, h + 0.05, 0]);
  put(m, 'green', [0.08, 0.1, 0.08], [w / 2 - 0.15, h + 0.15, 0]);
  return finish(m);
}

function mirror(w: number, d: number, h: number): Parts {
  const m = list(), f = 0.03;
  put(m, 'metal', [w, h, d], [0, h / 2, 0]);
  put(m, 'white', [w - 2 * f, h - 2 * f, d * 0.3], [0, h / 2, d * 0.4]);
  put(m, 'glass', [w - 2 * f, h - 2 * f, d * 0.1], [0, h / 2, d * 0.5]);
  return finish(m);
}

function tv(w: number, d: number, h: number): Parts {
  const m = list();
  put(m, 'dark', [w, h, d * 0.7], [0, h / 2, -d * 0.15]);
  put(m, 'metal', [w - 0.01, h - 0.01, d * 0.1], [0, h / 2, d * 0.2]);
  put(m, 'glass', [w - 0.04, h - 0.04, d * 0.06], [0, h / 2, d * 0.5]);
  return finish(m);
}

const BUILDERS: Record<string, (w: number, d: number, h: number) => Parts> = {
  'wall-art': art, curtain, 'wall-shelf': shelf, 'wall-mirror': mirror, 'wall-tv': tv,
};

/** Parts for a wall piece by category, or null when the category is not a wall piece. */
export function buildWallParts(category: string, w: number, d: number, h: number): Parts | null {
  const b = BUILDERS[category];
  return b ? b(w, d, h) : null;
}
