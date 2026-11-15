import { getState } from '../../core/store';
import { MEDIA_STOP_CODES, MediaError, pickTransport, requestImage } from '../../core/ai/transport';

/** Fastest first; the model that last answered is tried before the rest. */
export const IMAGE_MODELS = ['gemini-3.1-flash-image', 'gemini-2.5-flash-image', 'gemini-3.1-flash-image-preview', 'gemini-3-pro-image'];

const LS_MODEL = 'spacelens.render.model.v1';
function remembered(): string | null {
  try { const m = localStorage.getItem(LS_MODEL); return m && IMAGE_MODELS.includes(m) ? m : null; } catch { return null; }
}
function remember(m: string) { try { localStorage.setItem(LS_MODEL, m); } catch { /* storage blocked */ } }

export class RenderError extends Error {
  constructor(message: string, readonly reason: 'nokey' | 'quota' | 'blocked' | 'network' | 'empty' | 'other') { super(message); }
}

/** Send the frame and instruction to an image model. Tries each model until one answers; returns an image data URL. */
export async function generateImage(frameDataUrl: string, prompt: string, signal?: AbortSignal): Promise<{ dataUrl: string; model: string }> {
  const t = pickTransport(getState().settings.geminiKey);
  if (!t) throw new RenderError('Add a Gemini key in Settings to render.', 'nokey');
  const data = frameDataUrl.split(',')[1] ?? '';
  const mimeType = /^data:([^;]+);/.exec(frameDataUrl)?.[1] ?? 'image/jpeg';
  let last = new RenderError('No image model answered.', 'other');
  const first = remembered();
  const order = first ? [first, ...IMAGE_MODELS.filter((m) => m !== first)] : IMAGE_MODELS;
  for (const model of order) {
    try {
      const img = await requestImage(t, model, prompt, { mimeType, data }, signal);
      remember(model);
      return { dataUrl: `data:${img.mimeType || 'image/png'};base64,${img.data}`, model: img.model || model };
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      if (!(e instanceof MediaError)) { last = new RenderError('Could not reach Gemini. Check the connection and retry.', 'network'); continue; }
      const st = e.status;
      if (st === 429 || st === 403 || st === 404) {
        last = new RenderError(st === 429
          ? 'This key has no image quota right now. Paste a key with image generation enabled in Settings, or retry later.'
          : 'This key cannot use the image models. Paste a different key in Settings.', st === 429 ? 'quota' : 'blocked');
      } else if (e.code === 'no_media') {
        last = new RenderError('Gemini returned no image for this view. Try another style.', 'empty');
      } else {
        last = new RenderError('Gemini could not make the image. Retry in a moment.', 'other');
      }
      if (t.kind === 'server' && MEDIA_STOP_CODES.has(e.code)) break;
    }
  }
  throw last;
}
