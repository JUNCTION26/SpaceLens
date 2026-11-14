/**
 * Tolerant parser for a JSON document that is still streaming in.
 *
 * Returns the largest valid prefix of the document as a value: open strings that sit in a
 * value position are closed, open arrays and objects are closed, and anything that cannot
 * be completed yet (a half-written key, a dangling comma or colon, `tru`, `1.`) is dropped.
 * A fully received document parses exactly like JSON.parse. Leading prose or a ```json
 * fence before the first `{` or `[` is skipped. Returns undefined when nothing usable has
 * arrived yet.
 */
export function partialJson<T = unknown>(text: string): T | undefined {
  const start = text.search(/[[{]/);
  if (start < 0) return tryParse<T>(text.trim());
  const s = text.slice(start);

  interface Frame { t: '{' | '['; expect: 'key' | 'colon' | 'value' | 'comma' }
  const stack: Frame[] = [];
  const closers = () => stack.map((f) => (f.t === '{' ? '}' : ']')).reverse().join('');
  let safe: string | null = null;
  const markSafe = (end: number) => { safe = s.slice(0, end) + closers(); };
  const afterValue = (end: number) => {
    const top = stack[stack.length - 1];
    if (top) top.expect = 'comma';
    markSafe(end);
  };
  const best = (): T | undefined => (safe === null ? undefined : tryParse<T>(safe));

  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const top = stack[stack.length - 1];
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t') { i++; continue; }
    // Text after a finished top-level value never belongs to the document.
    if (!top && i > 0) break;
    const inValue = !top || top.expect === 'value';

    if (c === '"') {
      const end = stringEnd(s, i);
      const isKey = top?.t === '{' && top.expect === 'key';
      if (end < 0) {
        if (!inValue || isKey) return best();
        const partial = s.slice(0, i) + closeString(s.slice(i)) + closers();
        return tryParse<T>(partial) ?? best();
      }
      if (isKey) { top.expect = 'colon'; i = end + 1; continue; }
      if (!inValue) return best();
      afterValue(end + 1);
      i = end + 1;
      continue;
    }
    if (c === '{' || c === '[') {
      if (!inValue) return best();
      stack.push({ t: c, expect: c === '{' ? 'key' : 'value' });
      markSafe(i + 1);
      i++;
      continue;
    }
    if (c === '}' || c === ']') {
      if (!top || (c === '}') !== (top.t === '{')) return best();
      stack.pop();
      if (!stack.length) return tryParse<T>(s.slice(0, i + 1)) ?? best();
      afterValue(i + 1);
      i++;
      continue;
    }
    if (c === ':') {
      if (!top || top.expect !== 'colon') return best();
      top.expect = 'value';
      i++;
      continue;
    }
    if (c === ',') {
      if (!top || top.expect !== 'comma') return best();
      top.expect = top.t === '{' ? 'key' : 'value';
      i++;
      continue;
    }
    // Number or literal.
    if (!inValue) return best();
    let j = i;
    while (j < s.length && /[-+.\w]/.test(s[j])) j++;
    const token = s.slice(i, j);
    const complete = /^(-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?|true|false|null)$/.test(token);
    if (!complete) return best();
    if (j >= s.length) {
      // A number at the very end may still grow (9 -> 90), but it is valid as shown.
      // A literal at the end is complete by definition once it matches.
      afterValue(j);
      return best();
    }
    afterValue(j);
    i = j;
  }
  return best();
}

/** Index of the closing quote of the string starting at `from`, or -1 if unterminated. */
function stringEnd(s: string, from: number): number {
  for (let i = from + 1; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === '"') return i;
  }
  return -1;
}

/** Closes an unterminated string literal, dropping a half-written escape at its end. */
function closeString(lit: string): string {
  let body = lit;
  const u = body.match(/\\u[0-9a-fA-F]{0,3}$/);
  if (u) body = body.slice(0, -u[0].length);
  const slashes = body.match(/\\+$/);
  if (slashes && slashes[0].length % 2 === 1) body = body.slice(0, -1);
  return body + '"';
}

function tryParse<T>(s: string): T | undefined {
  if (!s) return undefined;
  try { return JSON.parse(s) as T; } catch { return undefined; }
}
