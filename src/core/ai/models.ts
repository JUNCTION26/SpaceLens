/** 'fast' = lowest latency for decisions; 'smart' = best reasoning; 'vision' = image input. */
export type AiTask = 'fast' | 'smart' | 'vision';

export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

/**
 * Candidate models per task, best first. Which one actually runs is decided at call time
 * from measured latency and health, so a key with more quota simply unlocks the earlier ones.
 */
export const CANDIDATES: Record<'fast' | 'smart', string[]> = {
  fast: ['gemini-4-hydrogen', 'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-flash-lite-latest'],
  smart: ['gemini-4-carbon', 'gemini-4-argon', 'gemini-4-hydrogen', 'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite'],
};

export const TASKS: AiTask[] = ['fast', 'smart', 'vision'];

/** Models the key offers that the lists above do not name yet (found through the model list). */
let extras: string[] | null = null;
const LS_EXTRAS = 'spacelens.ai.extras.v1';

export function extraModels(): string[] {
  if (!extras) {
    try { extras = JSON.parse(storage()?.getItem(LS_EXTRAS) ?? '[]') as string[]; } catch { extras = []; }
  }
  return extras;
}
export function setExtraModels(list: string[]) {
  extras = list;
  try { storage()?.setItem(LS_EXTRAS, JSON.stringify(list)); } catch { /* storage blocked */ }
}

const known = () => new Set([...CANDIDATES.fast, ...CANDIDATES.smart]);

/**
 * From a ListModels response: the newest text models (flash, flash-lite, pro) that no list names yet.
 * Specialised families (tts, image, live, embedding, ...) never qualify.
 */
export function pickNewModels(list: { name: string; supportedGenerationMethods?: string[] }[], max = 3): string[] {
  const have = known();
  const ver = (m: string) => parseFloat(m.match(/^gemini-(\d+(?:\.\d+)?)/)?.[1] ?? '0');
  return list
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''))
    .filter((m) => /^gemini-\d+(\.\d+)?-(flash|flash-lite|pro)$/.test(m) && !have.has(m))
    .sort((a, b) => ver(b) - ver(a))
    .slice(0, max);
}

// ---- per-task user override, remembered in this browser ----

const LS_OVERRIDE = 'spacelens.ai.override.v1';
export function getOverrides(): Partial<Record<AiTask, string>> {
  try { return JSON.parse(storage()?.getItem(LS_OVERRIDE) ?? '{}') as Partial<Record<AiTask, string>>; } catch { return {}; }
}
export function setOverride(task: AiTask, model: string) {
  const o = getOverrides();
  if (model) o[task] = model; else delete o[task];
  try { storage()?.setItem(LS_OVERRIDE, JSON.stringify(o)); } catch { /* storage blocked */ }
}

export function candidatesFor(task: AiTask): string[] {
  if (task === 'vision') return [...CANDIDATES.smart, ...extraModels()].filter(acceptsImages);
  return [...CANDIDATES[task], ...extraModels()];
}

/** Every model any task may use, deduplicated, in first-seen order. */
export function allCandidates(): string[] {
  return [...new Set([...CANDIDATES.fast, ...CANDIDATES.smart, ...extraModels()])];
}

/** "gemini-3.5-flash-lite" -> "3.5-flash-lite", "gemini-4-carbon" -> "4-carbon". */
export const shortModel = (model: string) => model.replace(/^models\//, '').replace(/^gemini-/, '');

// ---- Capabilities learned from the API, remembered per model in this browser ----

interface Learned { noThinking?: boolean; noImages?: boolean; floor?: ThinkingLevel }
const LS_LEARNED = 'spacelens.ai.learned.v1';
let learned: Record<string, Learned> | null = null;

function storage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

function learnedMap(): Record<string, Learned> {
  if (!learned) {
    try { learned = JSON.parse(storage()?.getItem(LS_LEARNED) ?? '{}') as Record<string, Learned>; } catch { learned = {}; }
  }
  return learned;
}

function learn(model: string, patch: Learned) {
  const map = learnedMap();
  map[model] = { ...map[model], ...patch };
  try { storage()?.setItem(LS_LEARNED, JSON.stringify(map)); } catch { /* storage blocked */ }
}

export const acceptsThinking = (model: string) => !learnedMap()[model]?.noThinking;
export const markNoThinking = (model: string) => learn(model, { noThinking: true });
export const acceptsImages = (model: string) => !learnedMap()[model]?.noImages && !/embedding|tts|imagen|veo/.test(model);
export const markNoImages = (model: string) => learn(model, { noImages: true });

// ---- thinking levels: some families (3.7+ flash, 4) reject 'minimal'; the lowest accepted level is learned ----

export const LEVELS: ThinkingLevel[] = ['minimal', 'low', 'medium', 'high'];
export const nextLevel = (l: ThinkingLevel): ThinkingLevel | null => LEVELS[LEVELS.indexOf(l) + 1] ?? null;
/** The level to send: never below what the model is known to accept. */
export function clampLevel(model: string, level: ThinkingLevel): ThinkingLevel {
  const floor = learnedMap()[model]?.floor;
  return floor && LEVELS.indexOf(level) < LEVELS.indexOf(floor) ? floor : level;
}
export const markThinkingFloor = (model: string, floor: ThinkingLevel) => learn(model, { floor });
/** "Thinking level MINIMAL is not supported for this model" -> true */
export const isLevelRejection = (message: string) => /thinking level \w+ is not supported/i.test(message);
