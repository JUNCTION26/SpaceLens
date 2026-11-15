import { create } from 'zustand';
import type { StoreListing } from '../../core/types';
import { emptyMemory, type RefMemory } from '../intent/roomEdit';
import { emptyConversation, type Conversation } from './conversation';

export interface Turn {
  id: string;
  who: 'you' | 'agent';
  text: string;
  at: number;
  /** Which engine answered ("Gemini · flash-lite"); never a timing. */
  meta?: string;
  /** What the agent did, one short line each. */
  done?: string[];
  products?: StoreListing[];
}

export type Phase = 'idle' | 'listening' | 'thinking' | 'speaking';

interface AgentState {
  turns: Turn[];
  /** What the assistant remembers: referred things, last action, stated goals. Plain data. */
  conv: Conversation;
  /** Which pieces the last edits touched, so "a bit left" after "move the desk" means the desk. */
  memory: RefMemory;
  /** Live words while the person is talking. */
  interim: string;
  /** The agent's line in progress or its last line. */
  caption: string;
  listening: boolean;
  thinking: boolean;
  speaking: boolean;
  handsFree: boolean;
  muted: boolean;
  /** Kept for older readers; no longer carries a latency. */
  timing: string | null;
  /** Work in progress under the caption ("Solving the layout…"); not spoken. */
  status: string;
  error: string | null;
  push: (t: Turn) => void;
  patchTurn: (id: string, patch: Partial<Turn>) => void;
  set: (patch: Partial<Omit<AgentState, 'push' | 'patchTurn' | 'set'>>) => void;
}

function loadMuted() { try { return localStorage.getItem('spacelens:agentMuted') === '1'; } catch { return false; } }

export const useAgent = create<AgentState>((set, get) => ({
  turns: [],
  conv: emptyConversation(),
  memory: emptyMemory(),
  interim: '',
  caption: '',
  listening: false,
  thinking: false,
  speaking: false,
  handsFree: false,
  muted: loadMuted(),
  timing: null,
  status: '',
  error: null,
  push: (t) => set({ turns: [...get().turns.slice(-79), t] }),
  patchTurn: (id, patch) => set({ turns: get().turns.map((t) => (t.id === id ? { ...t, ...patch } : t)) }),
  set: (patch) => {
    if ('muted' in patch) { try { localStorage.setItem('spacelens:agentMuted', patch.muted ? '1' : '0'); } catch { /* ignore */ } }
    set(patch);
  },
}));

/** Hands-free keeps the mic open while the agent talks, so the person's own words win, then work, then voice. */
export function phaseOf(s: Pick<AgentState, 'listening' | 'thinking' | 'speaking' | 'interim'>): Phase {
  if (s.listening && s.interim) return 'listening';
  if (s.thinking) return 'thinking';
  if (s.speaking) return 'speaking';
  if (s.listening) return 'listening';
  return 'idle';
}
