import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../../ui/icons';
import { fits, qrSvg } from './qr';
import './qr.css';

interface Props {
  /** Ready link, or a function that builds it when the code opens. */
  link?: string;
  getLink?: () => Promise<string>;
  /** Show the code as soon as it mounts. */
  openOnMount?: boolean;
  /** Show only the code, without its toggle button. */
  hideButton?: boolean;
  label?: string;
}

const pageAddress = () => `${location.origin}${location.pathname}`;
const shortOf = (u: string) => {
  try { const x = new URL(u); return `${x.host}${x.pathname === '/' ? '' : x.pathname}${x.search}`; } catch { return ''; }
};

/** QR toggle; the code renders inline in the panel (spans the full row of a grid parent). */
export function QrShare({ link, getLink, openOnMount = false, hideButton = false, label = 'QR' }: Props) {
  const [open, setOpen] = useState(openOnMount || hideButton);
  const [full, setFull] = useState<string | null>(link ?? null);
  const [copied, setCopied] = useState(false);

  useEffect(() => { if (link) setFull(link); }, [link]);
  useEffect(() => {
    if (!open || full || !getLink) return;
    let alive = true;
    getLink().then((u) => { if (alive) setFull(u); }, () => { if (alive) setFull(pageAddress()); });
    return () => { alive = false; };
  }, [open, full, getLink]);

  const shown = full && fits(full) ? full : full ? pageAddress() : null;
  const svg = useMemo(() => (shown ? qrSvg(shown, { size: 640, margin: 2 }) : null), [shown]);

  const copy = async () => {
    if (!full) return;
    try { await navigator.clipboard.writeText(full); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* clipboard blocked */ }
  };

  return (
    <>
      {!hideButton && (
        <button type="button" className="export-file qr-btn" aria-pressed={open} onClick={() => setOpen(!open)} aria-label="QR code" title="QR code">
          <Icon name="grid" size={18} /><span>{label}</span>
        </button>
      )}
      {open && (
        <div className="qr-inline">
          {svg
            ? <div className="qr-code" role="img" aria-label="QR code" dangerouslySetInnerHTML={{ __html: svg }} />
            : <div className="qr-code qr-wait" role="status" aria-label="Loading"><span className="qr-spin" /></div>}
          <div className="qr-line">
            <span className="qr-addr">{shown ? shortOf(shown) : ''}</span>
            <button type="button" className="btn btn-sm btn-ghost qr-copy" onClick={() => void copy()} aria-label="Copy link" title="Copy link" disabled={!full}>
              <Icon name={copied ? 'check' : 'copy'} size={14} />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
