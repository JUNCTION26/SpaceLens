import type { SpaceModel } from '../../core/types';

/** Returns a normalised model if the shape is valid, otherwise throws with a readable message. */
export function validateModel(x: unknown): SpaceModel {
  const m = x as Partial<SpaceModel> | null;
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('This file is not a SpaceLens project.');
  if (m.units !== 'm') throw new Error('Units must be metres ("m").');
  if (!Array.isArray(m.spaces) || !m.spaces.length) throw new Error('The project has no rooms.');
  const spaces = m.spaces.map((s) => {
    if (!s || !Array.isArray(s.polygon) || s.polygon.length < 3) throw new Error('Each room needs at least 3 corners.');
    if (!s.polygon.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))) throw new Error('Room corners must be numbers.');
    const walls = Array.isArray(s.walls) && s.walls.length === s.polygon.length
      ? s.walls
      : s.polygon.map(() => ({ thicknessM: 0.1, sourceKind: 'manual' as const, status: 'unknown' as const }));
    return { ...s, id: s.id ?? 'space', name: s.name ?? 'Room', walls };
  });
  return {
    id: m.id ?? 'imported', name: m.name ?? 'Imported', version: Number(m.version) || 1, units: 'm', ceilingM: Number(m.ceilingM) || 2.5,
    sourceLabel: m.sourceLabel ?? 'Imported file', spaces, openings: m.openings ?? [], furniture: m.furniture ?? [],
    measurements: m.measurements ?? [], evidence: m.evidence ?? [],
  };
}
