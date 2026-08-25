'use client';

import { useEffect } from 'react';

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
