import { getState } from './store';

export interface GeminiPart { text?: string; inlineData?: { mimeType: string; data: string } }

export const hasGemini = () => Boolean(getState().settings.geminiKey);

/**
 * Calls the Gemini API directly from the browser with the key the user pasted into Settings.
 * The key never leaves the user's browser except to Google. Returns parsed JSON when
 * `json` is true. Throws on any failure so callers can fall back to local logic.
 */
export async function gemini<T = string>(parts: GeminiPart[], opts: { json?: boolean; schema?: object; system?: string; timeoutMs?: number } = {}): Promise<T> {
  const { geminiKey, geminiModel } = getState().settings;
  if (!geminiKey) throw new Error('No Gemini key set');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 60000);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent`,
      {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
        body: JSON.stringify({
          ...(opts.system ? { systemInstruction: { parts: [{ text: opts.system }] } } : {}),
          contents: [{ role: 'user', parts }],
          generationConfig: {
            temperature: 0.2,
            ...(opts.json ? { responseMimeType: 'application/json' } : {}),
            ...(opts.schema ? { responseSchema: opts.schema } : {}),
          },
        }),
      },
    );
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const text: string = data?.candidates?.[0]?.content?.parts?.map((p: GeminiPart) => p.text ?? '').join('') ?? '';
    usage.calls += 1;
    usage.inputTokens += data?.usageMetadata?.promptTokenCount ?? 0;
    usage.outputTokens += data?.usageMetadata?.candidatesTokenCount ?? 0;
    return (opts.json ? JSON.parse(text) : text) as T;
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
