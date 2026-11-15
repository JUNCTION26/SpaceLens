import { ArButton } from '../ar/ArButton';
import { ShoppingList } from '../shoplist/ShoppingList';
import { IfcButton } from '../formats/IfcButton';
import { DxfButton } from '../formats/DxfButton';
import { useMemo, useRef, useState } from 'react';
import { useShownFurniture, useStore } from '../../core/store';
import { fmtSek } from '../../core/geometry';
import { planToSvg, uncertainWalls, type PlanOptions } from './svg';
import { itemPrice, scheduleCsv } from './csv';
import { quantities } from './quantities';
import { exportGlb } from './glb';
import { validateModel } from './validate';
import { shareLink } from './share';
import { QrShare } from './QrShare';
import { SharePoll } from '../vote/VoteUi';
import { Icon } from '../../ui/icons';
import { useUi } from '../../ui/uiStore';
import './export.css';

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'spacelens';

function download(name: string, data: Blob | string, type = 'text/plain') {
  const blob = typeof data === 'string' ? new Blob([data], { type }) : data;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export function ExportPanel() {
  const model = useStore((s) => s.model);
  const dispatch = useStore((s) => s.dispatch);
  const furniture = useShownFurniture();
  const candidates = useStore((s) => s.candidates);
  const activeId = useStore((s) => s.activeCandidateId);
  const routes = useStore((s) => s.analysis.routes);
  const [layers, setLayers] = useState<Required<PlanOptions>>({ furniture: true, dimensions: true, titleBlock: true });
  const svg = useMemo(() => planToSvg(model, furniture), [model, furniture]);
  const preview = useMemo(() => planToSvg(model, furniture, new Date(), layers), [model, furniture, layers]);
  const checks = candidates.find((c) => c.id === activeId)?.checks ?? [];
    const json = useMemo(() => JSON.stringify(model, null, 2), [model]);
  const q = useMemo(() => quantities(model), [model]);
  const [rates, setRates] = useState({ floor: '', paint: '', skirting: '' });
  const [shared, setShared] = useState(false);
  const [qr, setQr] = useState(false);
  const [err, setErr] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const base = `${slug(model.name)}-v${model.version}`;

  const openPrint = (title: string, body: string, css: string) => {
    const f = document.createElement('iframe');
    f.setAttribute('aria-hidden', 'true');
    f.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden';
    document.body.appendChild(f);
    const d = f.contentDocument;
    if (!d || !f.contentWindow) { f.remove(); setErr('Failed'); return; }
    d.open();
    d.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>body{font:12px Helvetica,Arial,sans-serif;color:#111}${css}
td,th{border:1px solid #bbb;padding:3px 6px;text-align:left}table{border-collapse:collapse;width:100%}h3{margin:6mm 0 2mm;font-size:13px}</style></head><body>${body}</body></html>`);
    d.close();
    const w = f.contentWindow;
    setTimeout(() => { w.focus(); w.print(); setTimeout(() => f.remove(), 60000); }, 150);
  };
  const total = furniture.reduce((t, f) => t + itemPrice(f), 0);
  const schedTable = () => `<table><tr><th>Name</th><th>Category</th><th>W × D × H cm</th><th>Price</th><th>Price status</th></tr>${furniture.map((f) => `<tr><td>${esc(f.name)}</td><td>${esc(f.category)}</td><td>${Math.round(f.w * 100)} × ${Math.round(f.d * 100)} × ${Math.round(f.h * 100)}</td><td>${f.owned ? 'Owned' : fmtSek(itemPrice(f))}</td><td>${f.priceStatus}</td></tr>`).join('')}<tr><th colspan="3">Total</th><th>${fmtSek(total)}</th><th></th></tr></table>`;

  const printPdf = () => openPrint(`${model.name} v${model.version}`,
    `${svg}<h3 style="page-break-before:always">Furniture schedule</h3>${schedTable()}`,
    '@page{size:A4 landscape;margin:12mm}svg{width:100%;height:auto;max-height:170mm}');

  const printSheet = () => {
    const pass = checks.filter((c) => c.result === 'pass').length, fail = checks.filter((c) => c.result === 'fail');
    const rOk = routes.filter((r) => r.ok).length;
    const uw = uncertainWalls(model);
    const qt = qRows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
    const checkLines = [
      checks.length ? `${pass} of ${checks.length} layout checks pass${fail.length ? `. Failing: ${esc(fail.map((c) => c.rule).join(', '))}` : ''}` : 'No layout checks run yet',
      routes.length ? `${rOk} of ${routes.length} routes clear` : 'No routes checked yet',
      uw.length ? `${uw.length} walls not verified` : 'All walls verified',
    ].map((t) => `<li>${t}</li>`).join('');
    openPrint(`${model.name} room sheet`,
      `<h2 style="margin:0 0 2mm">${esc(model.name)} <small style="font-weight:400;color:#666">Room sheet · v${model.version}</small></h2>${svg}
<div class="cols"><div><h3>Furniture schedule</h3>${schedTable()}</div><div><h3>Quantities</h3><table>${qt}</table><h3>Checks</h3><ul>${checkLines}</ul></div></div>`,
      '@page{size:A4 portrait;margin:10mm}svg{width:100%;height:auto;max-height:150mm}.cols{display:grid;grid-template-columns:3fr 2fr;gap:6mm;font-size:10px}ul{padding-left:4mm;margin:0}');
  };

  const glb = async () => {
    try { download(`${base}.glb`, await exportGlb(model, furniture)); } catch { setErr('Failed'); }
  };

  const importJson = async (file: File) => {
    try {
      const m = validateModel(JSON.parse(await file.text()));
      dispatch({ type: 'REPLACE_MODEL', model: m });
      setErr('');
    } catch { setErr('Failed'); }
  };

  const share = async () => {
    try {
      const url = await shareLink(model);
      history.replaceState(null, '', url);
      await navigator.clipboard.writeText(url).catch(() => undefined);
      setShared(true);
      setQr(true);
      setTimeout(() => setShared(false), 4000);
    } catch { setErr('Failed'); }
  };

  const num = (s: string) => (s.trim() === '' ? null : Number(s));
  const qRows: Array<[string, string, number | null]> = [
    ['Floor', `${q.floorM2.toFixed(1)} m²`, num(rates.floor) !== null ? q.floorM2 * num(rates.floor)! : null],
    ['Walls, net', `${q.wallNetM2.toFixed(1)} m²`, null],
    ['Paint, 2 coats', `${q.paintL.toFixed(1)} l`, num(rates.paint) !== null ? q.paintL * num(rates.paint)! : null],
    ['Skirting', `${q.skirtingM.toFixed(1)} m`, num(rates.skirting) !== null ? q.skirtingM * num(rates.skirting)! : null],
  ];
  const anyCost = qRows.some((r) => r[2] !== null);

  const files: Array<{ k: string; icon: string; name: string; run: () => void; primary?: boolean }> = [
    { k: 'svg', icon: 'image', name: 'Picture', run: () => download(`${base}.svg`, svg, 'image/svg+xml') },
  ];
  const moreFiles: Array<{ k: string; icon: string; name: string; run: () => void }> = [
    { k: 'pdf', icon: 'download', name: 'Plan PDF', run: printPdf },
    { k: 'glb', icon: 'cube', name: '3D', run: () => void glb() },
    { k: 'json', icon: 'file', name: 'Project', run: () => download(`${base}.json`, json, 'application/json') },
    { k: 'import', icon: 'plus', name: 'Import', run: () => fileRef.current?.click() },
  ];
  const [more, setMore] = useState(false);
  const toggle = (k: keyof PlanOptions, label: string) => (
    <label className="export-toggle"><input type="checkbox" checked={layers[k]} onChange={(e) => setLayers({ ...layers, [k]: e.target.checked })} />{label}</label>
  );

  return (
    <div className="export">
      <section className="export-block" aria-label="Send">
        <h3>Send</h3>
        <div className="export-grid">
          <button className="export-file" onClick={() => void share()} aria-label="Link" aria-pressed={qr} title="Link">
            <Icon name={shared ? 'check' : 'share'} size={16} /><span>Link</span>
          </button>
          <SharePoll />
          {qr && <QrShare getLink={() => shareLink(model)} hideButton />}
        </div>
      </section>

      <section className="export-block" aria-label="Files">
        <h3>Files</h3>
        <div className="export-grid">
          {files.map((r) => (
            <button key={r.k} className="export-file" onClick={r.run} title={r.name}>
              <Icon name={r.icon} size={16} /><span>{r.name}</span>
            </button>
          ))}
          <IfcButton model={model} className="export-file" />
          <DxfButton model={model} className="export-file" />
          <button className="export-file primary" onClick={printSheet} title="PDF sheet">
            <Icon name="file" size={16} /><span>PDF</span>
          </button>
        </div>
        <input ref={fileRef} type="file" accept=".json,application/json" hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void importJson(f); e.target.value = ''; }} />
        <div className="export-preview" dangerouslySetInnerHTML={{ __html: preview }} />
      </section>

      <section className="export-block" aria-label="Plan">
        <h3>Plan</h3>
        <ShoppingList model={model} />
        <div className="export-grid">
          <button className="export-file" onClick={() => useUi.getState().openSection('movein')} aria-label="Move-in" title="Move-in">
            <Icon name="door" size={16} /><span>Move-in</span>
          </button>
        </div>
      </section>

      {err && <div className="export-err" role="alert">{err}</div>}

      <button className="export-more" aria-expanded={more} onClick={() => setMore(!more)}>
        <Icon name={more ? 'chevronDown' : 'chevronRight'} size={14} />More
      </button>
      {more && (
        <div className="export-section">
          <div className="export-grid">
            {moreFiles.map((r) => (
              <button key={r.k} className="export-file" onClick={r.run} title={r.name}>
                <Icon name={r.icon} size={16} /><span>{r.name}</span>
              </button>
            ))}
            <ArButton model={model} className="export-file" label="AR" />
          </div>
          <button type="button" className="btn btn-sm" onClick={() => download(`${base}-schedule.csv`, scheduleCsv(furniture), 'text/csv;charset=utf-8')} title="Schedule CSV"><Icon name="download" size={14} />Schedule CSV</button>
          <div className="export-toggles">
            {toggle('furniture', 'Furniture')}{toggle('dimensions', 'Dimensions')}{toggle('titleBlock', 'Title block')}
          </div>
          <div className="export-label">Quantities</div>
          <table className="export-table">
            <tbody>
              {qRows.map(([k, v, cost]) => (
                <tr key={k}><td>{k}</td><td>{v}</td>{anyCost && <td>{cost !== null && Number.isFinite(cost) ? fmtSek(cost) : ''}</td>}</tr>
              ))}
            </tbody>
          </table>
          <div className="export-rates">
            <label className="field">Floor kr/m²<input inputMode="decimal" value={rates.floor} onChange={(e) => setRates({ ...rates, floor: e.target.value })} /></label>
            <label className="field">Paint kr/l<input inputMode="decimal" value={rates.paint} onChange={(e) => setRates({ ...rates, paint: e.target.value })} /></label>
            <label className="field">Skirting kr/m<input inputMode="decimal" value={rates.skirting} onChange={(e) => setRates({ ...rates, skirting: e.target.value })} /></label>
          </div>
        </div>
      )}
    </div>
  );
}
