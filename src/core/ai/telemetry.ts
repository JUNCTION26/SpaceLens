import { shortModel, type AiTask } from './models';

// ---------------------------------------------------------------- usage

export interface ModelUsage { calls: number; errors: number; inputTokens: number; outputTokens: number; ms: number }

const stats: Record<string, ModelUsage> = {};

export function recordUsage(model: string, patch: Partial<ModelUsage>) {
  const s = (stats[model] ??= { calls: 0, errors: 0, inputTokens: 0, outputTokens: 0, ms: 0 });
  s.calls += patch.calls ?? 0;
  s.errors += patch.errors ?? 0;
  s.inputTokens += patch.inputTokens ?? 0;
  s.outputTokens += patch.outputTokens ?? 0;
  s.ms += patch.ms ?? 0;
}

/** Per-model usage for this session (calls = successful answers; ms = summed wall time). */
export function aiStats(): Record<string, ModelUsage> {
  return Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, { ...v }]));
}

const tasks: Partial<Record<AiTask, { calls: number; ms: number; inputTokens: number; outputTokens: number }>> = {};

export function recordTask(task: AiTask, ms: number, inputTokens: number, outputTokens: number) {
  const t = (tasks[task] ??= { calls: 0, ms: 0, inputTokens: 0, outputTokens: 0 });
  t.calls += 1; t.ms += ms; t.inputTokens += inputTokens; t.outputTokens += outputTokens;
}

/** Calls, tokens and average answer time per task this session. */
export function aiTaskStats() {
  return (Object.entries(tasks) as [AiTask, NonNullable<(typeof tasks)[AiTask]>][]).map(([task, t]) => ({ task, calls: t.calls, avgMs: Math.round(t.ms / t.calls), inputTokens: t.inputTokens, outputTokens: t.outputTokens }));
}

/** List prices in USD per million tokens (input, output) where known. Anything else shows tokens only. */
export const PRICES_PER_M: Record<string, [number, number]> = {
  'gemini-2.5-flash': [0.3, 2.5],
  'gemini-2.5-flash-lite': [0.1, 0.4],
};

/** Estimated cost of this session's calls, or null when any model used has no known price. */
export function estimateCostUsd(): number | null {
  let sum = 0;
  for (const [m, u] of Object.entries(stats)) {
    if (!u.inputTokens && !u.outputTokens) continue;
    const p = PRICES_PER_M[m.replace(/^models\//, '')];
    if (!p) return null;
    sum += (u.inputTokens * p[0] + u.outputTokens * p[1]) / 1e6;
  }
  return sum;
}

// ---------------------------------------------------------------- activity events

export interface AiActivity {
  /** Same id for every event of one ai() call. */
  id: number;
  task: AiTask;
  phase: 'start' | 'model' | 'streaming' | 'done' | 'cached' | 'error' | 'waking' | 'awake';
  model?: string;
  /** Milliseconds since the call started. */
  ms: number;
  /** Ready-to-show line, e.g. "Gemini · 3.5-flash-lite · 1.2 s". */
  label: string;
  error?: string;
  /** Plain category when phase is 'error'. */
  reason?: import('./errors').AiReason;
}

const listeners = new Set<(e: AiActivity) => void>();

export function onAiActivity(cb: (e: AiActivity) => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function emitActivity(e: Omit<AiActivity, 'label'>) {
  const parts = ['Gemini'];
  if (e.model) parts.push(shortModel(e.model));
  if (e.phase === 'cached') parts.push('cached');
  else if (e.phase === 'error') parts.push('failed');
  else if (e.phase === 'start' || e.phase === 'model' || e.phase === 'waking') parts.push('…');
  else parts.push(`${(e.ms / 1000).toFixed(1)} s`);
  const full: AiActivity = { ...e, label: parts.join(' · ') };
  listeners.forEach((cb) => { try { cb(full); } catch { /* a listener must not break the call */ } });
}

// ---------------------------------------------------------------- cache

const SS_PREFIX = 'spacelens.ai.cache.';
const memory = new Map<string, unknown>();

function session(): Storage | null {
  try { return typeof sessionStorage === 'undefined' ? null : sessionStorage; } catch { return null; }
}

export function cacheGet<T>(key: string): T | undefined {
  if (memory.has(key)) return memory.get(key) as T;
  try {
    const raw = session()?.getItem(SS_PREFIX + key);
    if (raw) { const v = JSON.parse(raw) as T; memory.set(key, v); return v; }
  } catch { /* ignore */ }
  return undefined;
}

export function cacheSet(key: string, value: unknown) {
  memory.set(key, value);
  try { session()?.setItem(SS_PREFIX + key, JSON.stringify(value)); } catch { /* quota or blocked */ }
}

export function clearAiCache() {
  memory.clear();
  const s = session();
  if (!s) return;
  try {
    for (let i = s.length - 1; i >= 0; i--) { const k = s.key(i); if (k?.startsWith(SS_PREFIX)) s.removeItem(k); }
  } catch { /* ignore */ }
}
