import type { Op, Vec2 } from '../../core/types';

/** error: breaks the layout. warn: works but worse to live with. tip: a suggestion. */
export type ProblemSeverity = 'error' | 'warn' | 'tip';
export type ProblemSource = 'check' | 'design' | 'safety';

/** Where an item ends up if a fix runs; drawn as a ghost on the plan. */
export interface GhostPose { id: string; x: number; y: number; rotation: number; w: number; d: number; removed?: boolean }

export interface Fix {
  id: string;
  /** Short, plain verb phrase: "Move 20 cm left", "Turn to face the room", "Remove". */
  label: string;
  ops: Op[];
  /** Items as they will be after the fix. */
  preview: GhostPose[];
  /** Verified to clear the problem without causing a new one; Fix all only runs safe fixes. */
  safe: boolean;
  kind: 'move' | 'rotate' | 'swap' | 'remove' | 'opening' | 'go';
  /** Navigation fixes (open a panel) run this instead of ops. */
  go?: string;
}

export interface Problem {
  /** Stable across recomputes for the same issue. */
  id: string;
  severity: ProblemSeverity;
  source: ProblemSource;
  /** Short rule name, e.g. "Clearance". */
  rule: string;
  /** Furniture ids involved; the first unlocked one is what fixes move. */
  itemIds: string[];
  /** Door / window ids involved. */
  openingIds: string[];
  /** Where to put the marker, plan metres. */
  at: Vec2 | null;
  /** One plain sentence with numbers. */
  title: string;
  fixes: Fix[];
}

export const SEVERITY_ORDER: Record<ProblemSeverity, number> = { error: 0, warn: 1, tip: 2 };
export const SEVERITY_LABEL: Record<ProblemSeverity, string> = { error: 'Must fix', warn: 'Worth fixing', tip: 'Suggestion' };
