import type { FurnitureItem } from '../../core/types';

/** A CC0 glTF model (Poly Haven) and the yaw that turns its front to local +z. */
export interface ModelSpec { id: string; yaw: number; /** Material names that read as fabric and take the item colour as a tint. */ fabric?: string[] }

const m = (id: string, yaw = 0, fabric?: string[]): ModelSpec => ({ id, yaw, fabric });
const SOFA = m('sofa_02', 0, ['sofa_02']);

const BY_ID: Record<string, ModelSpec> = {
  'play-table': m('side_table_01'),
};
const BY_CATEGORY: Record<string, ModelSpec> = {
  sofa: SOFA, 'sofa-bed': SOFA,
  armchair: m('modern_arm_chair_01', 0, ['modern_arm_chair_01_pillow']),
  chair: m('dining_chair_02'),
  desk: m('metal_office_desk'),
  table: m('dining_table'),
  'coffee-table': m('modern_coffee_table_01', Math.PI / 2),
  bed: m('old_bed_frame'),
  storage: m('modern_wooden_cabinet'),
  'storage-cabinet': m('modern_wooden_cabinet'),
  'tv-unit': m('modern_wooden_cabinet'),
  dresser: m('drawer_cabinet'),
  'filing-cabinet': m('drawer_cabinet'),
  bookshelf: m('wooden_bookshelf_worn'),
  'toy-storage': m('steel_frame_shelves_01'),
  nightstand: m('ClassicNightstand_01'),
  stool: m('bar_chair_round_01'),
};

export function modelSpecFor(item: Pick<FurnitureItem, 'catalogId' | 'category'>): ModelSpec | undefined {
  return BY_ID[item.catalogId] ?? BY_CATEGORY[item.category];
}

export function modelUrl(spec: ModelSpec): string {
  return `${import.meta.env.BASE_URL}assets/models/${spec.id}/${spec.id}.gltf`;
}

/** Model URL for an item, or undefined when it keeps the procedural mesh. */
export function modelFor(item: Pick<FurnitureItem, 'catalogId' | 'category'>): string | undefined {
  const s = modelSpecFor(item);
  return s && modelUrl(s);
}
