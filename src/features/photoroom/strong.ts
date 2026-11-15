// A Gemini call that tries the stronger models first. The shared router picks the fastest model that
// answers, which for image work can be a lite model; reading a whole room from a photo needs a stronger one.

import { AiError, classify, currentTransport } from '../../core/ai';
import type { ModelRequest } from '../../core/ai/engine';
import { loadServerModels, routeFor, runRouted, TIMING } from '../../core/ai/router';

export const STRONG_VISION = ['gemini-4-hydrogen', 'gemini-3.8-flash'];

/** Runs one call, stronger models first, falling through to the usual route. Throws an Error with a safe message. */
export async function strongCall<T>(req: ModelRequest, opts: { task?: 'vision' | 'smart' | 'fast'; prefer?: string[]; signal?: AbortSignal; parse?: boolean } = {}): Promise<{ data: T; model: string }> {
  const t = currentTransport();
  if (!t) throw Object.assign(new Error('No Gemini key set'), { reason: 'no_key' });
  const task = opts.task ?? 'vision';
  try {
    await loadServerModels(t);
    const base = routeFor(t, task);
    const order = [...new Set([...(opts.prefer ?? STRONG_VISION).filter((m) => base.includes(m)), ...base])];
    let data: T | undefined;
    const parse = opts.parse ?? Boolean(req.schema || req.json);
    const out = await runRouted(t, order, req, TIMING[task], opts.signal, {
      accept: (o) => {
        if (!parse) { data = o.text as T; return; }
        const text = o.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
        try { data = JSON.parse(text) as T; } catch { throw new AiError(`${o.model}: invalid JSON`, 'parse'); }
      },
    });
    return { data: data as T, model: out.model };
  } catch (e) {
    const p = classify(e);
    throw Object.assign(new Error(p.message), { reason: p.reason });
  }
}
