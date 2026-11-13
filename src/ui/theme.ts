import { useEffect } from 'react';
import { useStore } from '../core/store';

export function useTheme() {
  const theme = useStore((s) => s.settings.theme);
  useEffect(() => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);
}
