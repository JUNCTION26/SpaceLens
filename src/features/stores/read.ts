// Reads a product page the person pasted. Browsers cannot fetch store pages directly (CORS), so
// the page goes through a public reader service, r.jina.ai, which returns it as markdown with
// image links. Title, price and dimensions are parsed locally; a fast model refines them when a
// key is set, but a price is only kept if it actually appears on the page.

import { ai, aiReady } from '../../core/ai';
import type { StoreListing } from '../../core/types';
import {
  compactBody, krCurrencyFor, mainSection, parseDimensions, parsePrice, parsePrices, parseReaderMarkdown, storeFromUrl, stripStoreSuffix,
  type Dims,
} from './parse';

export const READER = 'https://r.jina.ai/';
export const READER_NOTE = 'Links are read through a public reader service (r.jina.ai).';

export interface ReadListing extends StoreListing {
  images: string[];
  category?: string;
  /** Something the person should know about this reading (redirected, no price found...). */
  note?: string;
  via: 'page' | 'search' | 'photo' | 'manual';
}

/** The page as markdown through the reader. Throws with a readable message. */
export async function readerFetch(url: string, signal?: AbortSignal, timeoutMs = 45000): Promise<string> {
  const ctrl = new AbortController();
  const stop = () => ctrl.abort();
  signal?.addEventListener('abort', stop);
  const timer = setTimeout(stop, timeoutMs);
  try {
    const res = await fetch(READER + url, { signal: ctrl.signal, headers: { Accept: 'text/plain' } });
    if (!res.ok) throw new Error(res.status === 429 ? 'The reader service is busy, try again in a minute.' : `The reader could not open that page (${res.status}).`);
    return await res.text();
  } catch (e) {
    if (ctrl.signal.aborted && !signal?.aborted) throw new Error('The page took too long to read.');
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
}

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING' },
    store: { type: 'STRING' },
    price: { type: 'NUMBER', nullable: true },
    currency: { type: 'STRING' },
    widthCm: { type: 'NUMBER', nullable: true },
    depthCm: { type: 'NUMBER', nullable: true },
    heightCm: { type: 'NUMBER', nullable: true },
    category: { type: 'STRING' },
  },
  required: ['title', 'store', 'price', 'currency', 'widthCm', 'depthCm', 'heightCm', 'category'],
};

interface Extracted { title: string; store: string; price: number | null; currency: string; widthCm: number | null; depthCm: number | null; heightCm: number | null; category: string }

const SYSTEM = `Extract the MAIN product on this store page (not related or recommended products).
price: its current price as shown, a number; currency: ISO code. Dimensions: the assembled product's overall width, depth and height in cm (not package size, not seat size).
category: one lowercase word such as sofa, armchair, chair, table, desk, bed, bookshelf, wardrobe, dresser, nightstand, lamp, rug, tv-unit, bench.
Use null for anything not stated on the page. Never guess.`;

const cmToM = (v: number | null | undefined) => (typeof v === 'number' && v > 0 ? Math.round(v * 10) / 1000 : undefined);

/** Turns reader markdown into a listing. Exported for tests and for the search fallback. */
export async function listingFromMarkdown(md: string, url: string, signal?: AbortSignal): Promise<ReadListing> {
  const page = parseReaderMarkdown(md);
  const src = page.sourceUrl || url;
  const store = storeFromUrl(src);
  const kr = krCurrencyFor(src);
  const main = mainSection(page.body, page.title);
  const local = parsePrice(main, kr);
  const dims: Dims = parseDimensions(main);
  const allDims = parseDimensions(page.body);
  for (const k of ['w', 'd', 'h'] as const) if (dims[k] === undefined) dims[k] = allDims[k];

  let title = stripStoreSuffix(page.title, store) || store;
  let price = local?.amount ?? null;
  let currency = local?.currency ?? kr;
  let category: string | undefined;
  const notes: string[] = [];

  if (aiReady()) {
    try {
      const r = await ai<Extracted>({ task: 'fast', system: SYSTEM, schema: SCHEMA, parts: [{ text: `URL: ${src}\nTitle: ${page.title}\n\n${compactBody(main)}` }], signal, cacheKey: `listing:${src}` });
      const x = r.data;
      if (x.title) title = x.title;
      category = x.category || undefined;
      // A price is kept only if the page itself shows it.
      const seen = parsePrices(page.body, kr);
      if (x.price !== null && seen.some((p) => Math.abs(p.amount - x.price!) < 0.011)) { price = x.price; currency = (x.currency || currency).toUpperCase(); }
      else if (x.price !== null && local) notes.push('Model and page disagreed on the price; kept the one printed first on the page.');
      const md2 = { w: cmToM(x.widthCm), d: cmToM(x.depthCm), h: cmToM(x.heightCm) };
      for (const k of ['w', 'd', 'h'] as const) if (md2[k] !== undefined) dims[k] = md2[k];
    } catch { /* local parse stands */ }
  }

  if (page.finalUrl && page.finalUrl !== page.sourceUrl && !/\/p\/|produ/i.test(page.finalUrl)) notes.push('The store redirected this link, so this may not be the product page.');
  if (price === null) notes.push('No price found on the page.');
  const stated = Object.fromEntries(Object.entries(dims).filter(([, v]) => v !== undefined)) as Dims;
  return {
    store, title, url: src, price, currency, imageUrl: page.images[0], images: page.images,
    stated: Object.keys(stated).length ? stated : undefined,
    fetchedAt: Date.now(), category, note: notes.join(' ') || undefined, via: 'page',
  };
}

/** Read a pasted product link: title, price, stated dimensions and image links. */
export async function readListing(url: string, signal?: AbortSignal): Promise<ReadListing> {
  const clean = url.trim();
  if (!/^https?:\/\/\S+\.\S+/.test(clean)) throw new Error('Paste a full link starting with https://');
  const md = await readerFetch(clean, signal);
  return listingFromMarkdown(md, clean, signal);
}

// ---- images ----------------------------------------------------------------------------

/**
 * A store image as a Blob for 3D conversion, or null when the store blocks cross-site reads.
 * Many stores (IKEA, home24) allow it; when one does not, the UI shows the plain <img> and
 * asks the person to drop the picture instead.
 */
export async function loadImageBlob(url: string, signal?: AbortSignal): Promise<Blob | null> {
  try {
    const res = await fetch(url, { mode: 'cors', signal });
    if (!res.ok) return null;
    const blob = await res.blob();
    return blob.type.startsWith('image/') ? blob : null;
  } catch {
    return null;
  }
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// ---- screenshots / photos --------------------------------------------------------------

const PHOTO_SYSTEM = `This is a screenshot or photo of a furniture listing. Read only what is printed: product title, store, price (number) and currency (ISO), and the overall width, depth and height in cm if stated. Use null for anything not visible. Never guess.`;

/** Reads what a listing screenshot states. Without a key, returns an empty draft to fill in. */
export async function readListingImage(dataUrl: string, signal?: AbortSignal): Promise<ReadListing> {
  const base: ReadListing = { store: '', title: '', url: '', price: null, currency: 'SEK', imageUrl: dataUrl, images: [dataUrl], fetchedAt: Date.now(), via: 'photo' };
  if (!aiReady()) return { ...base, note: 'Type the title, price and size from the listing.' };
  const [head, data] = dataUrl.split(',');
  const mimeType = head.match(/data:(.*?);/)?.[1] ?? 'image/png';
  try {
    const r = await ai<Extracted>({ task: 'vision', system: PHOTO_SYSTEM, schema: SCHEMA, parts: [{ inlineData: { mimeType, data } }, { text: 'Read this listing.' }], signal });
    const x = r.data;
    const stated: Dims = { w: cmToM(x.widthCm), d: cmToM(x.depthCm), h: cmToM(x.heightCm) };
    const has = Object.values(stated).some((v) => v !== undefined);
    return { ...base, title: x.title ?? '', store: x.store ?? '', price: x.price ?? null, currency: (x.currency || 'SEK').toUpperCase(), category: x.category || undefined, stated: has ? stated : undefined, note: 'Read from your picture. Check the numbers.' };
  } catch {
    return { ...base, note: 'Could not read the picture. Type the title, price and size.' };
  }
}
