import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequestScheduler } from './scheduler';

/**
 * Calls through the SpaceLens server, as a themed room makes them: a brief, a burst of object
 * specs and a critic pass, against a stubbed server with its own per-address limit.
 */

const BASE = 'https://api.example.test';
const MODELS = ['m-a', 'm-b'];

type Reply = { status: number; code: string; retryAfterS?: number } | 'ok' | 'hang';

interface FakeResponse { ok: boolean; status: number; headers: Headers; body: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } }; text(): Promise<string>; json(): Promise<unknown> }

function response(status: number, text: string, headers: Record<string, string> = {}): FakeResponse {
  const bytes = new TextEncoder().encode(text);
  let sent = false;
  return {
    ok: status >= 200 && status < 300, status, headers: new Headers(headers),
    body: { getReader: () => ({ read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: bytes })), cancel: async () => undefined }) },
    text: async () => text, json: async () => JSON.parse(text),
  };
}
const okStream = (text: string) => response(200, `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })}\n\n`, { 'Content-Type': 'text/event-stream' });
const errorReply = (status: number, code: string, retryAfterS?: number) =>
  response(status, JSON.stringify({ error: { code, message: 'Plain message.', ...(retryAfterS ? { retryAfterS } : {}) } }), retryAfterS ? { 'Retry-After': String(retryAfterS) } : {});

const wait = (ms: number, signal?: AbortSignal | null) => new Promise<void>((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')); }, { once: true });
});

/** A server that allows `perSecond` starts per address (bucket of `burst`) and answers after `latencyMs`. */
function fakeServer(o: { perSecond: number; burst: number; latencyMs: number; reply?: (model: string, n: number) => Reply }) {
  let tokens = o.burst;
  let at = Date.now();
  const log = { generate: [] as { model: string; at: number }[], rejected: 0, live: 0, maxLive: 0, paths: [] as string[] };
  const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    log.paths.push(path);
    if (path === '/healthz') return response(200, '{"status":"ok"}');
    if (path === '/v1/models') return response(200, JSON.stringify({ models: MODELS }));
    const now = Date.now();
    tokens = Math.min(o.burst, tokens + ((now - at) * o.perSecond) / 1000);
    at = now;
    if (tokens < 1) {
      log.rejected += 1;
      return errorReply(429, 'rate_limited', Math.max(1, Math.ceil(((1 - tokens) * 1000) / o.perSecond / 1000)));
    }
    tokens -= 1;
    const model = JSON.parse(String(init.body)).model as string;
    log.generate.push({ model, at: now });
    const r = o.reply?.(model, log.generate.length) ?? 'ok';
    if (r !== 'ok' && r !== 'hang') return errorReply(r.status, r.code, r.retryAfterS);
    log.live += 1;
    log.maxLive = Math.max(log.maxLive, log.live);
    try { await wait(r === 'hang' ? 3_600_000 : o.latencyMs, init.signal); } finally { log.live -= 1; }
    return okStream(JSON.stringify({ ok: true, model }));
  });
  return { fetch, log };
}

async function load(server: ReturnType<typeof fakeServer>) {
  vi.stubEnv('DEV', false);
  vi.stubEnv('VITE_API_BASE', BASE);
  vi.stubGlobal('fetch', server.fetch);
  vi.resetModules();
  const ai = await import('./index');
  const router = await import('./router');
  const sched = await import('./scheduler');
  return { ...ai, router, sched };
}

const objectCall = (i: number, extra: object = {}) => ({ task: 'fast' as const, parts: [{ text: `object ${i}` }], json: true, noCache: true, ...extra });

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); });

describe('server path: a themed room in one burst', () => {
  it('20 object specs at once all arrive from a server allowing 6 a second, never more than 6 in flight', async () => {
    const server = fakeServer({ perSecond: 6, burst: 6, latencyMs: 200 });
    const m = await load(server);
    const calls = Array.from({ length: 20 }, (_, i) => m.ai<{ ok: boolean }>(objectCall(i)));
    const settled = Promise.allSettled(calls);
    await vi.advanceTimersByTimeAsync(30_000);
    const results = await settled;
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(20);
    expect(server.log.maxLive).toBeLessThanOrEqual(6);
    // Every object came from the preferred model: a rate-limit answer never pushed work to a worse one.
    expect(new Set(server.log.generate.map((g) => g.model))).toEqual(new Set(['m-a']));
    expect(m.isExhausted('m-a')).toBe(false);
    expect(m.aiRoute('fast')[0]).toBe('m-a');
    // At most one round of refusals: after the first, the client paces itself under the server.
    expect(server.log.rejected).toBeLessThanOrEqual(5);
    expect(m.aiQueue()).toEqual({ inFlight: 0, queued: 0, waitS: 0 });
  });

  it('a rate-limit answer with Retry-After 2 is retried after 2 s and succeeds; the model stays usable', async () => {
    const server = fakeServer({ perSecond: 100, burst: 100, latencyMs: 50, reply: (_m, n) => (n === 1 ? { status: 429, code: 'rate_limited', retryAfterS: 2 } : 'ok') });
    const m = await load(server);
    const p = m.ai<{ model: string }>(objectCall(1));
    await vi.advanceTimersByTimeAsync(10_000);
    const r = await p;
    expect(r.data.model).toBe('m-a');
    expect(server.log.generate).toHaveLength(2);
    expect(server.log.generate[1].at - server.log.generate[0].at).toBeGreaterThanOrEqual(2000);
    expect(server.log.generate.map((g) => g.model)).toEqual(['m-a', 'm-a']);
    expect(m.isExhausted('m-a')).toBe(false);
    expect(m.router.isHealthy('m-a')).toBe(true);
  });

  it('gives up after two retries with a "busy" reason, and still does not mark the model spent', async () => {
    const server = fakeServer({ perSecond: 100, burst: 100, latencyMs: 50, reply: () => ({ status: 429, code: 'rate_limited', retryAfterS: 1 }) });
    const m = await load(server);
    const p = m.ai(objectCall(1)).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    const err = (await p) as InstanceType<typeof m.AiError>;
    expect(err).toBeInstanceOf(m.AiError);
    expect(err.code).toBe('rate_limited');
    expect(err.reason).toBe('overloaded');
    expect(server.log.generate).toHaveLength(3);
    expect(m.isExhausted('m-a')).toBe(false);
    expect(m.router.isHealthy('m-a')).toBe(true);
  });

  it("Gemini's own quota on a model marks it spent and the call moves to the next model", async () => {
    const server = fakeServer({ perSecond: 100, burst: 100, latencyMs: 50, reply: (model) => (model === 'm-a' ? { status: 429, code: 'upstream_quota', retryAfterS: 60 } : 'ok') });
    const m = await load(server);
    const p = m.ai<{ model: string }>(objectCall(1));
    await vi.advanceTimersByTimeAsync(5000);
    expect((await p).data.model).toBe('m-b');
    expect(m.isExhausted('m-a')).toBe(true);
    // The next call does not knock on the spent model again.
    const q = m.ai<{ model: string }>(objectCall(2));
    await vi.advanceTimersByTimeAsync(5000);
    expect((await q).data.model).toBe('m-b');
    expect(server.log.generate.map((g) => g.model)).toEqual(['m-a', 'm-b', 'm-b']);
  });

  it('aborting cancels queued calls before they reach the server, and the queue count drops', async () => {
    const server = fakeServer({ perSecond: 100, burst: 100, latencyMs: 0, reply: () => 'hang' });
    const m = await load(server);
    const hog = new AbortController();
    const running = Array.from({ length: 6 }, (_, i) => m.ai(objectCall(i, { signal: hog.signal })).catch((e: unknown) => e));
    const user = new AbortController();
    const queued = Array.from({ length: 3 }, (_, i) => m.ai(objectCall(10 + i, { signal: user.signal })).catch((e: unknown) => e));
    await vi.advanceTimersByTimeAsync(100);
    expect(server.log.generate).toHaveLength(6);
    expect(m.aiQueue().queued).toBe(3);
    expect(m.aiQueue().waitS).toBeGreaterThan(0);
    user.abort();
    const out = await Promise.all(queued);
    for (const e of out) expect((e as { kind?: string }).kind).toBe('abort');
    expect(m.aiQueue().queued).toBe(0);
    hog.abort();
    await Promise.all(running);
    await vi.advanceTimersByTimeAsync(100);
    expect(server.log.generate).toHaveLength(6);
    expect(m.aiQueue().inFlight).toBe(0);
  });

  it('no hedge through the server while other calls wait; a lone slow call may hedge', async () => {
    const server = fakeServer({ perSecond: 100, burst: 100, latencyMs: 1000 });
    const m = await load(server);
    const burst = Array.from({ length: 7 }, (_, i) => m.ai(objectCall(i, { budgetMs: 100 })));
    await vi.advanceTimersByTimeAsync(500);
    expect(server.log.generate).toHaveLength(6);
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all(burst);
    const before = server.log.generate.length;
    const lone = m.ai(objectCall(99, { budgetMs: 100 }));
    await vi.advanceTimersByTimeAsync(300);
    expect(server.log.generate.length - before).toBe(2);
    expect(server.log.generate.slice(before).map((g) => g.model)).toEqual(['m-a', 'm-b']);
    await vi.advanceTimersByTimeAsync(2000);
    await lone;
  });

  it('the brief the person waits for jumps ahead of queued objects; the critic goes last', async () => {
    const server = fakeServer({ perSecond: 100, burst: 100, latencyMs: 400 });
    const m = await load(server);
    const order: string[] = [];
    const track = (label: string, p: Promise<unknown>) => p.then(() => order.push(label));
    const objects = Array.from({ length: 8 }, (_, i) => track(`object${i}`, m.ai(objectCall(i))));
    const critic = track('critic', m.ai({ ...objectCall(50), priority: 'low' }));
    const brief = track('brief', m.ai({ ...objectCall(60), priority: 'high' }));
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all([...objects, critic, brief]);
    // The first six objects were already running; the brief takes the first slot that frees up.
    expect(order.indexOf('brief')).toBeLessThan(order.indexOf('object6'));
    expect(order.at(-1)).toBe('critic');
  });

  it('warm-up through the server only wakes it and reads the model list: no model calls', async () => {
    const server = fakeServer({ perSecond: 100, burst: 100, latencyMs: 10 });
    const m = await load(server);
    const p = m.warmUp({ kind: 'server', base: BASE });
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    expect(server.log.generate).toHaveLength(0);
    expect(server.log.paths.every((x) => x === '/healthz' || x === '/v1/models')).toBe(true);
  });

  it('a probe that meets the server limit leaves the model alone; a probe that meets Gemini quota does not', async () => {
    const server = fakeServer({ perSecond: 100, burst: 100, latencyMs: 10, reply: (model) => ({ status: 429, code: model === 'm-a' ? 'rate_limited' : 'upstream_quota' }) });
    const m = await load(server);
    const t = { kind: 'server', base: BASE } as const;
    const pa = m.router.probeOne(t, 'm-a');
    const pb = m.router.probeOne(t, 'm-b');
    await vi.advanceTimersByTimeAsync(1000);
    const [a, b] = await Promise.all([pa, pb]);
    expect(a.code).toBe('rate_limited');
    expect(m.router.exhaustsModel(a)).toBe(false);
    expect(m.router.exhaustsModel(b)).toBe(true);
    // A direct 429 from Google still counts as spent.
    expect(m.router.exhaustsModel({ status: 429, reason: 'quota' })).toBe(true);
  });

  it('the start event of a queued call says how many wait ahead and for how long', async () => {
    const server = fakeServer({ perSecond: 100, burst: 100, latencyMs: 2000 });
    const m = await load(server);
    const starts: { queued?: number; waitS?: number }[] = [];
    const off = m.onAiActivity((e) => { if (e.phase === 'start') starts.push({ queued: e.queued, waitS: e.waitS }); });
    const calls = Array.from({ length: 6 }, (_, i) => m.ai(objectCall(i)));
    await vi.advanceTimersByTimeAsync(50);
    const late = m.ai(objectCall(7));
    const later = m.ai(objectCall(8));
    await vi.advanceTimersByTimeAsync(50);
    expect(m.aiQueue().queued).toBe(2);
    expect(starts.at(-1)?.queued).toBe(1);
    expect(starts.at(-1)?.waitS).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all([...calls, late, later]);
    off();
  });
});

describe('RequestScheduler', () => {
  it('paces starts: the burst at once, then the sustained rate', async () => {
    const s = new RequestScheduler({ maxInFlight: 100, burst: 5, perSecond: 2 });
    let started = 0;
    for (let i = 0; i < 15; i++) void s.acquire().then(() => { started += 1; });
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toBe(5);
    await vi.advanceTimersByTimeAsync(1000);
    expect(started).toBe(7);
    await vi.advanceTimersByTimeAsync(4000);
    expect(started).toBe(15);
  });

  it('a pause holds every start until it ends, and spends the burst', async () => {
    const s = new RequestScheduler({ maxInFlight: 10, burst: 10, perSecond: 5 });
    s.pause(3);
    let started = 0;
    for (let i = 0; i < 4; i++) void s.acquire().then(() => { started += 1; });
    await vi.advanceTimersByTimeAsync(2900);
    expect(started).toBe(0);
    expect(s.stats().waitS).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(started).toBeGreaterThanOrEqual(4);
  });

  it('priority, then arrival order; a retried call goes ahead of its peers', async () => {
    const s = new RequestScheduler({ maxInFlight: 1, burst: 100, perSecond: 100 });
    const first = await s.acquire();
    const order: string[] = [];
    const take = (label: string, p: Promise<() => void>) => p.then((release) => { order.push(label); release(); });
    const all = [
      take('low', s.acquire('low')),
      take('normal1', s.acquire('normal')),
      take('normal2', s.acquire('normal')),
      take('high', s.acquire('high')),
      take('retry', s.acquire('normal', undefined, true)),
    ];
    first();
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all(all);
    expect(order).toEqual(['high', 'retry', 'normal1', 'normal2', 'low']);
  });

  it('a hedge is refused while anything waits or every slot is busy', async () => {
    const s = new RequestScheduler({ maxInFlight: 1, burst: 100, perSecond: 100 });
    expect(s.tryExtra()).toBe(true);
    const release = await s.acquire();
    expect(s.tryExtra()).toBe(false);
    const waiting = s.acquire();
    release();
    (await waiting)();
    expect(s.tryExtra()).toBe(true);
  });
});
