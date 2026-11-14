// Feature modules the agent calls, loaded lazily and only if they exist in the build.
// import.meta.glob resolves at build time to an empty map for missing files, so the agent keeps
// working (with fallbacks) while those features are still being built.
import type {
  DesignReport, FurnitureItem, Infeasibility, LayoutCandidate, ObjectSpec, Requirements, SpaceModel, StoreListing,
} from '../../core/types';

export interface ForgeMod { generateObject: (prompt: string, opts?: { onPartial?: (spec: Partial<ObjectSpec>) => void; signal?: AbortSignal }) => Promise<ObjectSpec> }
export interface PipelineReport extends DesignReport {
  conceptName?: string; idea?: string; designScore?: number; finalScore?: number;
  critique?: DesignReport['critique'];
}
export interface PipelineMod {
  designRoom: (model: SpaceModel, req: Requirements, opts?: { onStage?: (stages: Array<{ id: string; label: string; status: string; ms?: number }>) => void; brief?: string; signal?: AbortSignal }) =>
    Promise<{ candidates: LayoutCandidate[]; reports: PipelineReport[]; infeasibility: Infeasibility | null }>;
}
export interface ReportStoreMod {
  useReports: {
    getState: () => { reports: Record<string, PipelineReport>; setReports: (list: PipelineReport[]) => void; setStages?: (stages: unknown[], running?: boolean) => void };
  };
}
export interface RulesMod { evaluateRules: (model: SpaceModel, furniture: FurnitureItem[], req: Requirements | null) => unknown }
export interface SafetyMod { assessSafety: (model: SpaceModel, furniture: FurnitureItem[]) => unknown }
export interface StoresMod { searchProducts: (query: string) => Promise<StoreListing[]> }
export interface IntentMod { compileIntent: (text: string, model: SpaceModel) => Promise<Requirements> }

interface ModMap { forge: ForgeMod; pipeline: PipelineMod; reports: ReportStoreMod; rules: RulesMod; safety: SafetyMod; stores: StoresMod; intent: IntentMod }

const GLOB = import.meta.glob([
  '../forge/generate.ts', '../design/pipeline.ts', '../design/reportStore.ts', '../design/rules.ts',
  '../safety/assess.ts', '../stores/search.ts', '../intent/compile.ts',
]);
const PATH: Record<keyof ModMap, string> = {
  forge: '../forge/generate.ts', pipeline: '../design/pipeline.ts', reports: '../design/reportStore.ts', rules: '../design/rules.ts',
  safety: '../safety/assess.ts', stores: '../stores/search.ts', intent: '../intent/compile.ts',
};

const cache: Partial<ModMap> = {};

/** Load a feature module; null when it is not in the build or fails to load. */
export async function loadMod<K extends keyof ModMap>(k: K): Promise<ModMap[K] | null> {
  if (cache[k]) return cache[k]!;
  const loader = GLOB[PATH[k]];
  if (!loader) return null;
  try { const m = (await loader()) as ModMap[K]; cache[k] = m; return m; } catch { return null; }
}

/** A module already loaded by loadMod, for synchronous reads. */
export const loadedMod = <K extends keyof ModMap>(k: K): ModMap[K] | null => cache[k] ?? null;

/** Warm the modules the world state reads synchronously. */
export const preloadMods = () => { void loadMod('reports'); };
