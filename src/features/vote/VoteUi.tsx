import { useEffect, useState } from 'react';
import { useStore } from '../../core/store';
import { fmtSek } from '../../core/geometry';
import { Icon } from '../../ui/icons';
import { castVote, createPoll, getPoll, ownsPoll, pollIdFromUrl, pollsEnabled, votedChoice, winnerOf, type Poll, type PollPlan } from './api';
import { QrShare } from '../export/QrShare';
import './vote.css';

/** Share for the Layouts compare view: makes a poll from the layouts and copies its link. Hidden without a server. */
export function SharePoll() {
  const candidates = useStore((s) => s.candidates);
  const model = useStore((s) => s.model);
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'fail'>('idle');
  const [pollLink, setPollLink] = useState<string | null>(null);
  if (!pollsEnabled() || candidates.length < 2) return null;
  const share = async () => {
    setState('busy');
    try {
      const { link } = await createPoll(model, candidates);
      setPollLink(link);
      try { await navigator.clipboard.writeText(link); } catch { /* the code below shows the link */ }
      setState('done');
    } catch { setState('fail'); }
    setTimeout(() => setState('idle'), 2500);
  };
  return (
    <>
      <button className="export-file" disabled={state === 'busy'} onClick={() => void share()} aria-live="polite" aria-label="Vote" title="Vote">
        <Icon name={state === 'done' ? 'check' : state === 'fail' ? 'alert' : 'layout'} size={18} /><span>Vote</span>
      </button>
      {pollLink && <QrShare link={pollLink} hideButton />}
    </>
  );
}

export function PlanThumb({ plan }: { plan: PollPlan }) {
  const pad = 0.2;
  return (
    <svg className="poll-plan" viewBox={`${-pad} ${-pad} ${plan.w + pad * 2} ${plan.h + pad * 2}`} role="img" aria-label="Layout">
      {plan.room
        ? <polygon points={plan.room.map((p) => `${p.x},${p.y}`).join(' ')} className="poll-room" />
        : <rect width={plan.w} height={plan.h} className="poll-room" />}
      {plan.items.map((i, k) => (
        <rect key={k} x={i.x - i.w / 2} y={i.y - i.d / 2} width={i.w} height={i.d} rx={0.04} className="poll-item"
          transform={`rotate(${(i.r * 180) / Math.PI} ${i.x} ${i.y})`} />
      ))}
    </svg>
  );
}

/** Full-screen vote page for a poll link: one large card per layout, a Vote button each, live counts. */
export function PollOverlay() {
  const [id, setId] = useState<string | null>(() => pollIdFromUrl());
  const [poll, setPoll] = useState<Poll | null>(null);
  const [gone, setGone] = useState(false);
  const [mine, setMine] = useState<number | null>(() => (id ? votedChoice(id) : null));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    const load = () => getPoll(id).then((p) => { if (alive) setPoll(p); }, (e: { status?: number }) => { if (alive && e.status === 404) setGone(true); });
    void load();
    const t = setInterval(() => void load(), 4000);
    return () => { alive = false; clearInterval(t); };
  }, [id]);

  if (!id) return null;
  const close = () => {
    const u = new URL(location.href);
    u.searchParams.delete('poll');
    history.replaceState(null, '', u.toString());
    setId(null);
  };
  const vote = async (i: number) => {
    setBusy(true);
    try { setPoll(await castVote(id, i)); setMine(i); } catch (e) { if ((e as { status?: number }).status === 409) setMine(votedChoice(id) ?? i); }
    setBusy(false);
  };
  const win = poll && ownsPoll(id) ? winnerOf(poll) : -1;
  return (
    <div className="poll-overlay" role="dialog" aria-label="Vote">
      <button className="btn btn-ghost poll-close" onClick={close} aria-label="Close"><Icon name="x" size={16} /></button>
      {gone && <div className="poll-empty" aria-label="Poll gone"><Icon name="alert" size={24} /></div>}
      {!gone && !poll && <div className="poll-empty" role="status" aria-label="Loading"><span className="poll-spin" /></div>}
      {poll && (
        <div className="poll-grid">
          {poll.layouts.map((l, i) => (
            <figure key={i} className={`poll-card${win === i ? ' win' : ''}${mine === i ? ' mine' : ''}`}>
              {l.plan ? <PlanThumb plan={l.plan} /> : l.thumb ? <img className="poll-plan" alt="Layout" src={`data:image/svg+xml;utf8,${encodeURIComponent(l.thumb)}`} /> : null}
              <figcaption>
                <strong>{l.name}</strong>
                <span className="poll-price">{fmtSek(l.priceSek)}</span>
                <span className="poll-count" aria-label={`${l.votes} votes`}>{l.votes}</span>
                <button className={`btn ${mine == null ? 'btn-primary' : ''}`} disabled={busy || mine != null} onClick={() => void vote(i)}>
                  {mine === i ? <Icon name="check" size={14} /> : null}Vote
                </button>
              </figcaption>
            </figure>
          ))}
        </div>
      )}
    </div>
  );
}
