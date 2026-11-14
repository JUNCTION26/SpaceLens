// Plans a building off the main thread so the panel stays responsive while options are searched.
import { planBuilding, type PlanOptions, type ShellEntrance, type ShellWindow } from './partition';
import type { RoomProgramme } from './programme';
import type { Vec2 } from '../../core/types';

export interface PlanJob { id: number; shell: Vec2[]; entrances: ShellEntrance[]; windows: ShellWindow[]; programme: RoomProgramme; opts: PlanOptions }

const scope = self as unknown as { onmessage: ((e: MessageEvent<PlanJob>) => void) | null; postMessage: (m: unknown) => void };
scope.onmessage = (e) => {
  const j = e.data;
  try { scope.postMessage({ id: j.id, plans: planBuilding(j.shell, j.entrances, j.windows, j.programme, j.opts) }); }
  catch (err) { scope.postMessage({ id: j.id, error: (err as Error).message }); }
};
