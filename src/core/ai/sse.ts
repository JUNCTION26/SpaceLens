/**
 * Incremental parser for a text/event-stream body. Feed it decoded chunks as they arrive;
 * it returns the `data:` payload of every event completed so far.
 */
export class SseParser {
  private buf = '';

  push(chunk: string): string[] {
    this.buf += chunk;
    const out: string[] = [];
    for (;;) {
      const m = this.buf.match(/\r?\n\r?\n/);
      if (!m || m.index === undefined) break;
      const event = this.buf.slice(0, m.index);
      this.buf = this.buf.slice(m.index + m[0].length);
      const data = dataOf(event);
      if (data !== null) out.push(data);
    }
    return out;
  }

  /** Call once the stream ends: returns a final event that had no trailing blank line. */
  flush(): string[] {
    const rest = this.buf;
    this.buf = '';
    const data = dataOf(rest);
    return data === null ? [] : [data];
  }
}

function dataOf(event: string): string | null {
  const lines = event.split(/\r?\n/).filter((l) => l.startsWith('data:'));
  if (!lines.length) return null;
  return lines.map((l) => l.slice(l.startsWith('data: ') ? 6 : 5)).join('\n');
}
