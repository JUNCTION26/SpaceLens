// PBR materials for generated parts.
//
// Geometry UVs are in world metres (see GeneratedMesh), so a texture that covers `tileM` metres
// gets repeat = 1 / tileM and every part shows the same texel density whatever its size. Wood
// grain runs along V, which the geometry aligns with each part's long axis.
//
// Colour: when a part has a colour, it is shown exactly. The texture then contributes only its
// light-dark detail (a luminance map normalised around a known mean), and the material colour is
// divided by that mean so the average comes out at the requested colour.
import * as THREE from 'three';
import type { MaterialId } from '../../core/types';

type Kind = 'wood' | 'fabric' | 'metal' | 'stone' | 'plain' | 'glass' | 'plant' | 'leather' | 'rattan' | 'quilt';

export interface MaterialDef {
  /** Base colour when the part has none and no photo texture is loaded. */
  color: string;
  rough: number;
  metal: number;
  kind: Kind;
  /** Metres covered by one procedural tile. */
  tileM: number;
  /** Photo texture colours are kept as-is when the part has no colour. */
  natural?: boolean;
  /** Multiplier on the photo texture when the part has no colour (to correct a too-light scan). */
  photoTint?: string;
  normal?: number;
  sheen?: number;
  clearcoat?: number;
  opacity?: number;
}

export const MATERIAL_DEFS: Record<MaterialId, MaterialDef> = {
  oak: { color: '#c39a6b', rough: 0.55, metal: 0, kind: 'wood', tileM: 1.2, natural: true, normal: 0.5, clearcoat: 0.08 },
  walnut: { color: '#6e4a32', rough: 0.5, metal: 0, kind: 'wood', tileM: 1.2, natural: true, photoTint: '#8c6a56', normal: 0.5, clearcoat: 0.12 },
  pine: { color: '#d8b47f', rough: 0.6, metal: 0, kind: 'wood', tileM: 0.9, natural: true, normal: 0.5 },
  birch: { color: '#e3cfae', rough: 0.55, metal: 0, kind: 'wood', tileM: 1.0, natural: true, normal: 0.4 },
  'white-laminate': { color: '#f1efea', rough: 0.42, metal: 0, kind: 'plain', tileM: 0.6, clearcoat: 0.1 },
  'black-laminate': { color: '#1f1f21', rough: 0.42, metal: 0, kind: 'plain', tileM: 0.6, clearcoat: 0.1 },
  'black-metal': { color: '#1c1c1e', rough: 0.42, metal: 0.75, kind: 'metal', tileM: 0.5, normal: 0.08 },
  steel: { color: '#b9bdc3', rough: 0.3, metal: 1, kind: 'metal', tileM: 0.5, normal: 0.1 },
  brass: { color: '#c9a24c', rough: 0.28, metal: 1, kind: 'metal', tileM: 0.5, normal: 0 },
  chrome: { color: '#eceef1', rough: 0.08, metal: 1, kind: 'metal', tileM: 0.5, normal: 0 },
  fabric: { color: '#9b968d', rough: 0.95, metal: 0, kind: 'fabric', tileM: 0.12, normal: 0.6 },
  linen: { color: '#d8cfbf', rough: 0.96, metal: 0, kind: 'fabric', tileM: 0.1, normal: 0.7 },
  velvet: { color: '#4d6a48', rough: 0.85, metal: 0, kind: 'fabric', tileM: 0.12, normal: 0.3, sheen: 1 },
  leather: { color: '#7b4a2c', rough: 0.5, metal: 0, kind: 'leather', tileM: 0.4, natural: true, normal: 0.5, clearcoat: 0.25 },
  wool: { color: '#bfb7a8', rough: 0.98, metal: 0, kind: 'fabric', tileM: 0.08, normal: 0.9, sheen: 0.4 },
  glass: { color: '#e9f2f6', rough: 0.04, metal: 0, kind: 'glass', tileM: 1, opacity: 0.28 },
  marble: { color: '#ebe8e3', rough: 0.22, metal: 0, kind: 'stone', tileM: 1.2, natural: true, clearcoat: 0.6, normal: 0.2 },
  concrete: { color: '#a9a59e', rough: 0.9, metal: 0, kind: 'stone', tileM: 1.5, natural: true, normal: 0.6 },
  plastic: { color: '#e8e6e1', rough: 0.38, metal: 0, kind: 'plain', tileM: 0.6, clearcoat: 0.2 },
  mattress: { color: '#f3f1ec', rough: 0.95, metal: 0, kind: 'quilt', tileM: 0.25, normal: 0.8 },
  rattan: { color: '#c7a06a', rough: 0.75, metal: 0, kind: 'rattan', tileM: 0.08, normal: 1 },
  ceramic: { color: '#f0ede7', rough: 0.25, metal: 0, kind: 'plain', tileM: 0.6, clearcoat: 0.8 },
  plant: { color: '#4b7a3c', rough: 0.65, metal: 0, kind: 'plant', tileM: 0.15, normal: 0.6, sheen: 0.3 },
};

export interface MaterialOptions { ghost?: boolean; selected?: boolean }

// ---- Procedural detail textures (linear luminance around DETAIL_MEAN) ---------------------

const DETAIL_MEAN = 0.8;
const hasDom = typeof document !== 'undefined';

function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

interface Proc { detail: THREE.Texture; normal: THREE.Texture | null }
const procCache = new Map<Kind, Proc | null>();

/** Height field (0..1) for a kind, n x n, tileable. */
function heightField(kind: Kind, n: number): Float32Array {
  const h = new Float32Array(n * n), rand = rng(kind.length * 7919 + 17);
  const set = (fn: (x: number, y: number) => number) => { for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) h[y * n + x] = fn(x, y); };
  const TAU = Math.PI * 2;
  const waves = Array.from({ length: 6 }, () => ({ k: 1 + Math.floor(rand() * 4), p: rand() * TAU, a: rand() }));
  const noise = (x: number, y: number) => waves.reduce((s, w, i) => s + w.a * Math.sin(TAU * w.k * (i % 2 ? x : y) / n + w.p + Math.sin(TAU * (i + 1) * (i % 2 ? y : x) / n) * 0.8), 0) / 6;
  switch (kind) {
    case 'wood': {
      // Fine grain lines running along V (y), wobbling slowly.
      const lines = Array.from({ length: 48 }, () => ({ x: rand(), w: 0.3 + rand() * 1.4, a: 0.3 + rand() * 0.7 }));
      set((x, y) => {
        let v = 0.5;
        for (const l of lines) {
          const cx = (l.x * n + Math.sin(TAU * y / n + l.x * 9) * 3 + Math.sin(TAU * 3 * y / n + l.x * 4) * 1.2);
          let dx = Math.abs(x - cx) % n; dx = Math.min(dx, n - dx);
          v -= l.a * 0.25 * Math.exp(-(dx * dx) / (l.w * l.w));
        }
        return v + noise(x, y) * 0.08;
      });
      break;
    }
    case 'fabric': case 'quilt': {
      set((x, y) => {
        const wx = 0.5 + 0.5 * Math.sin(TAU * x * 16 / n), wy = 0.5 + 0.5 * Math.sin(TAU * y * 16 / n);
        const over = ((Math.floor(x * 16 / n) + Math.floor(y * 16 / n)) % 2) ? wx : wy;
        let v = 0.35 + over * 0.4 + (rand() - 0.5) * 0.12;
        if (kind === 'quilt') {
          // Diamond stitching dips.
          const u = ((x + y) / n * 4) % 1, w = ((x - y + n) / n * 4) % 1;
          const d = Math.min(Math.min(u, 1 - u), Math.min(w, 1 - w));
          v = v * 0.4 + 0.6 * Math.min(1, d * 6);
        }
        return v;
      });
      break;
    }
    case 'rattan': {
      set((x, y) => {
        const cx = Math.floor(x * 8 / n), cy = Math.floor(y * 8 / n);
        const fx = (x * 8 / n) % 1, fy = (y * 8 / n) % 1;
        const horiz = (cx + cy) % 2 === 0;
        const f = horiz ? fy : fx;
        return 0.15 + 0.85 * Math.sin(Math.PI * f) + (rand() - 0.5) * 0.06;
      });
      break;
    }
    case 'leather': case 'stone': case 'plant': {
      // Soft blotchy noise from summed random blobs.
      set(() => 0.5);
      const blobs = kind === 'leather' ? 900 : 220;
      for (let b = 0; b < blobs; b++) {
        const bx = rand() * n, by = rand() * n, r = (kind === 'leather' ? 1.5 : 6) + rand() * (kind === 'leather' ? 3 : 18), a = (rand() - 0.5) * 0.35;
        const r2 = r * r;
        for (let y = Math.floor(by - r); y <= by + r; y++) for (let x = Math.floor(bx - r); x <= bx + r; x++) {
          const d2 = (x - bx) ** 2 + (y - by) ** 2;
          if (d2 > r2) continue;
          const i = ((y + n) % n) * n + ((x + n) % n);
          h[i] += a * (1 - d2 / r2);
        }
      }
      if (kind === 'plant') for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) h[y * n + x] -= 0.25 * Math.exp(-(((x % (n / 4)) - n / 8) ** 2) / 4);
      break;
    }
    case 'metal': {
      // Brushed: streaks along x.
      const rows = Array.from({ length: n }, () => (rand() - 0.5) * 0.25);
      set((x, y) => 0.5 + rows[y] + (rand() - 0.5) * 0.05);
      break;
    }
    default:
      set((x, y) => 0.5 + noise(x, y) * 0.04 + (rand() - 0.5) * 0.02);
  }
  return h;
}

function makeProc(kind: Kind): Proc | null {
  if (!hasDom) return null;
  const n = 256, h = heightField(kind, n);
  let lo = Infinity, hi = -Infinity, sum = 0;
  for (const v of h) { lo = Math.min(lo, v); hi = Math.max(hi, v); sum += v; }
  const mean = sum / h.length, span = Math.max(1e-6, hi - lo);
  const contrast = kind === 'wood' ? 0.32 : kind === 'rattan' ? 0.55 : kind === 'quilt' ? 0.3 : kind === 'fabric' ? 0.16 : kind === 'metal' ? 0.06 : kind === 'plain' ? 0.02 : 0.18;
  const dc = document.createElement('canvas'), nc = document.createElement('canvas');
  dc.width = dc.height = nc.width = nc.height = n;
  const dg = dc.getContext('2d'), ng = nc.getContext('2d');
  if (!dg || !ng) return null;
  const di = dg.createImageData(n, n), ni = ng.createImageData(n, n);
  const strength = kind === 'rattan' ? 3 : kind === 'fabric' || kind === 'quilt' ? 2 : 1.2;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = y * n + x, v = (h[i] - mean) / span;
    const d = Math.max(0, Math.min(1, DETAIL_MEAN + v * contrast * 2));
    const b = Math.round(d * 255);
    di.data[i * 4] = di.data[i * 4 + 1] = di.data[i * 4 + 2] = b; di.data[i * 4 + 3] = 255;
    const hx = (h[y * n + ((x + 1) % n)] - h[y * n + ((x - 1 + n) % n)]) / span;
    const hy = (h[((y + 1) % n) * n + x] - h[((y - 1 + n) % n) * n + x]) / span;
    const nx = -hx * strength, ny = hy * strength, len = Math.hypot(nx, ny, 1);
    ni.data[i * 4] = Math.round((nx / len * 0.5 + 0.5) * 255);
    ni.data[i * 4 + 1] = Math.round((ny / len * 0.5 + 0.5) * 255);
    ni.data[i * 4 + 2] = Math.round((1 / len * 0.5 + 0.5) * 255);
    ni.data[i * 4 + 3] = 255;
  }
  dg.putImageData(di, 0, 0); ng.putImageData(ni, 0, 0);
  const detail = new THREE.CanvasTexture(dc), normal = new THREE.CanvasTexture(nc);
  for (const t of [detail, normal]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; t.colorSpace = THREE.NoColorSpace; }
  return { detail, normal: kind === 'plain' || kind === 'glass' ? null : normal };
}

const procTiled = new Map<string, Proc | null>();
/** Procedural maps for a kind, repeated so one tile covers `tileM` metres. */
function proc(kind: Kind, tileM: number): Proc | null {
  const key = `${kind}|${tileM}`;
  if (!procTiled.has(key)) {
    if (!procCache.has(kind)) procCache.set(kind, makeProc(kind));
    const base = procCache.get(kind);
    if (!base) { procTiled.set(key, null); }
    else {
      const tile = (t: THREE.Texture) => { const c = t.clone(); c.repeat.set(1 / tileM, 1 / tileM); c.needsUpdate = true; return c; };
      procTiled.set(key, { detail: tile(base.detail), normal: base.normal ? tile(base.normal) : null });
    }
  }
  return procTiled.get(key) ?? null;
}

// ---- Photo textures from the manifest -------------------------------------------------------

interface ManifestEntry { folder: string; tileM: number }
interface Photo { diff: THREE.Texture; detail: THREE.Texture; nor: THREE.Texture | null; rough: THREE.Texture | null; roughMean: number; tileM: number }

const BASE = (() => { try { return (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/'; } catch { return '/'; } })();
const ROOT = `${BASE}assets/textures/materials/`;
let manifest: Promise<Record<string, ManifestEntry>> | null = null;
const photos = new Map<MaterialId, Promise<Photo | null>>();
const loaded = new Map<MaterialId, Photo>();

function getManifest(): Promise<Record<string, ManifestEntry>> {
  return manifest ??= fetch(ROOT + 'manifest.json')
    .then((r) => (r.ok ? r.json() : {}))
    .then((m: Record<string, unknown>) => {
      const out: Record<string, ManifestEntry> = {};
      for (const [id, v] of Object.entries(m ?? {})) {
        if (typeof v === 'string') out[id] = { folder: v, tileM: MATERIAL_DEFS[id as MaterialId]?.tileM ?? 1 };
        else if (v && typeof v === 'object') {
          const o = v as Record<string, unknown>;
          const folder = (o.folder ?? o.dir ?? o.name) as string | undefined;
          const tileM = typeof o.tileM === 'number' && o.tileM > 0 ? o.tileM : MATERIAL_DEFS[id as MaterialId]?.tileM ?? 1;
          if (typeof folder === 'string') out[id] = { folder, tileM };
        }
      }
      return out;
    })
    .catch(() => ({}));
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((res) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => res(img);
    img.onerror = () => res(null);
    img.src = url;
  });
}

/** Luminance detail map around DETAIL_MEAN, and the image's mean value (for roughness maps). */
function analyse(img: HTMLImageElement, makeDetail: boolean): { detail: THREE.Texture | null; mean: number } {
  const n = Math.min(1024, img.naturalWidth || img.width);
  const c = document.createElement('canvas'); c.width = c.height = n;
  const g = c.getContext('2d', { willReadFrequently: true });
  if (!g) return { detail: null, mean: 0.5 };
  g.drawImage(img, 0, 0, n, n);
  const data = g.getImageData(0, 0, n, n);
  const px = data.data;
  // sRGB -> linear luminance.
  const lin = (v: number) => { const c2 = v / 255; return c2 <= 0.04045 ? c2 / 12.92 : ((c2 + 0.055) / 1.055) ** 2.4; };
  const lut = new Float32Array(256); for (let i = 0; i < 256; i++) lut[i] = lin(i);
  const L = new Float32Array(n * n);
  let sum = 0;
  for (let i = 0; i < n * n; i++) { const v = 0.2126 * lut[px[i * 4]] + 0.7152 * lut[px[i * 4 + 1]] + 0.0722 * lut[px[i * 4 + 2]]; L[i] = v; sum += v; }
  const mean = sum / (n * n);
  if (!makeDetail) return { detail: null, mean: sum / (n * n) };
  for (let i = 0; i < n * n; i++) {
    const d = Math.max(0, Math.min(1, DETAIL_MEAN * (1 + (L[i] / Math.max(1e-4, mean) - 1) * 0.85)));
    const b = Math.round(d * 255);
    px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = b; px[i * 4 + 3] = 255;
  }
  g.putImageData(data, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return { detail: t, mean };
}

function loadPhoto(id: MaterialId): Promise<Photo | null> {
  if (!hasDom || typeof fetch === 'undefined') return Promise.resolve(null);
  let p = photos.get(id);
  if (!p) {
    p = getManifest().then(async (m) => {
      const e = m[id];
      if (!e) return null;
      const dir = ROOT + e.folder + '/';
      const [di, ni, ri] = await Promise.all([loadImage(dir + 'diff.jpg'), loadImage(dir + 'nor.jpg'), loadImage(dir + 'rough.jpg')]);
      if (!di) return null;
      const rep = 1 / e.tileM;
      const wrap = (t: THREE.Texture, srgb: boolean) => {
        t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rep, rep); t.anisotropy = 8;
        t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.needsUpdate = true; return t;
      };
      const diff = wrap(new THREE.Texture(di), true);
      const detail = analyse(di, true).detail;
      const nor = ni ? wrap(new THREE.Texture(ni), false) : null;
      const rough = ri ? wrap(new THREE.Texture(ri), false) : null;
      const roughMean = ri ? Math.max(0.05, Math.sqrt(analyse(ri, false).mean)) : 1;
      const photo: Photo = { diff, detail: detail ? wrap(detail, false) : diff, nor, rough, roughMean, tileM: e.tileM };
      loaded.set(id, photo);
      return photo;
    }).catch(() => null);
    photos.set(id, p);
  }
  return p;
}

// ---- Materials -------------------------------------------------------------------------------

type Mat = THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial;
interface Entry { mat: Mat; id: MaterialId; color?: string; opts: MaterialOptions }
const cache = new Map<string, Entry>();

const linearOf = (hex: string) => new THREE.Color(hex); // THREE.Color stores linear values (ColorManagement on).

function applyMaps(e: Entry) {
  const { mat, id, color } = e;
  const def = MATERIAL_DEFS[id];
  const photo = loaded.get(id);
  const p = photo ? null : proc(def.kind, def.tileM);
  const tinted = !!color || !def.natural;
  const base = linearOf(color ?? def.color);
  if (photo) {
    if (tinted) { mat.map = photo.detail; mat.color.copy(base).multiplyScalar(1 / DETAIL_MEAN); }
    else { mat.map = photo.diff; mat.color.set(def.photoTint ?? '#ffffff'); }
    mat.normalMap = photo.nor;
    mat.roughnessMap = photo.rough;
    mat.roughness = photo.rough ? Math.min(1, def.rough / photo.roughMean) : def.rough;
  } else {
    mat.map = p?.detail ?? null;
    mat.color.copy(base).multiplyScalar(p ? 1 / DETAIL_MEAN : 1);
    mat.normalMap = p?.normal ?? null;
    mat.roughnessMap = null;
    mat.roughness = def.rough;
  }
  const ns = def.normal ?? 0.4;
  mat.normalScale.set(ns, ns);
  if (ns <= 0) mat.normalMap = null;
  // Metals keep their exact colour; a detail map would only add grime.
  if (def.kind === 'metal') { mat.map = null; mat.color.copy(base); }
  if (mat instanceof THREE.MeshPhysicalMaterial && def.sheen) {
    mat.sheenColor.copy(base).lerp(new THREE.Color('#ffffff'), 0.35);
  }
  mat.needsUpdate = true;
}

/**
 * A cached PBR material for a part. Photo textures load lazily (when listed in the manifest);
 * until then, and for materials without photos, procedural detail and normal maps are used.
 * Materials are shared: never dispose them.
 */
export function materialFor(id: MaterialId, color?: string, opts: MaterialOptions = {}): Mat {
  const def = MATERIAL_DEFS[id] ?? MATERIAL_DEFS.oak;
  const mid = (MATERIAL_DEFS[id] ? id : 'oak') as MaterialId;
  const key = `${mid}|${color ?? ''}|${opts.ghost ? 'g' : ''}${opts.selected ? 's' : ''}`;
  const hit = cache.get(key);
  if (hit) return hit.mat;
  const physical = !!(def.sheen || def.clearcoat || def.kind === 'glass');
  const mat: Mat = physical ? new THREE.MeshPhysicalMaterial() : new THREE.MeshStandardMaterial();
  mat.name = `forge:${key}`;
  mat.metalness = def.metal;
  mat.roughness = def.rough;
  if (mat instanceof THREE.MeshPhysicalMaterial) {
    if (def.sheen) { mat.sheen = def.sheen; mat.sheenRoughness = 0.45; }
    if (def.clearcoat) { mat.clearcoat = def.clearcoat; mat.clearcoatRoughness = def.kind === 'stone' ? 0.15 : 0.35; }
    if (def.kind === 'glass') { mat.ior = 1.5; mat.specularIntensity = 1; mat.transparent = true; mat.opacity = def.opacity ?? 0.3; mat.depthWrite = false; mat.envMapIntensity = 1.4; }
  }
  if (def.kind === 'metal') mat.envMapIntensity = 1.15;
  if (opts.ghost) { mat.transparent = true; mat.opacity = Math.min(mat.opacity, 0.35); mat.depthWrite = false; }
  if (opts.selected) { mat.emissive = new THREE.Color('#4da3ff'); mat.emissiveIntensity = 0.22; }
  const entry: Entry = { mat, id: mid, color, opts };
  cache.set(key, entry);
  applyMaps(entry);
  if (!loaded.has(mid)) void loadPhoto(mid).then((photo) => { if (photo) for (const e of cache.values()) if (e.id === mid) applyMaps(e); });
  return mat;
}

/** Resolves once every photo texture listed in the manifest has loaded (or failed). */
export function preloadMaterials(ids: readonly MaterialId[] = Object.keys(MATERIAL_DEFS) as MaterialId[]): Promise<void> {
  return Promise.all(ids.map((id) => loadPhoto(id))).then(() => undefined);
}

/** The colour a part reads as in flat drawings (2D plan, swatches). */
export function swatchColor(id: MaterialId, color?: string): string {
  return color ?? MATERIAL_DEFS[id]?.color ?? '#999999';
}
