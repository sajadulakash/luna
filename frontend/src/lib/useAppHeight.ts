import { useEffect } from 'react';

/**
 * Keeps `--app-height` in step with the *visual* viewport.
 *
 * On mobile the on-screen keyboard is the whole problem. Chrome respects
 * `interactive-widget=resizes-content` and shrinks the layout viewport, so
 * `100dvh` is already correct there. iOS Safari does not: it overlays the
 * keyboard and leaves `100dvh` at its full value, which pushes the composer
 * underneath it. Reading `visualViewport.height` covers both.
 *
 * Called once, from the app shell.
 */
export function useAppHeight(): void {
  useEffect(() => {
    const viewport = window.visualViewport;

    const apply = () => {
      const height = viewport?.height ?? window.innerHeight;
      document.documentElement.style.setProperty('--app-height', `${height}px`);
    };

    apply();

    viewport?.addEventListener('resize', apply);
    viewport?.addEventListener('scroll', apply);
    window.addEventListener('orientationchange', apply);

    return () => {
      viewport?.removeEventListener('resize', apply);
      viewport?.removeEventListener('scroll', apply);
      window.removeEventListener('orientationchange', apply);
    };
  }, []);
}
