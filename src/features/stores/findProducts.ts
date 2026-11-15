// Finds real IKEA products (Sweden or Finland) that fit the space an item stands in. Gemini with
// Google Search grounding proposes candidates; none of its words are trusted. Every candidate's
// page is read again, and only what the page itself shows (price, size) is kept. A candidate whose
// page does not load, was redirected to a general page, shows no price, shows no full size, or
// does not fit the window is dropped, so a URL or a price is never invented.

import { ai, aiReady } from '../../core/ai';
import type { FurnitureItem, SpaceModel, StoreListing } from '../../core/types';
import { fitsWindow, fitWindow, type FitWindow } from './fit';
import { extractJsonBlock } from './parse';
import { readListing, type ReadListing } from './read';

export interface Candidate { name: string; url: string; price: number | null; currency: string; widthCm: number | null; depthCm: number | null; heightCm: number | null }
export interface Match { listing: StoreListing; image?: string }

export interface FindDeps {
  /** Returns the raw text of a grounded model reply. */
  ask: (prompt: string, signal?: AbortSignal) => Promise<string>;
  read: (url: string, signal?: AbortSignal) => Promise<ReadListing>;
}

const IKEA = /^https:\/\/www\.ikea\.com\/(se|fi)\/[a-z]{2}\/p\/[^\s?#]+/i;

/** Candidates from the model's reply. Only IKEA Sweden/Finland product URLs survive; duplicates are merged. */
export function parseCandidates(text: string): Candidate[] {
  const rows = extractJsonBlock<{ products?: Partial<Candidate>[]; results?: Partial<Candidate>[] } | Partial<Candidate>[]>(text);
  const list = Array.isArray(rows) ? rows : rows?.products ?? rows?.results ?? [];
  const seen = new Set<string>();
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
  const out: Candidate[] = [];
  for (const r of list) {
    if (typeof r?.url !== 'string' || !IKEA.test(r.url)) continue;
    const url = r.url.trim();
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ name: String(r.name ?? ''), url, price: num(r.price), currency: String(r.currency ?? '').toUpperCase(), widthCm: num(r.widthCm), depthCm: num(r.depthCm), heightCm: num(r.heightCm) });
  }
  return out.slice(0, 3);
}

export function promptFor(item: Pick<FurnitureItem, 'name' | 'category'>, win: Pick<FitWindow, 'w' | 'd' | 'h'>): string {
  const cm = (m: number) => Math.round(m * 100);
  return `Find up to 3 real products currently sold by IKEA Sweden (ikea.com/se) or IKEA Finland (ikea.com/fi) that could replace a "${item.name}" (category: ${item.category}).
It must fit in at most ${cm(win.w)} cm wide, ${cm(win.d)} cm deep and ${cm(win.h)} cm high. Use Google Search. Only individual product pages (URL contains /p/), never categories.
Never guess a URL, price or size; leave a value null if you did not see it. Reply ONLY with:
\`\`\`json
{"products":[{"name":"","url":"","price":null,"currency":"SEK","widthCm":null,"depthCm":null,"heightCm":null}]}
\`\`\``;
}

const defaultDeps: FindDeps = {
  ask: async (prompt, signal) => {
    const r = await ai<string>({ task: 'fast', parts: [{ text: prompt }], tools: [{ google_search: {} }], temperature: 0.1, thinking: 'low', signal, cacheKey: `findp:${prompt}` });
    return r.data;
  },
  read: readListing,
};

/** A candidate's page, read for real: kept only when it loads, is a product page, and has price and size within the window. */
export async function verifyCandidate(c: Candidate, win: Pick<FitWindow, 'w' | 'd' | 'h'>, read: FindDeps['read'], signal?: AbortSignal): Promise<Match | null> {
  let page: ReadListing;
  try { page = await read(c.url, signal); } catch { return null; }
  if (page.price === null || !(page.price > 0)) return null;
  const same = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
  if (!IKEA.test(page.url || c.url) || !same(page.url || c.url, c.url)) return null;
  // The reader flags links the store sent elsewhere; their numbers belong to another page.
  if (page.note && /general page|redirected this link/i.test(page.note)) return null;
  if (!fitsWindow(page.stated, win)) return null;
  const { images, category, note, via, ...listing } = page;
  void category; void note; void via;
  return { listing: { ...listing, url: page.url || c.url }, image: images[0] };
}

/** Up to 3 verified products for one item inside `win`. Empty when none could be verified. */
export async function findProducts(item: Pick<FurnitureItem, 'name' | 'category'>, win: Pick<FitWindow, 'w' | 'd' | 'h'>, opts: { signal?: AbortSignal; deps?: FindDeps } = {}): Promise<Match[]> {
  const deps = opts.deps ?? defaultDeps;
  if (!opts.deps && !aiReady()) return [];
  let text: string;
  try { text = await deps.ask(promptFor(item, win), opts.signal); } catch (e) { if (opts.signal?.aborted) throw e; return []; }
  const checked = await Promise.all(parseCandidates(text).map((c) => verifyCandidate(c, win, deps.read, opts.signal)));
  return checked.filter((m): m is Match => m !== null);
}

export interface ShopResult {
  /** Verified matches per item id. */
  matches: Record<string, Match[]>;
  /** Items with no verified match. */
  unmatched: string[];
}

/** Every item that is not already owned, 3 at a time. */
export async function shopTheRoom(
  model: Pick<SpaceModel, 'spaces' | 'furniture' | 'ceilingM'>,
  opts: { signal?: AbortSignal; deps?: FindDeps; concurrency?: number; onItem?: (id: string, matches: Match[]) => void; ids?: string[] } = {},
): Promise<ShopResult> {
  const items = model.furniture.filter((f) => !f.owned && f.mount !== 'wall' && f.mount !== 'ceiling' && (!opts.ids || opts.ids.includes(f.id)));
  const result: ShopResult = { matches: {}, unmatched: [] };
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const it = items[next++];
      let m: Match[] = [];
      try { m = await findProducts(it, fitWindow(it, model), { signal: opts.signal, deps: opts.deps }); } catch { if (opts.signal?.aborted) return; }
      if (m.length) result.matches[it.id] = m; else result.unmatched.push(it.id);
      opts.onItem?.(it.id, m);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 3, items.length) }, worker));
  return result;
}
