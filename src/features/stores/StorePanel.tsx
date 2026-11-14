import { lazy, Suspense, useEffect, useRef, useState, type ComponentType, type DragEvent } from 'react';
import { useStore } from '../../core/store';
import type { ObjectSpec } from '../../core/types';
import { Icon } from '../../ui/icons';
import { compareListings, negotiationNotes, type Comparison } from './advise';
import { addToRoom, listingToItem, missingDims, MissingDimensionsError } from './convert';
import { rateToSek, toSek, type Rate } from './fx';
import { fmtDims, fmtMoney, timeAgo } from './parse';
import { blobToDataUrl, loadImageBlob, READER_NOTE, readListing, readListingImage } from './read';
import { searchProducts, type ShopListing } from './search';
import './stores.css';

// The forge's assembling preview, when that feature is in the build.
type PreviewProps = { spec: ObjectSpec | null; assembling: boolean };
const PREVIEW = import.meta.glob('../forge/ForgePreview.tsx');
const ForgePreview: ComponentType<PreviewProps> | null = PREVIEW['../forge/ForgePreview.tsx']
  ? lazy(() => PREVIEW['../forge/ForgePreview.tsx']().then((m) => ({ default: (m as { ForgePreview: ComponentType<PreviewProps> }).ForgePreview })))
  : null;

type Card = ShopListing & { key: string };
type Dims = { w: string; d: string; h: string };
interface AddState {
  stage: 'size' | 'image' | 'building' | 'done' | 'error';
  dims: Dims;
  spec: ObjectSpec | null;
  image?: string;
  message?: string;
}

const cmStr = (m?: number) => (m ? String(Math.round(m * 100)) : '');
const cmNum = (s: string) => { const n = parseFloat(s.replace(',', '.')); return Number.isFinite(n) && n > 0 ? n / 100 : undefined; };
let seq = 0;
const keyed = (l: ShopListing): Card => ({ ...l, key: `c${++seq}` });

export function StorePanel() {
  const toast = useStore((s) => s.toast);
  const budget = useStore((s) => s.requirements?.budgetSek ?? null);
  const [query, setQuery] = useState('');
  const [link, setLink] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState<'search' | 'link' | 'photo' | null>(null);
  const [cards, setCards] = useState<Card[]>([]);
  const [rates, setRates] = useState<Record<string, Rate>>({});
  const [adds, setAdds] = useState<Record<string, AddState>>({});
  const [picked, setPicked] = useState<string[]>([]);
  const [comparison, setComparison] = useState<{ result: Comparison; keys: string[] } | null>(null);
  const [comparing, setComparing] = useState(false);
  const [tips, setTips] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [, tick] = useState(0);
  const abort = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Keep "read 2 min ago" fresh.
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 30_000); return () => clearInterval(t); }, []);

  // Look up a rate for every foreign currency shown.
  useEffect(() => {
    const need = [...new Set(cards.map((c) => c.currency))].filter((c) => c !== 'SEK' && !rates[c]);
    need.forEach((c) => void rateToSek(c).then((r) => setRates((m) => ({ ...m, [c]: m[c] ?? r }))));
  }, [cards, rates]);

  const patchAdd = (key: string, patch: Partial<AddState>) => setAdds((m) => ({ ...m, [key]: { ...m[key], ...patch } }));
  const rateMap = () => Object.fromEntries(Object.entries(rates).map(([k, v]) => [k, v.rate]));

  async function runSearch() {
    const q = query.trim();
    if (!q || busy) return;
    abort.current?.abort();
    const ctrl = new AbortController(); abort.current = ctrl;
    setBusy('search'); setComparison(null); setPicked([]); setStatus('');
    const keys: string[] = [];
    try {
      const done = await searchProducts(q, {
        signal: ctrl.signal, onStatus: setStatus,
        onUpdate: (list) => setCards((prev) => {
          const others = prev.filter((c) => !keys.includes(c.key));
          const next = list.map((l, i) => ({ ...l, key: keys[i] ?? (keys[i] = `c${++seq}`) }));
          return [...next, ...others];
        }),
      });
      if (!done.length) setStatus('No product pages found. Try other words, or paste a link.');
    } catch (e) {
      if (!ctrl.signal.aborted) setStatus(e instanceof Error ? e.message : 'Search failed.');
    } finally { setBusy(null); }
  }

  async function runLink() {
    const url = link.trim();
    if (!url || busy) return;
    setBusy('link'); setStatus('Reading the page…');
    try {
      const l = await readListing(url);
      setCards((prev) => [keyed({ ...l, issues: [] }), ...prev]);
      setLink(''); setStatus('');
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Could not read that page.');
    } finally { setBusy(null); }
  }

  async function runPhoto(file: File) {
    if (!file.type.startsWith('image/')) { setStatus('Drop an image file (a screenshot or photo of the listing).'); return; }
    setBusy('photo'); setStatus('Reading your picture…');
    try {
      const dataUrl = await blobToDataUrl(file);
      const l = await readListingImage(dataUrl);
      const card = keyed({ ...l, issues: [] });
      setCards((prev) => [card, ...prev]);
      setAdds((m) => ({ ...m, [card.key]: { stage: 'size', dims: { w: cmStr(l.stated?.w), d: cmStr(l.stated?.d), h: cmStr(l.stated?.h) }, spec: null, image: dataUrl } }));
      setStatus('');
    } catch {
      setStatus('Could not read that picture.');
    } finally { setBusy(null); }
  }

  function onDrop(e: DragEvent, key?: string) {
    e.preventDefault(); e.stopPropagation(); setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    if (key) { void blobToDataUrl(file).then((image) => { patchAdd(key, { image }); void build(key, image); }); return; }
    void runPhoto(file);
  }

  function updateCard(key: string, patch: Partial<Card>) { setCards((prev) => prev.map((c) => (c.key === key ? { ...c, ...patch } : c))); }

  /** Step 1: make sure the size is known, then check the photo can be used. */
  async function startAdd(c: Card) {
    const st = adds[c.key];
    const typed = st ? { w: cmNum(st.dims.w), d: cmNum(st.dims.d), h: cmNum(st.dims.h) } : undefined;
    const dims = { w: cmStr(typed?.w ?? c.stated?.w), d: cmStr(typed?.d ?? c.stated?.d), h: cmStr(typed?.h ?? c.stated?.h) };
    if (missingDims(c, typed).length) { patchAdd(c.key, { stage: 'size', dims, spec: null }); return; }
    if (st?.image) return build(c.key, st.image);
    const url = c.imageUrl;
    if (url && !url.startsWith('data:')) {
      setAdds((m) => ({ ...m, [c.key]: { stage: 'building', dims, spec: null, message: 'Fetching the photo…' } }));
      const blob = await loadImageBlob(url);
      if (!blob) { patchAdd(c.key, { stage: 'image', message: undefined }); return; }
      const image = await blobToDataUrl(blob);
      patchAdd(c.key, { image });
      return build(c.key, image, dims);
    }
    setAdds((m) => ({ ...m, [c.key]: { stage: 'building', dims, spec: null } }));
    return build(c.key, url, dims);
  }

  /** Step 2: build the true-size object and put it in the room. */
  async function build(key: string, image?: string, dimsIn?: Dims) {
    const c = cards.find((x) => x.key === key);
    if (!c) return;
    const dims = dimsIn ?? adds[key]?.dims ?? { w: '', d: '', h: '' };
    patchAdd(key, { stage: 'building', dims, spec: null, message: undefined });
    try {
      const item = await listingToItem(c, image, {
        dims: { w: cmNum(dims.w), d: cmNum(dims.d), h: cmNum(dims.h) },
        rate: c.currency !== 'SEK' ? rates[c.currency]?.rate : undefined,
        onPartial: (spec) => patchAdd(key, { spec }),
      });
      if (item.custom) patchAdd(key, { spec: item.custom });
      addToRoom(item);
      patchAdd(key, { stage: 'done' });
      toast(`${item.name} added at ${fmtDims(item)}. Price and link are in the bill.`, 'ok');
    } catch (e) {
      if (e instanceof MissingDimensionsError) patchAdd(key, { stage: 'size', message: e.message });
      else patchAdd(key, { stage: 'error', message: e instanceof Error ? e.message : 'Could not build it.' });
    }
  }

  async function runCompare() {
    const chosen = cards.filter((c) => picked.includes(c.key));
    if (chosen.length < 2) return;
    setComparing(true);
    try {
      const model = useStore.getState().model;
      const result = await compareListings(chosen, { model, budgetSek: budget, rates: rateMap() });
      setComparison({ result, keys: chosen.map((c) => c.key) });
    } finally { setComparing(false); }
  }

  const togglePick = (key: string) => setPicked((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]));

  return (
    <div className="shop">
      <form className="shop-row" onSubmit={(e) => { e.preventDefault(); void runSearch(); }}>
        <label className="shop-input">
          <Icon name="search" size={14} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="grey 3-seat sofa under 6 000 kr" aria-label="Search products" />
        </label>
        <button className="btn btn-primary btn-sm" disabled={!query.trim() || !!busy}>{busy === 'search' ? 'Searching…' : 'Search'}</button>
      </form>

      <form className="shop-row" onSubmit={(e) => { e.preventDefault(); void runLink(); }}>
        <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="Paste a product link" aria-label="Product link" inputMode="url" />
        <button className="btn btn-sm" disabled={!link.trim() || !!busy}>{busy === 'link' ? 'Reading…' : 'Read'}</button>
      </form>

      <div
        className={`shop-drop${dragOver ? ' over' : ''}`} role="button" tabIndex={0}
        onClick={() => fileRef.current?.click()} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileRef.current?.click(); }}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={(e) => onDrop(e)}
        onPaste={(e) => { const f = e.clipboardData.files?.[0]; if (f) void runPhoto(f); }}
      >
        <Icon name="image" size={16} />
        <span>{busy === 'photo' ? 'Reading picture…' : 'Drop a listing screenshot or photo'}</span>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void runPhoto(f); e.target.value = ''; }} />
      </div>

      <p className="shop-fine">{READER_NOTE} Prices and stock come from each listing at the time it was read.</p>
      {status && <p className="shop-status" role="status">{(busy === 'search' || busy === 'link') && <span className="shop-spin" aria-hidden="true" />}{status}</p>}

      {picked.length >= 2 && (
        <button className="btn btn-sm shop-compare" onClick={() => void runCompare()} disabled={comparing}>
          {comparing ? 'Comparing…' : `Compare ${picked.length}`}
        </button>
      )}

      {comparison && (() => {
        const pickCard = cards.find((c) => c.key === comparison.keys[comparison.result.pickIndex]);
        const deal = pickCard ? negotiationNotes(pickCard, cards.filter((c) => comparison.keys.includes(c.key)), rateMap()) : null;
        return (
          <section className="shop-verdict" aria-label="Comparison">
            <div className="shop-verdict-head">
              <span className="chip chip-ok">Pick</span>
              <strong>{pickCard?.title ?? comparison.result.pick?.title}</strong>
              <button className="btn btn-ghost btn-sm" onClick={() => setComparison(null)} aria-label="Close comparison"><Icon name="x" size={14} /></button>
            </div>
            <ul>{comparison.result.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
            {comparison.result.tradeoffs.length > 0 && <>
              <h4>Tradeoffs</h4>
              <ul>{comparison.result.tradeoffs.map((r, i) => <li key={i}>{r}</li>)}</ul>
            </>}
            {deal && <details>
              <summary>Ask for a better price</summary>
              <p className="shop-fine">{deal.label}</p>
              <ul>{deal.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
            </details>}
          </section>
        );
      })()}

      <ul className="shop-list">
        {cards.map((c) => {
          const st = adds[c.key];
          const rate = c.currency !== 'SEK' ? rates[c.currency] : undefined;
          const editable = c.via === 'photo' || c.via === 'manual';
          return (
            <li key={c.key} className={`shop-card${comparison?.result && comparison.keys[comparison.result.pickIndex] === c.key ? ' on' : ''}`}
              onDragOver={st?.stage === 'image' ? (e) => e.preventDefault() : undefined} onDrop={st?.stage === 'image' ? (e) => onDrop(e, c.key) : undefined}>
              <div className="shop-thumb">
                {c.imageUrl ? <img src={c.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }} /> : <Icon name="sofa" size={22} />}
              </div>
              <div className="shop-body">
                {editable
                  ? <input className="shop-edit" value={c.title} placeholder="Product title" aria-label="Title" onChange={(e) => updateCard(c.key, { title: e.target.value })} />
                  : <span className="shop-title" title={c.title}>{c.title}</span>}
                <span className="shop-meta">
                  {editable ? <input className="shop-edit shop-edit-sm" value={c.store} placeholder="Store" aria-label="Store" onChange={(e) => updateCard(c.key, { store: e.target.value })} /> : c.store}
                  {' · '}{c.pending ? 'reading…' : `read ${timeAgo(c.fetchedAt)}`}
                </span>
                <span className="shop-price">
                  {editable
                    ? <>
                        <input className="shop-edit shop-edit-sm" inputMode="decimal" value={c.price ?? ''} placeholder="Price" aria-label="Price"
                          onChange={(e) => { const n = parseFloat(e.target.value.replace(/\s/g, '').replace(',', '.')); updateCard(c.key, { price: Number.isFinite(n) ? n : null }); }} />
                        <select className="shop-edit shop-edit-sm" value={c.currency} aria-label="Currency" onChange={(e) => updateCard(c.key, { currency: e.target.value })}>
                          {['SEK', 'EUR', 'USD', 'GBP', 'NOK', 'DKK'].map((x) => <option key={x}>{x}</option>)}
                        </select>
                      </>
                    : c.price !== null ? fmtMoney(c.price, c.currency) : <span className="muted">{c.pending ? '…' : 'No price listed'}</span>}
                  <span className="shop-size">{fmtDims(c.stated)}</span>
                </span>
                {rate && c.price !== null && (
                  <label className="shop-rate">
                    ≈ {fmtMoney(toSek(c.price, rate.rate), 'SEK')} <span className="chip chip-warn">converted, check</span>
                    <span className="muted">1 {c.currency} =</span>
                    <input inputMode="decimal" value={rate.rate} aria-label={`SEK per ${c.currency}`}
                      onChange={(e) => { const n = parseFloat(e.target.value.replace(',', '.')); if (Number.isFinite(n) && n > 0) setRates((m) => ({ ...m, [c.currency]: { rate: n, source: 'your rate' } })); }} />
                    <span className="muted">kr · {rate.source}</span>
                  </label>
                )}
                {(c.issues.length > 0 || c.note) && (
                  <span className="shop-notes">
                    {c.issues.map((i) => <span key={i} className="chip chip-warn">{i}</span>)}
                    {c.note && <small className="muted">{c.note}</small>}
                  </span>
                )}

                {st?.stage === 'size' && (
                  <div className="shop-size-form">
                    <small>{st.message ?? 'Confirm the size from the listing (cm).'}</small>
                    <div className="shop-dims">
                      {(['w', 'd', 'h'] as const).map((k) => (
                        <label key={k}><span>{k.toUpperCase()}</span>
                          <input inputMode="decimal" value={st.dims[k]} aria-label={{ w: 'Width', d: 'Depth', h: 'Height' }[k] + ' in cm'}
                            onChange={(e) => patchAdd(c.key, { dims: { ...st.dims, [k]: e.target.value } })} />
                        </label>
                      ))}
                    </div>
                  </div>
                )}
                {st?.stage === 'image' && (
                  <div className="shop-size-form" role="note">
                    <small>This store does not let other sites reuse its photo. Drop the picture here to shape the 3D model from it, or build it from the title.</small>
                    <button className="btn btn-sm" onClick={() => void build(c.key)}>Build from title</button>
                  </div>
                )}
                {st?.stage === 'building' && (
                  <div className="shop-build">
                    {ForgePreview
                      ? <Suspense fallback={<span className="shop-spin" />}><div className="shop-preview"><ForgePreview spec={st.spec} assembling /></div></Suspense>
                      : <span className="shop-status"><span className="shop-spin" aria-hidden="true" />Building at true size…</span>}
                    {st.message && <small className="muted">{st.message}</small>}
                  </div>
                )}
                {st?.stage === 'error' && <small className="shop-err">{st.message}</small>}

                <div className="shop-actions">
                  {st?.stage === 'done'
                    ? <span className="chip chip-ok"><Icon name="check" size={12} /> In the room</span>
                    : <button className="btn btn-primary btn-sm" disabled={c.pending || st?.stage === 'building'} onClick={() => void (st?.stage === 'size' ? (missingDims(c, { w: cmNum(st.dims.w), d: cmNum(st.dims.d), h: cmNum(st.dims.h) }).length ? patchAdd(c.key, { message: 'Fill in all three sides.' }) : startAdd(c)) : startAdd(c))}>
                        <Icon name="plus" size={14} /> {st?.stage === 'size' ? 'Add at this size' : 'Add to room'}
                      </button>}
                  {c.url && <a className="btn btn-ghost btn-sm" href={c.url} target="_blank" rel="noopener noreferrer">Open <Icon name="share" size={12} /></a>}
                  <label className="shop-pick"><input type="checkbox" checked={picked.includes(c.key)} onChange={() => togglePick(c.key)} /> Compare</label>
                  <button className="btn btn-ghost btn-sm" aria-expanded={tips === c.key} onClick={() => setTips(tips === c.key ? null : c.key)}>Deal tips</button>
                </div>
                {tips === c.key && (() => {
                  const n = negotiationNotes(c, cards, rateMap());
                  return <div className="shop-tips"><p className="shop-fine">{n.label}</p><ul>{n.notes.map((x, i) => <li key={i}>{x}</li>)}</ul></div>;
                })()}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default StorePanel;
