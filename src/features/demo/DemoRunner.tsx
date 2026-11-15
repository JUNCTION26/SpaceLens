import { useEffect } from 'react';
import { ShowRunner } from './ShowRunner';

/**
 * Mounts the film and routes every demo entry to it: Settings > More > Demo and the search command
 * both emit spacelens:demo, which plays the full-screen film.
 * ?demo=<kind> still loads the demo building.
 */
export function DemoRunner() {
  useEffect(() => {
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('demo')) {
      void import('../building/demo').then((m) => m.applyDemoLink());
    }
    const start = () => window.dispatchEvent(new Event('spacelens:show'));
    window.addEventListener('spacelens:demo', start);
    return () => window.removeEventListener('spacelens:demo', start);
  }, []);
  return <ShowRunner />;
}
