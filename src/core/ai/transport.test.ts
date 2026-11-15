import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiBase, pickTransport, streamRequest, modelsRequest } from './transport';
import { AiError, streamModel } from './engine';
import { candidatesVia, loadServerModels, resetHealth, runRouted } from './router';

const server = { kind: 'server', base: 'https://api.example.test' } as const;
const direct = { kind: 'direct', key: 'personal-key' } as const;

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); resetHealth(); });

describe('transport selection', () => {
  it('prefers a personal key, then the server, else none', () => {
    expect(pickTransport('k', 'https://api.example.test')).toEqual({ kind: 'direct', key: 'k' });
    expect(pickTransport('', 'https://api.example.test')).toEqual(server);
    expect(pickTransport(undefined, '')).toBeNull();
  });

  it('reads VITE_API_BASE and trims trailing slashes', () => {
    vi.stubEnv('VITE_API_BASE', ' https://api.example.test// ');
    expect(apiBase()).toBe('https://api.example.test');
    vi.stubEnv('VITE_API_BASE', '');
    expect(apiBase()).toBe('');
  });

  it('aiReady is true through the server with no key, false with neither', async () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_API_BASE', 'https://api.example.test');
    vi.resetModules();
    const on = await import('./index');
    expect(on.aiReady()).toBe(true);
    expect(on.currentTransport()).toEqual(server);

    vi.stubEnv('VITE_API_BASE', '');
    vi.resetModules();
    const off = await import('./index');
    expect(off.aiReady()).toBe(false);
  });
});

describe('requests', () => {
  it('direct calls go to Google with the key in a header', () => {
    const r = streamRequest(direct, 'gemini-x', { contents: [] });
    expect(r.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-x:streamGenerateContent?alt=sse');
    expect((r.init.headers as Record<string, string>)['x-goog-api-key']).toBe('personal-key');
  });

  it('server calls carry the model in the body and no key anywhere', () => {
    const r = streamRequest(server, 'gemini-x', { contents: [{ parts: [{ text: 'hi' }] }] });
    expect(r.url).toBe('https://api.example.test/v1/generate/stream');
    expect(JSON.parse(String(r.init.body))).toEqual({ model: 'gemini-x', contents: [{ parts: [{ text: 'hi' }] }] });
    expect(JSON.stringify(r.init)).not.toMatch(/goog-api-key/i);
    expect(modelsRequest(server).url).toBe('https://api.example.test/v1/models');
  });
});

const sse = (texts: string[]) => new Response(texts.map((t) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: t }] } }] })}\n\n`).join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
const envelope = (status: number, code: string) => new Response(JSON.stringify({ error: { code, message: 'Plain message.' } }), { status });

describe('through the server', () => {
  it('streams text the same way as a direct call', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { urls.push(url); return sse(['Hel', 'lo']); }));
    const parts: string[] = [];
    const out = await streamModel('gemini-x', { parts: [{ text: 'hi' }] }, { transport: server, onText: (t) => parts.push(t) });
    expect(out.text).toBe('Hello');
    expect(parts).toEqual(['Hel', 'Hello']);
    expect(urls).toEqual(['https://api.example.test/v1/generate/stream']);
  });

  it('a server rate limit stops at once instead of trying every model', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => { calls.push(JSON.parse(String(init.body)).model); return envelope(429, 'rate_limited'); }));
    const err = await runRouted(server, ['a', 'b', 'c'], { parts: [{ text: 'x' }] }, { hedgeMs: 5000, firstTokenTimeoutMs: 1000, totalTimeoutMs: 2000 }, undefined).catch((e) => e);
    expect(err).toBeInstanceOf(AiError);
    expect(err.reason).toBe('overloaded');
    expect(err.code).toBe('rate_limited');
    expect(calls).toEqual(['a']);
  });

  it('a model quota upstream falls through to the next model', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const model = JSON.parse(String(init.body)).model;
      calls.push(model);
      return model === 'a' ? envelope(429, 'upstream_quota') : sse(['ok']);
    }));
    const out = await runRouted(server, ['a', 'b'], { parts: [{ text: 'x' }] }, { hedgeMs: 5000, firstTokenTimeoutMs: 1000, totalTimeoutMs: 2000 }, undefined);
    expect(out.model).toBe('b');
    expect(calls).toEqual(['a', 'b']);
  });

  it('an error event inside the stream becomes an AiError with the matching status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`data: ${JSON.stringify({ error: { code: 'upstream_timeout', message: 'Too slow.' } })}\n\n`, { status: 200 })));
    const err = await streamModel('gemini-x', { parts: [{ text: 'x' }] }, { transport: server }).catch((e) => e);
    expect(err).toBeInstanceOf(AiError);
    expect(err.status).toBe(504);
    expect(err.reason).toBe('overloaded');
  });

  it('routes only the models the server offers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ models: ['gemini-3.5-flash-lite', 'gemini-new-flash'] }), { status: 200 })));
    const t = { kind: 'server', base: 'https://models.example.test' } as const;
    await loadServerModels(t);
    expect(candidatesVia(t, 'fast')).toEqual(['gemini-3.5-flash-lite', 'gemini-new-flash']);
    expect(candidatesVia(direct, 'fast')).not.toContain('gemini-new-flash');
  });
});
