// Finds real listings for a request like "grey 3-seat sofa under 6 000 kr max 220 cm wide".
// First choice: Gemini with Google Search grounding. When the key has no grounding quota (or no
// key is set), the web is searched through DuckDuckGo's plain results page via the reader. Either
// way each product page is then read so the price and size come from the listing itself.

import { ai, aiReady, classify } from '../../core/ai';
import type { StoreListing } from '../../core/types';
import { extractJsonBlock, isCategoryUrl, isListTitle, isLikelyProductUrl, parseDdgResults, parseQueryLimits, searchTerms, storeFromUrl, type QueryLimits } from './parse';
import { readerFetch, readListing, type ReadListing } from './read';

export interface ShopListing extends ReadListing {
  /** Ways it misses the request ("over budget", "wider than 220 cm"). */
  issues: string[];
  /** Still reading the product page. */
  pending?: boolean;
}

export interface SearchOptions {
  limit?: number;
  signal?: AbortSignal;
  /** Called whenever a result is added or its page has been read. */
  onUpdate?: (results: ShopListing[]) => void;
  /** Short plain-language status for the UI. */
  onStatus?: (text: string) => void;
  /** Read each product page to confirm price and size (default true). */
  readPages?: boolean;
}

interface GroundedRow { title?: string; store?: string; url?: string; price?: number | null; currency?: string; imageUrl?: string | null; widthCm?: number | null; depthCm?: number | null; heightCm?: number | null }

/** Grounding that failed for quota or access is not retried for a while. */
let groundingPausedUntil = 0;

/** Grounded search through the shared router (cached, falls through models). Throws when unavailable so the caller can fall back. */
async function groundedSearch(query: string, limit: number, signal?: AbortSignal): Promise<ShopListing[]> {
  if (!aiReady()) throw new Error('no key');
  if (Date.now() < groundingPausedUntil) throw new Error('grounding paused');
  const prompt = `Find up to ${limit} real products currently sold online that match: "${query}".
Use Google Search. Only include individual product pages (not categories). For each give: the exact product page URL, title, store, price as a number exactly as listed (null if you did not see it), currency ISO code, image URL if seen (else null), and the stated overall width, depth and height in cm (null if not stated). Never guess a price or a size.
Reply ONLY with:
\`\`\`json
{"results":[{"title":"","store":"","url":"","price":null,"currency":"SEK","imageUrl":null,"widthCm":null,"depthCm":null,"heightCm":null}]}
\`\`\``;
  let text: string;
  try {
    // Grounding cannot be combined with responseSchema, so the JSON comes as text.
    const r = await ai<string>({ task: 'fast', parts: [{ text: prompt }], tools: [{ google_search: {} }], temperature: 0.1, signal, thinking: 'low', cacheKey: `ground:${limit}:${query.trim().toLowerCase()}` });
    text = r.data;
  } catch (e) {
    if (!signal?.aborted && classify(e).reason !== 'network') groundingPausedUntil = Date.now() + 10 * 60_000;
    throw e;
  }
  const rows = extractJsonBlock<{ results?: GroundedRow[] }>(text)?.results ?? [];
  const now = Date.now();
  const m = (v: number | null | undefined) => (typeof v === 'number' && v > 0 ? Math.round(v * 10) / 1000 : undefined);
  return rows
    .filter((r) => typeof r.url === 'string' && /^https?:\/\//.test(r.url))
    .slice(0, limit)
    .map((r) => {
      const stated = { w: m(r.widthCm), d: m(r.depthCm), h: m(r.heightCm) };
      return {
        title: r.title || storeFromUrl(r.url!), store: r.store || storeFromUrl(r.url!), url: r.url!,
        price: typeof r.price === 'number' && r.price > 0 ? r.price : null, currency: (r.currency || 'SEK').toUpperCase(),
        imageUrl: r.imageUrl || undefined, images: r.imageUrl ? [r.imageUrl] : [],
        stated: Object.values(stated).some((v) => v !== undefined) ? stated : undefined,
        fetchedAt: now, via: 'search' as const, issues: [],
      };
    });
}

const REGION: Record<string, string> = { SEK: 'se-sv', NOK: 'no-no', DKK: 'dk-da', GBP: 'uk-en', USD: 'us-en' };

/** Keyless web search: DuckDuckGo's HTML results read through the reader. Limits are stripped
 *  from the words (they are checked after each page is read) and the region follows the currency. */
async function webSearch(query: string, limit: number, lim: QueryLimits, signal?: AbortSignal): Promise<ShopListing[]> {
  const words = searchTerms(query) || query;
  const region = REGION[lim.currency ?? (/\bkr\b|:-/i.test(query) ? 'SEK' : '')];
  const md = await readerFetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(words)}${region ? `&kl=${region}` : ''}`, signal, 30000);
  const hits = parseDdgResults(md).filter((h) => !isCategoryUrl(h.url));
  // Clear product pages first, then other pages that might be one.
  const ranked = [...hits.filter((h) => isLikelyProductUrl(h.url)), ...hits.filter((h) => !isLikelyProductUrl(h.url))];
  const now = Date.now();
  return ranked.slice(0, limit).map((h) => ({
    title: h.title.replace(/\s+[|–-]\s+[^|–-]+$/, ''), store: storeFromUrl(h.url), url: h.url, price: null, currency: lim.currency ?? 'SEK',
    images: [], fetchedAt: now, via: 'search' as const, issues: [],
  }));
}

/** Ways a listing misses the limits in the request. Prices in another currency are not compared. */
export function issuesFor(l: StoreListing, lim: QueryLimits): string[] {
  const out: string[] = [];
  if (lim.maxPrice && l.price !== null && l.currency === (lim.currency ?? 'SEK') && l.price > lim.maxPrice) out.push('Over budget');
  const cm = (v: number) => `${Math.round(v * 100)} cm`;
  if (lim.maxW && l.stated?.w && l.stated.w > lim.maxW + 0.005) out.push(`Wider than ${cm(lim.maxW)}`);
  if (lim.maxD && l.stated?.d && l.stated.d > lim.maxD + 0.005) out.push(`Deeper than ${cm(lim.maxD)}`);
  if (lim.maxH && l.stated?.h && l.stated.h > lim.maxH + 0.005) out.push(`Taller than ${cm(lim.maxH)}`);
  return out;
}

/**
 * Real listings for a request. Every result carries its source URL and when it was read; results
 * without a URL are dropped and prices are never invented (null when the page does not show one).
 */
export async function searchProducts(query: string, opts: SearchOptions = {}): Promise<StoreListing[]> {
  const limit = opts.limit ?? 6;
  const lim = parseQueryLimits(query);
  let results: ShopListing[] = [];
  let grounded = false;
  try {
    opts.onStatus?.('Searching with Google…');
    results = await groundedSearch(query, limit, opts.signal);
    grounded = results.length > 0;
  } catch (e) {
    if (opts.signal?.aborted) throw e;
  }
  if (!grounded) {
    opts.onStatus?.('Searching the web…');
    results = await webSearch(query, limit, lim, opts.signal);
  }
  if (!results.length) { opts.onStatus?.('No product pages found. Try other words or paste a link.'); return []; }

  const emit = () => opts.onUpdate?.(results.map((r) => ({ ...r, issues: issuesFor(r, lim) })));
  if (opts.readPages === false) { emit(); return results; }

  results = results.map((r) => ({ ...r, pending: true }));
  emit();
  opts.onStatus?.(`Reading ${results.length} product pages…`);
  await Promise.all(results.map(async (r, i) => {
    try {
      const read = await readListing(r.url, opts.signal);
      // The page wins; a search-result price survives only when the page shows none.
      results[i] = { ...r, ...read, title: read.title || r.title, price: read.price ?? r.price, currency: read.price !== null ? read.currency : r.currency, stated: read.stated ?? r.stated, imageUrl: read.imageUrl ?? r.imageUrl, images: read.images.length ? read.images : r.images, via: 'page', pending: false, issues: [] };
    } catch {
      results[i] = { ...r, pending: false, note: 'Could not read the product page; details are from the search result.' };
    }
    emit();
  }));
  // A page that shows neither a price nor a size is not a usable product page.
  const done = results.filter((r) => (r.price !== null || r.stated) && (isLikelyProductUrl(r.url) || !isListTitle(r.title))).map((r) => ({ ...r, issues: issuesFor(r, lim) }));
  opts.onUpdate?.(done);
  opts.onStatus?.(grounded ? 'Found with Google Search, then read from each store.' : 'Found by web search, then read from each store.');
  return done;
}
