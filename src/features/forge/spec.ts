// Turning a model's loose JSON into a clean ObjectSpec, plus the geometry helpers every other
// forge module shares (part bounds, footprint).
//
// Local frame: metres, origin at the floor centre of the footprint, +y up, front faces +z.
import * as THREE from 'three';
import type { MaterialId, ObjectMotion, ObjectPart, ObjectRole, ObjectSemantics, ObjectSpec, PartShape } from '../../core/types';

export const PART_SHAPES: readonly PartShape[] = ['box', 'rounded', 'cylinder', 'cone', 'sphere', 'cushion', 'leg', 'panel', 'tube', 'extrude', 'lathe'];

export const MATERIAL_IDS: readonly MaterialId[] = [
  'oak', 'walnut', 'pine', 'birch', 'white-laminate', 'black-laminate',
  'black-metal', 'steel', 'brass', 'chrome',
  'fabric', 'linen', 'velvet', 'leather', 'wool',
  'glass', 'marble', 'concrete', 'plastic', 'mattress', 'rattan', 'ceramic', 'plant',
];

export const MIN_PART = 0.004;
export const MAX_PARTS = 80;
const MAX_DIM = 8;

const ROLES: readonly ObjectRole[] = ['seating', 'surface', 'storage', 'sleeping', 'decor', 'lighting', 'appliance', 'divider', 'floor'];
const FACES = ['room', 'window', 'screen', 'table', 'none'] as const;

/** Gemini `responseSchema` for one object: name, category, parts[], semantics. */
export const SPEC_JSON_SCHEMA = {
  type: 'OBJECT',
  properties: {
    name: { type: 'STRING', description: 'Short product-style name, e.g. "Walnut desk with pedestal".' },
    category: { type: 'STRING', description: 'One lowercase word or hyphenated phrase: desk, sofa, chair, bed, bookshelf, table, armchair, lamp, cabinet...' },
    parts: {
      type: 'ARRAY',
      description: 'Between 12 and 40 parts. Metres. Origin at the floor centre of the footprint, +y up, front faces +z. Lowest part touches y=0. Parts must touch each other (no floating pieces).',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          shape: { type: 'STRING', enum: [...PART_SHAPES], description: 'box: sharp block. rounded: block with radius. panel: thin board. leg: tapered post (long axis is the taper). tube: round bar along its longest axis. cylinder/cone: round along y (cone radius = top radius). sphere: ellipsoid. cushion: soft upholstered pad. extrude: the closed 2D outline in profile (x, y) extruded along z, scaled to size (arched or heart headboards, scalloped panels). lathe: profile of [radius, height] points revolved around y, scaled to size (vases, shades, turned legs, stool seats).' },
          size: { type: 'ARRAY', items: { type: 'NUMBER' }, minItems: 3, maxItems: 3, description: 'Full extents [x, y, z] in metres before rotation.' },
          pos: { type: 'ARRAY', items: { type: 'NUMBER' }, minItems: 3, maxItems: 3, description: 'Centre [x, y, z] in metres.' },
          rot: { type: 'ARRAY', items: { type: 'NUMBER' }, minItems: 3, maxItems: 3, nullable: true, description: 'Euler XYZ rotation in radians. Omit when not rotated.' },
          radius: { type: 'NUMBER', nullable: true, description: 'Corner radius in metres for rounded parts; top radius for cones.' },
          material: { type: 'STRING', enum: [...MATERIAL_IDS] },
          color: { type: 'STRING', nullable: true, description: 'Optional exact hex colour like #2f5d3a. Shown exactly as given.' },
          profile: { type: 'ARRAY', nullable: true, items: { type: 'ARRAY', items: { type: 'NUMBER' }, minItems: 2, maxItems: 2 }, description: 'Only for extrude and lathe: 2D points in metres, 4 to 64 of them.' },
          group: { type: 'STRING', nullable: true, description: 'Name of a moving group (a drawer, door or fold-down platform). Omit for fixed parts.' },
        },
        required: ['name', 'shape', 'size', 'pos', 'material'],
        propertyOrdering: ['name', 'shape', 'size', 'pos', 'rot', 'radius', 'material', 'color', 'profile', 'group'],
      },
    },
    motions: {
      type: 'ARRAY',
      nullable: true,
      description: 'Optional moving groups. Parts are authored closed. Hinge: pivot point on the axis, open angle in radians. Slide: axis is the direction, open in metres.',
      items: {
        type: 'OBJECT',
        properties: {
          group: { type: 'STRING' },
          label: { type: 'STRING' },
          kind: { type: 'STRING', enum: ['hinge', 'slide'] },
          pivot: { type: 'ARRAY', items: { type: 'NUMBER' }, minItems: 3, maxItems: 3, nullable: true },
          axis: { type: 'ARRAY', items: { type: 'NUMBER' }, minItems: 3, maxItems: 3 },
          open: { type: 'NUMBER' },
        },
        required: ['group', 'label', 'kind', 'axis', 'open'],
      },
    },
    semantics: {
      type: 'OBJECT',
      properties: {
        category: { type: 'STRING' },
        role: { type: 'STRING', enum: [...ROLES] },
        wallBacked: { type: 'BOOLEAN' },
        frontClearanceM: { type: 'NUMBER' },
        sideClearanceM: { type: 'NUMBER' },
        pairsWith: { type: 'ARRAY', items: { type: 'STRING' } },
        faces: { type: 'STRING', enum: [...FACES] },
        tall: { type: 'BOOLEAN' },
        description: { type: 'STRING' },
      },
      required: ['category', 'role', 'wallBacked', 'frontClearanceM', 'sideClearanceM', 'pairsWith', 'faces', 'description'],
    },
  },
  required: ['name', 'category', 'parts', 'semantics'],
  propertyOrdering: ['name', 'category', 'parts', 'motions', 'semantics'],
} as const;

// ---- Geometry helpers ------------------------------------------------------------------

export interface Bounds { min: [number, number, number]; max: [number, number, number] }

const ROUND: ReadonlySet<PartShape> = new Set(['cylinder', 'cone', 'tube', 'lathe']);
const _m = new THREE.Matrix4(), _e = new THREE.Euler(), _q = new THREE.Quaternion();

/** Rotation matrix columns (local x, y, z axes in object space), row-major 3x3. */
export function rotMatrix(rot?: [number, number, number]): number[] {
  if (!rot || (!rot[0] && !rot[1] && !rot[2])) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  _e.set(rot[0], rot[1], rot[2], 'XYZ');
  _m.makeRotationFromQuaternion(_q.setFromEuler(_e));
  const e = _m.elements; // column-major
  return [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]];
}

/** Index of the longest of three numbers. */
export const longestAxis = (s: readonly number[]) => (s[0] >= s[1] && s[0] >= s[2] ? 0 : s[1] >= s[2] ? 1 : 2);

/** Top radius of a cone as a fraction-free value in metres. */
export function coneTopRadius(p: ObjectPart): number {
  const rb = Math.max(p.size[0], p.size[2]) / 2;
  return p.radius != null && Number.isFinite(p.radius) ? Math.max(0, Math.min(p.radius, rb * 2)) : rb * 0.5;
}

/** Exact axis-aligned bounds of a part, rotation and round shapes included. */
export function partBounds(p: ObjectPart): Bounds {
  const R = rotMatrix(p.rot), [sx, sy, sz] = p.size;
  const ext = [0, 0, 0];
  if (ROUND.has(p.shape)) {
    // A round solid along axis a: two elliptical rims. Extent of an ellipse with half-axis
    // vectors u, v along world axis i is sqrt(u_i^2 + v_i^2).
    const a = p.shape === 'tube' ? longestAxis(p.size) : 1;
    const b = (a + 1) % 3, c = (a + 2) % 3;
    const half = p.size[a] / 2;
    const rb = p.size[b] / 2, rc = p.size[c] / 2;
    let topScale = 1;
    if (p.shape === 'cone') topScale = coneTopRadius(p) / Math.max(1e-6, Math.max(rb, rc));
    const rimScale = Math.max(1, topScale);
    for (let i = 0; i < 3; i++) {
      const ax = R[i * 3 + a], bx = R[i * 3 + b], cx = R[i * 3 + c];
      ext[i] = Math.abs(ax) * half + rimScale * Math.hypot(bx * rb, cx * rc);
    }
  } else if (p.shape === 'sphere') {
    for (let i = 0; i < 3; i++) ext[i] = Math.hypot(R[i * 3] * sx / 2, R[i * 3 + 1] * sy / 2, R[i * 3 + 2] * sz / 2);
  } else {
    for (let i = 0; i < 3; i++) ext[i] = Math.abs(R[i * 3]) * sx / 2 + Math.abs(R[i * 3 + 1]) * sy / 2 + Math.abs(R[i * 3 + 2]) * sz / 2;
  }
  return {
    min: [p.pos[0] - ext[0], p.pos[1] - ext[1], p.pos[2] - ext[2]],
    max: [p.pos[0] + ext[0], p.pos[1] + ext[1], p.pos[2] + ext[2]],
  };
}

export function partsBounds(parts: readonly ObjectPart[]): Bounds {
  const b: Bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const p of parts) {
    const pb = partBounds(p);
    for (let i = 0; i < 3; i++) { b.min[i] = Math.min(b.min[i], pb.min[i]); b.max[i] = Math.max(b.max[i], pb.max[i]); }
  }
  if (!parts.length) return { min: [0, 0, 0], max: [0, 0, 0] };
  return b;
}

export interface Footprint { w: number; d: number; h: number; minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }

/** Actual extents of the parts (which may differ from `spec.size` before fitting). */
export function specFootprint(spec: Pick<ObjectSpec, 'parts'>): Footprint {
  const b = partsBounds(spec.parts);
  return {
    w: b.max[0] - b.min[0], h: b.max[1] - b.min[1], d: b.max[2] - b.min[2],
    minX: b.min[0], maxX: b.max[0], minY: b.min[1], maxY: b.max[1], minZ: b.min[2], maxZ: b.max[2],
  };
}

// ---- Semantics defaults by category ------------------------------------------------------

type SemDefaults = Omit<ObjectSemantics, 'category' | 'tall' | 'description'>;
const sem = (role: ObjectRole, wallBacked: boolean, front: number, side: number, faces: ObjectSemantics['faces'], pairsWith: string[] = []): SemDefaults =>
  ({ role, wallBacked, frontClearanceM: front, sideClearanceM: side, faces, pairsWith });

const CATEGORY_RULES: Array<[RegExp, string, SemDefaults]> = [
  [/sofa|couch|settee|loveseat|sectional/, 'sofa', sem('seating', true, 0.8, 0.1, 'screen', ['coffee-table', 'rug', 'tv-unit', 'lamp'])],
  [/armchair|lounge ?chair|recliner|wing ?chair/, 'armchair', sem('seating', false, 0.7, 0.1, 'room', ['coffee-table', 'lamp', 'side-table'])],
  [/office ?chair|desk ?chair|task ?chair/, 'office-chair', sem('seating', false, 0.6, 0.1, 'table', ['desk'])],
  [/stool/, 'stool', sem('seating', false, 0.5, 0.1, 'table', ['counter', 'table'])],
  [/bench/, 'bench', sem('seating', false, 0.6, 0.1, 'none', ['table'])],
  [/chair|seat/, 'chair', sem('seating', false, 0.6, 0.1, 'table', ['table', 'desk'])],
  [/bunk/, 'bunk-bed', sem('sleeping', true, 0.7, 0.3, 'room', ['nightstand'])],
  [/crib|cot/, 'crib', sem('sleeping', true, 0.6, 0.2, 'room')],
  [/bed|mattress/, 'bed', sem('sleeping', true, 0.7, 0.6, 'room', ['nightstand', 'lamp'])],
  [/night ?stand|bedside/, 'nightstand', sem('storage', true, 0.4, 0.05, 'room', ['bed'])],
  [/desk|workstation/, 'desk', sem('surface', true, 0.9, 0.1, 'window', ['office-chair', 'chair', 'lamp'])],
  [/coffee ?table/, 'coffee-table', sem('surface', false, 0.45, 0.3, 'none', ['sofa', 'armchair', 'rug'])],
  [/side ?table|end ?table/, 'side-table', sem('surface', false, 0.2, 0.05, 'none', ['sofa', 'armchair', 'bed'])],
  [/table/, 'table', sem('surface', false, 0.8, 0.8, 'none', ['chair'])],
  [/counter|island/, 'counter', sem('surface', true, 1.0, 0.1, 'room', ['stool'])],
  [/book ?(case|shelf)|shelf|shelving|etagere/, 'bookshelf', sem('storage', true, 0.6, 0.05, 'room')],
  [/wardrobe|closet|armoire/, 'wardrobe', sem('storage', true, 0.9, 0.05, 'room', ['bed'])],
  [/dresser|chest|drawers/, 'dresser', sem('storage', true, 0.8, 0.05, 'room', ['bed'])],
  [/tv|media|console/, 'tv-unit', sem('storage', true, 0.5, 0.05, 'room', ['sofa'])],
  [/sideboard|buffet|credenza|cabinet|cupboard|locker|storage/, 'cabinet', sem('storage', true, 0.7, 0.05, 'room')],
  [/lamp|light|sconce|lantern/, 'lamp', sem('lighting', false, 0.1, 0.05, 'none', ['sofa', 'armchair', 'desk', 'bed'])],
  [/plant|tree|planter|fern|ficus|monstera/, 'plant', sem('decor', false, 0.1, 0.05, 'none')],
  [/rug|carpet|mat\b/, 'rug', sem('floor', false, 0, 0, 'none', ['sofa', 'coffee-table'])],
  [/divider|screen|partition/, 'room-divider', sem('divider', false, 0.2, 0.05, 'none')],
  [/fridge|refrigerator|oven|washer|dryer|dishwasher|stove|appliance/, 'appliance', sem('appliance', true, 0.9, 0.05, 'room')],
  [/piano/, 'piano', sem('decor', true, 0.9, 0.1, 'room', ['stool'])],
];

/** Canonical category and default semantics for a free-text category or name. */
export function categoryDefaults(text: string): { category: string; defaults: SemDefaults } {
  const t = text.toLowerCase();
  for (const [re, category, defaults] of CATEGORY_RULES) if (re.test(t)) return { category, defaults };
  const slug = t.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'object';
  return { category: slug, defaults: sem('decor', false, 0.5, 0.1, 'none') };
}

// ---- Coercion ------------------------------------------------------------------------------

const SHAPE_ALIASES: Record<string, PartShape> = {
  cube: 'box', block: 'box', cuboid: 'box', slab: 'box',
  roundedbox: 'rounded', rounded_box: 'rounded', 'rounded-box': 'rounded', roundbox: 'rounded', bevel: 'rounded', beveled: 'rounded',
  cyl: 'cylinder', disc: 'cylinder', disk: 'cylinder', round: 'cylinder', puck: 'cylinder',
  ball: 'sphere', ellipsoid: 'sphere', dome: 'sphere',
  pillow: 'cushion', pad: 'cushion', upholstery: 'cushion', mattress: 'cushion',
  post: 'leg', foot: 'leg', feet: 'leg', column: 'leg',
  board: 'panel', plate: 'panel', sheet: 'panel', shelf: 'panel',
  rod: 'tube', pipe: 'tube', bar: 'tube', rail: 'tube',
  frustum: 'cone', shade: 'cone',
};

const MATERIAL_RULES: Array<[RegExp, MaterialId]> = [
  [/walnut|teak|mahogany|dark ?wood|cherry|wenge|espresso/, 'walnut'],
  [/birch|maple|ash|beech|light ?wood|plywood/, 'birch'],
  [/pine|spruce|fir|bamboo/, 'pine'],
  [/oak|wood|timber|veneer/, 'oak'],
  [/white.*(lam|lacq|paint|mdf|melamine)|white/, 'white-laminate'],
  [/black.*(lam|lacq|paint|mdf|melamine)/, 'black-laminate'],
  [/laminate|lacquer|mdf|melamine|paint/, 'white-laminate'],
  [/chrome|mirror/, 'chrome'],
  [/brass|gold|bronze|copper/, 'brass'],
  [/steel|alumin|silver|metal ?grey|stainless/, 'steel'],
  [/metal|iron|black/, 'black-metal'],
  [/velvet|velour/, 'velvet'],
  [/leather|suede/, 'leather'],
  [/linen/, 'linen'],
  [/wool|felt|boucle|bouclé/, 'wool'],
  [/fabric|cloth|textile|upholster|cotton|polyester/, 'fabric'],
  [/glass|acrylic/, 'glass'],
  [/marble|stone|granite|quartz|terrazzo/, 'marble'],
  [/concrete|cement/, 'concrete'],
  [/mattress|foam/, 'mattress'],
  [/rattan|wicker|cane|jute|seagrass/, 'rattan'],
  [/ceramic|porcelain|terracotta|clay/, 'ceramic'],
  [/plant|leaf|leaves|foliage|green(ery)?$/, 'plant'],
  [/plastic|polyprop|vinyl|resin|rubber/, 'plastic'],
];

export function coerceMaterial(v: unknown, fallback: MaterialId = 'oak'): MaterialId {
  if (typeof v !== 'string') return fallback;
  const t = v.trim().toLowerCase();
  if ((MATERIAL_IDS as readonly string[]).includes(t)) return t as MaterialId;
  for (const [re, id] of MATERIAL_RULES) if (re.test(t)) return id;
  return fallback;
}

export function coerceShape(v: unknown): PartShape | null {
  if (typeof v !== 'string') return null;
  const t = v.trim().toLowerCase();
  if ((PART_SHAPES as readonly string[]).includes(t)) return t as PartShape;
  return SHAPE_ALIASES[t.replace(/\s+/g, '')] ?? SHAPE_ALIASES[t] ?? null;
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

function vec3(v: unknown): [number, number, number] | null {
  if (Array.isArray(v) && v.length >= 3) {
    const a = num(v[0]), b = num(v[1]), c = num(v[2]);
    return a != null && b != null && c != null ? [a, b, c] : null;
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const a = num(o.x ?? o.w), b = num(o.y ?? o.h), c = num(o.z ?? o.d);
    return a != null && b != null && c != null ? [a, b, c] : null;
  }
  return null;
}

export function coerceColor(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (/^#[0-9a-f]{6}$/i.test(t)) return t.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(t)) return ('#' + t.slice(1).split('').map((c) => c + c).join('')).toLowerCase();
  if (/^[0-9a-f]{6}$/i.test(t)) return '#' + t.toLowerCase();
  return undefined;
}

const r4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * Coerce one raw part. Returns null for anything that cannot be drawn.
 * `unit` converts the model's numbers to metres (1 when already metres, 0.01 for centimetres).
 */
export function coercePart(raw: unknown, unit = 1, fallbackMaterial: MaterialId = 'oak'): ObjectPart | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const shape = coerceShape(o.shape ?? o.type) ?? 'box';
  const size = vec3(o.size ?? o.dims ?? o.dimensions), pos = vec3(o.pos ?? o.position ?? o.center);
  if (!size || !pos) return null;
  const s = size.map((v) => Math.abs(v) * unit);
  if (s.some((v) => v < 1e-4) || s.some((v) => v > MAX_DIM)) {
    if (s.some((v) => v > MAX_DIM)) return null;
  }
  const part: ObjectPart = {
    name: typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 60) : shape,
    shape,
    size: s.map((v) => r4(Math.max(MIN_PART, v))) as [number, number, number],
    pos: pos.map((v) => r4(v * unit)) as [number, number, number],
    material: coerceMaterial(o.material, fallbackMaterial),
  };
  if (part.pos.some((v) => Math.abs(v) > MAX_DIM)) return null;
  const rot = vec3(o.rot ?? o.rotation);
  if (rot && rot.some((v) => v !== 0)) {
    // Degrees slipped in: anything beyond a full turn is read as degrees.
    const deg = rot.some((v) => Math.abs(v) > Math.PI * 2 + 0.01);
    part.rot = rot.map((v) => r4(deg ? (v * Math.PI) / 180 : v)) as [number, number, number];
  }
  const radius = num(o.radius);
  if (radius != null && radius > 0) part.radius = r4(radius * unit);
  const color = coerceColor(o.color);
  if (color) part.color = color;
  if (shape === 'extrude' || shape === 'lathe') {
    const prof = coerceProfile(o.profile ?? o.outline ?? o.points, shape === 'lathe');
    if (prof) part.profile = prof;
    else part.shape = shape === 'lathe' ? 'cylinder' : 'rounded';
  }
  const group = str(o.group, 40);
  if (group) part.group = group;
  return part;
}

/** A usable 2D outline: 3..128 finite points with some area (lathe radii are made non-negative). */
export function coerceProfile(v: unknown, lathe = false): Array<[number, number]> | undefined {
  if (!Array.isArray(v)) return undefined;
  const pts: Array<[number, number]> = [];
  for (const q of v.slice(0, 128)) {
    const rec = q && typeof q === 'object' && !Array.isArray(q) ? (q as Record<string, unknown>) : null;
    const a = Array.isArray(q) ? q : rec ? [rec.x ?? rec.r, rec.y ?? rec.h] : null;
    if (!a) continue;
    const x = num(a[0]), y = num(a[1]);
    if (x == null || y == null) continue;
    const pt: [number, number] = [r4(lathe ? Math.abs(x) : x), r4(y)];
    const last = pts[pts.length - 1];
    if (!last || Math.abs(last[0] - pt[0]) > 1e-6 || Math.abs(last[1] - pt[1]) > 1e-6) pts.push(pt);
  }
  if (pts.length < (lathe ? 2 : 3)) return undefined;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const spanX = Math.max(...xs) - Math.min(...xs), spanY = Math.max(...ys) - Math.min(...ys);
  if (spanY < 1e-5 || (!lathe && spanX < 1e-5) || (lathe && Math.max(...xs) < 1e-5)) return undefined;
  return pts;
}

/** Coerce motions, keeping only those whose group exists among the parts. */
export function coerceMotions(v: unknown, parts: readonly ObjectPart[], unit = 1): ObjectMotion[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const groups = new Set(parts.map((p) => p.group).filter(Boolean));
  const out: ObjectMotion[] = [];
  for (const m of v.slice(0, 12)) {
    if (!m || typeof m !== 'object') continue;
    const o = m as Record<string, unknown>;
    const group = str(o.group, 40);
    if (!group || !groups.has(group)) continue;
    const kind = o.kind === 'slide' ? 'slide' : 'hinge';
    const axis = vec3(o.axis);
    const len = axis ? Math.hypot(...axis) : 0;
    if (!axis || len < 1e-6) continue;
    let open = num(o.open) ?? (kind === 'hinge' ? Math.PI / 2 : 0.4);
    if (kind === 'hinge' && Math.abs(open) > Math.PI * 2 + 0.01) open = (open * Math.PI) / 180;
    if (kind === 'slide') open *= unit;
    open = kind === 'hinge' ? Math.max(-Math.PI, Math.min(Math.PI, open)) : Math.max(-2.5, Math.min(2.5, open));
    const motion: ObjectMotion = { group, label: str(o.label, 40) ?? group, kind, axis: axis.map((x) => r4(x / len)) as [number, number, number], open: r4(open) };
    if (kind === 'hinge') {
      const pivot = vec3(o.pivot);
      if (!pivot) continue;
      motion.pivot = pivot.map((x) => r4(x * unit)) as [number, number, number];
    }
    out.push(motion);
  }
  return out.length ? out : undefined;
}

/** Parts posed with every motion at `t` (0 closed .. 1 open). */
export function posedParts(spec: Pick<ObjectSpec, 'parts' | 'motions'>, t: number): ObjectPart[] {
  if (!spec.motions?.length || t <= 0) return spec.parts;
  const byGroup = new Map(spec.motions.map((m) => [m.group, m]));
  const v = new THREE.Vector3(), q = new THREE.Quaternion(), pq = new THREE.Quaternion(), e = new THREE.Euler(), ax = new THREE.Vector3();
  return spec.parts.map((p) => {
    const m = p.group ? byGroup.get(p.group) : undefined;
    if (!m) return p;
    ax.set(...m.axis);
    if (m.kind === 'slide') {
      const k = m.open * t;
      return { ...p, pos: [p.pos[0] + ax.x * k, p.pos[1] + ax.y * k, p.pos[2] + ax.z * k] };
    }
    const pv = m.pivot ?? [0, 0, 0];
    q.setFromAxisAngle(ax, m.open * t);
    v.set(p.pos[0] - pv[0], p.pos[1] - pv[1], p.pos[2] - pv[2]).applyQuaternion(q);
    pq.setFromEuler(e.set(...(p.rot ?? [0, 0, 0]), 'XYZ'));
    e.setFromQuaternion(pq.premultiply(q), 'XYZ');
    return { ...p, pos: [v.x + pv[0], v.y + pv[1], v.z + pv[2]], rot: [e.x, e.y, e.z] };
  });
}

/** Footprint when fully open, or undefined when nothing moves. */
export function openFootprint(spec: Pick<ObjectSpec, 'parts' | 'motions'>): Footprint | undefined {
  if (!spec.motions?.length) return undefined;
  return specFootprint({ parts: posedParts(spec, 1) });
}

/** Recompute `openSize` from the motions (call after anything moves or rescales parts). */
export function withOpenSize(spec: ObjectSpec): ObjectSpec {
  const of = openFootprint(spec);
  if (!of) { if (!spec.openSize) return spec; const { openSize: _o, ...rest } = spec; return rest; }
  return { ...spec, openSize: { w: r4(of.w), d: r4(of.d), h: r4(of.h) } };
}

function str(v: unknown, max = 200): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
}

let seq = 0;
const newId = () => `obj-${Date.now().toString(36)}-${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Fill semantics from the category, keeping any valid fields the model supplied. */
export function normalizeSemantics(raw: unknown, categoryText: string, name: string, h: number): ObjectSemantics {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const { category, defaults } = categoryDefaults(str(o.category) ?? (categoryText || name));
  const role = ROLES.includes(o.role as ObjectRole) ? (o.role as ObjectRole) : defaults.role;
  const faces = (FACES as readonly string[]).includes(o.faces as string) ? (o.faces as ObjectSemantics['faces']) : defaults.faces;
  const clamp = (v: unknown, d: number, max: number) => { const n = num(v); return n == null ? d : Math.max(0, Math.min(max, n)); };
  const pairs = Array.isArray(o.pairsWith) ? o.pairsWith.filter((x): x is string => typeof x === 'string').map((x) => categoryDefaults(x).category).slice(0, 8) : defaults.pairsWith;
  return {
    category,
    role,
    wallBacked: typeof o.wallBacked === 'boolean' ? o.wallBacked : defaults.wallBacked,
    frontClearanceM: clamp(o.frontClearanceM, defaults.frontClearanceM, 2),
    sideClearanceM: clamp(o.sideClearanceM, defaults.sideClearanceM, 1.5),
    pairsWith: [...new Set(pairs)],
    faces,
    tall: h > 1.2,
    description: str(o.description, 240) ?? `${name}.`,
  };
}

/**
 * Clean a model's JSON into an ObjectSpec. Drops undrawable parts, maps loose shape and material
 * names, converts centimetres, re-centres the parts on the floor origin and fills semantics.
 * `size` is the requested size (or the parts' own extents when nothing was requested).
 * Run `fitSpec` (or `forgeSpec`) afterwards to make the parts match `size` exactly.
 */
export function normalizeSpec(raw: unknown, want: { w?: number; d?: number; h?: number; name?: string; prompt: string }): ObjectSpec {
  let src: unknown = raw;
  if (typeof src === 'string') {
    const txt = src.replace(/^```(?:json)?\s*|\s*```$/g, '');
    try { src = JSON.parse(txt); } catch { src = {}; }
  }
  const o = (src && typeof src === 'object' ? src : {}) as Record<string, unknown>;
  const rawParts = Array.isArray(o.parts) ? o.parts : [];
  const sem = (o.semantics && typeof o.semantics === 'object' ? o.semantics : {}) as Record<string, unknown>;
  const name = want.name?.trim() || str(o.name, 80) || 'Custom object';
  const catText = str(o.category) ?? str(sem.category) ?? name;

  // Unit guess: furniture parts given in centimetres have extents in the tens.
  const sizes = rawParts.map((p) => vec3((p as Record<string, unknown>)?.size)).filter((v): v is [number, number, number] => !!v);
  const maxExt = sizes.reduce((m, s) => Math.max(m, ...s.map(Math.abs)), 0);
  const unit = maxExt > 12 ? (maxExt > 1200 ? 0.001 : 0.01) : 1;

  const fallbackMat = coerceMaterial(o.material, /sofa|chair|bed|cushion/.test(catText.toLowerCase()) ? 'fabric' : 'oak');
  let parts = rawParts.map((p) => coercePart(p, unit, fallbackMat)).filter((p): p is ObjectPart => !!p).slice(0, MAX_PARTS);

  let motions = coerceMotions(o.motions, parts, unit);
  // Re-centre: footprint centred on x/z, lowest point on the floor.
  if (parts.length) {
    const b = partsBounds(parts);
    const cx = (b.min[0] + b.max[0]) / 2, cz = (b.min[2] + b.max[2]) / 2, y0 = b.min[1];
    if (Math.abs(cx) > 1e-5 || Math.abs(cz) > 1e-5 || Math.abs(y0) > 1e-5) {
      parts = parts.map((p) => ({ ...p, pos: [r4(p.pos[0] - cx), r4(p.pos[1] - y0), r4(p.pos[2] - cz)] }));
      motions = motions?.map((m) => m.pivot ? { ...m, pivot: [r4(m.pivot[0] - cx), r4(m.pivot[1] - y0), r4(m.pivot[2] - cz)] } : m);
    }
  }
  const fp = specFootprint({ parts });
  const rawSize = (o.size && typeof o.size === 'object' ? o.size : {}) as Record<string, unknown>;
  const pick = (w: number | undefined, r: unknown, f: number, dflt: number) => {
    const v = w ?? (num(r) != null ? num(r)! * (num(r)! > 12 ? 0.01 : 1) : undefined) ?? (f > MIN_PART ? f : dflt);
    return r4(Math.max(0.02, Math.min(MAX_DIM, v)));
  };
  const size = {
    w: pick(want.w, rawSize.w, fp.w, 0.6),
    d: pick(want.d, rawSize.d, fp.d, 0.6),
    h: pick(want.h, rawSize.h, fp.h, 0.6),
  };
  const spec: ObjectSpec = {
    id: str(o.id, 60) ?? newId(),
    name,
    prompt: want.prompt,
    size,
    parts,
    semantics: normalizeSemantics(sem, catText, name, size.h),
    model: str(o.model, 60) ?? 'unknown',
    latencyMs: num(o.latencyMs) ?? 0,
    createdAt: num(o.createdAt) ?? Date.now(),
  };
  if (motions) spec.motions = motions;
  return withOpenSize(spec);
}
