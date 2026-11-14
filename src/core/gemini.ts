import { getState } from './store';
import { apiBase } from './ai/transport';

export interface GeminiPart { text?: string; inlineData?: { mimeType: string; data: string } }

/** Gemini is available with a personal key, or through the SpaceLens server when VITE_API_BASE is set. */
export const hasGemini = () => Boolean(getState().settings.geminiKey) || Boolean(apiBase());

/**
 * One Gemini call through the shared router: the fastest healthy model, fall-through when a model
 * is busy or out of quota, and a plain message on failure. A personal key stays in this browser and goes
 * only to Google; without one, calls go through the SpaceLens server, which holds its own key. Returns parsed JSON when `json` or `schema` is set. Throws an Error whose message is
 * safe to show (never raw API text), with `.reason` set, so callers can fall back to local logic.
 */
export async function gemini<T = string>(parts: GeminiPart[], opts: { json?: boolean; schema?: object; system?: string; timeoutMs?: number; task?: 'fast' | 'smart' | 'vision' } = {}): Promise<T> {
  const { ai, classify } = await import('./ai');
  const hasImage = parts.some((p) => p.inlineData);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 120000);
  try {
    const r = await ai<T>({ task: opts.task ?? (hasImage ? 'vision' : 'smart'), parts, system: opts.system, schema: opts.schema, json: opts.json, signal: ctrl.signal });
    // Features that show "model used" read this setting.
    if (getState().settings.geminiModel !== r.model) getState().setSettings({ geminiModel: r.model });
    return r.data;
  } catch (e) {
    const p = classify(e);
    throw Object.assign(new Error(p.message), { reason: p.reason });
  } finally {
    clearTimeout(timer);
  }
}

/** Running totals for the session, shown in Settings. */
export const usage = { calls: 0, inputTokens: 0, outputTokens: 0 };

export async function fileToInlineData(file: Blob): Promise<GeminiPart> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { inlineData: { mimeType: file.type || 'image/png', data: btoa(bin) } };
}

export function dataUrlToInlineData(dataUrl: string): GeminiPart {
  const [head, data] = dataUrl.split(',');
  const mimeType = head.match(/data:(.*?);/)?.[1] ?? 'image/png';
  return { inlineData: { mimeType, data } };
}
