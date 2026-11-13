import type { FurnitureItem } from '../../core/types';

const q = (v: string | number) => { const s = String(v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export const itemPrice = (f: FurnitureItem) => (f.owned ? 0 : f.priceSek);
export const rotDeg = (r: number) => ((Math.round((r * 180) / Math.PI) % 360) + 360) % 360;

export function scheduleCsv(items: FurnitureItem[]): string {
  const head = ['Name', 'Category', 'W cm', 'D cm', 'H cm', 'x m', 'y m', 'Rotation deg', 'Owned', 'Price kr', 'Price status'];
  const rows = items.map((f) => [f.name, f.category, Math.round(f.w * 100), Math.round(f.d * 100), Math.round(f.h * 100), f.x.toFixed(2), f.y.toFixed(2),
    rotDeg(f.rotation), f.owned ? 'yes' : 'no', Math.round(itemPrice(f)), f.priceStatus]);
  const total = items.reduce((t, f) => t + itemPrice(f), 0);
  return [head, ...rows, ['Total', '', '', '', '', '', '', '', '', Math.round(total), ''], ['Prices are estimates unless marked']]
    .map((r) => r.map(q).join(',')).join('\n');
}
