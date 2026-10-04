'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';

// A tab left open across an update kept running the code it loaded - moving
// between pages inside SlickSync is client-side, so nothing ever fetched the
// new build. People saw "the fix isn't there" on an instance that had it.
//
// Each image carries a build stamp (written by the Dockerfile, inlined here
// and served by /api/health/build). This checks it when the tab comes back
// into view and every 10 minutes; once the server is on a newer build, the
// next page change becomes a full load. Never mid-page, so nothing being
// typed is lost.
const MY_BUILD = process.env.NEXT_PUBLIC_BUILD_STAMP || '';
const CHECK_EVERY_MS = 10 * 60 * 1000;
const RELOAD_GUARD_KEY = 'slicksync-build-reload-at';

function reloadOnce() {
  // A guard against a loop if the server somehow keeps reporting a stamp
  // this build can never match: at most one forced reload a minute.
  try {
    const last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) || 0);
    if (Date.now() - last < 60_000) return;
    sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
  } catch {}
  window.location.reload();
}

export function BuildWatcher() {
  const pathname = usePathname();
  const stale = useRef(false);
  const firstPath = useRef(true);

  useEffect(() => {
    if (!MY_BUILD || MY_BUILD === 'dev') return;
    let stopped = false;
    const check = async () => {
      if (stopped || stale.current || document.visibilityState !== 'visible') return;
      try {
        const res = await fetch('/api/health/build', { cache: 'no-store', credentials: 'same-origin' });
        if (!res.ok) return;
        const { stamp } = await res.json();
        if (typeof stamp === 'string' && stamp && stamp !== MY_BUILD) stale.current = true;
      } catch {}
    };
    const onVisible = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onVisible);
    const timer = setInterval(check, CHECK_EVERY_MS);
    check();
    return () => { stopped = true; document.removeEventListener('visibilitychange', onVisible); clearInterval(timer); };
  }, []);

  // A page's code that the server no longer has (the tab is from an older
  // build) fails to load as a chunk error - load the page fresh instead of
  // leaving it broken.
  useEffect(() => {
    const isChunkError = (v: unknown) => {
      const e = v as { name?: string; message?: string } | null;
      const text = `${e?.name || ''} ${e?.message || ''}`;
      return /ChunkLoadError|Loading chunk [\w-]+ failed|Failed to fetch dynamically imported module|error loading dynamically imported module/i.test(text);
    };
    const onError = (ev: ErrorEvent) => { if (isChunkError(ev.error) || isChunkError({ message: ev.message })) reloadOnce(); };
    const onRejection = (ev: PromiseRejectionEvent) => { if (isChunkError(ev.reason)) reloadOnce(); };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => { window.removeEventListener('error', onError); window.removeEventListener('unhandledrejection', onRejection); };
  }, []);

  useEffect(() => {
    if (firstPath.current) { firstPath.current = false; return; }
    if (stale.current) reloadOnce();
  }, [pathname]);

  return null;
}
