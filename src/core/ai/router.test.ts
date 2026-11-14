import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBody, chunkText } from './engine';
import { acceptsThinking, candidatesFor, CANDIDATES, shortModel } from './models';
import { hashKey, rankModels, resetHealth, runRouted, type ModelStatus } from './router';
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
    expect(candidatesFor('vision')).toEqual(CANDIDATES.smart);
    expect(hashKey('a')).not.toBe(hashKey('b'));
  });
});

describe('rankModels', () => {
  const fast = CANDIDATES.fast;
  it('fast: fastest probed-ok first, unknown next, failed last', () => {
    const probes = { 'gemini-3.1-flash-lite': ok('gemini-3.1-flash-lite', 900), 'gemini-3.5-flash-lite': ok('gemini-3.5-flash-lite', 1500), 'gemini-4-hydrogen': bad('gemini-4-hydrogen') };
    expect(rankModels('fast', fast, probes)).toEqual(['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-flash-lite-latest', 'gemini-4-hydrogen']);
  });
  it('smart: quality order among responsive models', () => {
    const smart = CANDIDATES.smart;
    const probes = { 'gemini-4-argon': ok('gemini-4-argon', 2000), 'gemini-3.5-flash-lite': ok('gemini-3.5-flash-lite', 700), 'gemini-3.5-flash': ok('gemini-3.5-flash', 7000) };
    const r = rankModels('smart', smart, probes);
    expect(r.slice(0, 3)).toEqual(['gemini-4-argon', 'gemini-3.5-flash-lite', 'gemini-3.5-flash']);
  });
  it('unhealthy models go last', () => {
    const probes = { 'gemini-3.1-flash-lite': ok('gemini-3.1-flash-lite', 900), 'gemini-3.5-flash-lite': ok('gemini-3.5-flash-lite', 1500) };
    const r = rankModels('fast', fast, probes, (m) => m !== 'gemini-3.1-flash-lite');
    expect(r[0]).toBe('gemini-3.5-flash-lite');
    expect(r[r.length - 1]).toBe('gemini-3.1-flash-lite');
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

const timing = { hedgeMs: 60, firstTokenTimeoutMs: 400, totalTimeoutMs: 2000 };

describe('runRouted', () => {
  let calls: string[];
  beforeEach(() => { calls = []; resetHealth(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('falls through errors to the next model', async () => {
    vi.stubGlobal('fetch', fakeFetch({ a: { status: 429, body: '{"error":{"message":"quota"}}' }, b: { chunks: ['hel', 'lo'] } }, calls));
    const partials: string[] = [];
    const out = await runRouted('k', ['a', 'b'], { parts: [{ text: 'x' }] }, timing, undefined, { onText: (t) => partials.push(t) });
    expect(out.model).toBe('b');
    expect(out.text).toBe('hello');
    expect(partials).toEqual(['hel', 'hello']);
    expect(out.inputTokens).toBe(5);
  });

  it('hedges a slow model and takes whichever streams first', async () => {
    vi.stubGlobal('fetch', fakeFetch({ slow: { delayMs: 300, chunks: ['s'] }, quick: { delayMs: 5, chunks: ['q'] } }, calls));
    const out = await runRouted('k', ['slow', 'quick'], { parts: [{ text: 'x' }] }, timing, undefined);
    expect(out.model).toBe('quick');
    expect(calls).toEqual(['slow', 'quick']);
  });

  it('does not hedge when the first model answers quickly', async () => {
    vi.stubGlobal('fetch', fakeFetch({ a: { delayMs: 5 }, b: {} }, calls));
    const out = await runRouted('k', ['a', 'b'], { parts: [{ text: 'x' }] }, timing, undefined);
    expect(out.model).toBe('a');
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toEqual(['a']);
  });

  it('times out a silent model and moves on', async () => {
    vi.stubGlobal('fetch', fakeFetch({ dead: { delayMs: 5000 }, live: {} }, calls));
    const out = await runRouted('k', ['dead', 'live'], { parts: [{ text: 'x' }] }, { ...timing, hedgeMs: 10_000, firstTokenTimeoutMs: 80 }, undefined);
    expect(out.model).toBe('live');
  });

  it('learns that a model rejects thinkingConfig', async () => {
    vi.stubGlobal('fetch', fakeFetch({ 'no-think-model': { requireNoThinking: true } }, calls));
    const out = await runRouted('k', ['no-think-model'], { parts: [{ text: 'x' }], thinking: 'minimal' }, timing, undefined);
    expect(out.text).toBe('{"ok":true}');
    expect(calls).toEqual(['no-think-model', 'no-think-model']);
    expect(acceptsThinking('no-think-model')).toBe(false);
  });

  it('falls through when a response fails validation', async () => {
    vi.stubGlobal('fetch', fakeFetch({ a: { chunks: ['{"bro'] }, b: {} }, calls));
    const out = await runRouted('k', ['a', 'b'], { parts: [{ text: 'x' }] }, timing, undefined, {
      accept: (o) => { JSON.parse(o.text); },
    });
    expect(out.model).toBe('b');
  });

  it('rejects when every model fails, and on abort', async () => {
    vi.stubGlobal('fetch', fakeFetch({}, calls));
    await expect(runRouted('k', ['x', 'y'], { parts: [{ text: 'x' }] }, timing, undefined)).rejects.toThrow(/All Gemini models failed/);
    vi.stubGlobal('fetch', fakeFetch({ s: { delayMs: 500 } }, calls));
    const ctrl = new AbortController();
    const p = runRouted('k', ['s'], { parts: [{ text: 'x' }] }, timing, ctrl.signal);
    setTimeout(() => ctrl.abort(), 20);
    await expect(p).rejects.toThrow(/Aborted/);
  });
});
