import type { FurnitureItem, SpaceModel } from '../../core/types';

export interface BuyLine {
  name: string;
  /** Centimetres, rounded. */
  wCm: number; dCm: number; hCm: number;
  qty: number;
  /** Price per unit, or null when unknown. */
  unitPrice: number | null;
  currency: string | null;
  link: string;
  /** True when the link goes to a real listing, false for a search. */
  listed: boolean;
}

export interface ShoppingList {
  lines: BuyLine[];
  /** Sum per currency of priced lines. */
  totals: Record<string, number>;
  unpriced: number;
}

const cm = (m: number): number => Math.round(m * 100);

export function searchUrl(name: string, wCm: number, dCm: number, hCm: number): string {
  void wCm; void dCm; void hCm;
  return `https://www.ikea.com/se/en/search/?q=${encodeURIComponent(name)}`;
}

function priceOf(it: FurnitureItem): { price: number; currency: string } | null {
  if (it.listing && it.listing.price != null) return { price: it.listing.price, currency: it.listing.currency };
  if ((it.priceStatus === 'user' || it.priceStatus === 'catalog') && it.priceSek > 0) return { price: it.priceSek, currency: 'SEK' };
  return null;
}

export function buildShoppingList(model: Pick<SpaceModel, 'furniture'>): ShoppingList {
  const map = new Map<string, BuyLine>();
  for (const it of model.furniture) {
    if (it.owned) continue;
    const wCm = cm(it.w), dCm = cm(it.d), hCm = cm(it.h);
    const p = priceOf(it);
    const url = it.listing?.url;
    const key = [it.name, wCm, dCm, hCm, p?.price ?? '', p?.currency ?? '', url ?? ''].join('|');
    const hit = map.get(key);
    if (hit) { hit.qty += 1; continue; }
    map.set(key, {
      name: it.name, wCm, dCm, hCm, qty: 1,
      unitPrice: p ? p.price : null, currency: p ? p.currency : null,
      link: url || searchUrl(it.name, wCm, dCm, hCm), listed: !!url,
    });
  }
  const lines = [...map.values()];
  const totals: Record<string, number> = {};
  let unpriced = 0;
  for (const l of lines) {
    if (l.unitPrice == null || l.currency == null) { unpriced += 1; continue; }
    totals[l.currency] = (totals[l.currency] ?? 0) + l.unitPrice * l.qty;
  }
  return { lines, totals, unpriced };
}

const esc = (v: string | number): string => {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(list: ShoppingList): string {
  const rows: Array<Array<string | number>> = [['Name', 'Width cm', 'Depth cm', 'Height cm', 'Qty', 'Unit price', 'Currency', 'Line total', 'Link']];
  for (const l of list.lines) {
    rows.push([l.name, l.wCm, l.dCm, l.hCm, l.qty, l.unitPrice ?? '', l.currency ?? '', l.unitPrice != null ? l.unitPrice * l.qty : '', l.link]);
  }
  return rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
}
