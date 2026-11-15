// Finds real IKEA products (Sweden or Finland) that fit the space an item stands in. Gemini with
// Google Search grounding proposes candidates; none of its words are trusted. Every candidate's
// page is read again, and only what the page itself shows (price, size) is kept. A candidate whose
// page does not load, was redirected to a general page, shows no price, shows no full size, or
// does not fit the window is dropped, so a URL or a price is never invented.

import { ai, aiReady } from '../../core/ai';
import type { FurnitureItem, SpaceModel, StoreListing } from '../../core/types';
import { fitWindow, type FitWindow } from './fit';
import { extractJsonBlock } from './parse';
import { readListing, type ReadListing } from './read';

export interface Candidate { name: string; url: string; price: number | null; currency: string; widthCm: number | null; depthCm: number | null; heightCm: number | null }
export interface Match { listing: StoreListing; image?: string; /** Width and depth fit; the page gave no height. */ heightUnconfirmed?: boolean }

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
  return out.slice(0, 6);
}

export function promptFor(item: Pick<FurnitureItem, 'name' | 'category'>, win: Pick<FitWindow, 'w' | 'd' | 'h'>, country: 'se' | 'fi' | 'both' = 'both'): string {
  const cm = (m: number) => Math.round(m * 100);
  const where = country === 'se' ? 'IKEA Sweden (ikea.com/se)' : country === 'fi' ? 'IKEA Finland (ikea.com/fi)' : 'IKEA Sweden (ikea.com/se) or IKEA Finland (ikea.com/fi)';
  return `Find 6 different real products currently sold by ${where} that could replace a "${item.name}" (category: ${item.category}).
Each must fit in at most ${cm(win.w)} cm wide, ${cm(win.d)} cm deep and ${cm(win.h)} cm high. Use Google Search. Only individual product pages (URL contains /p/), never categories.
Copy each URL exactly as it appears in the search results: IKEA article numbers in URLs have 8 digits (for example ...-80213074/). Never type a URL from memory. Never guess a URL, price or size; leave a value null if you did not see it. Reply ONLY with:
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

export type DropReason = 'page did not load' | 'no price on page' | 'redirected to another page' | 'currency does not match store' | 'no size on page' | 'size over window' | 'different kind of product';
export interface Dropped { url: string; reason: DropReason; detail?: string }
export interface FindReport { asked: number; verified: number; dropped: Dropped[] }

const sameUrl = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
const storeCurrency = (url: string) => (/\.ikea\.com\/fi\//i.test(url) ? 'EUR' : 'SEK');

const KINDS = [['desk', 'table'], ['sofa', 'couch', 'loveseat'], ['bookshelf', 'bookcase', 'shelf', 'shelving', 'shelving-unit'], ['tv-unit', 'tv-bench', 'media'], ['dresser', 'chest', 'drawers'], ['nightstand', 'bedside-table']];
/** Same family of furniture, so a drawer unit is not offered for a desk. Unknown words are accepted. */
export function sameKind(want: string, got: string): boolean {
  const a = want.toLowerCase(), b = got.toLowerCase();
  if (a === b) return true;
  const fa = KINDS.find((k) => k.includes(a)), fb = KINDS.find((k) => k.includes(b));
  if (fa && fb) return fa === fb;
  return !(fa || fb) ? true : false;
}

/** 'fits' when all three sizes are stated and within the window; 'height-unconfirmed' when width and depth fit and height is not stated. */
export function fitState(stated: { w?: number; d?: number; h?: number } | undefined, win: Pick<FitWindow, 'w' | 'd' | 'h'>): 'fits' | 'height-unconfirmed' | 'over' | 'no-size' {
  if (!stated || stated.w === undefined || stated.d === undefined) return 'no-size';
  const tol = 0.005;
  if (stated.w > win.w + tol || stated.d > win.d + tol) return 'over';
  if (stated.h === undefined) return 'height-unconfirmed';
  return stated.h <= win.h + tol ? 'fits' : 'over';
}

/** A candidate's page, read for real: kept only when it loads, is a product page, has a price in the store's currency and a size within the window (height may be unconfirmed). */
export async function verifyCandidate(c: Candidate, win: Pick<FitWindow, 'w' | 'd' | 'h'>, kind: string | undefined, read: FindDeps['read'], signal?: AbortSignal, dropped?: Dropped[]): Promise<Match | null> {
  const drop = (reason: DropReason, detail?: string): null => { dropped?.push({ url: c.url, reason, detail }); return null; };
  let page: ReadListing;
  try { page = await read(c.url, signal); } catch (e) { if (signal?.aborted) throw e; return drop('page did not load', e instanceof Error ? e.message : undefined); }
  const url = page.url || c.url;
  if (!IKEA.test(url) || !sameUrl(url, c.url)) return drop('redirected to another page', url);
  // The reader flags links the store sent elsewhere; their numbers belong to another page.
  if (page.note && /general page|redirected this link/i.test(page.note)) return drop('redirected to another page', page.note);
  if (page.price === null || !(page.price > 0)) return drop('no price on page');
  if (page.currency.toUpperCase() !== storeCurrency(url)) return drop('currency does not match store', page.currency);
  if (kind && page.category && !sameKind(kind, page.category)) return drop('different kind of product', page.category);
  const st = fitState(page.stated, win);
  const sized = JSON.stringify(page.stated ?? {});
  if (st === 'no-size') return drop('no size on page', sized);
  if (st === 'over') return drop('size over window', `${sized} vs ${JSON.stringify({ w: win.w, d: win.d, h: win.h })}`);
  const { images, category, note, via, ...listing } = page;
  void category; void note; void via;
  return { listing: { ...listing, url, currency: page.currency.toUpperCase() }, image: images[0], heightUnconfirmed: st === 'height-unconfirmed' };
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } }));
  return out;
}

/** Best first: confirmed height before unconfirmed, then cheaper. */
export function rankMatches(ms: Match[]): Match[] {
  return [...ms].sort((a, b) => Number(!!a.heightUnconfirmed) - Number(!!b.heightUnconfirmed) || (a.listing.price ?? 0) - (b.listing.price ?? 0));
}

/** Up to 3 verified products for one item inside `win`, with the reason every other candidate was dropped. */
export async function findProductsReport(item: Pick<FurnitureItem, 'name' | 'category'>, win: Pick<FitWindow, 'w' | 'd' | 'h'>, opts: { signal?: AbortSignal; deps?: FindDeps; country?: 'se' | 'fi' | 'both' } = {}): Promise<{ matches: Match[]; report: FindReport }> {
  const deps = opts.deps ?? defaultDeps;
  const report: FindReport = { asked: 0, verified: 0, dropped: [] };
  if (!opts.deps && !aiReady()) return { matches: [], report };
  let text: string;
  try { text = await deps.ask(promptFor(item, win, opts.country), opts.signal); } catch (e) { if (opts.signal?.aborted) throw e; return { matches: [], report }; }
  const cands = parseCandidates(text);
  report.asked = cands.length;
  const checked = await pool(cands, 3, (c) => verifyCandidate(c, win, item.category, deps.read, opts.signal, report.dropped));
  const ok = rankMatches(checked.filter((m): m is Match => m !== null)).slice(0, 3);
  report.verified = ok.length;
  return { matches: ok, report };
}

export async function findProducts(item: Pick<FurnitureItem, 'name' | 'category'>, win: Pick<FitWindow, 'w' | 'd' | 'h'>, opts: { signal?: AbortSignal; deps?: FindDeps; country?: 'se' | 'fi' | 'both' } = {}): Promise<Match[]> {
  return (await findProductsReport(item, win, opts)).matches;
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
