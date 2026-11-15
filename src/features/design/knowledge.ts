// What a room is for decides what goes in it and how the pieces relate. Two halves:
// 1. Room programmes as data: essentials, optional pieces in priority order, how they scale with
//    floor area and people, and pairs that never share a small room.
// 2. Relations with measurable definitions and tolerances, checked on a placed layout. Each one is
//    hard (a professional would never hand it over) or soft (taste and comfort), has a 1-3 word chip
//    for when it holds and when it breaks, and, when broken, a specific repair as data.
import type { FurnitureItem, Relation, SpaceModel } from '../../core/types';
import { catalogEntry } from '../furniture/catalog';
import { overlapDepth, pointInPolygon, segmentsIntersect, type P } from '../referee/geom';
import { analyse, buildRoom, doorPoint, floorGrid, frontOf, rayFree, toPlanOf, widestFrom, type AItem, type FloorGrid, type LayoutCtx, type RoomCtx } from './rules';

// ================================================================ programmes
export type RoomUse =
  | 'bedroom-single' | 'bedroom-double' | 'bedroom-kids' | 'bedroom-guest' | 'living' | 'home-office' | 'studio'
  | 'dining' | 'kitchen-dining' | 'hallway' | 'bathroom' | 'nursery' | 'teen' | 'gaming' | 'reading'
  | 'open-office' | 'meeting' | 'reception' | 'cafe' | 'shop' | 'classroom' | 'clinic-waiting';

/** One line of a programme. `perPeople`: one per that many people (seats, desks). */
export interface ProgrammeLine { id: string; qty?: number; perPeople?: number; plus?: number; why: string }
export interface RoomProgramme {
  use: RoomUse; name: string;
  /** Below this the room cannot work for this use at all. */
  minAreaM2: number;
  /** Default number of people when none is given. */
  people: number;
  /** Floor area each person needs at their seat (caps seats by area). */
  m2PerPerson?: number;
  essentials: ProgrammeLine[];
  /** Highest priority first; area bands decide how many make it in. */
  optional: ProgrammeLine[];
  /** Pieces that never share a room below the given area: the later one in `ids` gives way. */
  neverTogether?: Array<{ belowM2: number; ids: [string, string]; why: string }>;
  /** Swap one piece for another below an area (a double bed for a single). */
  smallSwap?: Array<{ belowM2: number; from: string; to: string; why: string }>;
}

/** How many optional pieces fit, by floor area band. */
export const AREA_BANDS: Array<{ maxM2: number; band: 'tiny' | 'small' | 'medium' | 'large' | 'generous'; optional: number }> = [
  { maxM2: 8, band: 'tiny', optional: 0 },
  { maxM2: 12, band: 'small', optional: 1 },
  { maxM2: 18, band: 'medium', optional: 2 },
  { maxM2: 28, band: 'large', optional: 4 },
  { maxM2: Infinity, band: 'generous', optional: 6 },
];

const L = (id: string, why: string, qty = 1): ProgrammeLine => ({ id, qty, why });
const per = (id: string, perPeople: number, why: string, plus = 0): ProgrammeLine => ({ id, perPeople, plus, why });

export const PROGRAMMES: Record<RoomUse, RoomProgramme> = {
  'bedroom-single': {
    use: 'bedroom-single', name: 'Single bedroom', minAreaM2: 5, people: 1,
    essentials: [L('bed-single', 'Somewhere to sleep'), L('nightstand', 'Lamp and water in reach'), L('wardrobe-100', 'Clothes put away')],
    optional: [L('desk-120', 'A place to work'), L('desk-chair', 'Seat at the desk'), L('dresser', 'Folded clothes'), L('rug-160', 'Soft first step'), L('plant', 'Life by the window')],
    neverTogether: [{ belowM2: 7, ids: ['wardrobe-100', 'desk-120'], why: 'Under 7 m² a wardrobe and a desk leave no floor to dress or pull a chair out' }],
  },
  'bedroom-double': {
    use: 'bedroom-double', name: 'Double bedroom', minAreaM2: 8, people: 2,
    essentials: [L('bed-double', 'Bed for two'), L('nightstand', 'One each side', 2), L('wardrobe-150', 'Clothes for two')],
    optional: [L('dresser', 'Folded clothes'), L('rug-200', 'Soft first step either side'), L('armchair', 'A reading corner'), L('floor-lamp', 'Reading light'), L('plant', 'Life by the window')],
    smallSwap: [{ belowM2: 10, from: 'wardrobe-150', to: 'wardrobe-100', why: 'A narrower wardrobe keeps 60 cm beside the bed' }],
    neverTogether: [{ belowM2: 12, ids: ['dresser', 'armchair'], why: 'A dresser and an armchair crowd the bed sides below 12 m²' }],
  },
  'bedroom-kids': {
    use: 'bedroom-kids', name: "Child's room", minAreaM2: 6, people: 1,
    essentials: [L('bed-single', 'Bed'), L('toy-storage', 'Toys at reach height'), L('rug-160', 'Floor to play on')],
    optional: [L('desk-120', 'Homework'), L('desk-chair', 'Seat at the desk'), L('bookshelf-low', 'Books in reach'), L('wardrobe-100', 'Clothes'), L('play-table', 'Drawing and play')],
    neverTogether: [{ belowM2: 10, ids: ['desk-120', 'play-table'], why: 'Two tables leave no floor to play on in a small room' }],
  },
  'bedroom-guest': {
    use: 'bedroom-guest', name: 'Guest room', minAreaM2: 7, people: 2,
    essentials: [L('bed-double', 'Bed for guests'), L('nightstand', 'Lamp in reach', 2)],
    optional: [L('dresser', 'A place for a suitcase'), L('desk-120', 'Doubles as a study'), L('desk-chair', 'Seat at the desk'), L('rug-200', 'Soft first step'), L('plant', 'A welcome')],
    smallSwap: [{ belowM2: 9, from: 'bed-double', to: 'bed-single', why: 'Below 9 m² a single bed keeps the room usable' }],
  },
  living: {
    use: 'living', name: 'Living room', minAreaM2: 10, people: 3,
    essentials: [L('sofa-3', 'Seats for the household'), L('coffee-table', 'Cups in reach'), L('tv-unit', 'The focal wall')],
    optional: [L('rug-200', 'Ties the group together'), L('armchair', 'Closes the conversation circle'), L('floor-lamp', 'Reading light'), L('bookshelf', 'Books and display'), L('plant', 'Life by the window'), L('armchair', 'A second chair for guests')],
    smallSwap: [{ belowM2: 14, from: 'sofa-3', to: 'sofa-2', why: 'A 2-seat sofa keeps the TV distance and a walkway in a small room' }],
    neverTogether: [{ belowM2: 14, ids: ['bookshelf', 'armchair'], why: 'Below 14 m² an armchair and a bookshelf squeeze the walkway' }],
  },
  'home-office': {
    use: 'home-office', name: 'Home office', minAreaM2: 5, people: 1,
    essentials: [per('desk-140', 1, 'A desk per person'), per('office-chair', 1, 'A chair per desk')],
    optional: [L('bookshelf', 'Files and books'), L('floor-lamp', 'Task light'), L('filing-cabinet', 'Paperwork'), L('plant', 'Life by the window'), L('armchair', 'A reading chair')],
    smallSwap: [{ belowM2: 7, from: 'desk-140', to: 'desk-120', why: 'A 120 cm desk keeps 90 cm to pull the chair back' }],
  },
  studio: {
    use: 'studio', name: 'Studio flat', minAreaM2: 18, people: 1,
    essentials: [L('bed-double', 'Sleeping corner'), L('nightstand', 'Lamp in reach'), L('sofa-2', 'Somewhere to sit'), L('dining-4', 'Eat at a table'), L('chair', 'Seats at the table', 2), L('wardrobe-150', 'Clothes')],
    optional: [L('coffee-table', 'Cups in reach'), L('desk-120', 'Work corner'), L('desk-chair', 'Seat at the desk'), L('rug-200', 'Defines the lounge'), L('plant', 'Life by the window'), L('nightstand', 'Second bedside')],
    smallSwap: [{ belowM2: 22, from: 'bed-double', to: 'bed-single', why: 'Below 22 m² a single bed leaves room to live' }],
    neverTogether: [{ belowM2: 24, ids: ['dining-4', 'desk-120'], why: 'In a small studio the table doubles as the desk' }],
  },
  dining: {
    use: 'dining', name: 'Dining room', minAreaM2: 7, people: 4, m2PerPerson: 1.8,
    essentials: [L('dining-4', 'A table for the household'), per('chair', 1, 'A chair per person')],
    optional: [L('sideboard', 'Plates and linen'), L('rug-200', 'Chairs stay on it when pulled out'), L('plant', 'Life by the window')],
  },
  'kitchen-dining': {
    use: 'kitchen-dining', name: 'Kitchen and dining', minAreaM2: 9, people: 4, m2PerPerson: 2,
    essentials: [L('counter', 'Prep and serving'), L('dining-4', 'Eat together'), per('chair', 1, 'A chair per person')],
    optional: [L('sideboard', 'Plates and linen'), L('kitchen-island', 'Extra prep'), L('bar-stool', 'Seats at the island', 2), L('plant', 'Life by the window')],
    neverTogether: [{ belowM2: 16, ids: ['dining-4', 'kitchen-island'], why: 'An island and a table need 16 m² for aisles round both' }],
  },
  hallway: {
    use: 'hallway', name: 'Hallway', minAreaM2: 2, people: 1,
    essentials: [L('shoe-cabinet', 'Shoes off the floor')],
    optional: [L('shoe-bench', 'Sit to put shoes on'), L('storage-cabinet', 'Coats'), L('plant', 'A welcome')],
  },
  bathroom: {
    use: 'bathroom', name: 'Bathroom', minAreaM2: 2.5, people: 1,
    essentials: [L('toilet', 'WC'), L('washbasin', 'Basin'), L('shower', 'Shower')],
    optional: [L('washing-machine', 'Laundry'), L('bathtub', 'A bath'), L('storage-cabinet', 'Towels')],
    neverTogether: [{ belowM2: 6, ids: ['shower', 'bathtub'], why: 'A shower and a bath need 6 m² with 70 cm in front of each' }],
  },
  nursery: {
    use: 'nursery', name: 'Nursery', minAreaM2: 5, people: 1,
    essentials: [L('crib', 'Safe sleep'), L('dresser', 'Changing top and clothes')],
    optional: [L('armchair', 'Feeding chair'), L('floor-lamp', 'Soft night light'), L('toy-storage', 'Toys'), L('rug-160', 'Floor to play on')],
  },
  teen: {
    use: 'teen', name: 'Teen room', minAreaM2: 7, people: 1,
    essentials: [L('bed-single', 'Bed'), L('desk-120', 'Homework'), L('desk-chair', 'Seat at the desk'), L('wardrobe-100', 'Clothes')],
    optional: [L('bookshelf', 'Books and display'), L('armchair', 'A chair for a friend'), L('rug-160', 'Soft floor'), L('nightstand', 'Lamp in reach')],
  },
  gaming: {
    use: 'gaming', name: 'Gaming room', minAreaM2: 7, people: 2,
    essentials: [L('desk-monitor', 'Wide desk for screens'), L('office-chair', 'Long-session chair'), L('sofa-2', 'Couch play'), L('tv-unit', 'Big screen')],
    optional: [L('bookshelf', 'Games and display'), L('rug-160', 'Quiet floor'), L('floor-lamp', 'Bias light')],
    neverTogether: [{ belowM2: 12, ids: ['desk-monitor', 'sofa-2'], why: 'Below 12 m² a desk setup and a couch both lose their viewing distance' }],
  },
  reading: {
    use: 'reading', name: 'Reading room', minAreaM2: 5, people: 1,
    essentials: [L('armchair', 'A deep chair'), L('floor-lamp', 'Light over the shoulder'), L('bookshelf', 'Books')],
    optional: [L('bookshelf', 'More books'), L('rug-160', 'Warm floor'), L('plant', 'Life by the window'), L('armchair', 'A second chair')],
  },
  'open-office': {
    use: 'open-office', name: 'Open office', minAreaM2: 15, people: 6, m2PerPerson: 6,
    essentials: [per('desk-140', 1, 'A desk per person'), per('office-chair', 1, 'A chair per desk')],
    optional: [L('storage-cabinet', 'Shared storage'), L('office-pod', 'Quiet calls'), L('plant', 'Softens the room'), L('storage-cabinet', 'More storage'), L('plant', 'More green')],
  },
  meeting: {
    use: 'meeting', name: 'Meeting room', minAreaM2: 8, people: 6, m2PerPerson: 2,
    essentials: [L('dining-6', 'Table for the group'), per('chair', 1, 'A chair per person'), L('tv-unit', 'Shared screen')],
    optional: [L('sideboard', 'Coffee and papers'), L('plant', 'Softens the room')],
  },
  reception: {
    use: 'reception', name: 'Reception', minAreaM2: 10, people: 4,
    essentials: [L('reception-desk', 'Greets visitors'), L('office-chair', 'Staff seat'), per('waiting-chair', 2, 'Waiting seats', 0)],
    optional: [L('coffee-table', 'Magazines'), L('plant', 'A welcome'), L('display-shelf', 'Brochures'), L('sofa-2', 'Soft waiting')],
  },
  cafe: {
    use: 'cafe', name: 'Cafe', minAreaM2: 15, people: 16, m2PerPerson: 1.4,
    essentials: [L('counter', 'Service'), per('cafe-4', 4, 'A table per four guests'), per('chair', 1, 'A seat per guest')],
    optional: [L('display-shelf', 'Goods on show'), L('plant', 'Life by the window'), L('plant', 'More green')],
  },
  shop: {
    use: 'shop', name: 'Shop', minAreaM2: 10, people: 1,
    essentials: [L('counter', 'Till'), L('display-shelf', 'Goods', 2)],
    optional: [L('display-shelf', 'More goods'), L('plant', 'A welcome'), L('display-shelf', 'Wall of goods')],
  },
  classroom: {
    use: 'classroom', name: 'Classroom', minAreaM2: 30, people: 20, m2PerPerson: 1.9,
    essentials: [per('desk-120', 2, 'A desk per two pupils'), per('chair', 1, 'A chair per pupil'), L('desk-140', 'Teacher desk'), L('office-chair', 'Teacher chair'), L('tv-unit', 'The board')],
    optional: [L('bookshelf', 'Class library'), L('bookshelf', 'Supplies'), L('plant', 'Life by the window')],
  },
  'clinic-waiting': {
    use: 'clinic-waiting', name: 'Clinic waiting room', minAreaM2: 8, people: 6, m2PerPerson: 1.5,
    essentials: [per('waiting-chair', 1, 'A seat per waiting patient')],
    optional: [L('plant', 'Calm'), L('coffee-table', 'Magazines'), L('reception-desk', 'Check-in'), L('office-chair', 'Staff seat')],
  },
};

export interface Compromise {
  /** Machine-readable: what gave way and why. */
  kind: 'dropped' | 'swapped' | 'capped' | 'too-small';
  id: string; to?: string; wanted?: number; given?: number; why: string;
}
export interface ChosenProgramme {
  use: RoomUse; name: string; band: (typeof AREA_BANDS)[number]['band']; people: number;
  /** Catalogue ids and quantities, essentials first. */
  items: Array<[string, number]>;
  compromises: Compromise[];
}

const footprint = (id: string) => { const e = catalogEntry(id); return e ? (e.w + e.clearance.left + e.clearance.right) * (e.d + e.clearance.front + e.clearance.back) : 0; };

/** The pieces a room of this use, size and household gets, with what gave way and why. */
export function programmeFor(use: RoomUse, areaM2: number, people?: number): ChosenProgramme {
  const p = PROGRAMMES[use];
  const compromises: Compromise[] = [];
  let n = Math.max(1, Math.round(people ?? p.people));
  if (p.m2PerPerson) {
    const cap = Math.max(1, Math.floor(areaM2 / p.m2PerPerson));
    if (cap < n) { compromises.push({ kind: 'capped', id: 'people', wanted: n, given: cap, why: `${Math.round(areaM2)} m² seats ${cap}, not ${n}` }); n = cap; }
  }
  if (areaM2 < p.minAreaM2) compromises.push({ kind: 'too-small', id: use, why: `A ${p.name.toLowerCase()} needs ${p.minAreaM2} m²; this room has ${Math.round(areaM2 * 10) / 10}` });
  const qty = (l: ProgrammeLine) => (l.perPeople ? Math.max(1, Math.ceil(n / l.perPeople)) + (l.plus ?? 0) : l.qty ?? 1);
  const swap = (id: string) => {
    for (const s of p.smallSwap ?? []) if (s.from === id && areaM2 < s.belowM2) { compromises.push({ kind: 'swapped', id, to: s.to, why: s.why }); return s.to; }
    return id;
  };
  // Dining for more than four takes the six-seat table, more than six two tables.
  const tableFor = (id: string): [string, number] => (id === 'dining-4' && n > 4 ? (n > 6 ? ['dining-6', Math.ceil(n / 6)] : ['dining-6', 1]) : [id, 1]);
  const out = new Map<string, number>();
  const add = (id: string, q: number) => out.set(id, (out.get(id) ?? 0) + q);
  for (const l of p.essentials) {
    const id = swap(l.id);
    if (id === 'dining-4' || id === 'dining-6') { const [t, q] = tableFor(id); add(t, q); } else add(id, qty(l));
  }
  const band = AREA_BANDS.find((b) => areaM2 <= b.maxM2)!;
  // Optional pieces in priority order while the band allows and the furniture keeps under ~55% of the floor.
  let used = [...out].reduce((t, [id, q]) => t + footprint(id) * q, 0);
  let taken = 0;
  for (const l of p.optional) {
    const id = swap(l.id);
    const clash = (p.neverTogether ?? []).find((r) => areaM2 < r.belowM2 && r.ids[1] === id && out.has(r.ids[0]))
      ?? (p.neverTogether ?? []).find((r) => areaM2 < r.belowM2 && r.ids[0] === id && out.has(r.ids[1]));
    const fp = footprint(id) * qty(l);
    // A chair that only serves a desk follows the desk.
    if (/desk-chair|office-chair|bar-stool/.test(id) && !(id === 'bar-stool' ? out.has('kitchen-island') : [...out.keys()].some((k) => /^desk/.test(k)))) continue;
    if (clash) { compromises.push({ kind: 'dropped', id, why: clash.why }); continue; }
    const chairOfDesk = /desk-chair|office-chair/.test(id);
    if (!chairOfDesk && (taken >= band.optional || used + fp > 0.55 * areaM2)) { compromises.push({ kind: 'dropped', id, why: taken >= band.optional ? `${band.band} room: ${band.optional} extra piece${band.optional === 1 ? '' : 's'}` : 'Floor would be over half full' }); continue; }
    add(id, qty(l)); used += fp; if (!chairOfDesk) taken++;
  }
  return { use, name: p.name, band: band.band, people: n, items: [...out], compromises };
}

/** The use a set of furniture most likely serves, for rooms furnished by hand. */
export function inferUse(items: Array<Pick<FurnitureItem, 'category' | 'catalogId'>>, areaM2: number): RoomUse {
  const n = (re: RegExp) => items.filter((f) => re.test(f.category) || re.test(f.catalogId)).length;
  const beds = n(/^(bed|bunk-bed)$/), desks = n(/^desk$/), sofas = n(/^sofa/), tables = n(/^table$/), cafe = n(/cafe-table/);
  if (n(/crib/)) return 'nursery';
  if (n(/toilet|washbasin|shower|bathtub/)) return 'bathroom';
  if (n(/reception-desk/)) return 'reception';
  if (cafe) return 'cafe';
  if (desks >= 6 && n(/tv-unit/)) return 'classroom';
  if (desks >= 3) return 'open-office';
  if (beds && (sofas || tables)) return 'studio';
  if (beds) return n(/toy-storage|bunk/) ? 'bedroom-kids' : items.some((f) => /bed-single/.test(f.catalogId)) ? 'bedroom-single' : 'bedroom-double';
  if (sofas && desks && n(/desk-monitor/)) return 'gaming';
  if (sofas || n(/tv-unit/)) return 'living';
  if (tables && n(/counter|kitchen-island/)) return 'kitchen-dining';
  if (tables) return n(/chair/) >= 7 || items.some((f) => f.catalogId === 'dining-6') && n(/tv-unit/) ? 'meeting' : 'dining';
  if (desks) return 'home-office';
  if (n(/waiting-chair|armchair/) >= 3) return 'clinic-waiting';
  if (n(/armchair/) && n(/bookshelf/)) return 'reading';
  if (n(/display-shelf/)) return 'shop';
  return areaM2 < 6 ? 'hallway' : 'living';
}

// ================================================================ relations
export type RelationGroup = 'safety' | 'circulation' | 'sleep' | 'work' | 'lounge' | 'dining' | 'storage' | 'light' | 'privacy' | 'balance';

export interface Repair {
  itemId: string;
  action: 'move-out-of' | 'move-to-wall' | 'turn' | 'pull-in' | 'push-back' | 'move-near' | 'move-away';
  /** Where: a wall ('wall:2'), an item id, 'window', 'door', 'room-centre'. */
  to: string;
  /** How far to move, metres, when it can be measured. */
  byM?: number;
  /** The same repair as a programme relation the solver can follow. */
  relation: Relation;
  /** 1-3 words. */
  chip: string;
}

export interface KnowledgeVerdict {
  id: string;
  group: RelationGroup;
  hard: boolean;
  pass: boolean;
  /** 0 broken .. 1 ideal. */
  score: number;
  /** Weight for this room use. */
  weight: number;
  /** 1-3 words: what holds ("Desk side-lit") or what broke ("Screen glare"). */
  chip: string;
  itemIds: string[];
  /** The measured value the verdict turns on (metres, or a cosine for angles). */
  measured?: number;
  /** What the definition asks for, e.g. [0.4, 0.5]. */
  target?: [number, number];
  repair?: Repair;
}

export interface RelationDef {
  id: string; group: RelationGroup; hard: boolean; weight: number;
  okChip: string; badChip: string;
  /** Measurable definition, for people reading the data. */
  definition: string;
}

/** Every relation the knowledge checks, with its measurable definition. */
export const RELATION_DEFS: RelationDef[] = [
  { id: 'door-swing', group: 'safety', hard: true, weight: 1, okChip: 'Door swings free', badChip: 'Blocks door', definition: 'No solid piece inside an inward door swing (leaf width square), 2 cm tolerance.' },
  { id: 'door-entry', group: 'safety', hard: true, weight: 1, okChip: 'Clear entry', badChip: 'Entry blocked', definition: 'No solid piece within 80 cm in front of any door, 2 cm tolerance.' },
  { id: 'tall-window', group: 'light', hard: true, weight: 0.9, okChip: 'Window clear', badChip: 'Blocks window', definition: 'Nothing taller than 1.2 m within 40 cm of a window.' },
  { id: 'window-route', group: 'circulation', hard: true, weight: 0.9, okChip: 'Window reachable', badChip: 'Window cut off', definition: 'A path at least 60 cm wide from the door to within 1 m of a window (80 cm ideal).' },
  { id: 'bed-headboard', group: 'sleep', hard: true, weight: 1, okChip: 'Headboard on wall', badChip: 'Bed floats', definition: 'Bed head within 5 cm of a wall.' },
  { id: 'bed-access', group: 'sleep', hard: true, weight: 1, okChip: 'Bed sides free', badChip: 'Bed side blocked', definition: 'Double bed: 50 cm free on both long sides (70 ideal); single: on one side.' },
  { id: 'desk-pullback', group: 'work', hard: true, weight: 1, okChip: 'Chair room', badChip: 'Chair cramped', definition: 'Free depth in front of the desk at least its stated clearance (75 cm), 90 cm ideal, chairs ignored.' },
  { id: 'dining-pullout', group: 'dining', hard: true, weight: 0.9, okChip: 'Chairs pull out', badChip: 'No pull-out', definition: 'Behind every dining chair 60 cm free to pull out, 90 cm to walk behind.' },
  { id: 'storage-front', group: 'storage', hard: true, weight: 0.8, okChip: 'Doors open', badChip: 'Doors blocked', definition: 'In front of storage its stated clearance stays free; wardrobes 90 cm dressing zone ideal.' },
  { id: 'circulation', group: 'circulation', hard: false, weight: 0.8, okChip: 'Easy to reach', badChip: 'Tight route', definition: 'An 80 cm path from the door to every group and window.' },
  { id: 'bed-door-line', group: 'sleep', hard: false, weight: 0.5, okChip: 'Feet off door', badChip: 'Feet to door', definition: 'The door is not straight out from the foot of the bed.' },
  { id: 'bed-command', group: 'sleep', hard: false, weight: 0.4, okChip: 'Bed sees door', badChip: 'Door behind bed', definition: 'From the pillow the door is in view (not behind the head).' },
  { id: 'bed-window', group: 'sleep', hard: false, weight: 0.5, okChip: 'Solid headwall', badChip: 'Bed under window', definition: 'No window over the headboard span.' },
  { id: 'bed-privacy', group: 'privacy', hard: false, weight: 0.4, okChip: 'Bed tucked away', badChip: 'Bed seen first', definition: 'The bed is not within 25 degrees of the line of sight through the door.' },
  { id: 'nightstand-flank', group: 'sleep', hard: false, weight: 0.7, okChip: 'Nightstands flank', badChip: 'Nightstand adrift', definition: 'Nightstand within 10 cm of the bed side, back within 15 cm of the headboard line.' },
  { id: 'pair-symmetry', group: 'balance', hard: false, weight: 0.4, okChip: 'Pair symmetric', badChip: 'Pair lopsided', definition: 'Two nightstands on opposite sides, level within 5 cm.' },
  { id: 'coffee-reach', group: 'lounge', hard: false, weight: 0.8, okChip: 'Table in reach', badChip: 'Table too far', definition: 'Coffee table 40-50 cm in front of the sofa, centred within 20 cm.' },
  { id: 'tv-distance', group: 'lounge', hard: false, weight: 0.8, okChip: 'TV at distance', badChip: 'TV distance off', definition: 'Sofa faces the TV within 20 degrees at 2-3.5 m.' },
  { id: 'tv-calm', group: 'lounge', hard: false, weight: 0.6, okChip: 'Calm TV zone', badChip: 'Path past TV', definition: 'No route from the door to another group crosses between sofa and TV.' },
  { id: 'rug-legs', group: 'lounge', hard: false, weight: 0.4, okChip: 'Rug under legs', badChip: 'Rug adrift', definition: 'Front legs of the sofa and the whole coffee table on the rug.' },
  { id: 'sofa-anchor', group: 'lounge', hard: false, weight: 0.5, okChip: 'Sofa anchored', badChip: 'Sofa adrift', definition: 'Sofa back on a wall, or 90 cm walkway behind it.' },
  { id: 'desk-light', group: 'work', hard: false, weight: 0.7, okChip: 'Desk side-lit', badChip: 'Screen glare', definition: 'Nearest window to the side of the sitter: |cos| of gaze to window under 0.5.' },
  { id: 'plant-light', group: 'light', hard: false, weight: 0.3, okChip: 'Plant in light', badChip: 'Plant in shade', definition: 'Plant within 1.5 m of a window.' },
  { id: 'reading-light', group: 'light', hard: false, weight: 0.3, okChip: 'Reading light', badChip: 'Chair in dark', definition: 'Armchair within 2 m of a window or 50 cm of a lamp.' },
  { id: 'tall-by-door', group: 'storage', hard: false, weight: 0.2, okChip: 'Storage by door', badChip: 'Storage far in', definition: 'Tall storage within 1.5 m of the door wall end.' },
  { id: 'on-axis', group: 'balance', hard: false, weight: 0.3, okChip: 'On axis', badChip: 'Off axis', definition: 'Bed, sofa, TV and table centred on their wall, a window or the room within 10 cm.' },
];
const DEF = new Map(RELATION_DEFS.map((d) => [d.id, d]));

/** How much each group matters per use (1 when not listed). */
export const USE_WEIGHTS: Partial<Record<RoomUse, Partial<Record<RelationGroup, number>>>> = {
  'bedroom-single': { sleep: 1.5, privacy: 1.3, lounge: 0.5 },
  'bedroom-double': { sleep: 1.6, privacy: 1.4, balance: 1.3, lounge: 0.5 },
  'bedroom-guest': { sleep: 1.4, privacy: 1.2 },
  'bedroom-kids': { sleep: 1.2, circulation: 1.3, safety: 1.2 },
  nursery: { safety: 1.5, sleep: 1.3 },
  teen: { work: 1.3, sleep: 1.2 },
  living: { lounge: 1.6, balance: 1.2, light: 1.2 },
  'home-office': { work: 1.7, light: 1.3 },
  gaming: { work: 1.4, lounge: 1.4 },
  reading: { light: 1.8, lounge: 1.2 },
  studio: { privacy: 1.3, circulation: 1.2 },
  dining: { dining: 1.6, balance: 1.2 },
  'kitchen-dining': { dining: 1.4, circulation: 1.4 },
  meeting: { dining: 1.5, balance: 1.2 },
  'open-office': { work: 1.5, circulation: 1.4, light: 1.2 },
  classroom: { work: 1.4, circulation: 1.4 },
  cafe: { dining: 1.4, circulation: 1.5 },
  shop: { circulation: 1.6, storage: 1.3 },
  reception: { circulation: 1.4, safety: 1.3 },
  'clinic-waiting': { circulation: 1.5, safety: 1.3 },
  hallway: { circulation: 1.8, safety: 1.4 },
  bathroom: { safety: 1.3, storage: 1.2 },
};

// ---------------------------------------------------------------- geometry
const dot = (a: P, b: P) => a.x * b.x + a.y * b.y;
const sub = (a: P, b: P): P => ({ x: a.x - b.x, y: a.y - b.y });
const norm = (a: P): P => { const l = Math.hypot(a.x, a.y) || 1; return { x: a.x / l, y: a.y / l }; };
const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : Number.isFinite(x) ? x : 0);
/** 1 inside [lo, hi], falling linearly to 0 over `soft` outside. */
const band = (x: number, lo: number, hi: number, soft: number) => (x < lo ? clamp01(1 - (lo - x) / soft) : x > hi ? clamp01(1 - (x - hi) / soft) : 1);
const at = (a: AItem): P => ({ x: a.f.x, y: a.f.y });
const edgeToPoint = (a: AItem, p: P) => (pointInPolygon(p, a.poly) ? 0 : Math.min(...a.poly.map((q, i) => { const r = a.poly[(i + 1) % 4], e = sub(r, q), l2 = dot(e, e); const u = l2 ? Math.max(0, Math.min(1, dot(sub(p, q), e) / l2)) : 0; return dist(p, { x: q.x + e.x * u, y: q.y + e.y * u }); })));
const isCat = (a: AItem, re: RegExp) => re.test(a.f.category);
const TALL = 1.2;

/** Free depth from a wall's middle straight into the room (how much room a piece on it has in front). */
function wallDepth(room: RoomCtx, i: number): number {
  const w = room.walls[i];
  const o = { x: (w.a.x + w.b.x) / 2 + w.n.x * 0.01, y: (w.a.y + w.b.y) / 2 + w.n.y * 0.01 };
  let best = Infinity;
  for (const v of room.walls) {
    if (v.i === i) continue;
    const e = sub(v.b, v.a), den = w.n.x * e.y - w.n.y * e.x;
    if (Math.abs(den) < 1e-12) continue;
    const q = sub(v.a, o), t = (q.x * e.y - q.y * e.x) / den, u = (q.x * w.n.y - q.y * w.n.x) / den;
    if (t > 1e-6 && u >= 0 && u <= 1) best = Math.min(best, t);
  }
  return best;
}
/** Walls ranked for a piece that wants a solid wall: long, no window, not the door wall, room in front. */
function solidWalls(room: RoomCtx, minLen: number, avoid: Set<number> = new Set()): number[] {
  return room.walls.filter((w) => w.len >= minLen && !avoid.has(w.i))
    .map((w) => ({ i: w.i, s: (w.windows.length ? -2 : 0) + (w.doors.length ? -1 : 0) + Math.min(w.len, 5) * 0.2 + Math.min(wallDepth(room, w.i), 4) * 0.3 }))
    .sort((a, b) => b.s - a.s).map((x) => x.i);
}
/** Path width (m) from the door to within `radius` of `to`, through the free floor. */
function reachWidth(Lc: LayoutCtx, g: FloorGrid, best: Float32Array, to: P, radius: number): number {
  let m = -1;
  const c0 = Math.floor((to.x - radius - g.ox) / g.cell), c1 = Math.floor((to.x + radius - g.ox) / g.cell);
  const r0 = Math.floor((to.y - radius - g.oy) / g.cell), r1 = Math.floor((to.y + radius - g.oy) / g.cell);
  for (let r = Math.max(0, r0); r <= Math.min(g.rows - 1, r1); r++) for (let c = Math.max(0, c0); c <= Math.min(g.cols - 1, c1); c++) {
    const q = { x: g.ox + (c + 0.5) * g.cell, y: g.oy + (r + 0.5) * g.cell };
    if (dist(q, to) <= radius) m = Math.max(m, best[r * g.cols + c]);
  }
  void Lc;
  return m < 0 ? 0 : 2 * m;
}

// ---------------------------------------------------------------- evaluation
export interface KnowledgeResult {
  use: RoomUse;
  verdicts: KnowledgeVerdict[];
  /** 0..100 over the soft relations, capped at 30 while any hard one is broken. */
  score: number;
  hardBroken: KnowledgeVerdict[];
  /** Chips of the strongest satisfied relations, then the broken ones. */
  good: string[];
  bad: string[];
}

/** Check every relation that applies to this layout. */
export function evaluateKnowledge(model: SpaceModel, furniture: FurnitureItem[], use?: RoomUse, spaceId?: string): KnowledgeResult {
  const room = buildRoom(model, spaceId);
  const Lc = analyse(room, furniture);
  const u = use ?? inferUse(furniture, room.area);
  const mult = USE_WEIGHTS[u] ?? {};
  const out: KnowledgeVerdict[] = [];
  const solid = Lc.items.filter((a) => a.solid && a.f.h > 0.05);
  const push = (id: string, score: number, itemIds: string[], extra: Partial<KnowledgeVerdict> & { hardFail?: boolean } = {}) => {
    const d = DEF.get(id)!;
    const s = clamp01(score);
    const pass = d.hard ? !extra.hardFail : s >= 0.7;
    const { hardFail, ...rest } = extra; void hardFail;
    out.push({ id, group: d.group, hard: d.hard, pass, score: s, weight: d.weight * (mult[d.group] ?? 1), chip: pass ? d.okChip : rest.chip ?? d.badChip, itemIds, ...rest, ...(pass ? { chip: d.okChip } : {}) });
  };
  const rel = (kind: Relation['kind'], subject: string, target: string | undefined, reason: string, distanceM?: [number, number], weight = 1): Relation => ({ kind, subject, ...(target ? { target } : {}), ...(distanceM ? { distanceM } : {}), weight, reason });
  const seats = new Set(Lc.items.filter((a) => /chair|stool|bench/.test(a.f.category)).map((a) => a.f.id));

  // --- safety: door swing and entry
  for (const a of solid) {
    for (const z of room.swingZones) {
      const o = overlapDepth(a.rect, z.z);
      if (o > 0.02) push('door-swing', 0, [a.f.id], { hardFail: true, measured: o, repair: { itemId: a.f.id, action: 'move-out-of', to: z.id, byM: Math.round((o + 0.05) * 100) / 100, chip: 'Clear door swing', relation: rel('apart-from', a.f.id, 'door', 'Nothing may stand in the door swing.', [1.0, 9]) } });
    }
    for (const z of room.approachZones) {
      const o = overlapDepth(a.rect, z.z);
      if (o > 0.02 && !room.swingZones.some((s) => s.id === z.id && overlapDepth(a.rect, s.z) > 0.02)) push('door-entry', 0, [a.f.id], { hardFail: true, measured: o, repair: { itemId: a.f.id, action: 'move-out-of', to: z.id, byM: Math.round((o + 0.05) * 100) / 100, chip: 'Clear the entry', relation: rel('apart-from', a.f.id, 'door', 'Keep 80 cm in front of the door free.', [0.85, 9]) } });
    }
    if (a.f.h > TALL) for (const z of room.windowZones) {
      const o = overlapDepth(a.rect, z.z);
      if (o > 0.02) push('tall-window', 0, [a.f.id], { hardFail: true, measured: o, repair: { itemId: a.f.id, action: 'move-away', to: z.id, chip: 'Off the window', relation: rel('apart-from', a.f.id, 'window', 'Tall pieces never stand in front of a window.', [0.5, 9]) } });
    }
  }
  if (room.doors.length && !out.some((v) => v.id === 'door-swing')) push('door-swing', 1, []);
  if (room.doors.length && !out.some((v) => v.id === 'door-entry')) push('door-entry', 1, []);
  if (room.windows.length && !out.some((v) => v.id === 'tall-window')) push('tall-window', 1, []);

  // --- circulation
  const door = room.doors[0];
  if (door) {
    const dp = doorPoint(door);
    const g = floorGrid(Lc, 0.1, room.doors.map((d) => doorPoint(d)));
    const best = widestFrom(g, dp);
    if (room.windows.length) {
      const widths = room.windows.map((w) => reachWidth(Lc, g, best, w.c, 1.0));
      const top = Math.max(...widths);
      const blocker = (w: P) => solid.filter((a) => !seats.has(a.f.id)).sort((x, y) => edgeToPoint(x, w) - edgeToPoint(y, w))[0];
      const wi = widths.indexOf(top);
      push('window-route', band(top, 0.8, 99, 0.2), [], { hardFail: top < 0.6 - 0.05, measured: top, target: [0.6, 0.8], ...(top < 0.6 - 0.05 && blocker(room.windows[wi].c) ? { repair: { itemId: blocker(room.windows[wi].c)!.f.id, action: 'move-away', to: 'window', chip: 'Open window route', relation: rel('apart-from', blocker(room.windows[wi].c)!.f.id, 'window', 'Leave a way to the window.', [0.8, 9]) } } : {}) });
    }
    // Every group anchor and every window reachable at 80 cm.
    const anchors = Lc.items.filter((a) => isCat(a, /^(bed|bunk-bed|sofa|sofa-bed|desk|table|cafe-table|counter|reception-desk|wardrobe|treatment-bed)$/));
    let worst = Infinity, worstId = '';
    for (const a of anchors) {
      const w = reachWidth(Lc, g, best, at(a), Math.max(a.f.w, a.f.d) / 2 + 0.7);
      if (w < worst) { worst = w; worstId = a.f.id; }
    }
    for (const w of room.windows) { const v = reachWidth(Lc, g, best, w.c, 1.0); if (v < worst) { worst = v; worstId = 'window'; } }
    if (Number.isFinite(worst)) push('circulation', band(worst, 0.8, 99, 0.3), worstId && worstId !== 'window' ? [worstId] : [], { measured: worst, target: [0.8, 0.9], ...(worst < 0.7 && worstId && worstId !== 'window' ? { repair: { itemId: worstId, action: 'move-near', to: 'door', chip: 'Widen the route', relation: rel('away-from-door', worstId, 'door', 'An 80 cm route from the door to every group.', [0.9, 9], 0.6) } } : {}) });
  }

  // --- sleep
  for (const b of Lc.items.filter((a) => isCat(a, /^(bed|bunk-bed)$/))) {
    const id = b.f.id;
    const onWall = !!b.back && b.back.gap <= 0.05;
    const walls = solidWalls(room, b.f.w + 0.9);
    push('bed-headboard', onWall ? 1 : 0, [id], { hardFail: !onWall, measured: b.back?.gap, target: [0, 0.05], ...(!onWall ? { repair: { itemId: id, action: 'move-to-wall', to: `wall:${walls[0] ?? 0}`, chip: 'Head to wall', relation: rel('against-wall', id, `wall:${walls[0] ?? 0}`, 'Headboard against a solid wall.') } } : {}) });
    // Side access: rays out from the long sides, ignoring the nightstands at the head.
    const sides = ([-1, 1] as const).map((sg) => {
      const pts = [0, b.f.d / 4].map((ly) => toPlanOf(b.f, sg * (b.f.w / 2 - 0.01), ly));
      const dir = { x: b.right.x * sg, y: b.right.y * sg };
      return Math.min(...pts.map((p) => rayFree(Lc, p, dir, new Set([id]), 3)));
    });
    const double = b.f.w >= 1.2;
    const access = double ? Math.min(...sides) : Math.max(...sides);
    const walls2 = solidWalls(room, b.f.w + 1.2);
    push('bed-access', band(access, 0.7, 99, 0.25), [id], { hardFail: access < 0.5 - 0.02, measured: access, target: [0.5, 0.7], ...(access < 0.5 - 0.02 ? { repair: { itemId: id, action: 'move-to-wall', to: `wall:${walls2[0] ?? 0}`, byM: Math.round((0.6 - access) * 100) / 100, chip: double ? 'Free both sides' : 'Free one side', relation: rel('centered-on', id, 'room-centre', 'A double bed needs 60 cm on both sides.', undefined, 0.6) } } : {}) });
    if (door) {
      const r = sub(door.c, at(b)), along = dot(r, b.front), lat = Math.abs(dot(r, b.right));
      const inLine = along > b.f.d / 2 && lat < b.f.w / 2 + 0.2;
      const perp = room.walls.filter((w) => Math.abs(dot(w.n, room.walls[door.wall].n)) < 0.3 && w.len >= b.f.w + 0.9).map((w) => w.i);
      push('bed-door-line', inLine ? 0.3 : 1, [id], inLine ? { repair: { itemId: id, action: 'move-to-wall', to: `wall:${perp[0] ?? walls[0] ?? 0}`, chip: 'Turn bed', relation: rel('against-wall', id, `wall:${perp[0] ?? walls[0] ?? 0}`, 'Feet not pointing at the door.', undefined, 0.6) } } : {});
      const pillow = toPlanOf(b.f, 0, -b.f.d / 2 + 0.3);
      const c = dot(b.front, norm(sub(door.c, pillow)));
      push('bed-command', c >= -0.1 ? 1 : 0.4, [id], { measured: c });
      const dp = doorPoint(door), look = room.walls[door.wall].n, tb = norm(sub(at(b), dp));
      const seen = dot(look, tb) > Math.cos((25 * Math.PI) / 180);
      push('bed-privacy', seen ? 0.4 : 1, [id], seen ? { repair: { itemId: id, action: 'move-to-wall', to: `wall:${perp[0] ?? walls[0] ?? 0}`, chip: 'Out of sightline', relation: rel('away-from-door', id, 'door', 'The bed out of the line of sight from the door.', [1.5, 9], 0.5) } } : {});
    }
    if (b.back && room.walls[b.back.wall].windows.length) {
      const w = room.walls[b.back.wall], t = dot(sub(at(b), w.a), w.dir);
      const under = w.windows.some(([s, e]) => e > t - b.f.w / 2 && s < t + b.f.w / 2);
      const alt = solidWalls(room, b.f.w + 0.9).find((i) => !room.walls[i].windows.length);
      push('bed-window', under ? (alt !== undefined ? 0.3 : 0.75) : 1, [id], under && alt !== undefined ? { repair: { itemId: id, action: 'move-to-wall', to: `wall:${alt}`, chip: 'Solid headwall', relation: rel('against-wall', id, `wall:${alt}`, 'A headboard on a wall without a window.', undefined, 0.7) } } : {});
    } else if (room.windows.length) push('bed-window', 1, [id]);
    // Nightstands.
    const ns = Lc.items.filter((a) => isCat(a, /^nightstand$/));
    const lats: number[] = [], lys: number[] = [];
    for (const n of ns) {
      const r = sub(at(n), at(b)), lx = dot(r, b.right), ly = dot(r, b.front);
      const gap = Math.abs(lx) - b.f.w / 2 - n.f.w / 2, back = Math.abs(ly - (-b.f.d / 2 + n.f.d / 2));
      const sc = band(gap, -0.01, 0.1, 0.3) * band(back, 0, 0.15, 0.3);
      lats.push(lx); lys.push(ly);
      push('nightstand-flank', sc, [n.f.id, id], { measured: gap, target: [0, 0.1], ...(sc < 0.7 ? { repair: { itemId: n.f.id, action: 'pull-in', to: id, chip: 'Beside the bed', relation: rel('flanks', n.f.id, id, 'A nightstand at the head of the bed.') } } : {}) });
    }
    if (ns.length === 2) {
      const ok = Math.sign(lats[0]) !== Math.sign(lats[1]) && Math.abs(lys[0] - lys[1]) < 0.05;
      push('pair-symmetry', ok ? 1 : 0.3, ns.map((n) => n.f.id), ok ? {} : { repair: { itemId: ns[1].f.id, action: 'pull-in', to: id, chip: 'Mirror the pair', relation: rel('flanks', ns[1].f.id, id, 'One nightstand each side of the bed.') } });
    }
  }

  // --- lounge
  const sofa = Lc.items.find((a) => isCat(a, /^(sofa|sofa-bed)$/));
  const tv = Lc.items.find((a) => isCat(a, /^tv-unit$/));
  const coffee = Lc.items.find((a) => isCat(a, /^coffee-table$/));
  if (sofa) {
    if (coffee) {
      const r = sub(at(coffee), at(sofa)), along = dot(r, sofa.front), lat = Math.abs(dot(r, sofa.right));
      const half = Math.abs(dot(sofa.front, coffee.front)) > 0.7 ? coffee.f.d / 2 : coffee.f.w / 2;
      const gap = along - sofa.f.d / 2 - half;
      const sc = band(gap, 0.4, 0.5, 0.15) * band(lat, 0, 0.2, 0.4);
      push('coffee-reach', sc, [coffee.f.id, sofa.f.id], { measured: gap, target: [0.4, 0.5], ...(sc < 0.7 ? { repair: { itemId: coffee.f.id, action: gap > 0.5 ? 'pull-in' : 'push-back', to: sofa.f.id, byM: Math.round(Math.abs(gap - 0.45) * 100) / 100, chip: 'Table to 45 cm', relation: rel('in-front-of', coffee.f.id, sofa.f.id, 'About 45 cm in front of the sofa.', [0.4, 0.5]) } } : {}) });
    }
    if (tv) {
      const d = dist(at(sofa), at(tv)), c = dot(sofa.front, norm(sub(at(tv), at(sofa))));
      const sc = band(d, 2.0, 3.5, 0.6) * band(c, 0.94, 1, 0.5);
      push('tv-distance', sc, [sofa.f.id, tv.f.id], { measured: d, target: [2.0, 3.5], ...(sc < 0.7 ? { chip: c < 0.94 ? 'Sofa turned away' : d < 2 ? 'TV too close' : 'TV too far', repair: { itemId: sofa.f.id, action: 'turn', to: tv.f.id, chip: 'Face the TV', relation: rel('faces', sofa.f.id, tv.f.id, 'The sofa faces the TV at 2-3.5 m.', [2.0, 3.5]) } } : {}) });
      // A straight route from a door to another group or a window must not cross the sofa-TV axis.
      let cut = false;
      const targets = [...Lc.items.filter((a) => isCat(a, /^(bed|desk|table|counter|wardrobe)$/)).map(at), ...room.windows.map((w) => w.c)];
      for (const dr of room.doors) {
        const dp = doorPoint(dr);
        if (targets.some((t) => crossesMid(dp, t, sofa, tv))) cut = true;
      }
      push('tv-calm', cut ? 0.3 : 1, [sofa.f.id, tv.f.id], cut ? { repair: { itemId: tv.f.id, action: 'move-away', to: 'door', chip: 'Route behind sofa', relation: rel('apart-from', tv.f.id, 'door', 'The way through the room passes behind the sofa, not in front of the TV.', [1.5, 9], 0.6) } } : {});
    }
    const rug = Lc.items.find((a) => isCat(a, /^rug$/));
    if (rug && (coffee || tv)) {
      const legs = [toPlanOf(sofa.f, -sofa.f.w / 2 + 0.1, sofa.f.d / 2 - 0.1), toPlanOf(sofa.f, sofa.f.w / 2 - 0.1, sofa.f.d / 2 - 0.1)];
      const on = legs.filter((p) => pointInPolygon(p, rug.poly)).length / 2;
      const ct = coffee ? coffee.poly.filter((p) => pointInPolygon(p, rug.poly)).length / 4 : 1;
      const sc = 0.5 * on + 0.5 * ct;
      push('rug-legs', sc, [rug.f.id, sofa.f.id], sc < 0.7 ? { repair: { itemId: rug.f.id, action: 'move-near', to: coffee?.f.id ?? sofa.f.id, chip: 'Rug under group', relation: rel('centered-on', rug.f.id, coffee?.f.id ?? sofa.f.id, 'The rug under the coffee table and the front legs of the sofa.') } } : {});
    }
    const onWall = !!sofa.back && sofa.back.gap <= 0.05;
    const behind = rayFree(Lc, toPlanOf(sofa.f, 0, -sofa.f.d / 2 + 0.01), { x: -sofa.front.x, y: -sofa.front.y }, new Set([sofa.f.id]), 3);
    const sc = onWall ? 1 : behind >= 0.9 ? 0.85 : 0.3;
    push('sofa-anchor', sc, [sofa.f.id], { measured: onWall ? 0 : behind, ...(sc < 0.7 ? { repair: { itemId: sofa.f.id, action: 'push-back', to: 'wall', byM: Math.round(behind * 100) / 100, chip: 'Back to wall', relation: rel('against-wall', sofa.f.id, undefined, 'A sofa back to a wall, or a full walkway behind it.') } } : {}) });
  }

  // --- work
  for (const d of Lc.items.filter((a) => isCat(a, /^desk$/))) {
    const pts = [-d.f.w / 4, 0, d.f.w / 4].map((lx) => toPlanOf(d.f, lx, d.f.d / 2 - 0.01));
    const free = Math.min(...pts.map((p) => rayFree(Lc, p, d.front, new Set([d.f.id, ...seats]), 3)));
    const need = Math.max(0.75, d.f.clearance.front);
    const deep = solidWalls(room, d.f.w + 0.2).sort((a, b) => wallDepth(room, b) - wallDepth(room, a))[0];
    push('desk-pullback', band(free, need + 0.15, 99, 0.3), [d.f.id], { hardFail: free < need - 0.03, measured: free, target: [need, 0.9], ...(free < need - 0.03 ? { repair: { itemId: d.f.id, action: 'move-to-wall', to: `wall:${deep ?? 0}`, byM: Math.round((need - free) * 100) / 100, chip: 'Room to pull back', relation: rel('against-wall', d.f.id, `wall:${deep ?? 0}`, 'A desk where the chair can roll back 90 cm.') } } : {}) });
    if (room.windows.length) {
      const w = room.windows.reduce((p, q) => (dist(q.c, at(d)) < dist(p.c, at(d)) ? q : p));
      if (dist(w.c, at(d)) < 5) {
        // Gaze against the window wall's inward normal: 1 looks at the window, -1 has it behind (glare on the screen).
        const n = room.walls[w.wall].n, c = -dot({ x: -d.front.x, y: -d.front.y }, n);
        const sc = band(Math.abs(c), 0, 0.5, 0.45);
        const perp = room.walls.filter((x) => Math.abs(dot(x.n, room.walls[w.wall].n)) < 0.3 && x.len >= d.f.w + 0.2).map((x) => x.i).sort((a, b) => dist(room.walls[a].a, w.c) + dist(room.walls[a].b, w.c) - dist(room.walls[b].a, w.c) - dist(room.walls[b].b, w.c));
        push('desk-light', sc, [d.f.id], { measured: c, target: [-0.5, 0.5], ...(sc < 0.7 ? { chip: c > 0 ? 'Faces window' : 'Screen glare', repair: { itemId: d.f.id, action: 'move-to-wall', to: `wall:${perp[0] ?? 0}`, chip: 'Window to the side', relation: rel('against-wall', d.f.id, `wall:${perp[0] ?? 0}`, 'A desk at right angles to the window: daylight from the side, no glare.', undefined, 0.8) } } : {}) });
      }
    }
  }

  // --- dining: chairs at tables pull out
  for (const s of Lc.items.filter((a) => seats.has(a.f.id))) {
    const hostId = Lc.hostOf.get(s.f.id);
    const host = hostId ? Lc.byId.get(hostId) : undefined;
    if (!host || /desk|counter|reception/.test(host.f.category)) continue;
    if (dist(at(s), at(host)) > Math.max(host.f.w, host.f.d) / 2 + 1) continue;
    const back = toPlanOf(s.f, 0, -s.f.d / 2 + 0.01);
    const free = rayFree(Lc, back, { x: -s.front.x, y: -s.front.y }, new Set([s.f.id]), 2);
    push('dining-pullout', band(free, 0.9, 99, 0.3), [s.f.id, host.f.id], { hardFail: free < 0.6 - 0.03, measured: free, target: [0.6, 0.9], ...(free < 0.6 - 0.03 ? { repair: { itemId: host.f.id, action: 'move-near', to: 'room-centre', byM: Math.round((0.6 - free) * 100) / 100, chip: 'Table to centre', relation: rel('centered-on', host.f.id, 'room-centre', 'A table with 90 cm behind every chair.') } } : {}) });
  }

  // --- storage fronts
  for (const s of Lc.items.filter((a) => isCat(a, /^(wardrobe|dresser|storage-cabinet|bookshelf|filing-cabinet|toy-storage)$/))) {
    const pts = [-s.f.w / 3, 0, s.f.w / 3].map((lx) => toPlanOf(s.f, lx, s.f.d / 2 - 0.01));
    const free = Math.min(...pts.map((p) => rayFree(Lc, p, s.front, new Set([s.f.id]), 2)));
    const need = Math.max(0.3, s.f.clearance.front);
    const ideal = isCat(s, /^wardrobe$/) ? 0.9 : need + 0.1;
    const deep = solidWalls(room, s.f.w + 0.1).sort((a, b) => wallDepth(room, b) - wallDepth(room, a))[0];
    push('storage-front', band(free, ideal, 99, 0.3), [s.f.id], { hardFail: free < need - 0.03, measured: free, target: [need, ideal], ...(free < need - 0.03 ? { repair: { itemId: s.f.id, action: 'move-to-wall', to: `wall:${deep ?? 0}`, chip: 'Free the doors', relation: rel('against-wall', s.f.id, `wall:${deep ?? 0}`, 'Storage where its doors open fully.') } } : {}) });
    if (s.f.h > TALL && door) {
      const dd = edgeToPoint(s, door.c);
      push('tall-by-door', band(dd, 0, 1.5, 1.5), [s.f.id], { measured: dd });
    }
  }

  // --- light
  if (room.windows.length) {
    const nearWin = (a: AItem) => Math.min(...room.windows.map((w) => edgeToPoint(a, w.c)));
    for (const p of Lc.items.filter((a) => isCat(a, /^plant$/))) { const d = nearWin(p); push('plant-light', band(d, 0, 1.5, 1), [p.f.id], { measured: d, ...(d > 2 ? { repair: { itemId: p.f.id, action: 'move-near', to: 'window', chip: 'Plant to window', relation: rel('near-window', p.f.id, 'window', 'Plants by the light.', [0, 1.5], 0.5) } } : {}) }); }
    const lamps = Lc.items.filter((a) => isCat(a, /^lamp$/));
    for (const c of Lc.items.filter((a) => isCat(a, /^armchair$/) && !/waiting/.test(a.f.catalogId))) {
      const d = nearWin(c), l = lamps.length ? Math.min(...lamps.map((x) => edgeToPoint(c, at(x)))) : Infinity;
      const sc = Math.max(band(d, 0, 2, 1), band(l, 0, 0.5, 0.5));
      push('reading-light', sc, [c.f.id], sc < 0.7 ? { repair: { itemId: c.f.id, action: 'move-near', to: 'window', chip: 'Chair to light', relation: rel('near-window', c.f.id, 'window', 'A reading chair by the daylight.', [0, 2], 0.5) } } : {});
    }
  }

  // --- balance: focal pieces on an axis
  for (const a of Lc.items.filter((x) => isCat(x, /^(bed|sofa|tv-unit|table)$/))) {
    const axes: P[] = [room.centre];
    if (a.back) { const w = room.walls[a.back.wall]; axes.push({ x: (w.a.x + w.b.x) / 2, y: (w.a.y + w.b.y) / 2 }); for (const [s, e] of w.windows) { const t = (s + e) / 2; axes.push({ x: w.a.x + w.dir.x * t, y: w.a.y + w.dir.y * t }); } }
    const off = Math.min(...axes.map((p) => Math.abs(dot(sub(at(a), p), a.right))));
    const offOther = isCat(a, /^table$/) ? Math.min(...axes.map((p) => Math.abs(dot(sub(at(a), p), a.front)))) : 0;
    push('on-axis', band(Math.max(off, offOther), 0, 0.1, 0.5), [a.f.id], { measured: off });
  }

  const hardBroken = out.filter((v) => v.hard && !v.pass);
  const soft = out.filter((v) => !v.hard);
  const w = soft.reduce((t, v) => t + v.weight, 0);
  const raw = w ? (100 * soft.reduce((t, v) => t + v.weight * v.score, 0)) / w : 100;
  const score = Math.round(hardBroken.length ? Math.min(raw, Math.max(0, 30 - 5 * (hardBroken.length - 1))) : raw);
  const uniq = (xs: string[]) => [...new Set(xs)];
  const good = uniq(out.filter((v) => v.pass && v.score >= 0.95).sort((a, b) => Number(a.hard) - Number(b.hard) || b.weight - a.weight).map((v) => v.chip)).slice(0, 12);
  const bad = uniq(out.filter((v) => !v.pass).sort((a, b) => importance(b) - importance(a)).map((v) => v.chip));
  return { use: u, verdicts: out, score, hardBroken, good, bad };
}

/** Whether the segment door->target passes through the strip between sofa front and TV front. */
function crossesMid(p: P, q: P, sofa: AItem, tv: AItem): boolean {
  const a = toPlanOf(sofa.f, 0, sofa.f.d / 2), b = toPlanOf(tv.f, 0, tv.f.d / 2);
  // Crossing the sofa-to-TV axis anywhere along its middle 80% counts.
  const s0 = { x: a.x + (b.x - a.x) * 0.1, y: a.y + (b.y - a.y) * 0.1 }, s1 = { x: b.x + (a.x - b.x) * 0.1, y: b.y + (a.y - b.y) * 0.1 };
  return segmentsIntersect(p, q, s0, s1);
}

/** Order for the critic: hard first, then by weighted shortfall. */
export const importance = (v: KnowledgeVerdict) => (v.hard && !v.pass ? 100 : 0) + v.weight * (1 - v.score) * 10;

// ================================================================ critic
export interface CriticItem { relation: string; chip: string; hard: boolean; importance: number; itemIds: string[]; repair?: Repair }

/** Broken relations by importance, each with the specific repair. Pure data for panels and the solver. */
export function critiqueKnowledge(model: SpaceModel, furniture: FurnitureItem[], use?: RoomUse, spaceId?: string): CriticItem[] {
  const r = evaluateKnowledge(model, furniture, use, spaceId);
  return r.verdicts.filter((v) => !v.pass).sort((a, b) => importance(b) - importance(a))
    .map((v) => ({ relation: v.id, chip: v.chip, hard: v.hard, importance: Math.round(importance(v) * 10) / 10, itemIds: v.itemIds, ...(v.repair ? { repair: v.repair } : {}) }));
}

/** The repairs as programme relations, strongest first, at most `max`, one per item. */
export function repairRelations(items: CriticItem[], max = 3): Relation[] {
  const seen = new Set<string>(), out: Relation[] = [];
  for (const c of items) {
    if (!c.repair || seen.has(c.repair.itemId)) continue;
    seen.add(c.repair.itemId); out.push(c.repair.relation);
    if (out.length >= max) break;
  }
  return out;
}

export { frontOf };
