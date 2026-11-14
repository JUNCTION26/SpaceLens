// A store listing becomes a true-size object in the room: the 3D shape comes from the listing
// photo (or its title), the size is the listing's stated size exactly, and the price and link
// travel with the item into the bill of furniture.

import { uid } from '../../core/geometry';
import { getState } from '../../core/store';
import type { Clearance, FurnitureItem, ObjectSpec, StoreListing } from '../../core/types';
import { CATALOG } from '../furniture/catalog';
import { findFreeSpot, isWallCategory, snapToWall } from '../objects/placement';
import { rateToSek, toSek } from './fx';
import { blobToDataUrl, loadImageBlob } from './read';

type Size = { w: number; d: number; h: number };
type Partial3 = { w?: number; d?: number; h?: number };

interface ForgeGen {
  generateFromImage: (image: Blob | string, hint?: { name?: string; w?: number; d?: number; h?: number }, opts?: { onPartial?: (s: ObjectSpec) => void; signal?: AbortSignal }) => Promise<ObjectSpec>;
  generateObject: (prompt: string, opts?: { onPartial?: (s: ObjectSpec) => void; signal?: AbortSignal }) => Promise<ObjectSpec>;
}
interface ForgeFit { fitSpec: (spec: ObjectSpec, size: Size) => ObjectSpec }
interface ForgeLib { dominantColor?: (spec: ObjectSpec) => string; mainMaterial?: (spec: ObjectSpec) => string }

// Present only when the forge feature is in the build.
const FORGE = import.meta.glob(['../forge/generate.ts', '../forge/fit.ts', '../forge/library.ts']);
async function forge<T>(path: string): Promise<T | null> {
  const load = FORGE[path];
  if (!load) return null;
  try { return (await load()) as T; } catch { return null; }
}

export class MissingDimensionsError extends Error {
  constructor(readonly missing: Array<'w' | 'd' | 'h'>) {
    super(`The listing does not state its ${missing.map((k) => ({ w: 'width', d: 'depth', h: 'height' })[k]).join(', ')}.`);
    this.name = 'MissingDimensionsError';
  }
}

export interface ConvertOptions {
  /** Sizes the person typed or confirmed, metres; they win over the listing. */
  dims?: Partial3;
  /** SEK per unit of the listing currency; defaults to the current rate. */
  rate?: number;
  onPartial?: (spec: ObjectSpec) => void;
  signal?: AbortSignal;
}

/** Sides still missing after the listing and the person's own numbers. */
export function missingDims(listing: StoreListing, dims?: Partial3): Array<'w' | 'd' | 'h'> {
  const s = { ...listing.stated, ...dims };
  return (['w', 'd', 'h'] as const).filter((k) => !(typeof s[k] === 'number' && s[k]! > 0.01));
}

const CATEGORY_WORDS: Array<[RegExp, string]> = [
  [/sofa|couch|soffa|sitzer|canap/i, 'sofa'], [/armchair|fåtölj|sessel|lounge chair/i, 'armchair'],
  [/office chair|desk chair|kontorsstol|bürostuhl/i, 'office-chair'], [/chair|stol|stuhl/i, 'chair'],
  [/coffee table|soffbord|couchtisch/i, 'coffee-table'], [/desk|skrivbord|schreibtisch/i, 'desk'],
  [/table|bord|tisch/i, 'table'], [/bed|säng|bett/i, 'bed'], [/bookcase|bookshelf|shelf|hylla|regal/i, 'bookshelf'],
  [/wardrobe|garderob|kleiderschrank/i, 'wardrobe'], [/dresser|chest of drawers|byrå|kommode/i, 'dresser'],
  [/nightstand|bedside|sängbord|nachttisch/i, 'nightstand'], [/tv|media/i, 'tv-unit'], [/lamp|lampa|leuchte/i, 'lamp'],
  [/rug|matta|teppich/i, 'rug'], [/bench|bänk|bank/i, 'bench'],
];

export function guessCategory(title: string, hint?: string): string {
  if (hint && /^[a-z-]+$/.test(hint)) return hint.replace(/s$/, '');
  return CATEGORY_WORDS.find(([re]) => re.test(title))?.[1] ?? 'furniture';
}

/** Shorter display name: "KIVIK 3-seat sofa, Gunnared medium grey" stays; long SEO titles are cut. */
const shortName = (t: string) => (t.length > 60 ? `${t.slice(0, 57).replace(/\s+\S*$/, '')}…` : t);

function clearanceFor(category: string, spec?: ObjectSpec): Clearance {
  if (spec) return { front: spec.semantics.frontClearanceM, back: 0, left: spec.semantics.sideClearanceM, right: spec.semantics.sideClearanceM };
  const base = CATALOG.find((e) => e.category === category);
  return base ? { ...base.clearance } : { front: 0.5, back: 0, left: 0.1, right: 0.1 };
}

/** The listing price in SEK and how it was converted. */
export async function priceInSek(listing: StoreListing, rate?: number): Promise<{ sek: number | null; rate: number; source: string; converted: boolean }> {
  if (listing.price === null) return { sek: null, rate: rate ?? 1, source: 'no price', converted: false };
  if (listing.currency === 'SEK') return { sek: Math.round(listing.price), rate: 1, source: 'same currency', converted: false };
  const r = rate !== undefined ? { rate, source: 'your rate' } : await rateToSek(listing.currency);
  return { sek: toSek(listing.price, r.rate), rate: r.rate, source: r.source, converted: true };
}

/** Only the StoreListing fields, so extra UI fields (images, notes) stay out of the saved model. */
function bareListing(l: StoreListing, stated: Size): StoreListing {
  return { store: l.store, title: l.title, url: l.url, price: l.price, currency: l.currency, imageUrl: l.imageUrl?.startsWith('data:') ? undefined : l.imageUrl, stated, fetchedAt: l.fetchedAt };
}

/**
 * Builds a room item from a listing. The shape comes from the image (Blob, data URL or image
 * URL) when one is given, otherwise from the title; the size is the stated size exactly.
 * Throws MissingDimensionsError when a side is unknown so the UI can ask for it.
 */
export async function listingToItem(listing: StoreListing, image?: Blob | string, opts: ConvertOptions = {}): Promise<FurnitureItem> {
  const missing = missingDims(listing, opts.dims);
  if (missing.length) throw new MissingDimensionsError(missing);
  const s = { ...listing.stated, ...opts.dims } as Size;
  const size: Size = { w: s.w, d: s.d, h: s.h };
  const name = shortName(listing.title || 'Store item');

  // An image URL is only usable when the store allows cross-site reads.
  let img: Blob | string | undefined = image;
  if (typeof img === 'string' && /^https?:/.test(img)) {
    const blob = await loadImageBlob(img, opts.signal);
    img = blob ? await blobToDataUrl(blob) : undefined;
  }

  const gen = await forge<ForgeGen>('../forge/generate.ts');
  let spec: ObjectSpec | undefined;
  if (gen) {
    const hint = { name, w: size.w, d: size.d, h: size.h };
    spec = img
      ? await gen.generateFromImage(img, hint, { onPartial: opts.onPartial, signal: opts.signal })
      : await gen.generateObject(`${name}, ${Math.round(size.w * 100)} wide x ${Math.round(size.d * 100)} deep x ${Math.round(size.h * 100)} cm high`, { onPartial: opts.onPartial, signal: opts.signal });
    // The stated size is law: refit whatever came back to it exactly.
    const fit = await forge<ForgeFit>('../forge/fit.ts');
    if (fit) spec = fit.fitSpec(spec, size);
    spec = { ...spec, name, size };
  }

  const lib = spec ? await forge<ForgeLib>('../forge/library.ts') : null;
  const category = guessCategory(listing.title, spec?.semantics.category ?? (listing as { category?: string }).category);
  const price = await priceInSek(listing, opts.rate);
  const base = CATALOG.find((e) => e.category === category);
  return {
    id: uid('f'), catalogId: 'store', name, category,
    x: 1, y: 1, rotation: 0, w: size.w, d: size.d, h: size.h,
    clearance: clearanceFor(category, spec),
    locked: false, owned: false,
    priceSek: price.sek ?? 0, priceStatus: price.sek !== null ? 'catalog' : 'estimated',
    color: (spec && lib?.dominantColor?.(spec)) || base?.color || '#9aa3ad',
    material: (spec && lib?.mainMaterial?.(spec)) || base?.material,
    sourceKind: 'catalog',
    ...(spec ? { custom: spec } : {}),
    listing: bareListing(listing, size),
  };
}

/** Puts the item in a free spot (back to a wall when it wants one) and selects it. */
export function addToRoom(item: FurnitureItem): FurnitureItem {
  const st = getState();
  const placed = { ...item, ...findFreeSpot(st.model, item) };
  if (item.custom?.semantics.wallBacked || isWallCategory(item.category)) {
    const p = snapToWall(st.model, placed, 0.6);
    if (p) Object.assign(placed, p);
  }
  st.dispatch({ type: 'PLACE_OBJECT', item: placed });
  st.select({ kind: 'furniture', id: placed.id });
  return placed;
}
