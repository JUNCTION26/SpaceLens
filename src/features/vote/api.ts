import { apiBase } from '../../core/ai/transport';
import type { FurnitureItem, LayoutCandidate, SpaceModel } from '../../core/types';

export interface PollPlan { w: number; h: number; items: Array<{ x: number; y: number; w: number; d: number; r: number }>; room?: Array<{ x: number; y: number }> }
export interface PollLayout { name: string; priceSek: number; plan?: PollPlan; thumb?: string; votes: number }
export interface Poll { id: string; createdAt: number; expiresAt: number; layouts: PollLayout[]; total: number }

const OWN = 'spacelens.polls.own';
const TOKEN = 'spacelens.voter';

/** Sharing needs the server; without VITE_API_BASE the Share button is hidden. */
export const pollsEnabled = (base: string = apiBase()) => !!base;

function store(): Storage | null { try { return localStorage; } catch { return null; } }
function read(key: string): string | null { try { return store()?.getItem(key) ?? null; } catch { return null; } }
function write(key: string, v: string) { try { store()?.setItem(key, v); } catch { /* storage blocked */ } }

export function voterToken(): string {
  let t = read(TOKEN);
  if (!t || !/^[A-Za-z0-9_-]{16,64}$/.test(t)) {
    const a = new Uint8Array(18);
    crypto.getRandomValues(a);
    t = btoa(String.fromCharCode(...a)).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c]!);
    write(TOKEN, t);
  }
  return t;
}
export const ownsPoll = (id: string) => (read(OWN) ?? '').split(',').includes(id);
const markOwn = (id: string) => write(OWN, [...(read(OWN) ?? '').split(',').filter(Boolean).slice(-19), id].join(','));
const votedKey = (id: string) => `spacelens.voted.${id}`;
export const votedChoice = (id: string): number | null => { const v = read(votedKey(id)); return v == null ? null : Number(v); };

/** One layout as plan data: room outline and item rectangles in metres from the room's corner. */
export function planOf(model: SpaceModel, furniture: FurnitureItem[]): PollPlan {
  const pts = model.spaces.flatMap((s) => s.polygon);
  const minX = Math.min(...pts.map((p) => p.x)), minY = Math.min(...pts.map((p) => p.y));
  const maxX = Math.max(...pts.map((p) => p.x)), maxY = Math.max(...pts.map((p) => p.y));
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const outline = model.spaces.length === 1 && model.spaces[0].polygon.length <= 40 ? model.spaces[0].polygon : null;
  return {
    w: Math.max(0.5, r2(maxX - minX)), h: Math.max(0.5, r2(maxY - minY)),
    items: furniture.slice(0, 80).map((f) => ({ x: r2(f.x - minX), y: r2(f.y - minY), w: r2(f.w), d: r2(f.d), r: r2(f.rotation) })),
    ...(outline && outline.length >= 3 ? { room: outline.map((p) => ({ x: r2(p.x - minX), y: r2(p.y - minY) })) } : {}),
  };
}

export const pollBody = (model: SpaceModel, candidates: LayoutCandidate[]) => ({
  layouts: candidates.slice(0, 4).map((c) => ({
    name: c.name.slice(0, 40) || 'Layout',
    priceSek: Math.max(0, c.metrics.costSek),
    plan: planOf(model, c.furniture),
  })),
});

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, init);
  if (!res.ok) throw Object.assign(new Error(String(res.status)), { status: res.status });
  return (await res.json()) as T;
}
const json = (body: object): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export async function createPoll(model: SpaceModel, candidates: LayoutCandidate[]): Promise<{ poll: Poll; link: string }> {
  const poll = await call<Poll>('/v1/votes', json(pollBody(model, candidates)));
  markOwn(poll.id);
  const url = new URL(location.href);
  url.search = `?poll=${poll.id}`;
  url.hash = '';
  return { poll, link: url.toString() };
}
export const getPoll = (id: string) => call<Poll>(`/v1/votes/${encodeURIComponent(id)}`);
export async function castVote(id: string, choice: number): Promise<Poll> {
  const poll = await call<Poll>(`/v1/votes/${encodeURIComponent(id)}/vote`, json({ choice, token: voterToken() }));
  write(votedKey(id), String(choice));
  return poll;
}
export const pollIdFromUrl = (search: string = location.search): string | null => {
  const id = new URLSearchParams(search).get('poll');
  return id && /^[A-Za-z0-9]{10}$/.test(id) ? id : null;
};
/** Index of the layout with most votes, or -1 on no votes or a tie. */
export const winnerOf = (p: Poll): number => {
  const max = Math.max(...p.layouts.map((l) => l.votes));
  if (max <= 0) return -1;
  const at = p.layouts.map((l, i) => (l.votes === max ? i : -1)).filter((i) => i >= 0);
  return at.length === 1 ? at[0] : -1;
};
