import { centroid, convexOverlap, itemCorners, polygonInside } from '../../core/geometry';
import type { FurnitureItem, SpaceModel } from '../../core/types';

/** Drag-and-drop payload type for catalog items (library -> plan / 3D). Data = catalogId. */
export const CATALOG_DND = 'application/x-spacelens-catalog';

/** First pose where `item` fits inside the room without overlapping `others`. Falls back to the room centre. */
export function findFreeSpot(model: SpaceModel, item: FurnitureItem, others: FurnitureItem[] = model.furniture): { x: number; y: number; rotation: number } {
  const poly = model.spaces[0]?.polygon ?? [];
  const c = centroid(poly);
  for (let r = 0; r < 4; r += 0.1) {
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
      for (const rotation of [item.rotation, item.rotation + Math.PI / 2]) {
        const pose = { x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r, rotation };
        const corners = itemCorners({ ...item, ...pose });
        if (!polygonInside(corners, poly)) continue;
        if (others.some((o) => o.id !== item.id && o.category !== 'rug' && convexOverlap(corners, itemCorners(o)) > 0)) continue;
        return pose;
      }
    }
  }
  return { x: c.x, y: c.y, rotation: item.rotation };
}
