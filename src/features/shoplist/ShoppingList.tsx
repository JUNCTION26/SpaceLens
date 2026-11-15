import { useRef, useState } from 'react';
import type { FurnitureItem, SpaceModel } from '../../core/types';
import { useStore } from '../../core/store';
import { fitWindow } from '../stores/fit';
import { findProducts, type Match } from '../stores/findProducts';
import { buildShoppingList, toCsv, type BuyLine } from './buildShoppingList';
import './shoplist.css';

function download(csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = 'shopping-list.csv'; a.click();
  URL.revokeObjectURL(url);
}

type Find = 'busy' | 'ok' | 'none';
const lineKey = (l: BuyLine): string => l.ids[0];

export function ShoppingList({ model }: { model: Pick<SpaceModel, 'furniture'> & Partial<Pick<SpaceModel, 'spaces' | 'ceilingM'>> }) {
  const dispatch = useStore((s) => s.dispatch);
  const [state, setState] = useState<Record<string, Find>>({});
  const running = useRef(0);
  const list = buildShoppingList(model);

  const apply = (l: BuyLine, ms: Match[]): boolean => {
    const best = [...ms].sort((a, b) => (a.listing.price ?? 0) - (b.listing.price ?? 0))[0];
    if (!best) return false;
    const patch: Partial<FurnitureItem> = { listing: best.listing, priceStatus: 'catalog', ...(best.listing.currency === 'SEK' && best.listing.price ? { priceSek: best.listing.price } : {}) };
    for (const id of l.ids) dispatch({ type: 'UPDATE_OBJECT', id, patch });
    return true;
  };
  const find = async (l: BuyLine): Promise<void> => {
    const it = model.furniture.find((f) => f.id === l.ids[0]);
    if (!it || !model.spaces || model.ceilingM === undefined) return;
    setState((s) => ({ ...s, [lineKey(l)]: 'busy' }));
    let ms: Match[] = [];
    try { ms = await findProducts(it, fitWindow(it, { spaces: model.spaces, furniture: model.furniture, ceilingM: model.ceilingM })); } catch { /* shown as no match */ }
    setState((s) => ({ ...s, [lineKey(l)]: apply(l, ms) ? 'ok' : 'none' }));
  };
  const findAll = async (): Promise<void> => {
    const todo = list.lines.filter((l) => l.unitPrice == null && state[lineKey(l)] !== 'busy');
    let next = 0;
    running.current += 1;
    await Promise.all(Array.from({ length: Math.min(3, todo.length) }, async () => { while (next < todo.length) await find(todo[next++]); }));
    running.current -= 1;
  };
  const anyBusy = Object.values(state).includes('busy');
  const canFind = !!model.spaces && model.ceilingM !== undefined;
  if (!list.lines.length) return <div className="shoplist muted">Nothing to buy</div>;
  const money = (n: number, c: string): string => `${Math.round(n).toLocaleString('en')} ${c}`;
  return (
    <div className="shoplist">
      <table>
        <thead><tr><th>Item</th><th>Size cm</th><th>Qty</th><th>Price</th><th><span className="sr-only">Link</span></th><th><span className="sr-only">Find</span></th></tr></thead>
        <tbody>
          {list.lines.map((l, i) => (
            <tr key={i}>
              <td>{l.name}</td>
              <td>{l.wCm} x {l.dCm} x {l.hCm}</td>
              <td>{l.qty}</td>
              <td>{l.unitPrice != null && l.currency ? money(l.unitPrice * l.qty, l.currency) : '-'}</td>
              <td><a href={l.link} target="_blank" rel="noreferrer noopener" aria-label={l.listed ? `Open ${l.name}` : `Search ${l.name}`} title={l.listed ? 'Open' : 'Search'}>{l.listed ? '↗' : '⌕'}</a></td>
              <td>{l.unitPrice == null && canFind && <FindCell s={state[lineKey(l)]} name={l.name} onFind={() => void find(l)} />}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="shoplist-foot">
        <strong>Total {Object.entries(list.totals).map(([c, n]) => money(n, c)).join(' + ') || '-'}</strong>
        {list.unpriced > 0 && <span className="muted">No price {list.unpriced}</span>}
        {canFind && list.unpriced > 0 && <button type="button" disabled={anyBusy} onClick={() => void findAll()}>Find all</button>}
        <button type="button" onClick={() => download(toCsv(list))}>CSV</button>
      </div>
    </div>
  );
}

function FindCell({ s, name, onFind }: { s: Find | undefined; name: string; onFind: () => void }) {
  if (s === 'busy') return <span className="find-spin" role="status" aria-label={`Finding ${name}`} />;
  return (
    <>
      <button type="button" onClick={onFind} aria-label={`Find ${name}`}>Find</button>
      {s === 'ok' && <span className="find-ok" aria-label="Found">✓</span>}
      {s === 'none' && <span className="find-no" aria-label="No match">–</span>}
    </>
  );
}
