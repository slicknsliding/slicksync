'use client';

import { useEffect } from 'react';
import { useIsTV } from '@/lib/hooks/useIsTV';

// Android's hardware/remote back button has no equivalent on PC/mobile web,
// so Capacitor's WebView owns handling it - and by default that means
// checking the WebView's own native history stack, not the SPA's client-side
// route history. Confirmed live: every back press exited the app outright,
// even from deep inside Discover. Registering our own `backButton` listener
// via the Capacitor bridge takes full control away from that native default
// and lets it go through the SPA's actual router history instead, only
// really exiting once there's nowhere left to go back to.
//
// Reads `window.Capacitor` directly rather than importing the `@capacitor/app`
// npm package - this file also ships to every non-TV build (PC/mobile
// browser), which has no Capacitor runtime and shouldn't carry a hard
// dependency on one. The native `@capacitor/app` Android plugin still has to
// be installed in the TV shell project for `Capacitor.Plugins.App` to exist
// at all; see /tmp/slicksync-tv-app on the VPS.
export function TVBackButton() {
  const isTV = useIsTV();

  useEffect(() => {
    if (!isTV || typeof window === 'undefined') return;
    const cap = (window as any).Capacitor;
    const AppPlugin = cap?.Plugins?.App;
    if (!AppPlugin?.addListener) return;

    let handle: { remove: () => void } | null = null;
    let cancelled = false;

    AppPlugin.addListener('backButton', ({ canGoBack }: { canGoBack: boolean }) => {
      if (canGoBack) window.history.back();
      else AppPlugin.exitApp();
    }).then((h: { remove: () => void }) => {
      if (cancelled) h.remove();
      else handle = h;
    });

    return () => {
      cancelled = true;
      handle?.remove();
    };
  }, [isTV]);

  return null;
}
