import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../../ui/icons';
import { fits, qrSvg } from './qr';
import './qr.css';

interface Props {
  /** Ready link, or a function that builds it when the card opens. */
  link?: string;
  getLink?: () => Promise<string>;
  /** Open the card as soon as it mounts. */
  openOnMount?: boolean;
  label?: string;
}

const pageAddress = () => `${location.origin}${location.pathname}`;
const shortOf = (u: string) => {
  try { const x = new URL(u); return `${x.host}${x.pathname === '/' ? '' : x.pathname}${x.search}`; } catch { return ''; }
};

/** QR button plus a full-screen card, so anyone in the room can open the design on a phone. */
export function QrShare({ link, getLink, openOnMount = false, label = 'QR' }: Props) {
  const [open, setOpen] = useState(openOnMount);
  const [full, setFull] = useState<string | null>(link ?? null);
  const [copied, setCopied] = useState(false);

  useEffect(() => { if (link) setFull(link); }, [link]);
  useEffect(() => {
    if (!open || full || !getLink) return;
    let alive = true;
    getLink().then((u) => { if (alive) setFull(u); }, () => { if (alive) setFull(pageAddress()); });
    return () => { alive = false; };
  }, [open, full, getLink]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  const shown = full && fits(full) ? full : full ? pageAddress() : null;
  const svg = useMemo(() => (shown ? qrSvg(shown, { size: 640, margin: 2 }) : null), [shown]);

  const copy = async () => {
    if (!full) return;
    try { await navigator.clipboard.writeText(full); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* clipboard blocked */ }
  };

  return (
    <>
      <button type="button" className="btn btn-sm btn-ghost qr-btn" onClick={() => setOpen(true)} aria-label="Show QR code">
        <Icon name="grid" size={14} />{label}
      </button>
      {open && (
        <div className="qr-overlay" role="dialog" aria-modal="true" aria-label="QR code" onClick={() => setOpen(false)}>
          <div className="qr-card">
            {svg
              ? <div className="qr-code" dangerouslySetInnerHTML={{ __html: svg }} />
              : <div className="qr-code qr-wait" role="status" aria-label="Loading"><span className="qr-spin" /></div>}
            <div className="qr-addr">{shown ? shortOf(shown) : ''}</div>
            <button type="button" className="btn btn-sm qr-copy" onClick={(e) => { e.stopPropagation(); void copy(); }} aria-label="Copy link" disabled={!full}>
              <Icon name={copied ? 'check' : 'share'} size={14} />
            </button>
          </div>
          <button type="button" className="btn btn-ghost qr-close" onClick={() => setOpen(false)} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>
      )}
    </>
  );
}
