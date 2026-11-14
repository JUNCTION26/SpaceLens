/** Small HTTP helpers shared by every handler: one error type, one envelope, one body reader. */

/** Sent on every response. The API serves JSON and event streams only, so the CSP forbids everything. */
export const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
});

/** An error that is safe to show the client: a stable code and a plain message, nothing from upstream. */
export class HttpError extends Error {
  constructor(status, code, message, headers = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export const envelope = (code, message) => ({ error: { code, message } });

export function sendJson(res, status, body, headers = {}) {
  if (res.headersSent) return;
  const text = JSON.stringify(body);
  res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

export function sendError(res, err) {
  sendJson(res, err.status, envelope(err.code, err.message), err.headers);
}

/**
 * Reads a JSON body under a hard size cap. A declared length over the cap is refused before
 * reading; a body that grows past it while streaming is cut off.
 */
export async function readJson(req, maxBytes) {
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'unsupported_media_type', 'Send the request as application/json.');
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge(maxBytes);

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw tooLarge(maxBytes);
    chunks.push(chunk);
  }
  if (!size) throw new HttpError(400, 'invalid_request', 'The request body is empty.');
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json', 'The request body is not valid JSON.');
  }
}

const tooLarge = (maxBytes) => new HttpError(413, 'payload_too_large', `The request body is larger than ${maxBytes} bytes.`, { Connection: 'close' });
