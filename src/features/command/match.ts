// Matching and ranking for the command palette. Pure functions, no UI state.

export interface Matchable { id: string; label: string; words?: string }

/** Edit distance with adjacent swaps counted as one edit. */
export function distance(a: string, b: string): number {
  const n = a.length, m = b.length;
  if (!n) return m;
  if (!m) return n;
  const d: number[][] = Array.from({ length: n + 1 }, (_, i) => [i, ...Array(m).fill(0)]);
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[n][m];
}

const tokens = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** Edits allowed for a query word of this length. */
const allowed = (len: number) => (len <= 2 ? 0 : len <= 5 ? 1 : 2);

/** Score one query word against one target word; 0 means no match. */
function wordScore(q: string, w: string): number {
  if (q === w) return 100;
  if (w.startsWith(q)) return 80 - Math.min(20, w.length - q.length);
  if (q.length >= 3 && w.includes(q)) return 45;
  const tol = allowed(q.length);
  if (!tol) return 0;
  const full = distance(q, w);
  const pre = distance(q, w.slice(0, q.length));
  const best = Math.min(full, pre);
  return best <= tol ? 60 - best * 15 - (best === pre && best < full ? 5 : 0) : 0;
}

/** Score a query against a command. Higher is better; 0 means no match. */
export function scoreCommand(query: string, c: Matchable): number {
  const qs = tokens(query);
  if (!qs.length) return 0;
  const label = tokens(c.label);
  const joined = label.join('');
  const extra = tokens(c.words ?? '');
  let total = 0;
  for (const q of qs) {
    let best = 0;
    label.forEach((w, i) => { const ws = wordScore(q, w); if (ws) best = Math.max(best, ws + (i === 0 ? 5 : 0)); });
    { const ws = wordScore(q, joined); if (ws) best = Math.max(best, ws - 5); }
    for (const w of extra) { const ws = wordScore(q, w); if (ws) best = Math.max(best, ws - 15); }
    if (!best) return 0;
    total += best;
  }
  const lq = qs.join(' ');
  if (c.label.toLowerCase() === lq) total += 40;
  else if (c.label.toLowerCase().startsWith(lq)) total += 15;
  return total / qs.length + (qs.length > 1 ? 5 : 0);
}

/**
 * Rank commands for a query. With no query, recent commands come first (in recency order),
 * then the rest in their given order. Ties keep the given order.
 */
export function rank<T extends Matchable>(commands: T[], query: string, recent: string[] = [], limit = 40): T[] {
  const q = query.trim();
  const rec = (id: string) => { const i = recent.indexOf(id); return i < 0 ? 0 : 20 - i; };
  if (!q) {
    const byId = new Map(commands.map((c) => [c.id, c]));
    const first = recent.map((id) => byId.get(id)).filter((c): c is T => !!c);
    const seen = new Set(first.map((c) => c.id));
    return [...first, ...commands.filter((c) => !seen.has(c.id))].slice(0, limit);
  }
  return commands
    .map((c, i) => ({ c, i, s: scoreCommand(q, c) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => (b.s + rec(b.c.id)) - (a.s + rec(a.c.id)) || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.c);
}
