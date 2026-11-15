export interface P3 { x: number; y: number; z: number }

export type MeasureState =
  | { phase: 'idle' }
  | { phase: 'first'; a: P3 }
  | { phase: 'done'; a: P3; b: P3; metres: number };

export const idle: MeasureState = { phase: 'idle' };

export const distance = (a: P3, b: P3) => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);

/** Label text in metres, for example "3.42 m". */
export const formatMetres = (m: number) => `${m.toFixed(2)} m`;

/** Midpoint of the measured line, where the label sits. */
export const midpoint = (a: P3, b: P3): P3 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });

/** One tap: first point, then second point (a measurement), then a third tap starts a new one. */
export function tap(s: MeasureState, p: P3): MeasureState {
  if (s.phase === 'idle') return { phase: 'first', a: p };
  if (s.phase === 'first') return { phase: 'done', a: s.a, b: p, metres: distance(s.a, p) };
  return { phase: 'first', a: p };
}

/** Metres in a finished measurement, or null. */
export const measured = (s: MeasureState): number | null => (s.phase === 'done' ? s.metres : null);

/** Receiver for the length of a finished measurement, for example the wall-length input. */
export type MeasureCallback = (metres: number) => void;
let sink: MeasureCallback | null = null;
/** Register where finished lengths go (pass null to clear). Returns an unsubscribe function. */
export function setMeasureCallback(cb: MeasureCallback | null): () => void {
  sink = cb;
  return () => { if (sink === cb) sink = null; };
}
export function reportMeasured(metres: number) { if (sink && Number.isFinite(metres) && metres > 0) sink(metres); }

/** Whether a plan point is free floor: inside a room and outside every furniture footprint. */
export function isFreeFloor<R, F>(
  p: { x: number; y: number }, rooms: R[], furniture: F[],
  inRoom: (p: { x: number; y: number }, r: R) => boolean, onItem: (p: { x: number; y: number }, f: F) => boolean,
): boolean {
  return rooms.some((r) => inRoom(p, r)) && !furniture.some((f) => onItem(p, f));
}
