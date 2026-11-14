/** Exact-path routing. The API is small, so a table beats pattern matching. */

/**
 * @param {{ method: string, path: string, handler: Function, limited?: boolean }[]} routes
 *   `limited` routes need an allowed Origin and spend rate-limit tokens.
 */
export function createRouter(routes) {
  const byPath = new Map();
  for (const r of routes) {
    if (!byPath.has(r.path)) byPath.set(r.path, new Map());
    byPath.get(r.path).set(r.method, r);
  }
  /** @returns {{ route?: object, allow?: string[] }} a route, or the methods the path allows, or {} for unknown paths */
  return function match(method, path) {
    const methods = byPath.get(path);
    if (!methods) return {};
    const route = methods.get(method) ?? (method === 'HEAD' ? methods.get('GET') : undefined);
    return route ? { route } : { allow: [...methods.keys(), 'OPTIONS'] };
  };
}
