import { useStore } from '../core/store';

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => <button key={t.id} className={`toast toast-${t.tone}`} onClick={() => dismiss(t.id)}>{t.text}</button>)}
    </div>
  );
}
