// How fresh a Now Playing card's information is, as the small line under it:
// "Live · updated 8 s ago", "Paused · 2 min ago" or "Last seen 12 min ago".
//
// Pure, so the thresholds can be tested on their own. The age counts from
// `reportedAtTimestamp`, which the server sets per kind of row: the poll that
// last reconfirmed a proxy stream, the pass that last saw a Jellyfin session,
// or when a provider's checkpoint was last written. It says nothing about
// which source wins a merge.

export interface FreshnessRow {
  source?: string;
  /** Set only when the player itself said paused. */
  paused?: boolean;
  /** The proxy has stopped reconfirming the stream. */
  elapsedFrozen?: boolean;
  /** When the row's information was last reconfirmed or saved, in ms. */
  reportedAtTimestamp?: number | null;
  /** AIOStreams apps only: until when "Playing" is believable (the server's
   *  estimate of the runtime running out). Past it the row is "Last seen". */
  playingUntilTimestamp?: number | null;
}

// 'playing-estimated' is a start we have not heard anything since (AIOStreams
// apps report start, pause and stop only) - not a confirmation like 'live'.
export type FreshnessState = 'live' | 'playing-estimated' | 'paused' | 'seen';

export interface Freshness {
  state: FreshnessState;
  /** The whole line, e.g. "Live · updated 8 s ago". */
  text: string;
  /** Confirmed by a heartbeat the server keeps hearing ("Live · updated"). */
  live: boolean;
  /** Whether the card's dot should beat. */
  pulse: boolean;
}

/** Sources that keep confirming a viewing while it plays (the server's own
 *  passes: the proxy poll every ~30 s, Jellyfin's sessions every minute). */
const HEARTBEAT_SOURCES = new Set(['aiostreams-proxy', 'jellyfin']);

/** Past this without a reconfirmation a row is no longer called live - the
 *  server drops a Jellyfin viewing after the same 150 s. */
export const LIVE_WINDOW_MS = 150 * 1000;

/** A clock a little ahead of the server's is skew, not the future; further
 *  than this the timestamp is not trusted at all. */
const SKEW_TOLERANCE_MS = 30 * 1000;

/** "8 s", "2 min", "3 hr", "2 days" - null seconds for the non-live wording. */
export function formatAge(ageMs: number, withSeconds: boolean): string {
  const seconds = Math.floor(Math.max(0, ageMs) / 1000);
  if (seconds < 60) return withSeconds && seconds >= 3 ? `${seconds} s ago` : 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

/** The freshness line for a row, or null when there is no usable time. */
export function playbackFreshness(row: FreshnessRow | null | undefined, now: number): Freshness | null {
  const at = row?.reportedAtTimestamp;
  if (!row || typeof at !== 'number' || !Number.isFinite(at) || at <= 0 || !Number.isFinite(now)) return null;
  if (at > now + SKEW_TOLERANCE_MS) return null;
  const age = Math.max(0, now - at);

  if (row.paused === true) {
    return { state: 'paused', live: false, pulse: false, text: `Paused · ${formatAge(age, false)}` };
  }
  if (row.source && HEARTBEAT_SOURCES.has(row.source) && !row.elapsedFrozen && age <= LIVE_WINDOW_MS) {
    const when = formatAge(age, true);
    return { state: 'live', live: true, pulse: true, text: `Live · ${when === 'just now' ? 'updated just now' : `updated ${when}`}` };
  }
  if (row.source === 'aiostreams' && typeof row.playingUntilTimestamp === 'number' && Number.isFinite(row.playingUntilTimestamp) && now <= row.playingUntilTimestamp) {
    return { state: 'playing-estimated', live: false, pulse: true, text: `Playing · started ${formatAge(age, false)}` };
  }
  return { state: 'seen', live: false, pulse: false, text: `Last seen ${formatAge(age, false)}` };
}
