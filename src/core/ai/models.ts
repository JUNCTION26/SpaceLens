/** 'fast' = lowest latency for decisions; 'smart' = best reasoning; 'vision' = image input. */
export type AiTask = 'fast' | 'smart' | 'vision';

export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

/**
 * Candidate models per task, best first. Which one actually runs is decided at call time
 * from measured latency and health, so a key with more quota simply unlocks the earlier ones.
 */
export const CANDIDATES: Record<'fast' | 'smart', string[]> = {
  fast: ['gemini-4-hydrogen', 'gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-flash-lite-latest'],
  smart: ['gemini-4-carbon', 'gemini-4-argon', 'gemini-4-hydrogen', 'gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite'],
};

export function candidatesFor(task: AiTask): string[] {
  if (task === 'vision') return CANDIDATES.smart.filter(acceptsImages);
  return CANDIDATES[task];
}

/** Every model any task may use, deduplicated, in first-seen order. */
export function allCandidates(): string[] {
  return [...new Set([...CANDIDATES.fast, ...CANDIDATES.smart])];
}

/** "gemini-3.5-flash-lite" -> "3.5-flash-lite", "gemini-4-carbon" -> "4-carbon". */
export const shortModel = (model: string) => model.replace(/^models\//, '').replace(/^gemini-/, '');

// ---- Capabilities learned from the API, remembered per model in this browser ----

interface Learned { noThinking?: boolean; noImages?: boolean }
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
