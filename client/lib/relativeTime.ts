// Shared "how long ago" formatting.
//
// NowPlayingSection and NotificationsDropdown each grew their own private copy
// of this logic; the wording here matches theirs so the same instant reads the
// same everywhere in the app.

/**
 * Relative time for a past instant, or null if there isn't one.
 *
 * Returns null - rather than a string like 'Unknown' - so each caller picks
 * its own empty-state wording ('Never' for a sync that has not happened,
 * 'Unknown' for a date we genuinely cannot recover).
 */
export function formatRelativeTime(value?: string | Date | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  if (Number.isNaN(ms)) return null;

  const diffMs = Date.now() - ms;
  // A timestamp in the future means clock skew between the server and this
  // browser, not a real event. Round it down to "just now" instead of
  // rendering a negative age.
  if (diffMs < 0) return 'Just now';

  const mins = Math.floor(diffMs / 60000);
  const hours = Math.floor(diffMs / 3600000);
  const days = Math.floor(diffMs / 86400000);

  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days === 1) return 'Yesterday';
  // Past a few weeks a running day count stops being useful - an actual date
  // is easier to read than "63d ago".
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}

/**
 * Relative time for a last-sync timestamp, falling back to 'Never'.
 *
 * 'Never' is deliberate: a null lastSyncedAt means the sync genuinely has not
 * run yet, which is a real answer. The old hardcoded 'Unknown' told the user
 * nothing and was shown even when a sync time was available.
 */
export function formatLastSync(value?: string | Date | null): string {
  return formatRelativeTime(value) ?? 'Never';
}
