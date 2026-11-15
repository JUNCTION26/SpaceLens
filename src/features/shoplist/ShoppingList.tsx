import type { SpaceModel } from '../../core/types';
import { buildShoppingList, toCsv } from './buildShoppingList';

function download(csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = 'shopping-list.csv'; a.click();
  URL.revokeObjectURL(url);
}

export function ShoppingList({ model }: { model: Pick<SpaceModel, 'furniture'> }) {
  const list = buildShoppingList(model);
  if (!list.lines.length) return <div className="shoplist muted">Nothing to buy</div>;
  const money = (n: number, c: string): string => `${Math.round(n).toLocaleString('en')} ${c}`;
  return (
    <div className="shoplist">
      <table>
        <thead><tr><th>Item</th><th>Size cm</th><th>Qty</th><th>Price</th><th><span className="sr-only">Link</span></th></tr></thead>
        <tbody>
          {list.lines.map((l, i) => (
            <tr key={i}>
              <td>{l.name}</td>
              <td>{l.wCm} x {l.dCm} x {l.hCm}</td>
              <td>{l.qty}</td>
              <td>{l.unitPrice != null && l.currency ? money(l.unitPrice * l.qty, l.currency) : '-'}</td>
              <td><a href={l.link} target="_blank" rel="noreferrer noopener" aria-label={l.listed ? `Open ${l.name}` : `Search ${l.name}`} title={l.listed ? 'Open' : 'Search'}>{l.listed ? '↗' : '⌕'}</a></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="shoplist-foot">
        <strong>Total {Object.entries(list.totals).map(([c, n]) => money(n, c)).join(' + ') || '-'}</strong>
        {list.unpriced > 0 && <span className="muted">No price {list.unpriced}</span>}
        <button type="button" onClick={() => download(toCsv(list))}>CSV</button>
      </div>
    </div>
  );
}
