import { getState } from '../../core/store';

export const IMAGE_MODELS = ['gemini-3.1-flash-image', 'gemini-3.1-flash-image-preview', 'gemini-2.5-flash-image', 'gemini-3-pro-image'];

export class RenderError extends Error {
  constructor(message: string, readonly reason: 'nokey' | 'quota' | 'blocked' | 'network' | 'empty' | 'other') { super(message); }
}

interface Img { mimeType: string; data: string }
interface Part { text?: string; inlineData?: Img; inline_data?: Img }

/** Send the frame and instruction to an image model. Tries each model until one answers; returns a PNG data URL. */
export async function generateImage(frameDataUrl: string, prompt: string, signal?: AbortSignal): Promise<{ dataUrl: string; model: string }> {
  const key = getState().settings.geminiKey;
  if (!key) throw new RenderError('Add a Gemini key in Settings to render.', 'nokey');
  const data = frameDataUrl.split(',')[1] ?? '';
  let last = new RenderError('No image model answered.', 'other');
  for (const model of IMAGE_MODELS) {
    let res: Response;
    try {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST', signal,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ parts: [{ inlineData: { mimeType: 'image/png', data } }, { text: prompt }] }],
          generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
        }),
      });
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      last = new RenderError('Could not reach Gemini. Check the connection and retry.', 'network');
      continue;
    }
    if (res.status === 429 || res.status === 403 || res.status === 404) {
      last = new RenderError(res.status === 429
        ? 'This key has no image quota right now. Paste a key with image generation enabled in Settings, or retry later.'
        : 'This key cannot use the image models. Paste a different key in Settings.', res.status === 429 ? 'quota' : 'blocked');
      continue;
    }
    if (!res.ok) { last = new RenderError('Gemini could not make the image. Retry in a moment.', 'other'); continue; }
    const json = await res.json() as { candidates?: Array<{ content?: { parts?: Part[] } }> };
    const part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData || p.inline_data);
    const img = part?.inlineData ?? part?.inline_data;
    if (!img) { last = new RenderError('Gemini returned no image for this view. Try another style.', 'empty'); continue; }
    return { dataUrl: `data:${img.mimeType || 'image/png'};base64,${img.data}`, model };
  }
  throw last;
}
