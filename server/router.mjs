/** Exact-path routing. The API is small, so a table beats pattern matching. */

/**
 * @param {{ method: string, path: string, handler: Function, limited?: boolean }[]} routes
 *   `limited` routes need an allowed Origin and spend rate-limit tokens.
 */
export function createRouter(routes) {
  const byPath = new Map();
  const patterns = [];
  for (const r of routes) {
    if (r.path.includes(':')) {
      const names = [];
      const re = new RegExp(`^${r.path.replace(/:([a-z]+)/g, (_, n) => { names.push(n); return '([A-Za-z0-9_-]{1,64})'; })}$`);
      patterns.push({ re, names, r });
      continue;
    }
    if (!byPath.has(r.path)) byPath.set(r.path, new Map());
    byPath.get(r.path).set(r.method, r);
  }
  /** @returns {{ route?: object, allow?: string[] }} a route, or the methods the path allows, or {} for unknown paths */
  return function match(method, path) {
    const methods = byPath.get(path);
    if (!methods) {
      // Parameterised routes such as /v1/votes/:id: parameters come back with the route.
      const hits = patterns.map((p) => ({ p, m: p.re.exec(path) })).filter((x) => x.m);
      if (!hits.length) return {};
      const hit = hits.find((x) => x.p.r.method === method || (method === 'HEAD' && x.p.r.method === 'GET'));
      if (!hit) return { allow: [...new Set([...hits.map((x) => x.p.r.method), 'OPTIONS'])] };
      return { route: hit.p.r, params: Object.fromEntries(hit.p.names.map((n, i) => [n, hit.m[i + 1]])) };
    }
    const route = methods.get(method) ?? (method === 'HEAD' ? methods.get('GET') : undefined);
    return route ? { route } : { allow: [...methods.keys(), 'OPTIONS'] };
  };
}
