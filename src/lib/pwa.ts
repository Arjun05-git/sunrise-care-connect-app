// Installable PWA: service worker registration, update prompt, online state and install prompt.
// The worker caches only the app shell (see public/sw.js); patient data is never stored offline.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import i18n from '@/i18n';
import { isNative } from './native';

/** Registers /sw.js in production web builds. Inside the native app the shell ships in the binary. */
export function registerServiceWorker() {
  if (!import.meta.env.PROD || isNative() || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      // Reload only after the user accepts an update (the first install also changes the controller).
      let accepted = false;
      const offer = (w: ServiceWorker) => {
        toast(i18n.t('pwa.update'), {
          id: 'pwa-update', duration: Infinity,
          action: { label: i18n.t('pwa.reload'), onClick: () => { accepted = true; w.postMessage({ type: 'SKIP_WAITING' }); } },
        });
      };
      if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w?.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w); });
      });
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!accepted) return;
        accepted = false;
        window.location.reload();
      });
      // Check for a new deploy hourly while the app stays open.
      setInterval(() => void reg.update().catch(() => undefined), 60 * 60 * 1000);
    } catch {
      // A failed registration only loses offline start-up; the app works as a normal site.
    }
  });
}

const subscribeOnline = (cb: () => void) => {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => { window.removeEventListener('online', cb); window.removeEventListener('offline', cb); };
};
export const useOnline = () => useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);

interface BeforeInstallPromptEvent extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }

// The browser fires beforeinstallprompt once, early; keep it for the Install button.
let deferred: BeforeInstallPromptEvent | null = null;
const installListeners = new Set<() => void>();
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e as BeforeInstallPromptEvent; installListeners.forEach((l) => l()); });
  window.addEventListener('appinstalled', () => { deferred = null; installListeners.forEach((l) => l()); });
}

export const isStandalone = () =>
  typeof window !== 'undefined' && (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true);
const isIos = () => typeof navigator !== 'undefined' && /iphone|ipad|ipod/i.test(navigator.userAgent) && !/crios|fxios/i.test(navigator.userAgent);

/** 'prompt': the browser can install now; 'ios': show the Share → Add to Home Screen hint; 'none': installed or unsupported. */
export function useInstall() {
  const [, bump] = useState(0);
  useEffect(() => { const l = () => bump((n) => n + 1); installListeners.add(l); return () => { installListeners.delete(l); }; }, []);
  const mode: 'prompt' | 'ios' | 'none' = isNative() || isStandalone() ? 'none' : deferred ? 'prompt' : isIos() ? 'ios' : 'none';
  const install = async () => {
    if (!deferred) return false;
    await deferred.prompt();
    const { outcome } = await deferred.userChoice;
    deferred = null;
    installListeners.forEach((l) => l());
    return outcome === 'accepted';
  };
  return { mode, install };
}
