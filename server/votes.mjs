/**
 * Layout polls. A poll is 2-4 layout snapshots (name, price, a small thumbnail) and one vote per
 * browser token. Storage is in memory with a size cap and an expiry, so polls disappear when the
 * process restarts. The handlers validate everything they store.
 */
import { randomBytes } from 'node:crypto';
import { HttpError, readJson, sendJson } from './http.mjs';

export const POLL_TTL_MS = 48 * 3_600_000;
export const MAX_POLLS = 300;
export const MAX_VOTERS = 2000;
export const MAX_BODY_BYTES = 64 * 1024;
const MAX_THUMB = 12_000;
const MAX_PLAN_ITEMS = 80;
const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;
const POLL_ID = /^[A-Za-z0-9]{10}$/;
// A thumbnail is shown as an image, but anything that could run or fetch is refused outright.
const UNSAFE_SVG = /<\s*(script|foreignObject|iframe|image|style|use|a)\b|\son\w+\s*=|javascript:|data:|href\s*=|url\s*\(|@import|<!/i;

const bad = (message) => new HttpError(400, 'invalid_request', message);
const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

function validateThumb(svg) {
  if (typeof svg !== 'string' || svg.length > MAX_THUMB) throw bad('A thumbnail is missing or too large.');
  const t = svg.trim();
  if (!/^<svg[\s>]/i.test(t) || !/<\/svg>$/i.test(t) || UNSAFE_SVG.test(t)) throw bad('A thumbnail is not a plain SVG.');
  return t;
}

function validatePlan(plan) {
  if (!plan || typeof plan !== 'object' || !num(plan.w, 0.5, 200) || !num(plan.h, 0.5, 200) || !Array.isArray(plan.items) || plan.items.length > MAX_PLAN_ITEMS) throw bad('Plan data is not valid.');
  const items = plan.items.map((i) => {
    if (!i || !num(i.x, -200, 400) || !num(i.y, -200, 400) || !num(i.w, 0, 50) || !num(i.d, 0, 50) || !num(i.r ?? 0, -10, 10)) throw bad('Plan data is not valid.');
    return { x: i.x, y: i.y, w: i.w, d: i.d, r: i.r ?? 0 };
  });
  const out = { w: plan.w, h: plan.h, items };
  if (plan.room !== undefined) {
    if (!Array.isArray(plan.room) || plan.room.length < 3 || plan.room.length > 40 || plan.room.some((p) => !p || !num(p.x, -200, 400) || !num(p.y, -200, 400))) throw bad('Plan data is not valid.');
    out.room = plan.room.map((p) => ({ x: p.x, y: p.y }));
  }
  return out;
}

/** @returns {{ layouts: { name: string, priceSek: number, thumb?: string, plan?: object }[] }} */
export function validatePoll(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('The request must be a JSON object.');
  const list = body.layouts;
  if (!Array.isArray(list) || list.length < 2 || list.length > 4) throw bad('A poll needs 2 to 4 layouts.');
  const layouts = list.map((l) => {
    if (!l || typeof l !== 'object') throw bad('A layout is not valid.');
    const name = typeof l.name === 'string' ? l.name.trim() : '';
    if (!name || name.length > 40 || /[\u0000-\u001f<>]/.test(name)) throw bad('A layout name is missing or too long.');
    if (!num(l.priceSek, 0, 1e9)) throw bad('A layout price is not valid.');
    if (l.thumb === undefined && l.plan === undefined) throw bad('A layout needs a thumbnail or plan data.');
    const out = { name, priceSek: Math.round(l.priceSek) };
    if (l.thumb !== undefined) out.thumb = validateThumb(l.thumb);
    if (l.plan !== undefined) out.plan = validatePlan(l.plan);
    return out;
  });
  return { layouts };
}

export function createVoteStore({ now = Date.now, ttlMs = POLL_TTL_MS, maxPolls = MAX_POLLS, maxVoters = MAX_VOTERS } = {}) {
  const polls = new Map();
  const view = (p) => ({ id: p.id, createdAt: p.createdAt, expiresAt: p.expiresAt, layouts: p.layouts.map((l, i) => ({ ...l, votes: p.counts[i] })), total: p.voters.size });
  const prune = () => {
    const t = now();
    for (const [id, p] of polls) if (p.expiresAt <= t) polls.delete(id);
    // Still full: the oldest polls go first (Map keeps insertion order).
    for (const id of polls.keys()) { if (polls.size < maxPolls) break; polls.delete(id); }
  };
  const live = (id) => {
    const p = polls.get(id);
    if (p && p.expiresAt <= now()) { polls.delete(id); return undefined; }
    return p;
  };
  return {
    create({ layouts }) {
      if (polls.size >= maxPolls) prune();
      let id;
      do id = randomBytes(9).toString('base64url').replace(/[-_]/g, 'x').slice(0, 10); while (polls.has(id));
      const t = now();
      const p = { id, createdAt: t, expiresAt: t + ttlMs, layouts, counts: layouts.map(() => 0), voters: new Set() };
      polls.set(id, p);
      return view(p);
    },
    get(id) { const p = live(id); return p ? view(p) : null; },
    /** @returns {{ poll: object } | { error: 'missing' | 'already' | 'choice' | 'full' }} */
    vote(id, choice, token) {
      const p = live(id);
      if (!p) return { error: 'missing' };
      if (!Number.isInteger(choice) || choice < 0 || choice >= p.layouts.length) return { error: 'choice' };
      if (p.voters.has(token)) return { error: 'already' };
      if (p.voters.size >= maxVoters) return { error: 'full' };
      p.voters.add(token);
      p.counts[choice] += 1;
      return { poll: view(p) };
    },
    size: () => polls.size,
  };
}

const gone = () => new HttpError(404, 'not_found', 'This poll does not exist or has expired.');

/** Route handlers for /v1/votes. `store` is injectable so tests can control time and size. */
export function createVoteHandlers(store = createVoteStore()) {
  const idOf = ({ params }) => {
    if (!POLL_ID.test(params?.id ?? '')) throw gone();
    return params.id;
  };
  return {
    store,
    async create(ctx) {
      sendJson(ctx.res, 201, store.create(validatePoll(await readJson(ctx.req, MAX_BODY_BYTES))));
    },
    async read(ctx) {
      const poll = store.get(idOf(ctx));
      if (!poll) throw gone();
      sendJson(ctx.res, 200, poll);
    },
    async vote(ctx) {
      const id = idOf(ctx);
      const body = await readJson(ctx.req, 1024);
      if (!body || typeof body !== 'object' || typeof body.token !== 'string' || !TOKEN.test(body.token)) throw bad('A voter token is required.');
      const r = store.vote(id, body.choice, body.token);
      if (r.poll) return sendJson(ctx.res, 200, r.poll);
      if (r.error === 'missing') throw gone();
      if (r.error === 'already') throw new HttpError(409, 'already_voted', 'This browser has already voted.');
      if (r.error === 'full') throw new HttpError(429, 'poll_full', 'This poll has reached its vote limit.');
      throw bad('That choice is not on the poll.');
    },
  };
}
