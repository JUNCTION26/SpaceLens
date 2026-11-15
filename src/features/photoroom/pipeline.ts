// Photo -> Gemini vision -> SpaceModel, then custom objects for anything the catalogue has no piece for.

import { dataUrlToInlineData } from '../../core/gemini';
import { getState } from '../../core/store';
import type { SpaceModel } from '../../core/types';
import { strongCall } from './strong';
import { buildPhotoRoom, parseEstimate, MULTI_PHOTO_ROOM_PROMPT, PHOTO_ROOM_PROMPT, PHOTO_ROOM_SCHEMA, type PhotoRoomEstimate } from './room';

/** Draws an image file into a JPEG data URL no larger than `max` pixels on its long side. */
export async function shrinkImage(file: Blob, max: number, quality = 0.85): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', quality);
  } finally { URL.revokeObjectURL(url); }
}

/** Asks Gemini for the room behind one photo or several photos of the same room (data URLs) in a single call. */
export async function estimateRoom(photos: string | string[], opts: { prefer?: string[]; signal?: AbortSignal } = {}): Promise<PhotoRoomEstimate & { model: string }> {
  const list = (Array.isArray(photos) ? photos : [photos]).slice(0, MAX_PHOTOS);
  const prompt = list.length > 1 ? MULTI_PHOTO_ROOM_PROMPT : PHOTO_ROOM_PROMPT;
  const r = await strongCall<unknown>({ parts: [...list.map(dataUrlToInlineData), { text: prompt }], schema: PHOTO_ROOM_SCHEMA, thinking: 'low', temperature: 0.2 }, { prefer: opts.prefer, signal: opts.signal });
  return { ...parseEstimate(r.data), photoCount: list.length, model: r.model };
}

/** Replaces each 'other' item with a custom object built to its estimated size, a few at a time. */
export async function forgeUnknowns(model: SpaceModel, max = 4): Promise<void> {
  const ids = model.furniture.filter((f) => f.catalogId === 'custom' && !f.custom).slice(0, max);
  if (!ids.length) return;
  const [{ generateObject }, { fitSpec }] = await Promise.all([import('../forge/generate'), import('../forge/fit')]);
  await Promise.all(ids.map(async (f) => {
    const cm = (m: number) => Math.round(m * 100);
    try {
      const spec = await generateObject(`${f.name}, ${cm(f.w)} wide x ${cm(f.d)} deep x ${cm(f.h)} cm high, ${f.material ?? ''} ${f.color}`.trim());
      const size = { w: f.w, d: f.d, h: f.h };
      const st = getState();
      // The person may have moved on to another room meanwhile.
      if (!st.model.furniture.some((x) => x.id === f.id)) return;
      st.dispatch({ type: 'UPDATE_OBJECT', id: f.id, patch: { custom: { ...fitSpec(spec, size), name: f.name, size } } });
    } catch { /* the plain block stays */ }
  }));
}

export const MIN_PHOTOS = 2;
export const MAX_PHOTOS = 6;

/** The whole flow for one or several photo files of the same room: shrink, one vision call, build. */
export async function photoToRoom(files: Blob | Blob[]): Promise<{ model: SpaceModel; estimate: PhotoRoomEstimate; photo: string; photos: string[] }> {
  const list = (Array.isArray(files) ? files : [files]).slice(0, MAX_PHOTOS);
  const big = await Promise.all(list.map((f) => shrinkImage(f, 1280)));
  const estimate = await estimateRoom(big);
  const thumbs = await Promise.all(list.map((f) => shrinkImage(f, 480, 0.75)));
  return { model: buildPhotoRoom(estimate, { photoUrl: thumbs[0] }), estimate, photo: thumbs[0], photos: thumbs };
}
