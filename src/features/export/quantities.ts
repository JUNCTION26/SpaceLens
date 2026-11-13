import type { SpaceModel } from '../../core/types';
import { area, perimeter } from '../../core/geometry';

export interface Quantities { floorM2: number; wallNetM2: number; skirtingM: number; paintL: number }

/** Paint: 10 m² per litre per coat, 2 coats. */
export function quantities(model: SpaceModel): Quantities {
  let floor = 0, per = 0;
  for (const s of model.spaces) { floor += area(s.polygon); per += perimeter(s.polygon); }
  const openArea = model.openings.reduce((t, o) => t + o.widthM * o.heightM, 0);
  const doorW = model.openings.filter((o) => o.kind !== 'window').reduce((t, o) => t + o.widthM, 0);
  const wallNet = Math.max(0, per * model.ceilingM - openArea);
  return { floorM2: floor, wallNetM2: wallNet, skirtingM: Math.max(0, per - doorW), paintL: (wallNet * 2) / 10 };
}
