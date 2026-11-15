import { useRef, useState } from 'react';
import type { FurnitureItem, SpaceModel } from '../../core/types';
import { useStore } from '../../core/store';
import { fitWindow } from '../stores/fit';
import { findProductsReport, rankMatches, type Match } from '../stores/findProducts';
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
  const [cands, setCands] = useState<Record<string, { ms: Match[]; i: number }>>({});
  const running = useRef(0);
  const list = buildShoppingList(model);

  const put = (l: BuyLine, m: Match): void => {
    const patch: Partial<FurnitureItem> = { listing: m.listing, priceStatus: 'catalog', ...(m.listing.currency === 'SEK' && m.listing.price ? { priceSek: m.listing.price } : {}) };
    for (const id of l.ids) dispatch({ type: 'UPDATE_OBJECT', id, patch });
  };
  const apply = (l: BuyLine, ms: Match[]): boolean => {
    const ranked = rankMatches(ms);
    if (!ranked[0]) return false;
    setCands((c) => ({ ...c, [lineKey(l)]: { ms: ranked, i: 0 } }));
    put(l, ranked[0]);
    return true;
  };
  const swap = (l: BuyLine): void => {
    const c = cands[lineKey(l)];
    if (!c || c.ms.length < 2) return;
    const i = (c.i + 1) % c.ms.length;
    setCands((all) => ({ ...all, [lineKey(l)]: { ms: c.ms, i } }));
    put(l, c.ms[i]);
  };
  const find = async (l: BuyLine): Promise<void> => {
    const it = model.furniture.find((f) => f.id === l.ids[0]);
    if (!it || !model.spaces || model.ceilingM === undefined) return;
    setState((s) => ({ ...s, [lineKey(l)]: 'busy' }));
    let ms: Match[] = [];
    try { ms = (await findProductsReport(it, fitWindow(it, { spaces: model.spaces, furniture: model.furniture, ceilingM: model.ceilingM }))).matches; } catch { /* shown as no match */ }
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
              <td className="shop-name">{cands[lineKey(l)] && l.listed && cands[lineKey(l)].ms[cands[lineKey(l)].i].listing.imageUrl && <img className="shop-thumb" src={cands[lineKey(l)].ms[cands[lineKey(l)].i].listing.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />}{l.name}</td>
              <td>{l.wCm} x {l.dCm} x {l.hCm}</td>
              <td>{l.qty}</td>
              <td>{l.unitPrice != null && l.currency ? money(l.unitPrice * l.qty, l.currency) : '-'}</td>
              <td><a href={l.link} target="_blank" rel="noreferrer noopener" aria-label={l.listed ? `Open ${l.name}` : `Search ${l.name}`} title={l.listed ? 'Open' : 'Search'}>{l.listed ? '↗' : '⌕'}</a></td>
              <td>{(l.unitPrice == null || cands[lineKey(l)]) && canFind && <FindCell s={state[lineKey(l)]} name={l.name} onFind={() => void find(l)} cand={cands[lineKey(l)]} onSwap={() => swap(l)} />}</td>
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

function FindCell({ s, name, onFind, cand, onSwap }: { s: Find | undefined; name: string; onFind: () => void; cand?: { ms: Match[]; i: number }; onSwap: () => void }) {
  if (s === 'busy') return <span className="find-spin" role="status" aria-label={`Finding ${name}`} />;
  const cur = cand?.ms[cand.i];
  return (
    <>
      {!cand && <button type="button" onClick={onFind} aria-label={`Find ${name}`}>Find</button>}
      {cur && <span className={cur.heightUnconfirmed ? 'find-ok unsure' : 'find-ok'} role="img" aria-label={cur.heightUnconfirmed ? 'Fits, height unconfirmed' : 'Fits'} title={cur.heightUnconfirmed ? 'Height unconfirmed' : 'Fits'}>✓</span>}
      {cand && cand.ms.length > 1 && <button type="button" className="swap" onClick={onSwap} aria-label={`Next option for ${name}, ${cand.i + 1} of ${cand.ms.length}`} title={`${cand.i + 1}/${cand.ms.length}`}>⇄</button>}
      {s === 'none' && <span className="find-no" aria-label="No match">–</span>}
    </>
  );
}
