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

// ---------------------------------------------------------------- activity events

export interface AiActivity {
  /** Same id for every event of one ai() call. */
  id: number;
  task: AiTask;
  phase: 'start' | 'model' | 'streaming' | 'done' | 'cached' | 'error';
  model?: string;
  /** Milliseconds since the call started. */
  ms: number;
  /** Ready-to-show line, e.g. "Gemini · 3.5-flash-lite · 1.2 s". */
  label: string;
  error?: string;
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
  else if (e.phase === 'start' || e.phase === 'model') parts.push('…');
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
