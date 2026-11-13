import { add, dist, dot, mul, norm, sub } from './geometry';
import type { Op, SpaceModel } from './types';

const bump = (m: SpaceModel): SpaceModel => ({ ...m, version: m.version + 1 });

/** Pure reducer: every edit to the space goes through here. */
export function applyOp(model: SpaceModel, op: Op): SpaceModel {
  switch (op.type) {
    case 'REPLACE_MODEL':
      return { ...op.model, version: model.version + 1 };

    case 'SET_WALL_LENGTH': {
      const spaces = model.spaces.map((s) => {
        if (s.id !== op.spaceId) return s;
        const n = s.polygon.length;
        const a = s.polygon[op.wallIndex], b = s.polygon[(op.wallIndex + 1) % n];
        const cur = dist(a, b);
        if (cur < 1e-9 || op.lengthM <= 0) return s;
        const dir = norm(sub(b, a));
        const delta = op.lengthM - cur;
        const far = dot(sub(b, a), dir);
        // Shift every vertex at or beyond the wall's far end along the wall direction.
        // Keeps rectangles and orthogonal L-shapes rectangular.
        const polygon = s.polygon.map((p) => (dot(sub(p, a), dir) >= far - 1e-6 ? add(p, mul(dir, delta)) : p));
        const walls = s.walls.map((w, i) => (i === op.wallIndex ? { ...w, sourceKind: op.sourceKind ?? 'manual', status: 'verified' as const } : w));
        return { ...s, polygon, walls };
      });
      return bump({ ...model, spaces });
    }

    case 'MOVE_VERTEX':
      return bump({
        ...model,
        spaces: model.spaces.map((s) => (s.id !== op.spaceId ? s : { ...s, polygon: s.polygon.map((p, i) => (i === op.index ? op.to : p)) })),
      });

    case 'INSERT_VERTEX':
      return bump({
        ...model,
        spaces: model.spaces.map((s) => {
          if (s.id !== op.spaceId) return s;
          const polygon = [...s.polygon]; polygon.splice(op.afterIndex + 1, 0, op.at);
          const walls = [...s.walls]; walls.splice(op.afterIndex + 1, 0, { ...s.walls[op.afterIndex] });
          return { ...s, polygon, walls };
        }),
        openings: model.openings.map((o) => (o.spaceId === op.spaceId && o.wallIndex > op.afterIndex ? { ...o, wallIndex: o.wallIndex + 1 } : o)),
      });

    case 'REMOVE_VERTEX':
      return bump({
        ...model,
        spaces: model.spaces.map((s) => {
          if (s.id !== op.spaceId || s.polygon.length <= 3) return s;
          return { ...s, polygon: s.polygon.filter((_, i) => i !== op.index), walls: s.walls.filter((_, i) => i !== op.index) };
        }),
        openings: model.openings
          .filter((o) => !(o.spaceId === op.spaceId && o.wallIndex === op.index))
          .map((o) => (o.spaceId === op.spaceId && o.wallIndex > op.index ? { ...o, wallIndex: o.wallIndex - 1 } : o)),
      });

    case 'SET_CEILING':
      return bump({ ...model, ceilingM: op.heightM });

    case 'ADD_OPENING':
      return bump({ ...model, openings: [...model.openings, op.opening] });
    case 'UPDATE_OPENING':
      return bump({ ...model, openings: model.openings.map((o) => (o.id === op.id ? { ...o, ...op.patch } : o)) });
    case 'REMOVE_OPENING':
      return bump({ ...model, openings: model.openings.filter((o) => o.id !== op.id) });

    case 'PLACE_OBJECT':
      return bump({ ...model, furniture: [...model.furniture, op.item] });
    case 'UPDATE_OBJECT':
      return bump({ ...model, furniture: model.furniture.map((f) => (f.id === op.id ? { ...f, ...op.patch } : f)) });
    case 'REMOVE_OBJECT':
      return bump({ ...model, furniture: model.furniture.filter((f) => f.id !== op.id) });
    case 'SET_FURNITURE':
      return bump({ ...model, furniture: op.items });

    case 'ADD_EVIDENCE':
      return bump({ ...model, evidence: [...model.evidence.filter((e) => e.id !== op.evidence.id), op.evidence] });
    case 'SET_MEASUREMENT':
      return bump({ ...model, measurements: [...model.measurements.filter((m) => m.id !== op.measurement.id), op.measurement] });

    case 'RENAME':
      return bump({ ...model, name: op.name });
  }
}

export function describeOp(op: Op): string {
  switch (op.type) {
    case 'REPLACE_MODEL': return `Loaded "${op.model.name}"`;
    case 'SET_WALL_LENGTH': return `Wall set to ${op.lengthM.toFixed(2)} m`;
    case 'MOVE_VERTEX': return 'Corner moved';
    case 'INSERT_VERTEX': return 'Corner added';
    case 'REMOVE_VERTEX': return 'Corner removed';
    case 'SET_CEILING': return `Ceiling set to ${op.heightM.toFixed(2)} m`;
    case 'ADD_OPENING': return `${op.opening.kind} added`;
    case 'UPDATE_OPENING': return 'Opening changed';
    case 'REMOVE_OPENING': return 'Opening removed';
    case 'PLACE_OBJECT': return `${op.item.name} placed`;
    case 'UPDATE_OBJECT': return 'Object changed';
    case 'REMOVE_OBJECT': return 'Object removed';
    case 'SET_FURNITURE': return op.label ?? 'Layout applied';
    case 'ADD_EVIDENCE': return 'Evidence added';
    case 'SET_MEASUREMENT': return `Measurement "${op.measurement.label}" set`;
    case 'RENAME': return `Renamed to "${op.name}"`;
  }
}
