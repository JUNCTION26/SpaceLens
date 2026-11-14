/** Runs the real app on a random local port with a stubbed upstream. No network leaves the machine. */
import { createServer } from 'node:http';
import { loadConfig } from '../../config.mjs';
import { createApp } from '../../app.mjs';
import { createLogger } from '../../log.mjs';

export const TEST_KEY = 'AIzaTEST-secret-key-0123456789abcdef';
export const ORIGIN = 'https://junction26.github.io';

/** A Gemini-like SSE response from a list of payload objects. */
export function sseResponse(payloads, { delayMs = 0, signal } = {}) {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    async start(ctrl) {
      for (const p of payloads) {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        if (signal?.aborted) { ctrl.error(new DOMException('aborted', 'AbortError')); return; }
        ctrl.enqueue(enc.encode(typeof p === 'string' ? p : `data: ${JSON.stringify(p)}\r\n\r\n`));
      }
      ctrl.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

export const chunk = (text, extra = {}) => ({
  candidates: [{ content: { role: 'model', parts: [{ text }] } }],
  usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 },
  responseId: 'upstream-internal-id',
  ...extra,
});

export const jsonResponse = (status, obj, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...headers } });

/** A minimal valid request, shaped like the one the app sends. */
export const validBody = (over = {}) => ({
  model: 'gemini-3.5-flash-lite',
  contents: [{ role: 'user', parts: [{ text: 'Say OK' }] }],
  generationConfig: { temperature: 0.2, thinkingConfig: { thinkingLevel: 'low' } },
  systemInstruction: { parts: [{ text: 'Be brief.' }] },
  ...over,
});

/**
 * @param {{ env?: object, upstream?: (url: string, init: RequestInit) => Response | Promise<Response>, now?: () => number }} opts
 */
export async function startServer({ env = {}, upstream, now } = {}) {
  const config = loadConfig({ GEMINI_API_KEY: TEST_KEY, LOG_LEVEL: 'debug', ...env });
  const lines = [];
  const calls = [];
  const fetchStub = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (!upstream) throw new Error('no upstream configured');
    return upstream(String(url), init);
  };
  const app = createApp(config, { fetch: fetchStub, logger: createLogger({ level: 'debug', write: (l) => lines.push(l) }), now });
  const server = createServer((req, res) => { void app.handle(req, res); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    app,
    calls,
    lines,
    /** fetch against the server; JSON-encodes `json` and adds the allowed Origin unless told otherwise. */
    request(path, { json, origin = ORIGIN, headers = {}, ...init } = {}) {
      const h = { ...(origin ? { Origin: origin } : {}), ...headers };
      if (json !== undefined) { h['Content-Type'] ??= 'application/json'; init.body = JSON.stringify(json); init.method ??= 'POST'; }
      return fetch(base + path, { ...init, headers: h });
    },
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

/** Reads an SSE response into its data payloads. */
export async function readEvents(res) {
  const text = await res.text();
  return text.split(/\n\n/).map((e) => e.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n')).filter(Boolean).map((d) => JSON.parse(d));
}

/** Waits until the access-log line for a request has been written. */
export async function waitForLog(lines, predicate, ms = 1000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const hit = lines.map((l) => JSON.parse(l)).find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('log line not found');
}
