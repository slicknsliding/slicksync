'use client';

// "Didn't open?" check for aiostreams:// links. A browser silently ignores a
// custom-scheme link when no app handles it, so after one is pressed we wait
// 2.5 s: if the page lost focus or was hidden an app took over, otherwise show
// a note. Every place that opens an AIOStreams link calls watch(url).

import { useCallback, useEffect, useRef, useState } from 'react';

const WAIT_MS = 2500;
const TV_HIDE_MS = 10000;

export function useAppOpenCheck(isTV = false) {
  const [shown, setShown] = useState(false);
  const stopRef = useRef<(() => void) | null>(null);

  const stop = useCallback(() => { stopRef.current?.(); stopRef.current = null; }, []);

  const watch = useCallback((url: string | null | undefined) => {
    if (!url || !url.startsWith('aiostreams://')) return;
    stop();
    setShown(false);
    const timer = window.setTimeout(() => {
      stop();
      if (document.visibilityState === 'visible') setShown(true);
    }, WAIT_MS);
    const cancel = () => stop();
    const onVis = () => { if (document.visibilityState === 'hidden') stop(); };
    window.addEventListener('blur', cancel);
    window.addEventListener('pagehide', cancel);
    document.addEventListener('visibilitychange', onVis);
    stopRef.current = () => {
      window.clearTimeout(timer);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('pagehide', cancel);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [stop]);

  // No close button on a remote: the note goes away by itself.
  useEffect(() => {
    if (!shown || !isTV) return;
    const t = window.setTimeout(() => setShown(false), TV_HIDE_MS);
    return () => window.clearTimeout(t);
  }, [shown, isTV]);

  useEffect(() => stop, [stop]);

  const hide = useCallback(() => setShown(false), []);
  return { watch, shown, hide };
}
