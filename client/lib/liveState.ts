// Whether the server's live-update stream (LiveEventsBridge) is currently
// connected. Pollers use this to stretch their interval: with the stream up,
// a change is pushed the moment it happens and the poll is only a safety
// net, so it can run every few minutes instead of every thirty seconds.
// Without the stream (a proxy that buffers, the user portal, an old
// browser) they keep the fast cadence they always had.
export const LIVE_STATE_EVENT = 'slicksync:live-state';

let connected = false;

export function setLiveConnected(next: boolean) {
  if (connected === next) return;
  connected = next;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(LIVE_STATE_EVENT));
}

export function isLiveConnected() {
  return connected;
}
