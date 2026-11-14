import { afterEach, describe, expect, it, vi } from 'vitest';
import { classify, dominantReason, problemFor, reasonFromStatus } from './errors';
import { AiError, callModel } from './engine';
import { clampLevel, getOverrides, isLevelRejection, nextLevel, pickNewModels, setOverride } from './models';

describe('error classes', () => {
  it('maps statuses to plain reasons', () => {
    expect(reasonFromStatus(429)).toBe('quota');
    expect(reasonFromStatus(503)).toBe('overloaded');
    expect(reasonFromStatus(400, 'API key not valid. Please pass a valid API key.')).toBe('invalid_key');
    expect(reasonFromStatus(400, 'bad schema')).toBe('other');
    expect(reasonFromStatus(0)).toBe('network');
    expect(new AiError('x', 'timeout').reason).toBe('timeout');
  });
  it('picks the most useful reason and never shows raw text', () => {
    expect(dominantReason(['overloaded', 'quota'])).toBe('quota');
    expect(dominantReason(['network', 'invalid_key'])).toBe('invalid_key');
    const p = classify(new AiError('gemini-x 429: {"error":{"code":429}}', 'http', 429));
    expect(p.message).not.toMatch(/429|\{/);
    expect(p.actions).toContain('offline');
    expect(problemFor('no_key').actions).toEqual(['settings']);
  });
});

describe('model discovery and overrides', () => {
  it('picks only newer text models that are not listed yet', () => {
    const gen = ['generateContent'];
    const list = [
      { name: 'models/gemini-9-flash', supportedGenerationMethods: gen },
      { name: 'models/gemini-9.1-pro', supportedGenerationMethods: gen },
      { name: 'models/gemini-9-flash-tts', supportedGenerationMethods: gen },
      { name: 'models/gemini-9-flash-image', supportedGenerationMethods: gen },
      { name: 'models/gemini-9-live', supportedGenerationMethods: ['bidiGenerateContent'] },
      { name: 'models/gemini-3.5-flash', supportedGenerationMethods: gen },
    ];
    expect(pickNewModels(list)).toEqual(['gemini-9.1-pro', 'gemini-9-flash']);
  });
  it('stores a per-task override', () => {
    const mem = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => mem.set(k, v) });
    setOverride('fast', 'gemini-x');
    expect(getOverrides().fast).toBe('gemini-x');
    setOverride('fast', '');
    expect(getOverrides().fast).toBeUndefined();
  });
});

describe('thinking levels', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('walks up when a model rejects the level, and remembers the floor', async () => {
    const mem = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => mem.set(k, v) });
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: { body: string }) => {
      const level = JSON.parse(init.body).generationConfig.thinkingConfig?.thinkingLevel as string | undefined;
      seen.push(level ?? 'none');
      if (level === 'minimal') return new Response('{"error":{"message":"Thinking level MINIMAL is not supported for this model."}}', { status: 400 });
      const sse = 'data: {"candidates":[{"content":{"parts":[{"text":"OK"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":1}}\n\n';
      return new Response(sse, { status: 200 });
    }));
    const out = await callModel('gemini-t-floor', { parts: [{ text: 'hi' }], thinking: 'minimal' }, { key: 'k' });
    expect(out.text).toBe('OK');
    expect(seen).toEqual(['minimal', 'low']);
    expect(clampLevel('gemini-t-floor', 'minimal')).toBe('low');
    expect(nextLevel('high')).toBeNull();
    expect(isLevelRejection('Thinking level MINIMAL is not supported for this model.')).toBe(true);
  });
});
