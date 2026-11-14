import type { FurnitureItem, ObjectRole, ObjectSemantics } from '../../core/types';

type Row = Omit<ObjectSemantics, 'category' | 'tall'> & { tall?: boolean };

const S = (role: ObjectRole, wallBacked: boolean, frontClearanceM: number, sideClearanceM: number, pairsWith: string[], faces: ObjectSemantics['faces'], description: string): Row =>
  ({ role, wallBacked, frontClearanceM, sideClearanceM, pairsWith, faces, description });

/** One row for every category in the catalogue, plus a few common extras. */
export const SEMANTICS: Record<string, Row> = {
  bed: S('sleeping', true, 0.6, 0.6, ['nightstand', 'wardrobe', 'dresser', 'rug'], 'room', 'A bed: headboard against a wall, reachable from the sides.'),
  'bunk-bed': S('sleeping', true, 0.7, 0.6, ['wardrobe', 'toy-storage'], 'room', 'A bunk bed: tall, long side or head against a wall.'),
  crib: S('sleeping', true, 0.6, 0, ['bed', 'dresser'], 'room', 'A crib: against a wall, within reach of the parents\' bed.'),
  'sofa-bed': S('seating', true, 0.45, 0, ['coffee-table', 'rug', 'tv-unit', 'lamp'], 'screen', 'A sofa that unfolds into a bed; needs its unfolded depth free.'),
  sofa: S('seating', true, 0.45, 0, ['coffee-table', 'rug', 'tv-unit', 'lamp', 'armchair'], 'screen', 'A sofa: faces the focal point, coffee table in front.'),
  armchair: S('seating', false, 0.4, 0, ['coffee-table', 'lamp', 'sofa', 'side-table'], 'table', 'An armchair: angled into the conversation group.'),
  chair: S('seating', false, 0.6, 0, ['table', 'desk', 'cafe-table'], 'table', 'A chair that belongs to a table or desk.'),
  'desk-chair': S('seating', false, 0.75, 0, ['desk'], 'table', 'A desk chair that needs room to roll back.'),
  'office-chair': S('seating', false, 0.75, 0, ['desk'], 'table', 'An office chair that needs room to roll back.'),
  stool: S('seating', false, 0.45, 0, ['counter', 'table', 'cafe-table'], 'table', 'A stool at a counter or high table.'),
  bench: S('seating', false, 0.45, 0, ['table'], 'table', 'A bench along a table or wall.'),
  desk: S('surface', true, 0.9, 0, ['chair', 'desk-chair', 'office-chair', 'lamp', 'bookshelf'], 'room', 'A desk: back to a wall, chair in front, daylight from the side.'),
  'reception-desk': S('surface', false, 1.0, 0, ['chair', 'office-chair', 'stool'], 'room', 'A reception desk facing the entrance.'),
  table: S('surface', false, 0.75, 0.75, ['chair', 'bench', 'rug'], 'none', 'A table with chairs around it and room to pull them out.'),
  'cafe-table': S('surface', false, 0.6, 0.6, ['chair', 'stool'], 'none', 'A small table with its own chairs.'),
  'coffee-table': S('surface', false, 0.3, 0, ['sofa', 'armchair', 'rug'], 'none', 'A coffee table in reach of the sofa.'),
  'side-table': S('surface', false, 0, 0, ['sofa', 'armchair', 'lamp'], 'none', 'A side table beside a seat.'),
  counter: S('surface', true, 1.0, 0, ['stool', 'chair'], 'room', 'A counter against a wall with a working aisle in front.'),
  'kitchen-island': S('surface', false, 1.0, 0.9, ['stool'], 'room', 'A free-standing island with aisles all round.'),
  bookshelf: S('storage', true, 0.6, 0, ['desk', 'armchair', 'sofa'], 'room', 'Shelving against a wall, front free to reach the books.'),
  wardrobe: S('storage', true, 0.75, 0, ['bed', 'dresser'], 'room', 'A wardrobe against a wall with room to open its doors.'),
  dresser: S('storage', true, 0.6, 0, ['bed', 'lamp'], 'room', 'A chest of drawers against a wall with room to pull drawers out.'),
  nightstand: S('storage', true, 0.3, 0, ['bed', 'lamp'], 'room', 'A nightstand at the head of the bed.'),
  'storage-cabinet': S('storage', true, 0.6, 0, [], 'room', 'A cabinet against a wall with room to open it.'),
  'filing-cabinet': S('storage', true, 0.7, 0, ['desk'], 'room', 'A filing cabinet near the desk with room to pull drawers.'),
  'toy-storage': S('storage', true, 0.5, 0, ['bed', 'play-table'], 'room', 'Low storage at a child\'s reach, against a wall.'),
  'tv-unit': S('storage', true, 0.5, 0, ['sofa', 'rug'], 'room', 'A TV unit on the wall the sofa faces.'),
  sideboard: S('storage', true, 0.5, 0, ['table'], 'room', 'A sideboard against a wall near the table.'),
  rug: S('floor', false, 0, 0, ['sofa', 'coffee-table', 'table', 'bed'], 'none', 'A rug that ties a group together under the front legs.'),
  plant: S('decor', false, 0, 0, [], 'none', 'A floor plant that softens a corner.'),
  lamp: S('lighting', false, 0, 0, ['sofa', 'armchair', 'desk'], 'none', 'A floor lamp beside a seat.'),
  'room-divider': S('divider', false, 0.3, 0, [], 'none', 'A screen that separates two zones.'),
  'office-pod': S('appliance', true, 0.9, 0, [], 'room', 'A closed booth with its door kept clear.'),
  'treatment-bed': S('sleeping', false, 0.9, 0.9, ['stool'], 'none', 'A treatment bed with working room on both sides.'),
  // Themed pieces made for pets and dressing.
  'cat-tree': S('storage', true, 0.3, 0.1, [], 'room', 'A cat tree against a wall, ideally where the cat can see out.'),
  'pet-bed': S('storage', true, 0.15, 0, [], 'room', 'A pet bed along a quiet wall.'),
  'pet-bowls': S('storage', true, 0.15, 0, [], 'room', 'Food and water bowls on a mat against a wall.'),
  'litter-box': S('storage', true, 0.3, 0, [], 'room', 'A litter box tucked into a corner, away from the bowls.'),
  'toy-basket': S('storage', true, 0.1, 0, [], 'room', 'A toy basket against a wall.'),
  'window-perch': S('storage', true, 0.15, 0, [], 'window', 'A low perch under a window.'),
  'scratching-post': S('decor', false, 0.15, 0, [], 'none', 'A scratching post near where the cat rests.'),
  vanity: S('surface', true, 0.7, 0, ['stool', 'chair'], 'room', 'A vanity with a mirror against a wall, light from the side.'),
  statue: S('decor', false, 0.2, 0, [], 'room', 'A statue on a plinth, seen from the room.'),
};

const FALLBACK: Row = S('decor', false, 0.4, 0, [], 'room', 'A free-standing object.');

/** What an item is and how it wants to be used. Generated objects carry their own semantics. */
export function semanticsOf(item: FurnitureItem): ObjectSemantics {
  const own = item.custom?.semantics;
  if (own) return { ...own, pairsWith: [...(own.pairsWith ?? [])], tall: own.tall ?? item.h > 1.2 };
  const row = SEMANTICS[item.category] ?? (item.custom ? SEMANTICS[effectiveCategory(item)] : undefined) ?? FALLBACK;
  return { category: item.category, ...row, pairsWith: [...row.pairsWith], tall: item.h > 1.2 };
}

export type ZoneKind = 'sleep' | 'work' | 'lounge' | 'dining' | 'service' | 'storage' | 'decor';

/** Functional zone an item naturally belongs to, before looking at what else is in the room. */
export function zoneKindOf(item: FurnitureItem): ZoneKind {
  const c = semanticsOf(item).category;
  if (['bed', 'bunk-bed', 'crib', 'nightstand', 'treatment-bed'].includes(c)) return 'sleep';
  if (['desk', 'office-chair', 'desk-chair', 'filing-cabinet', 'office-pod', 'reception-desk'].includes(c)) return 'work';
  if (['sofa', 'sofa-bed', 'armchair', 'coffee-table', 'tv-unit', 'side-table'].includes(c)) return 'lounge';
  if (['table', 'cafe-table', 'chair', 'bench', 'sideboard'].includes(c)) return 'dining';
  if (['counter', 'kitchen-island', 'stool'].includes(c)) return 'service';
  if (['wardrobe', 'dresser', 'bookshelf', 'storage-cabinet', 'toy-storage'].includes(c)) return 'storage';
  return 'decor';
}

const ROLE_CATEGORY: Record<ObjectRole, string> = {
  seating: 'armchair', surface: 'table', storage: 'storage-cabinet', sleeping: 'bed', decor: 'plant',
  lighting: 'lamp', appliance: 'storage-cabinet', divider: 'room-divider', floor: 'rug',
};
// Words in a generated object's category, longest first, mapped to the category the rules know.
const WORDS: Array<[RegExp, string]> = [
  [/bunk|loft/, 'bunk-bed'], [/crib|cot\b/, 'crib'], [/sofa.?bed/, 'sofa-bed'], [/night.?stand|bedside/, 'nightstand'], [/bed/, 'bed'],
  [/sofa|couch|settee/, 'sofa'], [/arm.?chair|lounge chair|bean.?bag/, 'armchair'], [/office chair/, 'office-chair'], [/stool/, 'stool'], [/bench/, 'bench'], [/chair/, 'chair'],
  [/reception/, 'reception-desk'], [/desk|workstation/, 'desk'], [/coffee table/, 'coffee-table'], [/side table/, 'side-table'], [/island/, 'kitchen-island'],
  [/counter|bar\b/, 'counter'], [/table/, 'table'], [/wardrobe|closet|armoire/, 'wardrobe'], [/dresser|drawers/, 'dresser'], [/toy/, 'toy-storage'],
  [/book|shelf|shelves/, 'bookshelf'], [/tv|media/, 'tv-unit'], [/sideboard|buffet/, 'sideboard'], [/cabinet|cupboard|storage/, 'storage-cabinet'],
  [/rug|carpet/, 'rug'], [/lamp|light/, 'lamp'], [/plant|tree/, 'plant'], [/divider|screen|partition/, 'room-divider'], [/booth|pod/, 'office-pod'],
];

/** The category the layout rules use: a generated object's own words or role mapped onto a known one. */
export function effectiveCategory(item: Pick<FurnitureItem, 'category' | 'custom'>): string {
  if (SEMANTICS[item.category]) return item.category;
  const sem = item.custom?.semantics;
  const words = `${sem?.category ?? ''} ${item.category}`.toLowerCase();
  if (sem?.category && SEMANTICS[sem.category]) return sem.category;
  for (const [re, c] of WORDS) if (re.test(words)) return c;
  return sem?.role ? ROLE_CATEGORY[sem.role] : item.category;
}

/**
 * The item as the layout rules see it: a known category, clearances at least what its semantics ask
 * for, and the open footprint of its moving parts (a fold-down bed, an extending table) as unfolded size.
 * Returns the same object when nothing changes.
 */
export function normaliseItem(f: FurnitureItem): FurnitureItem {
  const spec = f.custom;
  const category = effectiveCategory(f);
  if (!spec && category === f.category) return f;
  let clearance = f.clearance, unfoldedD = f.unfoldedD;
  if (spec?.semantics) {
    const s = spec.semantics;
    // The item's own side zones win when it has any (a single bed open on one side); otherwise both sides.
    const own = f.clearance.left > 0 || f.clearance.right > 0;
    clearance = {
      front: Math.max(f.clearance.front, s.frontClearanceM ?? 0), back: f.clearance.back,
      left: own ? f.clearance.left : s.sideClearanceM ?? 0, right: own ? f.clearance.right : s.sideClearanceM ?? 0,
    };
  }
  const os = spec?.openSize;
  if (os && spec) {
    // The item may have been resized after generation: scale the open footprint with it.
    const kd = spec.size.d > 0 ? f.d / spec.size.d : 1, kw = spec.size.w > 0 ? f.w / spec.size.w : 1;
    const od = os.d * kd, ow = os.w * kw;
    if (od > f.d + 0.05) unfoldedD = Math.max(unfoldedD ?? 0, od);
    if (ow > f.w + 0.05) { const e = (ow - f.w) / 2; clearance = { ...clearance, left: Math.max(clearance.left, e), right: Math.max(clearance.right, e) }; }
  }
  return { ...f, category, clearance, unfoldedD };
}

export const isRug = (f: { category: string }) => f.category === 'rug';
export const isSeatCategory = (c: string) => ['chair', 'desk-chair', 'office-chair', 'stool', 'bench'].includes(c);
/** Same definition the referee uses: a seat belongs to the nearest desk, table or counter. */
export const isHostCategory = (c: string) => /desk|table|counter/.test(c) && !/coffee|side/.test(c);
export const isSoftSeat = (c: string) => c === 'sofa' || c === 'sofa-bed' || c === 'armchair';
export const isStorage = (c: string) => semanticsOfCategory(c).role === 'storage';
export function semanticsOfCategory(c: string): Row { return SEMANTICS[c] ?? FALLBACK; }
