import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBody, chunkText } from './engine';
import { acceptsThinking, candidatesFor, LADDERS, shortModel } from './models';
import { AiError } from './engine';
import { hashKey, isExhausted, markUnhealthy, nextUtcMidnight, rankModels, resetExhausted, resetHealth, routeFor, runRouted, type ModelStatus } from './router';
import { SseParser } from './sse';

const ok = (model: string, totalMs: number): ModelStatus => ({ model, ok: true, firstTokenMs: totalMs, totalMs });
const bad = (model: string): ModelStatus => ({ model, ok: false, firstTokenMs: null, totalMs: null, error: 'x' });

describe('SseParser', () => {
  it('splits events across arbitrary chunk boundaries', () => {
    const p = new SseParser();
    const stream = 'data: {"a":1}\n\ndata: {"b":\r\n\r\ndata: 2}\n\ndata: tail';
    const got: string[] = [];
    for (const ch of stream) got.push(...p.push(ch));
    got.push(...p.flush());
    expect(got).toEqual(['{"a":1}', '{"b":', '2}', 'tail']);
  });
});

describe('engine helpers', () => {
  it('ignores thought parts', () => {
    expect(chunkText({ candidates: [{ content: { parts: [{ text: 'plan', thought: true }, { text: 'answer' }] } }] })).toBe('answer');
    expect(chunkText({})).toBe('');
  });
  it('only sends thinkingConfig when allowed', () => {
    const req = { parts: [{ text: 'hi' }], thinking: 'minimal' as const, schema: { type: 'OBJECT' } };
    expect(JSON.stringify(buildBody(req, true))).toContain('thinkingLevel');
    expect(JSON.stringify(buildBody(req, false))).not.toContain('thinking');
    expect(JSON.stringify(buildBody(req, false))).toContain('application/json');
  });
});

describe('models', () => {
  it('names and candidate lists', () => {
    expect(shortModel('gemini-3.5-flash-lite')).toBe('3.5-flash-lite');
    expect(candidatesFor('vision')).toEqual(LADDERS.vision);
    expect(hashKey('a')).not.toBe(hashKey('b'));
  });
});

describe('ladders', () => {
  it('are plain ordered data', () => {
    expect(LADDERS.fast[0]).toBe('gemini-3.5-flash-lite');
    expect(LADDERS.smart.slice(0, 3)).toEqual(['gemini-4-hydrogen', 'gemini-3.8-flash', 'gemini-3.5-flash']);
    expect(LADDERS.vision.slice(0, 2)).toEqual(['gemini-4-hydrogen', 'gemini-3.8-flash']);
  });
});

describe('rankModels', () => {
  const fast = LADDERS.fast;
  it('fast: fastest probed-ok first, unknown next, failed last', () => {
    const probes = { 'gemini-3.1-flash-lite': ok('gemini-3.1-flash-lite', 900), 'gemini-3.5-flash-lite': ok('gemini-3.5-flash-lite', 1500), 'gemini-4-hydrogen': bad('gemini-4-hydrogen') };
    const r = rankModels('fast', fast, probes);
    expect(r.slice(0, 2)).toEqual(['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite']);
    expect(r[r.length - 1]).toBe('gemini-4-hydrogen');
  });
  it('smart: ladder order among models answering under 4 s', () => {
    const probes = { 'gemini-4-hydrogen': ok('gemini-4-hydrogen', 1800), 'gemini-3.8-flash': ok('gemini-3.8-flash', 2300), 'gemini-3.5-flash-lite': ok('gemini-3.5-flash-lite', 700), 'gemini-3.5-flash': ok('gemini-3.5-flash', 7000) };
    expect(rankModels('smart', LADDERS.smart, probes).slice(0, 4)).toEqual(['gemini-4-hydrogen', 'gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.5-flash']);
  });
  it('a model slower than 4 s is not first while a quicker one exists', () => {
    const probes = { 'gemini-4-hydrogen': ok('gemini-4-hydrogen', 15000), 'gemini-3.5-flash-lite': ok('gemini-3.5-flash-lite', 900) };
    expect(rankModels('vision', LADDERS.vision, probes)[0]).toBe('gemini-3.5-flash-lite');
  });
  it('unhealthy models go last', () => {
    const probes = { 'gemini-3.1-flash-lite': ok('gemini-3.1-flash-lite', 900), 'gemini-3.5-flash-lite': ok('gemini-3.5-flash-lite', 1500) };
    const r = rankModels('fast', fast, probes, (m) => m !== 'gemini-3.1-flash-lite');
    expect(r[0]).toBe('gemini-3.5-flash-lite');
    expect(r[r.length - 1]).toBe('gemini-3.1-flash-lite');
  });
});

describe('quota awareness', () => {
  beforeEach(() => { resetHealth(); resetExhausted(); });
  afterEach(() => { vi.useRealTimers(); });
  const quota = () => new AiError('m 429: RESOURCE_EXHAUSTED', 'http', 429);

  it('skips an exhausted model at once and brings it back after UTC midnight', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-15T22:00:00Z'));
    const t = { kind: 'direct', key: 'ladder-test' } as const;
    const head = routeFor(t, 'smart')[0];
    markUnhealthy(head, 'quota', quota());
    expect(isExhausted(head)).toBe(true);
    expect(routeFor(t, 'smart')).not.toContain(head);
    vi.setSystemTime(new Date('2026-11-15T23:59:00Z'));
    expect(isExhausted(head)).toBe(true);
    vi.setSystemTime(new Date('2026-11-16T00:00:01Z'));
    expect(isExhausted(head)).toBe(false);
    expect(routeFor(t, 'smart')[0]).toBe(head);
    expect(nextUtcMidnight(Date.parse('2026-11-15T22:00:00Z'))).toBe(Date.parse('2026-11-16T00:00:00Z'));
  });

  it('a 503 backs the model off without exhausting it; a 400 does not mark it', () => {
    markUnhealthy('busy', 'x', new AiError('busy 503: overloaded', 'http', 503));
    markUnhealthy('picky', 'x', new AiError('picky 400: bad schema', 'http', 400));
    expect(isExhausted('busy')).toBe(false);
    expect(isExhausted('picky')).toBe(false);
  });
});

// ---- runRouted against a fake streaming fetch ----

type Behaviour = { status?: number; delayMs?: number; chunks?: string[]; body?: string; requireNoThinking?: boolean };

function sseResponse(chunks: string[], delayMs: number, signal?: AbortSignal): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      const abort = () => { try { ctrl.error(new DOMException('aborted', 'AbortError')); } catch { /* closed */ } };
      signal?.addEventListener('abort', abort);
      for (const c of chunks) {
        await new Promise((r) => setTimeout(r, delayMs));
        if (signal?.aborted) return;
        const payload = { candidates: [{ content: { parts: [{ text: c }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 } };
        ctrl.enqueue(enc.encode(`data: ${JSON.stringify(payload)}\n\n`));
      }
      ctrl.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function fakeFetch(map: Record<string, Behaviour>, calls: string[]) {
  return vi.fn(async (url: string, init: RequestInit) => {
    const model = decodeURIComponent(url.match(/models\/([^:]+):/)![1]);
    calls.push(model);
    const b = map[model] ?? { status: 404, body: '{"error":{"message":"not found"}}' };
    if (b.requireNoThinking && String(init.body).includes('thinkingConfig')) return new Response('{"error":{"code":400,"message":"Request contains an invalid argument."}}', { status: 400 });
    if (b.status && b.status !== 200) return new Response(b.body ?? '{}', { status: b.status });
    return sseResponse(b.chunks ?? ['{"ok":', 'true}'], b.delayMs ?? 5, init.signal ?? undefined);
  });
}

const slack = Number(process.env.SPACELENS_TIME_SLACK ?? 1);
const timing = { hedgeMs: 60, firstTokenTimeoutMs: 400 * slack, totalTimeoutMs: 2000 * slack };
const direct = { kind: 'direct', key: 'k' } as const;

describe('runRouted', () => {
  let calls: string[];
  beforeEach(() => { calls = []; resetHealth(); resetExhausted(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('falls through errors to the next model', async () => {
    vi.stubGlobal('fetch', fakeFetch({ a: { status: 429, body: '{"error":{"message":"quota"}}' }, b: { chunks: ['hel', 'lo'] } }, calls));
    const partials: string[] = [];
    const out = await runRouted(direct, ['a', 'b'], { parts: [{ text: 'x' }] }, timing, undefined, { onText: (t) => partials.push(t) });
    expect(out.model).toBe('b');
    expect(out.text).toBe('hello');
    expect(partials).toEqual(['hel', 'hello']);
    expect(out.inputTokens).toBe(5);
  });

  it('hedges a slow model and takes whichever streams first', async () => {
    vi.stubGlobal('fetch', fakeFetch({ slow: { delayMs: 300, chunks: ['s'] }, quick: { delayMs: 5, chunks: ['q'] } }, calls));
    const out = await runRouted(direct, ['slow', 'quick'], { parts: [{ text: 'x' }] }, timing, undefined);
    expect(out.model).toBe('quick');
    expect(calls).toEqual(['slow', 'quick']);
  });

  it('does not hedge when the first model answers quickly', async () => {
    vi.stubGlobal('fetch', fakeFetch({ a: { delayMs: 5 }, b: {} }, calls));
    const out = await runRouted(direct, ['a', 'b'], { parts: [{ text: 'x' }] }, { ...timing, hedgeMs: 400, firstTokenTimeoutMs: 1500 }, undefined);
    expect(out.model).toBe('a');
    await new Promise((r) => setTimeout(r, 500));
    expect(calls).toEqual(['a']);
  });

  it('times out a silent model and moves on', async () => {
    vi.stubGlobal('fetch', fakeFetch({ dead: { delayMs: 5000 }, live: {} }, calls));
    const out = await runRouted(direct, ['dead', 'live'], { parts: [{ text: 'x' }] }, { ...timing, hedgeMs: 10_000, firstTokenTimeoutMs: 80 }, undefined);
    expect(out.model).toBe('live');
  });

  it('learns that a model rejects thinkingConfig', async () => {
    vi.stubGlobal('fetch', fakeFetch({ 'no-think-model': { requireNoThinking: true } }, calls));
    const out = await runRouted(direct, ['no-think-model'], { parts: [{ text: 'x' }], thinking: 'minimal' }, timing, undefined);
    expect(out.text).toBe('{"ok":true}');
    expect(calls).toEqual(['no-think-model', 'no-think-model']);
    expect(acceptsThinking('no-think-model')).toBe(false);
  });

  it('falls through when a response fails validation', async () => {
    vi.stubGlobal('fetch', fakeFetch({ a: { chunks: ['{"bro'] }, b: {} }, calls));
    const out = await runRouted(direct, ['a', 'b'], { parts: [{ text: 'x' }] }, timing, undefined, {
      accept: (o) => { JSON.parse(o.text); },
    });
    expect(out.model).toBe('b');
  });

  it('gives a typed timeout error at the hard deadline', async () => {
    vi.stubGlobal('fetch', fakeFetch({ a: { delayMs: 5000 }, b: { delayMs: 5000 } }, calls));
    const t0 = Date.now();
    const err = await runRouted(direct, ['a', 'b'], { parts: [{ text: 'x' }] }, { hedgeMs: 30, firstTokenTimeoutMs: 4000, totalTimeoutMs: 8000, deadlineMs: 150 }, undefined).catch((e) => e);
    expect(err).toBeInstanceOf(AiError);
    expect(err.kind).toBe('timeout');
    expect(err.reason).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(900);
  });

  it('a 429 marks the model exhausted and the next model answers', async () => {
    vi.stubGlobal('fetch', fakeFetch({ qa: { status: 429, body: '{"error":{"message":"RESOURCE_EXHAUSTED"}}' }, qb: {} }, calls));
    const out = await runRouted(direct, ['qa', 'qb'], { parts: [{ text: 'x' }] }, timing, undefined);
    expect(out.model).toBe('qb');
    expect(isExhausted('qa')).toBe(true);
  });

  it('rejects when every model fails, and on abort', async () => {
    vi.stubGlobal('fetch', fakeFetch({}, calls));
    await expect(runRouted(direct, ['x', 'y'], { parts: [{ text: 'x' }] }, timing, undefined)).rejects.toThrow(/All Gemini models failed/);
    vi.stubGlobal('fetch', fakeFetch({ s: { delayMs: 500 } }, calls));
    const ctrl = new AbortController();
    const p = runRouted(direct, ['s'], { parts: [{ text: 'x' }] }, timing, ctrl.signal);
    setTimeout(() => ctrl.abort(), 20);
    await expect(p).rejects.toThrow(/Aborted/);
  });
});

describe('automatic cache', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it('answers a repeated prompt without a second request, and noCache bypasses it', async () => {
    const { useStore } = await import('../store');
    const { ai, clearAiCache } = await import('./index');
    useStore.setState({ settings: { ...useStore.getState().settings, geminiKey: 'cache-test-key' } });
    clearAiCache();
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (!/:streamGenerateContent/.test(url)) return new Response('{}', { status: 404 });
      seen.push(String(init.body));
      return sseResponse(['{"v":1}'], 1, init.signal ?? undefined);
    }));
    const call = { task: 'fast' as const, parts: [{ text: 'cache me please' }], json: true };
    const mine = () => seen.filter((b) => b.includes('cache me please')).length;
    const first = await ai<{ v: number }>(call);
    expect(first.cached).toBe(false);
    expect(mine()).toBe(1);
    const second = await ai<{ v: number }>(call);
    expect(second.cached).toBe(true);
    expect(second.data).toEqual({ v: 1 });
    expect(mine()).toBe(1);
    await ai({ ...call, noCache: true });
    expect(mine()).toBe(2);
  });
});
