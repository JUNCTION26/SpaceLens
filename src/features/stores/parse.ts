// Pure text parsers for store listings: prices, dimensions, reader markdown and search results.
// Everything here is deterministic so it can be tested and used without a model.

export interface Price { amount: number; currency: string }
export interface Dims { w?: number; d?: number; h?: number }

const SPACES = /[    ]/g;
/** Strip markdown emphasis and odd spaces so labels and numbers sit next to each other. */
export const cleanText = (s: string) => s.replace(SPACES, ' ').replace(/\*\*|__/g, '');

// ---- prices ----------------------------------------------------------------------------

const NUM = String.raw`\d{1,3}(?:[ .,']\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?`;
const SYMBOL: Record<string, string> = { '€': 'EUR', '$': 'USD', '£': 'GBP', 'us$': 'USD' };
const CODES = 'SEK|EUR|USD|GBP|NOK|DKK|CHF|PLN';
const PREFIX = new RegExp(String.raw`(€|US\$|\$|£|\b(?:${CODES})\b|\bkr\.?)\s?(${NUM})`, 'gi');
const SUFFIX = new RegExp(String.raw`(${NUM})\s?(€|:-|,-|\bkr\b\.?|\b(?:${CODES})\b)`, 'gi');

/** "5 995" -> 5995, "1.299,00" -> 1299, "1,299.99" -> 1299.99, "826,99" -> 826.99. */
export function parseNumber(raw: string): number | null {
  let s = raw.replace(/[ ']/g, '');
  const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = lastDot > lastComma ? '.' : ',';
    const thou = dec === '.' ? ',' : '.';
    s = s.split(thou).join('').replace(dec, '.');
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? '.' : ',';
    const parts = s.split(sep);
    // "1.299" or "12,995" with 3-digit groups are thousands; "826,99" is a decimal.
    const thousands = parts.length > 2 || (parts.length === 2 && parts[1].length === 3);
    s = thousands ? parts.join('') : parts.join('.');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function currencyOf(token: string, fallback: string): string {
  const t = token.toLowerCase().replace(/\.$/, '');
  if (SYMBOL[t]) return SYMBOL[t];
  if (t === 'kr' || t === ':-' || t === ',-') return fallback;
  return t.toUpperCase();
}

/** Every price in the text, in order of appearance. `krCurrency` decides what "kr" / ":-" mean. */
export function parsePrices(text: string, krCurrency = 'SEK'): Array<Price & { index: number }> {
  const t = cleanText(text);
  const out: Array<Price & { index: number }> = [];
  for (const m of t.matchAll(PREFIX)) {
    const n = parseNumber(m[2]);
    if (n !== null && n > 0) out.push({ amount: n, currency: currencyOf(m[1], krCurrency), index: m.index ?? 0 });
  }
  for (const m of t.matchAll(SUFFIX)) {
    const n = parseNumber(m[1]);
    const idx = m.index ?? 0;
    if (n !== null && n > 0 && !out.some((p) => Math.abs(p.index - idx) < m[0].length)) out.push({ amount: n, currency: currencyOf(m[2], krCurrency), index: idx });
  }
  return out.sort((a, b) => a.index - b.index);
}

/** First price in the text, or null. */
export function parsePrice(text: string, krCurrency = 'SEK'): Price | null {
  const p = parsePrices(text, krCurrency)[0];
  return p ? { amount: p.amount, currency: p.currency } : null;
}

/** What "kr" means for a store, from its domain. */
export function krCurrencyFor(url: string): string {
  try {
    const h = new URL(url).hostname;
    if (/\.no$|\/no\//.test(h + new URL(url).pathname)) return 'NOK';
    if (/\.dk$|\/dk\//.test(h + new URL(url).pathname)) return 'DKK';
  } catch { /* not a URL */ }
  return 'SEK';
}

// ---- dimensions ------------------------------------------------------------------------

const toM = (v: number, unit: string | undefined) => {
  const u = (unit ?? 'cm').toLowerCase();
  const m = u === 'mm' ? v / 1000 : u === 'm' ? v : v / 100;
  return Math.round(m * 1000) / 1000;
};

const AXIS_WORDS: Array<[keyof Dims, string]> = [
  ['w', 'width|bredd|breite|largeur|larghezza|bredde|leveys'],
  ['d', 'depth|djup|djupt|tiefe|profondeur|profondità|dybde|syvyys'],
  ['h', 'height|höjd|höhe|hauteur|altezza|højde|høyde|korkeus'],
];
const LETTER: Record<string, keyof Dims> = { w: 'w', b: 'w', l: 'w', d: 'd', t: 'd', p: 'd', h: 'h' };
const N = String.raw`(\d+(?:[.,]\d+)?)`;
const U = String.raw`(mm|cm|m)\b`;

/** Dimensions in metres from listing text: "W 220 x D 95 x H 82 cm", "Bredd: 220 cm", "B/T/H: 220 x 71 x 85 cm". */
export function parseDimensions(text: string): Dims {
  const t = cleanText(text);
  const out: Dims = {};
  const num = (s: string) => parseFloat(s.replace(',', '.'));

  // Labelled triple: W 220 x D 95 x H 82 cm (labels may follow the number too).
  const lab = String.raw`([WBLDTPH])\s*:?\s*`;
  const tripleLab = new RegExp(String.raw`(?<![\p{L}])${lab}${N}\s*(?:${U})?\s*[x×*]\s*${lab}${N}\s*(?:${U})?\s*[x×*]\s*${lab}${N}\s*${U}`, 'iu');
  const m1 = t.match(tripleLab);
  if (m1) {
    const unit = m1[9];
    const pairs: Array<[string, string, string | undefined]> = [[m1[1], m1[2], m1[3]], [m1[4], m1[5], m1[6]], [m1[7], m1[8], unit]];
    for (const [l, v, u] of pairs) { const k = LETTER[l.toLowerCase()]; if (k && out[k] === undefined) out[k] = toM(num(v), u ?? unit); }
    if (out.w && out.d && out.h) return out;
  }

  // Order given up front: "B/T/H: 220 x 71 x 85 cm", "WxDxH 220 x 95 x 82 cm".
  const order = new RegExp(String.raw`(?<![\p{L}])([WBLDTPH])\s*[/x×]\s*([WBLDTPH])\s*[/x×]\s*([WBLDTPH])\s*:?\s*${N}\s*[x×*]\s*${N}\s*[x×*]\s*${N}\s*${U}`, 'iu');
  const m2 = t.match(order);
  if (m2) {
    const unit = m2[7];
    [m2[1], m2[2], m2[3]].forEach((l, i) => { const k = LETTER[l.toLowerCase()]; if (k && out[k] === undefined) out[k] = toM(num(m2[4 + i]), unit); });
    if (out.w && out.d && out.h) return out;
  }

  // Single labelled values: "Width 228 cm", "Bredd: 220 cm", "Höhe: 87 cm" (not "Sitzhöhe").
  for (const [k, words] of AXIS_WORDS) {
    if (out[k] !== undefined) continue;
    const re = new RegExp(String.raw`(?<![\p{L}])(?:${words})(?![\p{L}])\s*[:=]?\s*(?:ca\.?|approx\.?|about)?\s*${N}\s*${U}`, 'iu');
    const m = t.match(re);
    if (m) out[k] = toM(num(m[1]), m[2]);
  }

  // Bare triple "220 x 95 x 82 cm": read as width x depth x height.
  if (out.w === undefined && out.d === undefined && out.h === undefined) {
    const bare = new RegExp(String.raw`${N}\s*[x×*]\s*${N}\s*[x×*]\s*${N}\s*${U}`, 'i');
    const m3 = t.match(bare);
    if (m3) { out.w = toM(num(m3[1]), m3[4]); out.d = toM(num(m3[2]), m3[4]); out.h = toM(num(m3[3]), m3[4]); }
  }
  return out;
}

// ---- reader markdown -------------------------------------------------------------------

export interface ReaderPage { title: string; sourceUrl: string; finalUrl?: string; images: string[]; body: string }

const IMG_EXT = /\.(jpe?g|png|webp|avif)(\?|$)|\/images?\/|\/media\//i;
const IMG_SKIP = /\.svg(\?|$)|logo|icon|sprite|favicon|badge|flag|pixel|placeholder|avatar|payment|klarna|trustpilot/i;

/** Splits the reader's markdown into title, source URL, product-looking images and body text. */
export function parseReaderMarkdown(md: string): ReaderPage {
  const title = md.match(/^Title:\s*(.*)$/m)?.[1]?.trim() ?? '';
  const sourceUrl = md.match(/^URL Source:\s*(\S+)/m)?.[1] ?? '';
  const finalUrl = md.match(/^Final URL:\s*(\S+)/m)?.[1];
  const bodyStart = md.indexOf('Markdown Content:');
  const body = bodyStart >= 0 ? md.slice(bodyStart + 17) : md;
  const seen = new Set<string>();
  const images: string[] = [];
  for (const m of body.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)) {
    const u = m[1];
    if (seen.has(u) || IMG_SKIP.test(u) || !IMG_EXT.test(u)) continue;
    seen.add(u);
    images.push(u);
  }
  // Prefer images whose file name shares a word with the product title.
  const key = title.toLowerCase().split(/[^a-z0-9åäöüéß]+/).filter((w) => w.length > 3).slice(0, 3);
  const score = (u: string) => (key.some((k) => u.toLowerCase().includes(k)) ? 1 : 0);
  images.sort((a, b) => score(b) - score(a));
  return { title, sourceUrl, finalUrl, images, body };
}

/** Body text with images and link targets removed, for a model prompt. */
export function compactBody(body: string, max = 24000): string {
  return cleanText(body)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\]\((?:[^()]|\([^)]*\))*\)/g, ']')
    .replace(/\[\]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .slice(0, max);
}

/** "KIVIK 3-seat sofa, grey - IKEA Sweden" -> "KIVIK 3-seat sofa, grey". */
export function stripStoreSuffix(title: string, store: string): string {
  const s = store.toLowerCase().split('.')[0];
  const parts = title.split(/\s+[|–-]\s+/);
  if (parts.length > 1 && parts[parts.length - 1].toLowerCase().includes(s)) parts.pop();
  return parts.join(' - ').replace(/\s+kaufen$/i, '').trim();
}

/** Short store name from a URL: "https://www.ikea.com/se/..." -> "ikea.com". */
export function storeFromUrl(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/** Text after the product heading, where the main price sits (before related products). */
export function mainSection(body: string, title: string): string {
  const first = title.split(/[\s,]+/)[0];
  if (first && first.length > 2) {
    const re = new RegExp(String.raw`^#{1,2}\s.*${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'im');
    const m = body.match(re);
    if (m?.index !== undefined) return body.slice(m.index);
  }
  return body;
}

// ---- web search results (DuckDuckGo HTML through the reader) ----------------------------

export interface SearchHit { title: string; url: string }

/** Result links from DuckDuckGo's HTML results page as returned by the reader. */
export function parseDdgResults(md: string): SearchHit[] {
  const out: SearchHit[] = [];
  const seen = new Set<string>();
  for (const m of md.matchAll(/^##\s*\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gm)) {
    let url = m[2];
    const u = url.match(/[?&]uddg=([^&]+)/);
    if (u) url = decodeURIComponent(u[1]);
    if (/duckduckgo\.com\/y\.js|bing\.com\/aclick/.test(url) || !/^https?:\/\//.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({ title: m[1].replace(/\*\*/g, '').trim(), url });
  }
  return out;
}

/** Product pages rather than categories or searches. */
export function isLikelyProductUrl(url: string): boolean {
  let p = '';
  try { p = new URL(url).pathname.toLowerCase(); } catch { return false; }
  if (isCategoryUrl(url)) return false;
  return /\/(p|product|products|produkt|produkte|dp|item|artikel|art|pd)\//.test(p) || /[-_/]\d{5,}|[-_][a-z]?\d{4,}\/?$/.test(p) || /-p-?\d+/.test(p);
}

/** Category, search and listing pages: never a single product. */
export function isCategoryUrl(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return true; }
  const p = u.pathname.toLowerCase();
  if (/\/p\//.test(p)) return false;
  if (/\/(cat|category|categories|kategori|kategorie|c|b|s|sb2|browse|search|sok|suche|rooms|ideas|inspiration|blog|collections?|sp)\//.test(p)) return true;
  if (/[?&](k|q|query|search|colour|color)=/.test(u.search)) return true;
  return p.split('/').filter(Boolean).length <= 1;
}

// ---- query constraints -----------------------------------------------------------------

export interface QueryLimits { maxPrice?: number; currency?: string; maxW?: number; maxD?: number; maxH?: number }

/** "under 6 000 kr", "max 220 cm wide", "below €500". */
export function parseQueryLimits(q: string): QueryLimits {
  const t = cleanText(q).toLowerCase();
  const out: QueryLimits = {};
  const pm = t.match(new RegExp(String.raw`(?:under|below|max(?:imum)?|less than|up to|upp till|högst|unter|bis)\s*(€|\$|£|sek|eur|usd|gbp)?\s?(${NUM})\s*(kr|sek|€|eur|usd|\$|gbp|£|:-)?`, 'i'));
  if (pm && !/^\s*(cm|mm|m)\b/.test(t.slice((pm.index ?? 0) + pm[0].length)) ) {
    const n = parseNumber(pm[2]);
    const cur = (pm[1] ?? pm[3] ?? '').toLowerCase();
    if (n !== null && (cur || n >= 50)) { out.maxPrice = n; out.currency = cur ? currencyOf(cur, 'SEK') : 'SEK'; }
  }
  const dm = (words: string) => t.match(new RegExp(String.raw`(?:max(?:imum)?|under|up to|högst|at most)?\s*${N}\s*${U}\s*(?:${words})`, 'i'));
  const w = dm('wide|width|bred|bredd|breit'); if (w) out.maxW = toM(parseFloat(w[1].replace(',', '.')), w[2]);
  const d = dm('deep|depth|djup|tief'); if (d) out.maxD = toM(parseFloat(d[1].replace(',', '.')), d[2]);
  const h = dm('high|tall|height|hög|hoch'); if (h) out.maxH = toM(parseFloat(h[1].replace(',', '.')), h[2]);
  return out;
}

/** The search words without budget and size limits, which are checked after reading each page. */
export function searchTerms(q: string): string {
  const LIMIT = String.raw`(?:under|below|max(?:imum)?|less than|up to|upp till|högst|unter|bis|at most)`;
  const AXIS = 'wide|width|bred|bredd|breit|deep|depth|djup|tief|high|tall|height|hög|hoch';
  return cleanText(q)
    .replace(new RegExp(String.raw`(?:${LIMIT}\s*)?${N}\s*${U}\s*(?:${AXIS})?`, 'gi'), ' ')
    .replace(new RegExp(String.raw`${LIMIT}\s*(?:€|\$|£|sek|eur|usd|gbp)?\s?(?:${NUM})\s*(?:kr|sek|€|eur|usd|\$|gbp|£|:-)?(?![\p{L}])`, 'giu'), ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ---- misc ------------------------------------------------------------------------------

/** First JSON object in model text: a ```json block or the outermost braces. */
export function extractJsonBlock<T = unknown>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const tryParse = (s: string | undefined) => { if (!s) return null; try { return JSON.parse(s) as T; } catch { return null; } };
  const a = tryParse(fenced?.trim());
  if (a) return a;
  const i = text.indexOf('{'), j = text.lastIndexOf('}');
  return i >= 0 && j > i ? tryParse(text.slice(i, j + 1)) : null;
}

/** "just now", "2 min ago", "3 h ago", "2 d ago". */
export function timeAgo(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** "220 × 95 × 82 cm" with "?" for missing sides. */
export function fmtDims(d: Dims | undefined): string {
  if (!d || (d.w === undefined && d.d === undefined && d.h === undefined)) return 'Size not stated';
  const c = (v?: number) => (v === undefined ? '?' : String(Math.round(v * 100)));
  return `${c(d.w)} × ${c(d.d)} × ${c(d.h)} cm`;
}

export function fmtMoney(amount: number, currency: string): string {
  const n = amount % 1 ? amount.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : Math.round(amount).toLocaleString('sv-SE');
  if (currency === 'SEK') return `${n} kr`;
  if (currency === 'EUR') return `€${n}`;
  if (currency === 'USD') return `$${n}`;
  if (currency === 'GBP') return `£${n}`;
  return `${n} ${currency}`;
}
