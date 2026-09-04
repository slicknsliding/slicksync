'use client';

import { useEffect } from 'react';

// Per-device kill switch for the worker, used to isolate the iPhone
// installed-PWA freeze: on iOS, third-party BROWSER tabs (Firefox, DDG)
// never run service workers at all, while Safari and every installed PWA
// do - and the freeze occurs exactly and only where a worker runs. This
// flag lets one device drop the worker (and its caches) to test that
// split directly. Read by the Settings toggle as well - keep the key in
// sync with settings/page.tsx.
export const SW_DISABLED_KEY = 'slicksync-sw-disabled';

export function isSwDisabled(): boolean {
  try { return localStorage.getItem(SW_DISABLED_KEY) === '1'; } catch { return false; }
}

/** Unregisters every worker and clears its caches on this device. */
export async function tearDownServiceWorker(): Promise<void> {
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister().catch(() => false)));
  } catch { /* nothing registered */ }
  try {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('slicksync-')).map((k) => caches.delete(k)));
  } catch { /* cache API unavailable */ }
}

// Registers the service worker on every load, not just when push
// notifications get enabled. The worker used to be registered exclusively
// by PushNotificationToggle (its /sw.js registration remains and is
// harmless - registering the same script URL twice is an explicit no-op in
// the spec), which meant the app-shell caching sw.js now does only worked
// for people who had turned push on. Renders nothing; mounted once from
// the root layout so admin, user portal, and public pages all get it.
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
    // Troubleshooting kill switch (Settings → Notifications): with the
    // flag set, not only skip registering but actively tear down whatever
    // is already controlling this device, so one reload after flipping
    // the toggle really tests a worker-free app.
    if (isSwDisabled()) {
      tearDownServiceWorker();
      return;
    }
    // After the window load event, so worker installation never competes
    // with the page's own first-load network traffic.
    const register = () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        // Private browsing / unsupported - the app just loads normally.
      });
    };
    if (document.readyState === 'complete') register();
    else {
      window.addEventListener('load', register, { once: true });
      return () => window.removeEventListener('load', register);
    }
  }, []);

  return null;
}
