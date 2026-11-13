import { useMemo, useState } from 'react';
import { useStore } from '../../core/store';
import { centroid, fmtSek } from '../../core/geometry';
import type { FurnitureItem, PriceStatus } from '../../core/types';
import { CATALOG, CATEGORIES, makeItem, makeOwnItem } from './catalog';
import './furniture.css';

const cm = (m: number) => Math.round(m * 100);
const dims = (x: { w: number; d: number; h: number }) => `${cm(x.w)}×${cm(x.d)}×${cm(x.h)} cm`;
const label = (c: string) => c.replace(/-/g, ' ');
const STATUS: Record<PriceStatus, { text: string; cls: string }> = {
  estimated: { text: 'estimated', cls: 'chip-warn' },
  catalog: { text: 'catalog', cls: 'chip-ok' },
  user: { text: 'your price', cls: 'chip-ok' },
  owned: { text: 'owned', cls: 'chip-ok' },
};

export function LibraryPanel() {
  const model = useStore((s) => s.model);
  const dispatch = useStore((s) => s.dispatch);
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const budget = useStore((s) => s.requirements?.budgetSek ?? null);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<string | null>(null);
  const [own, setOwn] = useState({ open: false, name: '', w: '', d: '', h: '', category: 'storage-cabinet' });

  const center = () => {
    const poly = model.spaces[0]?.polygon;
    return poly && poly.length >= 3 ? centroid(poly) : { x: 1, y: 1 };
  };
  const place = (item: FurnitureItem) => {
    dispatch({ type: 'PLACE_OBJECT', item });
    select({ kind: 'furniture', id: item.id });
  };

  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    return CATALOG.filter((e) => (!cat || e.category === cat)
      && (!t || e.name.toLowerCase().includes(t) || e.category.includes(t) || e.tags.some((g) => g.includes(t))));
  }, [q, cat]);

  const sel = selection?.kind === 'furniture' ? model.furniture.find((f) => f.id === selection.id) : undefined;
  const total = model.furniture.reduce((s, f) => s + (f.owned ? 0 : f.priceSek), 0);
  const ownValid = own.name.trim() && [own.w, own.d, own.h].every((v) => Number(v) > 0 && Number(v) < 1000);

  const addOwn = () => {
    if (!ownValid) return;
    place(makeOwnItem(own.name.trim(), own.category, Number(own.w) / 100, Number(own.d) / 100, Number(own.h) / 100, center()));
    setOwn({ ...own, open: false, name: '', w: '', d: '', h: '' });
  };
  const setPrice = (f: FurnitureItem) => {
    const v = window.prompt(`Your price for ${f.name} (kr)`, String(f.priceSek));
    if (v == null) return;
    const n = Number(v.replace(/\s/g, ''));
    if (Number.isFinite(n) && n >= 0) dispatch({ type: 'UPDATE_OBJECT', id: f.id, patch: { priceSek: n, priceStatus: 'user', owned: false } });
  };

  return (
    <div className="furniture-panel">
      {sel && (
        <section className="card furniture-sel">
          <div className="row furniture-head"><strong>{sel.name}</strong><span className="muted">{dims(sel)}</span></div>
          <div className="row furniture-actions">
            <button className="btn btn-sm" onClick={() => dispatch({ type: 'UPDATE_OBJECT', id: sel.id, patch: { locked: !sel.locked } })}>{sel.locked ? 'Unlock' : 'Lock'}</button>
            <button className="btn btn-sm" onClick={() => dispatch({ type: 'UPDATE_OBJECT', id: sel.id, patch: sel.owned ? { owned: false, priceStatus: 'estimated' } : { owned: true, priceStatus: 'owned' } })}>{sel.owned ? 'Not owned' : 'I own this'}</button>
            <button className="btn btn-sm" onClick={() => setPrice(sel)}>Set my price</button>
            <button className="btn btn-sm btn-ghost" onClick={() => { dispatch({ type: 'REMOVE_OBJECT', id: sel.id }); select(null); }}>Remove</button>
          </div>
        </section>
      )}

      <input className="field" placeholder="Search furniture" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search furniture" />
      <div className="furniture-chips">
        <button className={`chip${cat === null ? ' furniture-on' : ''}`} onClick={() => setCat(null)}>All</button>
        {CATEGORIES.map((c) => <button key={c} className={`chip${cat === c ? ' furniture-on' : ''}`} onClick={() => setCat(cat === c ? null : c)}>{label(c)}</button>)}
      </div>

      <div className="furniture-grid">
        {list.map((e) => (
          <div key={e.id} className="card furniture-card">
            <span className="furniture-swatch" style={{ background: e.color }} />
            <div className="furniture-info">
              <strong>{e.name}</strong>
              <span className="muted">{dims(e)}</span>
              <span className="muted">~{fmtSek(e.priceSek)}</span>
            </div>
            <button className="btn btn-sm btn-primary" onClick={() => place(makeItem(e.id, center()))}>Add</button>
          </div>
        ))}
        {list.length === 0 && <p className="muted">No matches.</p>}
      </div>
      <p className="muted furniture-note">Prices are estimates.</p>

      {own.open ? (
        <section className="card furniture-own">
          <input className="field" placeholder="Name" value={own.name} onChange={(e) => setOwn({ ...own, name: e.target.value })} />
          <div className="row">
            {(['w', 'd', 'h'] as const).map((k) => (
              <input key={k} className="field" inputMode="numeric" placeholder={{ w: 'Width cm', d: 'Depth cm', h: 'Height cm' }[k]} value={own[k]} onChange={(e) => setOwn({ ...own, [k]: e.target.value })} />
            ))}
          </div>
          <select className="field" value={own.category} onChange={(e) => setOwn({ ...own, category: e.target.value })}>
            {CATEGORIES.map((c) => <option key={c} value={c}>{label(c)}</option>)}
          </select>
          <div className="row">
            <button className="btn btn-sm btn-primary" disabled={!ownValid} onClick={addOwn}>Add</button>
            <button className="btn btn-sm btn-ghost" onClick={() => setOwn({ ...own, open: false })}>Cancel</button>
          </div>
        </section>
      ) : (
        <button className="btn" onClick={() => setOwn({ ...own, open: true })}>Add my own item</button>
      )}

      <section className="furniture-bill">
        <h3>Bill of furniture</h3>
        {model.furniture.length === 0 ? <p className="muted">Nothing placed yet.</p> : (
          <ul className="list">
            {model.furniture.map((f) => (
              <li key={f.id} className="furniture-line" onClick={() => select({ kind: 'furniture', id: f.id })}>
                <span>{f.name}{f.locked ? ' (locked)' : ''}<br /><span className="muted">{dims(f)}</span></span>
                <span className={`chip ${STATUS[f.priceStatus].cls}`}>{STATUS[f.priceStatus].text}</span>
                <span className="furniture-price">{f.owned ? '0 kr' : fmtSek(f.priceSek)}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="row furniture-total"><strong>Total</strong><strong>{fmtSek(total)}</strong></div>
        {budget != null && (
          <div className={`chip ${total <= budget ? 'chip-ok' : 'chip-bad'}`}>
            {total <= budget ? `${fmtSek(budget - total)} under budget` : `${fmtSek(total - budget)} over budget`} ({fmtSek(budget)})
          </div>
        )}
      </section>
    </div>
  );
}
