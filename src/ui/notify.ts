import { create } from 'zustand';

/** A button on a notice that fixes or undoes something right there. */
export interface NoticeAction { label: string; run: () => void; primary?: boolean }
export interface Notice { id: number; text: string; tone: 'info' | 'ok' | 'warn' | 'error'; actions: NoticeAction[]; ttl: number }

interface NoticeState {
  notices: Notice[];
  push: (n: Omit<Notice, 'id' | 'ttl' | 'actions'> & { actions?: NoticeAction[]; ttl?: number }) => number;
  dismiss: (id: number) => void;
}

let seq = 1;
export const useNotices = create<NoticeState>((set, get) => ({
  notices: [],
  push: (n) => {
    const id = seq++;
    // Notices with buttons stay longer so there is time to use them.
    const ttl = n.ttl ?? (n.actions?.length ? 8000 : 4500);
    set({ notices: [...get().notices.slice(-3), { id, actions: [], ...n, ttl }] });
    if (ttl > 0) setTimeout(() => get().dismiss(id), ttl);
    return id;
  },
  dismiss: (id) => set({ notices: get().notices.filter((x) => x.id !== id) }),
}));

/** Show a short notice with up to three buttons that act on it. */
export function notify(text: string, opts: { tone?: Notice['tone']; actions?: NoticeAction[]; ttl?: number } = {}): number {
  return useNotices.getState().push({ text, tone: opts.tone ?? 'info', actions: (opts.actions ?? []).slice(0, 3), ttl: opts.ttl });
}
