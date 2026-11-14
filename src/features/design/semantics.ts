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
};

const FALLBACK: Row = S('decor', false, 0.4, 0, [], 'room', 'A free-standing object.');

/** What an item is and how it wants to be used. Generated objects carry their own semantics. */
export function semanticsOf(item: FurnitureItem): ObjectSemantics {
  const own = item.custom?.semantics;
  if (own) return { ...own, pairsWith: [...(own.pairsWith ?? [])], tall: own.tall ?? item.h > 1.2 };
  const row = SEMANTICS[item.category] ?? FALLBACK;
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

export const isSeatCategory = (c: string) => ['chair', 'desk-chair', 'office-chair', 'stool', 'bench'].includes(c);
/** Same definition the referee uses: a seat belongs to the nearest desk, table or counter. */
export const isHostCategory = (c: string) => /desk|table|counter/.test(c) && !/coffee|side/.test(c);
export const isSoftSeat = (c: string) => c === 'sofa' || c === 'sofa-bed' || c === 'armchair';
export const isStorage = (c: string) => semanticsOfCategory(c).role === 'storage';
export function semanticsOfCategory(c: string): Row { return SEMANTICS[c] ?? FALLBACK; }
