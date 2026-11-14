// Shared spatial model. All lengths are metres, all angles radians.
// Plan coordinates: x to the right, y "down" on the plan (towards the viewer), origin at the
// top-left of the space. 3D maps plan (x, y) to world (x, 0, y) with height on +Y.

export type Metres = number;
export interface Vec2 { x: number; y: number }

export type SourceKind =
  | 'user-measured' | 'ar-depth' | 'photo-inferred' | 'pdf-annotation'
  | 'manual' | 'catalog' | 'generated' | 'sample';

export type Status = 'verified' | 'estimated' | 'conflicting' | 'unknown';

export interface Evidence {
  id: string;
  kind: 'photo' | 'pdf' | 'image' | 'manual' | 'sample';
  label: string;
  /** Data URL or object URL for the source image / rendered page. */
  imageUrl?: string;
  page?: number;
  /** Normalised 0..1 region within the image or page: [x, y, w, h]. */
  bbox?: [number, number, number, number];
  note?: string;
  createdAt: number;
}

export interface Measurement {
  id: string;
  label: string;
  valueM: Metres;
  sourceKind: SourceKind;
  status: Status;
  /** Half-width of the plausible range, e.g. 0.05 means ±5 cm. */
  toleranceM?: number;
  evidenceIds: string[];
  /** Wall id (`${spaceId}:${wallIndex}`), opening id, or furniture id this measures. */
  targetId?: string;
}

export interface WallMeta {
  thicknessM: Metres;
  sourceKind: SourceKind;
  status: Status;
  measurementId?: string;
}

export interface Space {
  id: string;
  name: string;
  purpose?: string;
  /** Closed polygon, clockwise on screen. Wall i runs from polygon[i] to polygon[i+1]. */
  polygon: Vec2[];
  /** One entry per wall (same length as polygon). */
  walls: WallMeta[];
}

export type OpeningKind = 'door' | 'window' | 'opening';

export interface Opening {
  id: string;
  kind: OpeningKind;
  spaceId: string;
  wallIndex: number;
  /** Distance from polygon[wallIndex] along the wall to the opening's centre. */
  offsetM: Metres;
  widthM: Metres;
  heightM: Metres;
  sillM: Metres;
  swing: 'in' | 'out' | 'none';
  hinge: 'start' | 'end';
  sourceKind: SourceKind;
  status: Status;
  measurementId?: string;
}

export type PriceStatus = 'catalog' | 'estimated' | 'user' | 'owned';

export interface Clearance { front: Metres; back: Metres; left: Metres; right: Metres }

export interface FurnitureItem {
  id: string;
  catalogId: string;
  name: string;
  category: string;
  /** Centre of the footprint. */
  x: Metres;
  y: Metres;
  /** Rotation in radians; 0 means the item's front faces +y (down on the plan). */
  rotation: number;
  w: Metres;
  d: Metres;
  h: Metres;
  /** Use envelope around the footprint (chair pull-out, drawer, door access...). */
  clearance: Clearance;
  /** Depth when unfolded (sofa bed, extendable table). */
  unfoldedD?: Metres;
  locked: boolean;
  owned: boolean;
  priceSek: number;
  priceStatus: PriceStatus;
  color: string;
  material?: string;
  sourceKind: SourceKind;
  /** Present when the object was generated to the person's own description. */
  custom?: ObjectSpec;
  /** Present when the item comes from a real store listing. */
  listing?: StoreListing;
}

export interface StoreListing {
  store: string;
  title: string;
  url: string;
  price: number | null;
  currency: string;
  imageUrl?: string;
  /** Dimensions as stated on the listing, metres, when found. */
  stated?: { w?: number; d?: number; h?: number };
  /** When the listing was read. Prices change; this is not a quote. */
  fetchedAt: number;
}

/** A mark drawn on the plan by the person or the design agent. Coordinates in plan metres. */
export interface SketchMark {
  id: string;
  by: 'you' | 'agent';
  kind: 'stroke' | 'arrow' | 'circle' | 'rect' | 'zone' | 'label' | 'ghost';
  points: Vec2[];
  text?: string;
  color?: string;
  /** For 'ghost': a proposed footprint. */
  w?: number; d?: number; rotation?: number;
  createdAt: number;
}

export interface SpaceModel {
  id: string;
  name: string;
  version: number;
  units: 'm';
  ceilingM: Metres;
  sourceLabel: string;
  spaces: Space[];
  openings: Opening[];
  furniture: FurnitureItem[];
  measurements: Measurement[];
  evidence: Evidence[];
}

export interface RequirementItem { catalogId: string; qty: number; keepExistingId?: string }

export interface Requirements {
  purpose: string;
  people: number;
  budgetSek: number | null;
  items: RequirementItem[];
  /** Keep a clear route from every door to these targets. */
  routeTargets: Array<{ kind: 'window' | 'door' | 'opening'; id?: string }>;
  minRouteWidthM: Metres;
  style: string;
  lockedIds: string[];
  notes: string[];
  /** Questions the compiler could not resolve on its own. */
  questions: string[];
  compiledBy: 'gemini' | 'rules';
}

export type CheckResult = 'pass' | 'fail' | 'unknown';

export interface ValidationResult {
  id: string;
  rule: string;
  result: CheckResult;
  measured?: number;
  threshold?: number;
  subjectIds: string[];
  details: string;
}

export interface LayoutCandidate {
  id: string;
  name: string;
  summary: string;
  parentVersion: number;
  furniture: FurnitureItem[];
  metrics: { openAreaM2: number; costSek: number; minClearanceM: number | null; routeLenM: number | null; score: number };
  checks: ValidationResult[];
  assumptions: string[];
  generator: string;
}

export interface Infeasibility {
  reasons: string[];
  relaxations: Array<{ label: string; patch: Partial<Requirements> }>;
}

export type BodyProfileId = 'adult' | 'child' | 'wheelchair' | 'stroller' | 'cart';

export interface RouteResult {
  id: string;
  profile: BodyProfileId;
  points: Vec2[];
  ok: boolean;
  lengthM: number | null;
  narrowestM: number | null;
  narrowestAt?: Vec2;
  label: string;
}

export interface PassagePose { x: number; y: number; rotation: number }

export interface PassageResult {
  itemId: string;
  ok: boolean;
  poses: PassagePose[];
  blockedAt?: Vec2;
  details: string;
}

export interface HeatGrid { origin: Vec2; cellM: number; cols: number; rows: number; values: number[] }

export interface Highlight { ids: string[]; color: string; label: string }

export interface Analysis {
  version: number;
  routes: RouteResult[];
  passage: PassageResult | null;
  heat: HeatGrid | null;
  sightlines: Array<{ a: Vec2; b: Vec2; visible: boolean }>;
  highlights: Highlight[];
}

export type Op =
  | { type: 'REPLACE_MODEL'; model: SpaceModel }
  | { type: 'SET_WALL_LENGTH'; spaceId: string; wallIndex: number; lengthM: number; sourceKind?: SourceKind }
  | { type: 'MOVE_VERTEX'; spaceId: string; index: number; to: Vec2 }
  | { type: 'INSERT_VERTEX'; spaceId: string; afterIndex: number; at: Vec2 }
  | { type: 'REMOVE_VERTEX'; spaceId: string; index: number }
  | { type: 'SET_CEILING'; heightM: number }
  | { type: 'ADD_OPENING'; opening: Opening }
  | { type: 'UPDATE_OPENING'; id: string; patch: Partial<Opening> }
  | { type: 'REMOVE_OPENING'; id: string }
  | { type: 'PLACE_OBJECT'; item: FurnitureItem }
  | { type: 'UPDATE_OBJECT'; id: string; patch: Partial<FurnitureItem> }
  | { type: 'REMOVE_OBJECT'; id: string }
  | { type: 'SET_FURNITURE'; items: FurnitureItem[]; label?: string }
  | { type: 'ADD_EVIDENCE'; evidence: Evidence }
  | { type: 'SET_MEASUREMENT'; measurement: Measurement }
  | { type: 'RENAME'; name: string };

export interface Selection { kind: 'wall' | 'opening' | 'furniture' | 'space' | 'vertex' | 'measurement'; id: string }

export type Mode = 'home' | 'capture' | 'design' | 'experience' | 'deliver';

export interface Settings {
  geminiKey: string;
  geminiModel: string;
  theme: 'dark' | 'light' | 'system';
}

export interface Layers {
  dimensions: boolean;
  clearance: boolean;
  routes: boolean;
  provenance: boolean;
  heat: boolean;
  sightlines: boolean;
}

// ---- Generated objects -------------------------------------------------------------------
// A custom object is a list of parts in local metres: origin at the floor centre of the
// footprint, +y up, front faces +z. The bounding box of all parts equals `size` exactly.

export type PartShape = 'box' | 'rounded' | 'cylinder' | 'cone' | 'sphere' | 'cushion' | 'leg' | 'panel' | 'tube' | 'extrude' | 'lathe';

export type MaterialId =
  | 'oak' | 'walnut' | 'pine' | 'birch' | 'white-laminate' | 'black-laminate'
  | 'black-metal' | 'steel' | 'brass' | 'chrome'
  | 'fabric' | 'linen' | 'velvet' | 'leather' | 'wool'
  | 'glass' | 'marble' | 'concrete' | 'plastic' | 'mattress' | 'rattan' | 'ceramic' | 'plant';

export interface ObjectPart {
  name: string;
  shape: PartShape;
  /** Full extents [x, y, z] in metres before rotation. */
  size: [number, number, number];
  /** Centre position [x, y, z] in metres. */
  pos: [number, number, number];
  /** Euler rotation in radians, optional. */
  rot?: [number, number, number];
  /** Corner radius for rounded parts, metres. */
  radius?: number;
  material: MaterialId;
  /** Optional tint, hex. */
  color?: string;
  /**
   * 2D outline in metres for 'extrude' (x, y points of a closed shape, extruded along z by size[2])
   * and 'lathe' (radius, height points revolved around the y axis). Lets parts be curved:
   * arched headboards, heart shapes, vases, lamp shades.
   */
  profile?: Array<[number, number]>;
  /** Parts sharing a group move together (a fold-down bed platform, a drawer, a door). */
  group?: string;
}

/** A moving group: how a fold-down bed drops, a drawer slides or a door swings. */
export interface ObjectMotion {
  group: string;
  label: string;
  kind: 'hinge' | 'slide';
  /** Hinge: point on the axis [x, y, z]; slide: unused. */
  pivot?: [number, number, number];
  /** Hinge axis or slide direction, unit vector. */
  axis: [number, number, number];
  /** Radians for a hinge, metres for a slide, at the fully open state. */
  open: number;
}

export type ObjectRole = 'seating' | 'surface' | 'storage' | 'sleeping' | 'decor' | 'lighting' | 'appliance' | 'divider' | 'floor';

/** What an object is and how it wants to be used. Layout rules read this, not the name. */
export interface ObjectSemantics {
  category: string;
  role: ObjectRole;
  /** Wants its back against a wall. */
  wallBacked: boolean;
  /** Free space needed in front / at the sides to use it, metres. */
  frontClearanceM: number;
  sideClearanceM: number;
  /** Categories it should be grouped with (a chair pairs with desk, a nightstand with bed). */
  pairsWith: string[];
  /** What its front should face. */
  faces: 'room' | 'window' | 'screen' | 'table' | 'none';
  /** Taller than 1.2 m: must not block windows or sightlines. */
  tall: boolean;
  /** One plain sentence describing the object. */
  description: string;
}

export interface ObjectSpec {
  id: string;
  name: string;
  /** The words the person used. */
  prompt: string;
  size: { w: number; d: number; h: number };
  parts: ObjectPart[];
  /** Optional moving groups. `size` is the closed state; `openSize` the footprint when open. */
  motions?: ObjectMotion[];
  openSize?: { w: number; d: number; h: number };
  semantics: ObjectSemantics;
  /** Which model produced it, or 'rules'. */
  model: string;
  latencyMs: number;
  createdAt: number;
}

// ---- Design program ----------------------------------------------------------------------
// The planner states intent as relations between named things; the solver finds exact poses.

export type RelationKind =
  | 'against-wall' | 'in-corner' | 'near-window' | 'away-from-door' | 'faces' | 'beside' | 'flanks'
  | 'in-front-of' | 'centered-on' | 'paired-seat' | 'on-rug' | 'apart-from' | 'aligned-with';

export interface Relation {
  kind: RelationKind;
  /** Item id (or requirement ref) the relation is about. */
  subject: string;
  /** Another item id, or 'window', 'door', 'wall:<index>', 'room-centre'. */
  target?: string;
  /** Preferred distance range in metres, when it applies. */
  distanceM?: [number, number];
  /** 0..1, how much it matters. */
  weight: number;
  /** One plain sentence: why. Shown to the person. */
  reason: string;
}

export interface DesignZone { id: string; name: string; purpose: string; itemIds: string[] }

export interface DesignProgram {
  zones: DesignZone[];
  relations: Relation[];
  /** Item the room is organised around. */
  focalItemId?: string;
  notes: string[];
  by: 'gemini' | 'rules';
  model?: string;
  latencyMs?: number;
}

export interface RuleVerdict {
  ruleId: string;
  /** Short human name, e.g. "Walkway width". */
  name: string;
  itemIds: string[];
  /** 0 (broken) .. 1 (ideal). */
  score: number;
  pass: boolean;
  severity: 'hard' | 'strong' | 'preference';
  /** Plain sentence with numbers. */
  message: string;
}

export interface DesignCritique {
  by: string;
  latencyMs: number;
  summary: string;
  decisions: Array<{ itemId: string; verdict: 'keep' | 'change'; reason: string }>;
  /** Score 0..10 from the critic. */
  score: number;
}

/** Extra design data attached to a layout candidate (kept separate so older code is unaffected). */
export interface DesignReport {
  candidateId: string;
  program: DesignProgram;
  verdicts: RuleVerdict[];
  critique?: DesignCritique;
}
