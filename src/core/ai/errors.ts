/** What went wrong, in terms a person can act on. Never carries raw API text. */
export type AiReason = 'quota' | 'overloaded' | 'invalid_key' | 'network' | 'blocked' | 'timeout' | 'no_key' | 'other';

export type AiAction = 'retry' | 'offline' | 'settings';

export interface AiProblem { reason: AiReason; message: string; actions: AiAction[] }

/** Reason from an HTTP status and (optional) API message. Status 0 means the request never got an answer. */
export function reasonFromStatus(status: number, message = ''): AiReason {
  if (status === 429) return 'quota';
  if (status === 503 || status === 500 || status === 502 || status === 504 || status === 529) return 'overloaded';
  if (status === 401 || status === 403) return 'invalid_key';
  if (status === 400 && /api key|api_key|key not valid|permission/i.test(message)) return 'invalid_key';
  if (status === 0) return 'network';
  return 'other';
}

/** The most useful reason among several failures: a bad key explains everything, then quota, then load. */
export function dominantReason(reasons: AiReason[]): AiReason {
  for (const r of ['invalid_key', 'quota', 'overloaded', 'network', 'timeout', 'blocked'] as AiReason[]) if (reasons.includes(r)) return r;
  return 'other';
}

const MESSAGES: Record<AiReason, string> = {
  quota: 'Gemini has reached its usage limit for now.',
  overloaded: 'Gemini is busy right now.',
  invalid_key: 'This Gemini key was not accepted.',
  network: 'Could not reach Gemini. Check the connection.',
  timeout: 'Gemini took too long to answer.',
  blocked: 'Gemini declined this request.',
  no_key: 'Add a Gemini key to use this.',
  other: 'Gemini could not answer this time.',
};

export function problemFor(reason: AiReason): AiProblem {
  const actions: AiAction[] = reason === 'no_key' ? ['settings'] : reason === 'invalid_key' ? ['settings', 'offline']
    : reason === 'quota' ? ['offline', 'settings', 'retry']
    : reason === 'blocked' ? ['offline']
    : ['retry', 'offline'];
  return { reason, message: MESSAGES[reason], actions };
}

/** Turns anything thrown by ai() into a problem to show. */
export function classify(err: unknown): AiProblem {
  const r = (err as { reason?: AiReason })?.reason;
  return problemFor(r ?? 'other');
}

export const OFFLINE_NOTE = 'Works offline with rules. Add a Gemini key for custom objects and smarter design.';
