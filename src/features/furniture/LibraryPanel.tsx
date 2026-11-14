import { useMemo, useState } from 'react';
import { useStore } from '../../core/store';
import { centroid, fmtSek } from '../../core/geometry';
import type { FurnitureItem, PriceStatus } from '../../core/types';
import { CATALOG, CATEGORIES, makeItem, makeOwnItem, variantsFor } from './catalog';
import type { CatalogEntry } from './catalog';
import { CATALOG_DND, findFreeSpot } from '../objects/placement';
import './furniture.css';

const cm = (m: number) => Math.round(m * 100);
const dims = (x: { w: number; d: number; h: number }) => `${cm(x.w)}×${cm(x.d)}×${cm(x.h)} cm`;
const label = (c: string) => c.replace(/-/g, ' ');
const ROUND = new Set(['cafe-table', 'stool', 'plant', 'lamp']);

/** Tiny top-down footprint drawn to scale from the item's dims. */
function Footprint({ e }: { e: Pick<CatalogEntry, 'w' | 'd' | 'category' | 'color'> }) {
  const k = 30 / Math.max(e.w, e.d, 0.4), w = Math.max(3, e.w * k), d = Math.max(3, e.d * k), x = 18 - w / 2, y = 18 - d / 2;
  const c = e.category;
  return (
    <svg className="furniture-fp" viewBox="0 0 36 36" aria-hidden="true">
      {ROUND.has(c) ? <circle cx="18" cy="18" r={Math.min(w, d) / 2} fill={e.color} stroke="currentColor" strokeOpacity=".5" />
        : <rect x={x} y={y} width={w} height={d} rx={c === 'rug' ? 0 : 1.5} fill={e.color} stroke="currentColor" strokeOpacity=".5" />}
      {(c === 'bed' || c === 'bunk-bed' || c === 'crib') && <rect x={x + 1.5} y={y + 1.5} width={w - 3} height={Math.min(6, d / 4)} rx="1.5" fill="#fff" opacity=".8" />}
      {(c === 'sofa' || c === 'sofa-bed' || c === 'armchair') && <path d={`M${x} ${y + d} V${y} H${x + w} V${y + d} M${x} ${y + d * 0.35} H${x + w}`} fill="none" stroke="currentColor" strokeOpacity=".5" />}
      {(c === 'desk' || c === 'table' || c === 'reception-desk') && <rect x={15} y={Math.min(32, y + d + 0.5)} width="6" height="3" rx="1" fill="currentColor" opacity=".35" />}
    </svg>
  );
}

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
  const toast = useStore((s) => s.toast);
  const budget = useStore((s) => s.requirements?.budgetSek ?? null);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<string | null>(null);
  const [fits, setFits] = useState(false);
  const [own, setOwn] = useState({ open: false, name: '', w: '', d: '', h: '', category: 'storage-cabinet' });

  const center = () => {
    const poly = model.spaces[0]?.polygon;
    return poly && poly.length >= 3 ? centroid(poly) : { x: 1, y: 1 };
  };
  const room = useMemo(() => {
    const poly = model.spaces[0]?.polygon ?? [];
    if (poly.length < 3) return null;
    const xs = poly.map((p) => p.x), ys = poly.map((p) => p.y);
    const a = Math.max(...xs) - Math.min(...xs), b = Math.max(...ys) - Math.min(...ys);
    return { lo: Math.min(a, b), hi: Math.max(a, b) };
  }, [model.spaces]);
  const addFromCatalog = (id: string) => {
    const item = makeItem(id, center());
    place({ ...item, ...findFreeSpot(model, item) });
  };
  const place = (item: FurnitureItem) => {
    dispatch({ type: 'PLACE_OBJECT', item });
    select({ kind: 'furniture', id: item.id });
  };

  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    return CATALOG.filter((e) => (!cat || e.category === cat)
      && (!fits || !room || (Math.min(e.w, e.d) <= room.lo && Math.max(e.w, e.d) <= room.hi)) && (!t || e.name.toLowerCase().includes(t) || e.category.includes(t) || e.tags.some((g) => g.includes(t))));
  }, [q, cat, fits, room]);

  const sel = selection?.kind === 'furniture' ? model.furniture.find((f) => f.id === selection.id) : undefined;
  const total = model.furniture.reduce((s, f) => s + (f.owned ? 0 : f.priceSek), 0);
  const ownedN = model.furniture.filter((f) => f.owned).length;
  const groups = useMemo(() => {
    const m = new Map<string, FurnitureItem[]>();
    for (const f of model.furniture) m.set(f.category, [...(m.get(f.category) ?? []), f]);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [model.furniture]);
  const tone = budget == null ? '' : total > budget ? 'bad' : total > budget * 0.85 ? 'warn' : 'ok';
  const copyCsv = () => {
    const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
    const rows: Array<Array<string | number>> = [['Category', 'Item', 'Width cm', 'Depth cm', 'Height cm', 'Material', 'Status', 'Price SEK'],
      ...groups.flatMap(([, items]) => items.map((f) => [label(f.category), f.name, cm(f.w), cm(f.d), cm(f.h), f.material ?? '', f.owned ? 'owned' : 'to buy', f.owned ? 0 : f.priceSek])),
      ['', 'Total', '', '', '', '', '', total]];
    const csv = rows.map((r) => r.map(esc).join(',')).join('\n');
    navigator.clipboard?.writeText(csv).then(() => toast('CSV copied'), () => toast('Could not copy'));
  };
  const ownValid = own.name.trim() && [own.w, own.d, own.h].every((v) => Number(v) > 0 && Number(v) < 1000);

  const addOwn = () => {
    if (!ownValid) return;
    const it = makeOwnItem(own.name.trim(), own.category, Number(own.w) / 100, Number(own.d) / 100, Number(own.h) / 100, center());
    place({ ...it, ...findFreeSpot(model, it) });
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
          <div className="furniture-swatches" role="group" aria-label="Finish">
            {variantsFor(sel).map((v) => (
              <button key={v.color + v.material} title={v.material || v.color} aria-label={v.material || v.color} aria-pressed={sel.color === v.color}
                className={`furniture-dot${sel.color === v.color ? ' furniture-on' : ''}`} style={{ background: v.color }}
                onClick={() => dispatch({ type: 'UPDATE_OBJECT', id: sel.id, patch: { color: v.color, material: v.material || sel.material } })} />
            ))}
            {sel.material && <span className="muted">{sel.material}</span>}
          </div>
          <div className="row furniture-actions">
            <button className="btn btn-sm" onClick={() => dispatch({ type: 'UPDATE_OBJECT', id: sel.id, patch: { locked: !sel.locked } })}>{sel.locked ? 'Unlock' : 'Lock'}</button>
            <button className="btn btn-sm" onClick={() => dispatch({ type: 'UPDATE_OBJECT', id: sel.id, patch: sel.owned ? { owned: false, priceStatus: 'estimated' } : { owned: true, priceStatus: 'owned' } })}>{sel.owned ? 'Not owned' : 'I own this'}</button>
            <button className="btn btn-sm" onClick={() => setPrice(sel)}>Set my price</button>
            <button className="btn btn-sm btn-ghost" onClick={() => { dispatch({ type: 'REMOVE_OBJECT', id: sel.id }); select(null); }}>Remove</button>
          </div>
        </section>
      )}

      <input className="field" type="search" placeholder="Search furniture" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search furniture" />
      <div className="furniture-chips">
        <button className={`chip${fits ? ' furniture-on' : ''}`} aria-pressed={fits} onClick={() => setFits(!fits)} title="Only items that fit this room">Fits room</button>
        <button className={`chip${cat === null ? ' furniture-on' : ''}`} onClick={() => setCat(null)}>All</button>
        {CATEGORIES.map((c) => <button key={c} className={`chip${cat === c ? ' furniture-on' : ''}`} onClick={() => setCat(cat === c ? null : c)}>{label(c)}</button>)}
      </div>

      <div className="furniture-grid">
        {list.map((e) => (
          <div key={e.id} className="card furniture-card" draggable title="Drag onto the plan"
            onDragStart={(ev) => { ev.dataTransfer.setData(CATALOG_DND, e.id); ev.dataTransfer.setData('text/plain', e.name); ev.dataTransfer.effectAllowed = 'copy'; }}>
            <Footprint e={e} />
            <div className="furniture-info">
              <strong>{e.name}</strong>
              <span className="muted">{dims(e)}</span>
              <span className="muted">~{fmtSek(e.priceSek)}</span>
            </div>
            <button className="btn btn-sm btn-primary" onClick={() => addFromCatalog(e.id)} aria-label={`Add ${e.name}`}>Add</button>
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
        {model.furniture.length === 0 ? <p className="muted">Nothing placed yet.</p> : groups.map(([g, items]) => (
          <div key={g} className="furniture-group">
            <div className="row furniture-ghead"><span>{label(g)}</span><span className="muted">{fmtSek(items.reduce((n, f) => n + (f.owned ? 0 : f.priceSek), 0))}</span></div>
            <ul className="list">
              {items.map((f) => (
                <li key={f.id} className="furniture-line" onClick={() => select({ kind: 'furniture', id: f.id })}>
                  <span>{f.name}{f.locked ? ' (locked)' : ''}<br /><span className="muted">{dims(f)}</span></span>
                  <span className={`chip ${STATUS[f.priceStatus].cls}`}>{STATUS[f.priceStatus].text}</span>
                  <span className="furniture-price">{f.owned ? '0 kr' : fmtSek(f.priceSek)}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {model.furniture.length > 0 && <div className="row furniture-split muted"><span>Owned {ownedN}</span><span>To buy {model.furniture.length - ownedN}</span></div>}
        <div className="row furniture-total"><strong>Total</strong><strong>{fmtSek(total)}</strong></div>
        {budget != null && budget > 0 && (<>
          <div className="furniture-bar" role="meter" aria-valuemin={0} aria-valuemax={budget} aria-valuenow={total} aria-label="Budget used">
            <span className={`furniture-bar-fill ${tone}`} style={{ width: `${Math.min(100, (total / budget) * 100)}%` }} />
          </div>
          <div className={`chip ${total <= budget ? 'chip-ok' : 'chip-bad'}`}>
            {total <= budget ? `${fmtSek(budget - total)} under budget` : `${fmtSek(total - budget)} over budget`} ({fmtSek(budget)})
          </div>
        </>)}
        {model.furniture.length > 0 && <button className="btn btn-sm" onClick={copyCsv}>Copy CSV</button>}
      </section>
    </div>
  );
}
