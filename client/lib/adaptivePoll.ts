import { isLiveConnected, LIVE_STATE_EVENT } from './liveState';

/**
 * A polling loop that knows when it is not needed.
 *
 * Replaces a bare setInterval for the pages and widgets that refetch on a
 * timer. Three differences, all invisible when everything is normal:
 *
 * - While the live-update stream is connected, the poll runs at `slowMs`
 *   instead of `fastMs`: changes arrive by push, the poll is a safety net.
 *   An open dashboard used to make twenty API calls a minute doing nothing.
 * - While the tab is hidden it does not run at all. A backgrounded phone
 *   has no reason to keep asking - and every call was battery, data and a
 *   round trip through whatever sits in front of the instance.
 * - When the tab becomes visible again after a long gap it refetches once,
 *   right away, so nothing looks stale for the length of a slow interval.
 *
 * Returns the stop function, to be returned from the effect that started it.
 */
export function startAdaptivePoll(fn: () => void, fastMs: number, slowMs: number): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastRun = Date.now();
  let stopped = false;

  const interval = () => (isLiveConnected() ? slowMs : fastMs);
  const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';

  const schedule = () => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(tick, interval());
  };
  const tick = () => {
    if (stopped) return;
    if (visible()) {
      lastRun = Date.now();
      fn();
    }
    schedule();
  };
  const onVisibility = () => {
    if (!visible() || stopped) return;
    if (Date.now() - lastRun >= fastMs) {
      lastRun = Date.now();
      fn();
    }
    schedule();
  };
  // The stream connecting or dropping changes the cadence from the next
  // tick; nothing fires immediately.
  const onLiveState = () => schedule();

  schedule();
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
  if (typeof window !== 'undefined') window.addEventListener(LIVE_STATE_EVENT, onLiveState);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    if (typeof window !== 'undefined') window.removeEventListener(LIVE_STATE_EVENT, onLiveState);
  };
}
