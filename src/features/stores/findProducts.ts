// Finds real IKEA products (Sweden or Finland) that fit the space an item stands in. Gemini with
// Google Search grounding proposes candidates; none of its words are trusted. Every candidate's
// page is read again, and only what the page itself shows (price, size) is kept. A candidate whose
// page does not load, was redirected to a general page, shows no price, shows no full size, or
// does not fit the window is dropped, so a URL or a price is never invented.

import { ai, aiReady, currentTransport } from '../../core/ai';
import { candidatesFor } from '../../core/ai/models';
import { SseParser } from '../../core/ai/sse';
import { streamRequest } from '../../core/ai/transport';
import type { FurnitureItem, SpaceModel, StoreListing } from '../../core/types';
import { fitWindow, type FitWindow } from './fit';
import { extractJsonBlock } from './parse';
import { readListing, readerFetch, type ReadListing } from './read';

export interface Candidate { name: string; url: string; price: number | null; currency: string; widthCm: number | null; depthCm: number | null; heightCm: number | null }
export interface Match { listing: StoreListing; image?: string; /** Width and depth fit; the page gave no height. */ heightUnconfirmed?: boolean }

/** A grounded reply: its text and the source links the search tool returned (often redirect links). */
export interface Grounded { text: string; sources: string[] }

export interface FindDeps {
  /** Returns the raw text of a grounded model reply, or the text with the search sources. */
  ask: (prompt: string, signal?: AbortSignal) => Promise<string | Grounded>;
  read: (url: string, signal?: AbortSignal) => Promise<ReadListing>;
  /** Where a search source link really leads (an IKEA product url), or null. */
  resolve?: (url: string, signal?: AbortSignal) => Promise<string | null>;
  /** Product links on the store's own search page for a query. */
  search?: (query: string, store: 'se' | 'fi', signal?: AbortSignal) => Promise<{ title: string; url: string }[]>;
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

/** One grounded Gemini call that keeps the text and the sources the search tool returned. */
async function groundedCall(prompt: string, signal?: AbortSignal): Promise<Grounded> {
  const t = currentTransport();
  if (!t) throw new Error('no key');
  let lastErr: unknown;
  for (const model of candidatesFor('fast').slice(0, 3)) {
    const ctrl = new AbortController();
    const stop = () => ctrl.abort();
    signal?.addEventListener('abort', stop);
    const timer = setTimeout(stop, 40000);
    try {
      const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], tools: [{ google_search: {} }], generationConfig: { temperature: 0.1, thinkingConfig: { thinkingLevel: 'low' } } };
      const { url, init } = streamRequest(t, model, body, ctrl.signal);
      const res = await fetch(url, init);
      if (!res.ok || !res.body) { lastErr = new Error(`http ${res.status}`); continue; }
      const reader = res.body.getReader(); const dec = new TextDecoder(); const sse = new SseParser();
      const out: Grounded = { text: '', sources: [] };
      const handle = (data: string) => {
        let p: any; try { p = JSON.parse(data); } catch { return; }
        const c = p?.candidates?.[0];
        for (const part of c?.content?.parts ?? []) if (!part.thought && typeof part.text === 'string') out.text += part.text;
        for (const ch of c?.groundingMetadata?.groundingChunks ?? []) if (typeof ch?.web?.uri === 'string') out.sources.push(ch.web.uri);
      };
      for (;;) { const { done, value } = await reader.read(); if (done) break; for (const d of sse.push(dec.decode(value, { stream: true }))) handle(d); }
      for (const d of sse.push(dec.decode())) handle(d);
      for (const d of sse.flush()) handle(d);
      if (out.text || out.sources.length) return out;
    } catch (e) {
      if (signal?.aborted) throw e;
      lastErr = e;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); }
  }
  throw lastErr instanceof Error ? lastErr : new Error('no answer');
}

/** Follows a search source link through the page reader to the page it leads to; keeps only IKEA product pages. */
async function resolveSource(url: string, signal?: AbortSignal): Promise<string | null> {
  if (IKEA.test(url)) return cleanUrl(url);
  const md = await readerFetch(url, signal, 30000);
  const final = md.match(/^Final URL:\s*(\S+)/m)?.[1] ?? md.match(/^URL Source:\s*(\S+)/m)?.[1];
  return final && IKEA.test(final) ? cleanUrl(final) : null;
}

const SEARCH_BASE = { se: 'https://www.ikea.com/se/sv/search/?q=', fi: 'https://www.ikea.com/fi/fi/search/?q=' };
/** Product links on the store's own search page. */
export function parseSearchLinks(md: string): { title: string; url: string }[] {
  const out: { title: string; url: string }[] = [];
  const seen = new Set<string>();
  for (const m of md.matchAll(/(?:\[([^\]]*)\]\()?(https:\/\/www\.ikea\.com\/(?:se|fi)\/[a-z]{2}\/p\/[^\s)?#\]]+)/g)) {
    const url = m[2];
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ title: m[1] ?? '', url });
  }
  return out;
}

const defaultDeps: FindDeps = {
  ask: async (prompt, signal) => {
    try { return await groundedCall(prompt, signal); } catch (e) { if (signal?.aborted) throw e; }
    const r = await ai<string>({ task: 'fast', parts: [{ text: prompt }], tools: [{ google_search: {} }], temperature: 0.1, thinking: 'low', signal, cacheKey: `findp:${prompt}` });
    return r.data;
  },
  read: readListing,
  resolve: resolveSource,
  search: async (query, store, signal) => parseSearchLinks(await readerFetch(SEARCH_BASE[store] + encodeURIComponent(query), signal, 30000)),
};

export type DropReason = 'page did not load' | 'no price on page' | 'redirected to another page' | 'currency does not match store' | 'no size on page' | 'size over window' | 'different kind of product';
export interface Dropped { url: string; reason: DropReason; detail?: string }
export interface FindReport { asked: number; verified: number; dropped: Dropped[] }

const sameUrl = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
const storeCurrency = (url: string) => (/\.ikea\.com\/fi\//i.test(url) ? 'EUR' : 'SEK');

const KINDS = [
  ['desk', 'table'], ['sofa', 'couch', 'loveseat'], ['bookshelf', 'bookcase', 'shelf', 'shelving', 'shelving-unit'], ['tv-unit', 'tv-bench', 'media'],
  ['dresser', 'chest', 'drawers'], ['nightstand', 'bedside-table'], ['bed'], ['wardrobe', 'closet'], ['armchair', 'chair'],
];
/** Same family of furniture, so a drawer unit is not offered for a desk. Unknown words are accepted. */
export function sameKind(want: string, got: string): boolean {
  const a = want.toLowerCase(), b = got.toLowerCase();
  if (a === b) return true;
  const fa = KINDS.find((k) => k.includes(a)), fb = KINDS.find((k) => k.includes(b));
  if (fa && fb) return fa === fb;
  return !(fa || fb) ? true : false;
}

/** Words that name each family in Swedish, Finnish and English, as found in a title or an article slug (ä, ö as ae, oe in slugs). */
const KIND_WORDS: [string, RegExp][] = [
  ['nightstand', /nattduk|sangbord|saengbord|sängbord|\by(?:ö|o|oe)p(?:ö|o|oe)yt|bedside|nightstand/i],
  ['tv-unit', /tv-?(bank|bench|unit|taso|tason)|tv-?baenk|tv-?bänk|mediabank|mediabaenk/i],
  ['desk', /skrivbord|tyopoyt|työpöyt|tyoepoeyt|writing desk|\bdesk\b/i],
  ['bed', /sangstomme|saengstomme|sängstomme|\bsang\b|\bsäng\b|\bsaeng\b|sänky|saenky|sanky|bed frame|\bbed\b|bunk/i],
  ['sofa', /\bsoffa|soffor|sohva|\bsofa|couch|bäddsoffa|baeddsoffa/i],
  ['armchair', /fatolj|fåtölj|faatoelj|nojatuoli|noyatuoli|armchair|lounge chair/i],
  ['wardrobe', /garderob|vaatekaap|vaatekaappi|wardrobe|closet/i],
  ['bookshelf', /bokhyl|bokstall|bokställ|kirjahyl|hylla|hylly|bookcase|bookshelf|shelving|shelf/i],
  ['dresser', /byra|byrå|lådor|laador|lipasto|dresser|chest of drawers|drawer/i],
];
const kindOfText = (t: string): string | null => KIND_WORDS.find(([, re]) => re.test(t))?.[0] ?? null;
const FAMILY_OF: Record<string, string> = { desk: 'desk', table: 'desk', sofa: 'sofa', couch: 'sofa', loveseat: 'sofa', bookshelf: 'bookshelf', bookcase: 'bookshelf', shelf: 'bookshelf', shelving: 'bookshelf', 'shelving-unit': 'bookshelf', 'tv-unit': 'tv-unit', 'tv-bench': 'tv-unit', media: 'tv-unit', dresser: 'dresser', chest: 'dresser', drawers: 'dresser', nightstand: 'nightstand', 'bedside-table': 'nightstand', bed: 'bed', wardrobe: 'wardrobe', closet: 'wardrobe', armchair: 'armchair', chair: 'armchair' };

/** What the page's title (and article slug) say about the kind, checked against the wanted kind. 'unknown' when no known word appears. */
export function kindFromTitle(want: string, title: string, url = ''): 'match' | 'other' | 'unknown' {
  const fam = FAMILY_OF[want.toLowerCase()];
  if (!fam) return 'unknown';
  const slug = decodeURIComponent(url.split('/p/')[1] ?? '').replace(/-[a-z]?\d{5,}\/?$/i, '').replace(/-/g, ' ');
  const got = kindOfText(`${title} ${slug}`);
  return got === null ? 'unknown' : got === fam ? 'match' : 'other';
}

/** 'fits' when all three sizes are stated and within the window; 'height-unconfirmed' when width and depth fit and height is not stated. */
export function fitState(stated: { w?: number; d?: number; h?: number } | undefined, win: Pick<FitWindow, 'w' | 'd' | 'h'>): 'fits' | 'height-unconfirmed' | 'over' | 'no-size' {
  if (!stated || stated.w === undefined || stated.d === undefined) return 'no-size';
  const tol = 0.005;
  if (stated.w > win.w + tol || stated.d > win.d + tol) return 'over';
  if (stated.h === undefined) return 'height-unconfirmed';
  return stated.h <= win.h + tol ? 'fits' : 'over';
}

const cleanUrl = (u: string) => u.trim().replace(/[?#].*$/, '');
const TRANSIENT = /too long|busy|timed out|timeout|fetch failed|network|50\d/i;
/** A page read, retried once when the reader was slow or busy. */
async function readOnce(read: FindDeps['read'], url: string, signal?: AbortSignal): Promise<ReadListing> {
  try { return await read(url, signal); } catch (e) {
    if (signal?.aborted || !(e instanceof Error) || !TRANSIENT.test(e.message)) throw e;
    return read(url, signal);
  }
}

/** A candidate's page, read for real: kept only when it loads, is a product page, has a price in the store's currency and a size within the window (height may be unconfirmed). */
export async function verifyCandidate(c: Candidate, win: Pick<FitWindow, 'w' | 'd' | 'h'>, kind: string | undefined, read: FindDeps['read'], signal?: AbortSignal, dropped?: Dropped[]): Promise<Match | null> {
  const drop = (reason: DropReason, detail?: string): null => { dropped?.push({ url: c.url, reason, detail }); return null; };
  let page: ReadListing;
  try { page = await readOnce(read, c.url, signal); } catch (e) { if (signal?.aborted) throw e; return drop('page did not load', e instanceof Error ? e.message : undefined); }
  const url = page.url || c.url;
  if (!IKEA.test(url) || !sameUrl(url, c.url)) return drop('redirected to another page', url);
  // The reader flags links the store sent elsewhere; their numbers belong to another page.
  if (page.note && /general page|redirected this link/i.test(page.note)) return drop('redirected to another page', page.note);
  if (page.price === null || !(page.price > 0)) return drop('no price on page');
  if (page.currency.toUpperCase() !== storeCurrency(url)) return drop('currency does not match store', page.currency);
  if (kind) {
    // The title and article slug (Swedish, Finnish or English words) decide first; the page's own category word only when they are silent.
    const byTitle = kindFromTitle(kind, page.title, url);
    if (byTitle === 'other') return drop('different kind of product', page.title);
    if (byTitle === 'unknown' && page.category && !sameKind(kind, page.category)) return drop('different kind of product', page.category);
  }
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

/** Concurrency for page reads: the reader times out under load. */
const READ_CONCURRENCY = 2;

/** Best first: confirmed height before unconfirmed, then cheaper. */
export function rankMatches(ms: Match[]): Match[] {
  return [...ms].sort((a, b) => Number(!!a.heightUnconfirmed) - Number(!!b.heightUnconfirmed) || (a.listing.price ?? 0) - (b.listing.price ?? 0));
}

// ---- names, search pass, simpler retry, cache ------------------------------------------

/** Swedish/Finnish word for the kind, used to search the store's own search page. */
const TYPE_WORD: Record<string, { se: string; fi: string }> = {
  desk: { se: 'skrivbord', fi: 'työpöytä' }, bed: { se: 'säng', fi: 'sänky' }, sofa: { se: 'soffa', fi: 'sohva' }, bookshelf: { se: 'bokhylla', fi: 'kirjahylly' },
  wardrobe: { se: 'garderob', fi: 'vaatekaappi' }, armchair: { se: 'fåtölj', fi: 'nojatuoli' }, 'tv-unit': { se: 'tv-bänk', fi: 'tv-taso' }, dresser: { se: 'byrå', fi: 'lipasto' }, nightstand: { se: 'sängbord', fi: 'yöpöytä' },
};
const storeOf = (url: string): 'se' | 'fi' => (/\/fi\//i.test(url) ? 'fi' : 'se');
const fold = (t: string) => t.toLowerCase().replace(/å/g, 'a').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/[^a-z0-9]/g, '');

/** The product name word: the model's name, else the first word of the article slug. */
function nameWord(c: Candidate): string {
  const fromName = c.name.trim().split(/[\s,]+/)[0] ?? '';
  if (fromName.length >= 3) return fromName;
  const slug = decodeURIComponent(c.url.split('/p/')[1] ?? '');
  return slug.split('-')[0] ?? '';
}

/** Search-page links whose article slug starts with the product name, or whose link text contains it. */
export function matchByName(links: { title: string; url: string }[], word: string): string[] {
  const w = fold(word);
  if (w.length < 3) return [];
  return links.filter((l) => fold(l.url.split('/p/')[1] ?? '').startsWith(w) || fold(l.title).includes(w)).map((l) => cleanUrl(l.url));
}

/** Plain prompt for a second try after an empty answer. */
export function simplePrompt(item: Pick<FurnitureItem, 'name' | 'category'>, win: Pick<FitWindow, 'w'>, country: 'se' | 'fi' | 'both' = 'both'): string {
  const site = country === 'fi' ? 'ikea.com/fi' : 'ikea.com/se';
  return `IKEA ${item.category} under ${Math.round(win.w * 100)} cm wide site:${site}`;
}

const asGrounded = (r: string | Grounded): Grounded => (typeof r === 'string' ? { text: r, sources: [] } : r);

const CACHE_TTL_MS = 60 * 60_000;
const cacheKey = (item: Pick<FurnitureItem, 'category'>, win: Pick<FitWindow, 'w' | 'd' | 'h'>, country: string) => {
  const b = (m: number) => Math.floor((m * 100) / 5) * 5;
  return `spacelens.shop.v1:${item.category}:${country}:${b(win.w)}x${b(win.d)}x${b(win.h)}`;
};
function cacheGet(key: string, win: Pick<FitWindow, 'w' | 'd' | 'h'>): Match[] | null {
  try {
    const raw = globalThis.sessionStorage?.getItem(key);
    if (!raw) return null;
    const { at, matches } = JSON.parse(raw) as { at: number; matches: Match[] };
    if (Date.now() - at > CACHE_TTL_MS) return null;
    // The window bucket is coarse: every cached product is re-checked against this window.
    const ok = matches.filter((m) => { const f = fitState(m.listing.stated, win); return f === 'fits' || f === 'height-unconfirmed'; });
    return ok.length ? ok : null;
  } catch { return null; }
}
function cachePut(key: string, matches: Match[]) {
  try { globalThis.sessionStorage?.setItem(key, JSON.stringify({ at: Date.now(), matches })); } catch { /* storage full or blocked */ }
}

export interface FindOpts { signal?: AbortSignal; deps?: FindDeps; country?: 'se' | 'fi' | 'both'; /** Session cache of verified products. Default: on with the real reader, off with injected deps. */ cache?: boolean }

const blank = (url: string): Candidate => ({ name: '', url, price: null, currency: '', widthCm: null, depthCm: null, heightCm: null });

/** Up to 3 verified products for one item inside `win`, with the reason every other candidate was dropped. */
export async function findProductsReport(item: Pick<FurnitureItem, 'name' | 'category'>, win: Pick<FitWindow, 'w' | 'd' | 'h'>, opts: FindOpts = {}): Promise<{ matches: Match[]; report: FindReport }> {
  const deps = opts.deps ?? defaultDeps;
  const report: FindReport = { asked: 0, verified: 0, dropped: [] };
  if (!opts.deps && !aiReady()) return { matches: [], report };
  const signal = opts.signal;
  const useCache = opts.cache ?? !opts.deps;
  const ckey = cacheKey(item, win, opts.country ?? 'both');
  if (useCache) {
    const hit = cacheGet(ckey, win);
    if (hit) { report.verified = hit.length; report.asked = hit.length; return { matches: rankMatches(hit).slice(0, 3), report }; }
  }

  // 1. Grounded answer; an empty one is asked again with a plain query.
  let g: Grounded = { text: '', sources: [] };
  try { g = asGrounded(await deps.ask(promptFor(item, win, opts.country), signal)); } catch (e) { if (signal?.aborted) throw e; }
  let fromText = parseCandidates(g.text);
  if (!fromText.length && !g.sources.length) {
    try { g = asGrounded(await deps.ask(simplePrompt(item, win, opts.country), signal)); } catch (e) { if (signal?.aborted) throw e; }
    fromText = parseCandidates(g.text);
    // A plain-query answer is prose: take the product links written in it.
    if (!fromText.length) fromText = [...new Set(g.text.match(/https:\/\/www\.ikea\.com\/(?:se|fi)\/[a-z]{2}\/p\/[^\s)\]"'>,;?#]+/gi) ?? [])].map((u) => blank(cleanUrl(u)));
  }

  // 2. The links the search tool really returned come first; the model's written links follow.
  const cands: Candidate[] = [];
  const seen = new Set<string>();
  const add = (c: Candidate) => { const k = c.url.replace(/\/+$/, ''); if (!seen.has(k)) { seen.add(k); cands.push(c); } };
  if (deps.resolve) {
    const resolved = await pool(g.sources.slice(0, 8), READ_CONCURRENCY, async (u) => { try { return await deps.resolve!(u, signal); } catch (e) { if (signal?.aborted) throw e; return null; } });
    for (const url of resolved) if (url && IKEA.test(url)) add(blank(url));
  }
  for (const c of fromText) add(c);
  const queue = cands.slice(0, 10);
  report.asked = queue.length;

  const found: Match[] = [];
  const have = new Set<string>();
  const take = (m: Match | null) => { if (m && !have.has(m.listing.url)) { have.add(m.listing.url); found.push(m); } };
  const checked = await pool(queue, READ_CONCURRENCY, (c) => verifyCandidate(c, win, item.category, deps.read, signal, report.dropped));
  checked.forEach(take);

  // 3. A dropped candidate is looked up again by name on the store's own search page.
  if (deps.search && found.length < 3) {
    const retry = queue.filter((c) => report.dropped.some((d) => d.url === c.url && (d.reason === 'redirected to another page' || d.reason === 'page did not load' || d.reason === 'no price on page')));
    const words = [...new Map(retry.map((c) => [fold(nameWord(c)), c] as const)).values()].filter((c) => nameWord(c).length >= 3).slice(0, 4);
    const second = await pool(words, READ_CONCURRENCY, async (c) => {
      const store = storeOf(c.url);
      const type = TYPE_WORD[item.category]?.[store] ?? item.category;
      let links: { title: string; url: string }[] = [];
      try { links = await deps.search!(`${nameWord(c)} ${type}`, store, signal); } catch (e) { if (signal?.aborted) throw e; return null; }
      const url = matchByName(links, nameWord(c)).find((u) => u.replace(/\/+$/, '') !== c.url.replace(/\/+$/, '') && !have.has(u));
      return url ? verifyCandidate({ ...c, url }, win, item.category, deps.read, signal, report.dropped) : null;
    });
    second.forEach(take);
  }

  const ok = rankMatches(found).slice(0, 3);
  report.verified = ok.length;
  if (useCache && ok.length) cachePut(ckey, ok);
  return { matches: ok, report };
}


export async function findProducts(item: Pick<FurnitureItem, 'name' | 'category'>, win: Pick<FitWindow, 'w' | 'd' | 'h'>, opts: FindOpts = {}): Promise<Match[]> {
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
