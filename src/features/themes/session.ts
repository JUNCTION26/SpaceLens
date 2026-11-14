// The last themed room, so a follow-up ("make the bed bigger") edits the pieces already made
// instead of starting over.
import type { ThemedResult } from './designThemed';

export interface ThemedSession { text: string; result: ThemedResult; applied: string[] }
let last: ThemedSession | null = null;

export const lastThemed = () => last;
export function rememberThemed(s: ThemedSession | null): void { last = s; }
